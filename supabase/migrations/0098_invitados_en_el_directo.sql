-- 0098 · Invitados en el directo
--
-- QUÉ RESUELVE. Quien emite quiere poder subir a otras personas a su directo,
-- con su cámara, y que la pantalla se reparta entre todos (pedido el
-- 07/10/2026). El papel ya existía —`invitado` en `live/roles.py`, `guest` en
-- la plantilla del proveedor de vídeo—, pero no había dónde apuntar A QUIÉN se
-- ha invitado ni qué contestó: la regla estaba escrita y nadie podía cumplirla.
--
-- QUÉ HACE. Crea `live_guests`: una fila por persona invitada a una emisión,
-- con lo que pasó (`invited`, `accepted`, `declined`, `left`, `removed`).
--
-- QUÉ NO HACE.
--   · No toca `live_sessions`, `live_messages` ni una sola fila existente.
--   · No entra en la publicación de tiempo real: los avisos de «te han
--     invitado» viajan por difusión entre los clientes y cada uno le pregunta
--     después a la API, que es la que manda.
--   · No deja leer ni escribir al cliente. Ver más abajo.
--
-- SE PUEDE DESPLEGAR EL CÓDIGO ANTES O DESPUÉS. Sin esta tabla la API contesta
-- 503 (`live_guests_not_available`) a todo lo de invitados, la aplicación no
-- enseña el botón de invitar y el resto del directo funciona igual que antes
-- (`recommendations/esquema.py::hay_invitados_de_directo`). Tras aplicarla hay
-- que REINICIAR la API: lo que averigua del esquema lo recuerda por proceso.
--
-- IDEMPOTENTE: se puede ejecutar dos veces.
--
-- VUELTA ATRÁS: `drop table public.live_guests;` Y REINICIAR LA API, igual que
-- al aplicarla y por el mismo motivo. Las emisiones y su chat no se enteran.

create table if not exists public.live_guests (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- Lo ÚLTIMO que pasó con esta persona en esta emisión. Una fila por persona
  -- y emisión: volver a invitar a quien dijo que no reutiliza la suya.
  status text not null default 'invited',
  -- Quién la invitó. `SET NULL`: si esa cuenta desaparece, el hecho de que
  -- esta persona estuvo invitada no desaparece con ella.
  invited_by uuid references public.profiles(id) on delete set null,
  invited_at timestamptz not null default now(),
  -- Cuándo aceptó o rechazó.
  responded_at timestamptz,
  -- Cuándo dejó de estar en pantalla, por irse o porque la quitaron.
  ended_at timestamptz,
  primary key (session_id, user_id)
);

alter table public.live_guests
  drop constraint if exists live_guests_status_check;
alter table public.live_guests
  add constraint live_guests_status_check
  check (status in ('invited', 'accepted', 'declined', 'left', 'removed'));

-- Quién ocupa plaza en una emisión y quién está en pantalla: es lo que se
-- pregunta al invitar y cada vez que alguien pide permiso para entrar.
create index if not exists live_guests_session_status_idx
  on public.live_guests (session_id, status);

-- Las invitaciones de una persona, para cuando se borra su cuenta.
create index if not exists live_guests_user_idx
  on public.live_guests (user_id);

alter table public.live_guests enable row level security;

-- NINGUNA POLÍTICA, NI DE LECTURA. Con RLS activada eso significa que desde el
-- cliente no se puede ni leer ni escribir: estas filas solo las toca la API.
-- Si el cliente pudiera escribirlas, cualquiera se apuntaría como «aceptado»
-- en el directo de otra persona y saldría con su cámara delante de su público.
-- Y a quién se invitó y quién dijo que no, no es asunto de nadie más.

do $$
declare
  con_rls boolean;
  politicas integer;
begin
  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.live_guests'::regclass;
  if not coalesce(con_rls, false) then
    raise exception 'La 0098 no ha dejado RLS activada en live_guests.';
  end if;

  select count(*) into politicas
  from pg_policies
  where schemaname = 'public'
    and tablename = 'live_guests';
  if politicas > 0 then
    raise exception
      'live_guests tiene % política(s). No debe tener ninguna: estas filas '
      'solo las lee y las escribe la API.',
      politicas;
  end if;
end
$$;

notify pgrst, 'reload schema';
