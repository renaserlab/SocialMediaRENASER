-- Agenda: sesiones 1:1 que existen de verdad.
--
-- QUE HABIA. La migracion 0019 abrio la insercion de un AVISO de tipo
-- `session_booked`. Eso arreglo lo urgente —antes la pantalla anunciaba «sesion
-- agendada» y la otra persona no se enteraba jamas—, pero un aviso no es una
-- reserva: se lee una vez, se pierde entre los demas, y no se puede aceptar,
-- rechazar, reprogramar, cancelar ni dar por hecha. Tampoco deja rastro de que
-- dos personas se hayan visto, que es justo lo que hara falta el dia que una
-- resena tenga que ser verificable.
--
-- QUE SE ANADE. La entidad que faltaba. Los avisos y el mensaje en el chat se
-- conservan tal cual: son el canal, no el registro.
--
-- PREPARADO PARA LAS RESENAS. `completed_at` no es decoracion: una resena
-- verificable necesita poder comprobar que la sesion ocurrio y quien participo
-- en ella. Sin ese dato desde el principio, anadir resenas obligaria a
-- reconstruir la historia a posteriori, que no se puede.
--
-- No se toca ninguna tabla existente. El script es REPETIBLE.

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  -- Quien pide la sesion y quien la daria. Nombres explicitos: con "user_a" y
  -- "user_b" cualquier consulta futura tendria que adivinar quien es quien.
  requester_id uuid not null references public.profiles(id) on delete cascade,
  provider_id uuid not null references public.profiles(id) on delete cascade,
  topic text not null check (char_length(trim(topic)) between 1 and 200),
  note text not null default '' check (char_length(note) <= 1000),
  -- Momento propuesto. Nulo mientras se acuerda por chat.
  scheduled_at timestamptz,
  -- Zona horaria de quien propuso, en formato IANA ("America/Lima"). Sin ella,
  -- "5:00 PM" no significa lo mismo para las dos partes.
  timezone text,
  status text not null default 'pending' check (
    status in (
      'pending',               -- solicitada, sin responder
      'accepted',              -- la otra persona dijo que si
      'rejected',              -- dijo que no
      'cancelled',             -- una de las dos la anulo despues
      'reschedule_requested',  -- se propone otra fecha
      'completed',             -- ocurrio
      'expired'                -- paso la fecha sin que nadie la atendiera
    )
  ),
  -- Chat donde se acordo. Permite abrir la conversacion desde la agenda.
  conversation_id uuid,
  -- Cuando se dio por hecha. Es lo que permitira verificar una resena.
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Agendar consigo mismo no es una sesion.
  check (requester_id <> provider_id)
);

-- Las dos consultas de la pantalla: «lo que me piden» y «lo que he pedido».
create index if not exists bookings_provider_idx
  on public.bookings (provider_id, status, created_at desc);
create index if not exists bookings_requester_idx
  on public.bookings (requester_id, status, created_at desc);

alter table public.bookings enable row level security;

/*
  Quien puede que.

  LEER: solo las dos partes. Una agenda dice con quien se ve alguien y sobre
  que; no es informacion publica.

  CREAR: solo se puede pedir en nombre propio.

  ACTUALIZAR: las dos partes pueden tocar la fila (aceptar, rechazar, cancelar,
  reprogramar, completar). QUE transicion vale la decide el backend, que es
  quien conoce las reglas; aqui se limita QUIEN puede escribir.

  BORRAR: nadie. Una sesion cancelada se marca `cancelled`, no se hace
  desaparecer: borrarla dejaria a la otra persona sin saber que paso, y
  destruiria la prueba que una resena futura necesita.
*/
drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select to authenticated
  using (requester_id = auth.uid() or provider_id = auth.uid());

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings
  for insert to authenticated
  with check (requester_id = auth.uid() and provider_id <> auth.uid());

drop policy if exists bookings_update on public.bookings;
create policy bookings_update on public.bookings
  for update to authenticated
  using (requester_id = auth.uid() or provider_id = auth.uid())
  with check (requester_id = auth.uid() or provider_id = auth.uid());

comment on table public.bookings is
  'Sesiones 1:1 con estado. Sustituye al aviso suelto de la migracion 0019.';
comment on column public.bookings.completed_at is
  'Cuando ocurrio la sesion. Es lo que permite verificar una resena posterior.';

notify pgrst, 'reload schema';

-- Comprobacion final.
select
  (select count(*) from public.bookings) as reservas,
  (select count(*) from pg_policies where tablename = 'bookings') as politicas,
  (select count(*) from public.notifications) as avisos_conservados;
-- Esperado: reservas = 0 la primera vez, politicas = 3, y los avisos que ya
-- hubiera (esta migracion no toca ninguno).
