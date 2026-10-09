-- 0100 · Disponibilidad para las sesiones 1:1 (prototipo)
--
-- QUÉ RESUELVE (documento «Z bugs y nuevas funcionalidades», 07/10/2026): que
-- cada persona diga en qué días y a qué horas está disponible, y que quien le
-- pide una sesión elija entre esos horarios en vez de proponer uno a ciegas.
--
-- QUÉ HACE. Crea `availability_slots`: las franjas de la SEMANA de cada
-- persona («los martes de 9 a 12»). Es una semana tipo que se repite; no hay
-- excepciones por fecha.
--
-- ES UN PROTOTIPO, y lo que deja fuera está dicho en
-- `apps/api/app/modules/bookings/disponibilidad.py`: sin excepciones ni
-- bloqueos por día, sesiones de duración fija, y la franja ORIENTA —la API
-- no rechaza una sesión pedida fuera de ella—.
--
-- QUÉ NO HACE.
--   · No toca `bookings`, `profiles` ni una sola fila existente.
--   · No tiene nada que ver con la agenda de Z Servicios
--     (`service_availability_*`, migración 0092), que es de los prestadores y
--     tiene sus propias reglas.
--   · No deja leer ni escribir al cliente: solo la API.
--
-- SE PUEDE DESPLEGAR EL CÓDIGO ANTES O DESPUÉS. Sin esta tabla la API dice
-- que la disponibilidad no está montada, la aplicación no la enseña y pedir
-- una sesión funciona como siempre. Tras aplicarla hay que REINICIAR la API.
--
-- IDEMPOTENTE: se puede ejecutar dos veces.
--
-- VUELTA ATRÁS: `drop table public.availability_slots;` y reiniciar la API.

create table if not exists public.availability_slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- 0 = lunes … 6 = domingo, en la zona horaria de la persona.
  weekday smallint not null,
  -- Minutos desde las 00:00 de ese día, en la zona horaria de la persona.
  starts_minute smallint not null,
  ends_minute smallint not null,
  -- Zona horaria IANA en la que están dichas las horas («America/Lima»). La
  -- misma en todas las filas de una persona.
  timezone text not null default 'America/Lima',
  created_at timestamptz not null default now()
);

alter table public.availability_slots
  drop constraint if exists availability_slots_weekday_check;
alter table public.availability_slots
  add constraint availability_slots_weekday_check
  check (weekday between 0 and 6);

alter table public.availability_slots
  drop constraint if exists availability_slots_minutes_check;
alter table public.availability_slots
  add constraint availability_slots_minutes_check
  check (starts_minute >= 0 and ends_minute <= 1440 and starts_minute < ends_minute);

-- Las franjas de una persona, en orden: es la única pregunta que se hace.
create index if not exists availability_slots_user_idx
  on public.availability_slots (user_id, weekday, starts_minute);

alter table public.availability_slots enable row level security;

-- NINGUNA POLÍTICA. Estas filas solo las lee y las escribe la API, que es
-- donde se comprueba quién pregunta (nadie cambia la disponibilidad de otra
-- persona) y donde un bloqueo entre dos cuentas corta también esto.

do $$
declare
  con_rls boolean;
  politicas integer;
begin
  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.availability_slots'::regclass;
  if not coalesce(con_rls, false) then
    raise exception 'La 0100 no ha dejado RLS activada en availability_slots.';
  end if;

  select count(*) into politicas
  from pg_policies
  where schemaname = 'public'
    and tablename = 'availability_slots';
  if politicas > 0 then
    raise exception
      'availability_slots tiene % política(s). No debe tener ninguna.',
      politicas;
  end if;
end
$$;

notify pgrst, 'reload schema';
