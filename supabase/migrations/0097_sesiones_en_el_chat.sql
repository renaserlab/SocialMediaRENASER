-- 0097 · Las sesiones 1:1, dentro del chat
--
-- QUÉ RESUELVE. Pedir una sesión dejaba en el chat un mensaje de texto normal
-- que no sabía de qué sesión hablaba: en Mensajes no se podía aceptar ni
-- rechazar, y tampoco quedaba escrito qué se respondió. Había que ir al perfil,
-- abrir la agenda y responder allí.
--
-- QUÉ HACE. Crea `message_booking_context`: de qué sesión habla un mensaje y
-- qué pasó en ella (se pidió, se aceptó, se rechazó, se canceló, se propuso
-- otra fecha, se realizó). Es el mismo patrón que `message_story_context`
-- (0044): tabla aparte y NINGUNA columna nueva en `messages`.
--
-- QUÉ NO HACE.
--   · No toca `messages` ni `bookings`, ni una sola fila existente.
--   · No guarda el estado de la sesión: se lee de `bookings` en cada consulta.
--   · No deja escribir al cliente. Ver las políticas.
--
-- SE PUEDE DESPLEGAR EL CÓDIGO ANTES O DESPUÉS. Sin esta tabla la API escribe
-- igualmente el mensaje de cada hecho, como texto, y no ofrece la tarjeta
-- (`messaging/esquema.py::hay_sesiones_en_el_chat`). Tras aplicarla hay que
-- REINICIAR la API: lo que averigua del esquema lo recuerda por proceso.
--
-- IDEMPOTENTE: se puede ejecutar dos veces.
--
-- VUELTA ATRÁS: `drop table public.message_booking_context;`. Los mensajes se
-- quedan, como texto; las sesiones no se enteran.

create table if not exists public.message_booking_context (
  -- Clave primaria Y clave ajena a la vez: un mensaje habla de UN hecho de UNA
  -- sesión, o de ninguno.
  message_id uuid primary key references public.messages(id) on delete cascade,
  -- `CASCADE`: una sesión solo desaparece si desaparece una de las dos cuentas,
  -- y entonces su conversación se va con ella.
  booking_id uuid not null references public.bookings(id) on delete cascade,
  -- Lo que pasó EN ESTE MENSAJE. No cambia nunca: lo que cambia es el estado de
  -- la sesión, que vive en `bookings.status`.
  event text not null,
  created_at timestamptz not null default now()
);

alter table public.message_booking_context
  drop constraint if exists message_booking_context_event_check;
alter table public.message_booking_context
  add constraint message_booking_context_event_check
  check (event in (
    'requested', 'accepted', 'rejected', 'cancelled',
    'reschedule_requested', 'completed'
  ));

-- Todos los mensajes de una sesión, en orden: es lo que se consulta al abrir
-- la conversación y al pintar su historia.
create index if not exists message_booking_context_booking_idx
  on public.message_booking_context (booking_id, created_at);

alter table public.message_booking_context enable row level security;

-- LEER: quien está en la conversación del mensaje. Igual que el contexto de
-- las historias.
drop policy if exists message_booking_context_read on public.message_booking_context;
create policy message_booking_context_read on public.message_booking_context
  for select using (
    exists (
      select 1 from public.messages m
      where m.id = message_id
        and public.is_conversation_member(m.conversation_id)
    )
  );

-- ESCRIBIR: NADIE DESDE EL CLIENTE. No hay política de `insert`, `update` ni
-- `delete`, y con RLS activada eso significa que PostgREST no deja hacer
-- ninguna de las tres. Estas filas las escribe solo la API, en la misma
-- transacción que cambia la sesión. Si el cliente pudiera insertarlas,
-- cualquiera dejaría escrito «sesión aceptada» en un chat sin que nadie hubiera
-- aceptado nada.

do $$
declare
  con_rls boolean;
  politicas_de_escritura integer;
begin
  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.message_booking_context'::regclass;
  if not coalesce(con_rls, false) then
    raise exception
      'La 0097 no ha dejado RLS activada en message_booking_context.';
  end if;

  select count(*) into politicas_de_escritura
  from pg_policies
  where schemaname = 'public'
    and tablename = 'message_booking_context'
    and cmd <> 'SELECT';
  if politicas_de_escritura > 0 then
    raise exception
      'message_booking_context tiene % política(s) de escritura. No debe '
      'tener ninguna: estas filas solo las escribe la API.',
      politicas_de_escritura;
  end if;
end
$$;

notify pgrst, 'reload schema';
