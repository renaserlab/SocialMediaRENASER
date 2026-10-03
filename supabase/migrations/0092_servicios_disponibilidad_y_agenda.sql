-- 0092 · Z Servicios, Incremento 4: disponibilidad y agenda del prestador.
--
-- SIN APLICAR. Escrita el 30/09/2026 y probada solo contra PostgreSQL local:
-- desde cero (0001–0092), sobre una base con la 0091 y datos, reejecutada, con
-- un fallo a mitad y sin sus dependencias
-- (`tests/test_servicios_migracion_0092.py`). Requiere la 0086–0091, ya
-- aplicadas en Supabase. NO LAS TOCA.
-- Al aplicarla, REINICIAR LA API: la puerta de la agenda recuerda el «no».
--
-- QUÉ AÑADE, Y NADA MÁS: la agenda de cada servicio, en cinco tablas.
--
--   service_schedules            la configuración: zona IANA, estado,
--                                preparación, descanso e intervalo.
--   service_schedule_rules       la semana, en minutos del día LOCAL.
--   service_schedule_exceptions  una FECHA local: cerrarla (entera o una
--                                franja), añadir una franja o sustituir la
--                                semana ese día.
--   service_schedule_blocks      un intervalo REAL (timestamptz) con un motivo
--                                PRIVADO. Cambiar la zona no lo mueve.
--   service_schedule_events      el historial. Solo se añade; nunca el motivo.
--
-- LA AGENDA ES DEL SERVICIO (la identidad estable de la 0090), no de una
-- versión: editar la descripción abre una versión nueva y no toca la agenda.
-- La duración, la modalidad y la capacidad siguen en la versión.
--
-- LOS HORARIOS NO SE GUARDAN: se calculan en la API al pedirlos. Ninguna tabla
-- de aquí es una reserva, una retención, un pedido ni un cobro.
--
-- LOS CRUCES LOS IMPIDE LA BASE, con RESTRICCIONES DE EXCLUSIÓN: dos reglas
-- ACTIVAS del mismo servicio no se pisan el mismo día de la semana, y dos
-- excepciones del mismo servicio no se pisan en la misma fecha (cerrar el día
-- entero ocupa las 24 horas: no admite nada más ese día). Una restricción de
-- exclusión vale con cualquier nivel de aislamiento y sin cerrojos: dos
-- escrituras a la vez no pueden dejar dos franjas cruzadas. Necesita
-- `btree_gist` para comparar el servicio y el día con `=` dentro del índice
-- GiST; se crea en el esquema `extensions`, como `pg_trgm` en la 0040.
--
-- LA ZONA la valida un disparador contra la base de zonas de PostgreSQL:
-- además de la forma («Área/Lugar», nunca «UTC-5» ni «Etc/GMT+5»), que exista.
--
-- RLS activa, CERO políticas y CERO privilegios para `anon` y
-- `authenticated`: solo la API.
--
-- UNA ÚNICA TRANSACCIÓN, que primero comprueba la 0086–0091 y al final
-- verifica lo que dejó. REEJECUTABLE: `if not exists`, `create or replace`.
--
-- ROLLBACK (la agenda de cada servicio se pierde; nada más depende de ella):
--   drop table public.service_schedule_events, public.service_schedule_blocks,
--              public.service_schedule_exceptions, public.service_schedule_rules,
--              public.service_schedules;
--   drop function public.servicios_agenda_zona_valida();
-- y REINICIAR LA API. `btree_gist` puede quedarse: no cambia nada más.

begin;

-- ------------------------------------------------------------------------- --
-- 1. Lo que tiene que haber.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
begin
  if to_regclass('public.services') is null
     or to_regclass('public.service_versions') is null
     or to_regclass('public.saved_services') is null
     or to_regprocedure('public.servicios_catalogo_historial_inmutable()') is null
     or to_regprocedure('public.servicios_borrado_solo_en_cascada()') is null then
    raise exception 'La 0092 requiere la 0086–0091 aplicadas';
  end if;

  select string_agg(format('%s.%s', e.tabla, e.columna), ', ') into faltan
    from (values
      ('services', 'id'), ('services', 'status'), ('service_versions', 'duration_minutes'),
      ('service_versions', 'modality'), ('service_versions', 'capacity')
    ) as e(tabla, columna)
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = e.tabla and c.column_name = e.columna
   );
  if faltan is not null then
    raise exception 'La 0092 no encontró las columnas %', faltan;
  end if;

  if to_regnamespace('extensions') is null
     or not exists (select 1 from pg_catalog.pg_available_extensions where name = 'btree_gist') then
    raise exception 'La 0092 necesita el esquema extensions y la extensión btree_gist';
  end if;
end;
$$;

create extension if not exists btree_gist with schema extensions;

-- ------------------------------------------------------------------------- --
-- 2. La configuración de la agenda: una por servicio.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_schedules (
  service_id uuid primary key
    references public.services(id) on delete cascade,
  -- IANA, con lugar: «America/Lima». Nunca un desplazamiento fijo.
  timezone text not null
    constraint service_schedules_zona
    check (
      length(timezone) between 3 and 64
      and ltrim(timezone, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/_+-') = ''
      and ltrim(substr(timezone, 1, 1), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = ''
      and timezone like '%/%'
      and timezone not like 'Etc/%'
    ),
  -- `paused`: el prestador deja de ofrecer horarios sin borrar nada.
  status text not null default 'active'
    constraint service_schedules_estado
    check (status in ('active', 'paused')),
  -- Preparación antes y descanso después: ocupan la agenda, no son atención.
  buffer_before_minutes integer not null default 0
    constraint service_schedules_preparacion
    check (buffer_before_minutes between 0 and 240 and buffer_before_minutes % 5 = 0),
  buffer_after_minutes integer not null default 0
    constraint service_schedules_descanso
    check (buffer_after_minutes between 0 and 240 and buffer_after_minutes % 5 = 0),
  -- Cada cuánto empieza un horario. Nulo: uno detrás de otro.
  slot_interval_minutes integer
    constraint service_schedules_intervalo
    check (
      slot_interval_minutes is null
      or (slot_interval_minutes between 5 and 1440 and slot_interval_minutes % 5 = 0)
    ),
  -- SIN CLAVE AJENA a propósito (0086, S10): la historia sobrevive a la cuenta.
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------------- --
-- 3. La semana.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_schedule_rules (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null
    references public.service_schedules(service_id) on delete cascade,
  -- ISO: 1 = lunes … 7 = domingo.
  weekday smallint not null
    constraint service_schedule_rules_dia
    check (weekday between 1 and 7),
  -- Minutos desde la medianoche LOCAL de la agenda; 1440 son las 24:00.
  start_minute integer not null,
  end_minute integer not null,
  modality text not null
    constraint service_schedule_rules_modalidad
    check (modality in ('virtual', 'in_person', 'at_home')),
  capacity integer not null default 1
    constraint service_schedule_rules_capacidad
    check (capacity between 1 and 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint service_schedule_rules_franja
    check (
      start_minute between 0 and 1435 and end_minute between 5 and 1440
      and start_minute < end_minute and start_minute % 5 = 0 and end_minute % 5 = 0
    ),
  -- DOS REGLAS ACTIVAS NO SE CRUZAN el mismo día (tocarse sí: 09–12 y 12–15).
  -- Tampoco con otra modalidad: la misma persona no atiende dos a la vez.
  constraint service_schedule_rules_sin_cruces
    exclude using gist (
      service_id with =,
      weekday with =,
      int4range(start_minute, end_minute) with &&
    ) where (active)
);

create index if not exists service_schedule_rules_de_la_agenda
  on public.service_schedule_rules (service_id, weekday, start_minute);

-- ------------------------------------------------------------------------- --
-- 4. Las excepciones de una fecha.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null
    references public.service_schedules(service_id) on delete cascade,
  -- La fecha LOCAL de la agenda.
  on_date date not null,
  -- `closed` cierra (sin franja, el día entero); `extra` añade una franja;
  -- `replace` sustituye la semana ese día.
  kind text not null
    constraint service_schedule_exceptions_tipo
    check (kind in ('closed', 'extra', 'replace')),
  start_minute integer,
  end_minute integer,
  modality text,
  capacity integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint service_schedule_exceptions_franja
    check (
      (start_minute is null and end_minute is null)
      or (
        start_minute is not null and end_minute is not null
        and start_minute between 0 and 1435 and end_minute between 5 and 1440
        and start_minute < end_minute and start_minute % 5 = 0 and end_minute % 5 = 0
      )
    ),
  constraint service_schedule_exceptions_abrir_con_franja
    check (kind = 'closed' or start_minute is not null),
  -- Solo lo que ABRE lleva modalidad y capacidad. Con `is not null` escrito:
  -- `modality in (...)` con un nulo da nulo, y un CHECK nulo no rechaza.
  constraint service_schedule_exceptions_lo_que_abre
    check (
      (kind = 'closed' and modality is null and capacity is null)
      or (
        kind <> 'closed' and modality is not null and capacity is not null
        and modality in ('virtual', 'in_person', 'at_home')
        and capacity between 1 and 1000
      )
    ),
  -- DOS EXCEPCIONES NO SE PISAN en la misma fecha: ni dos franjas cruzadas,
  -- ni un día cerrado entero con cualquier otra. Nunca un estado ambiguo.
  constraint service_schedule_exceptions_sin_cruces
    exclude using gist (
      service_id with =,
      on_date with =,
      int4range(coalesce(start_minute, 0), coalesce(end_minute, 1440)) with &&
    )
);

create index if not exists service_schedule_exceptions_de_la_agenda
  on public.service_schedule_exceptions (service_id, on_date);

-- ------------------------------------------------------------------------- --
-- 5. Los bloqueos: instantes reales, con motivo PRIVADO.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null
    references public.service_schedules(service_id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- PRIVADO: solo lo ve el prestador. Nunca en lo público ni en el historial.
  reason text
    constraint service_schedule_blocks_motivo
    check (reason is null or length(trim(reason)) between 1 and 200),
  created_at timestamptz not null default now(),

  constraint service_schedule_blocks_orden
    check (starts_at < ends_at)
);

-- Lo que todavía no terminó, que es lo único que se lee.
create index if not exists service_schedule_blocks_de_la_agenda
  on public.service_schedule_blocks (service_id, ends_at);

-- ------------------------------------------------------------------------- --
-- 6. El historial: solo se añade.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_schedule_events (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null
    references public.services(id) on delete cascade,
  action text not null
    constraint service_schedule_events_accion
    check (action in (
      'schedule_created', 'schedule_updated',
      'rule_created', 'rule_updated', 'rule_deleted',
      'exception_created', 'exception_updated', 'exception_deleted',
      'block_created', 'block_deleted'
    )),
  -- SIN CLAVE AJENA a propósito (0086, S10).
  actor_id uuid,
  actor_role text not null
    constraint service_schedule_events_rol
    check (actor_role in ('provider', 'system')),
  details jsonb not null default '{}',
  idempotency_key text
    constraint service_schedule_events_clave
    check (idempotency_key is null or length(idempotency_key) between 8 and 100),
  created_at timestamptz not null default now()
);

-- Una `Idempotency-Key` por servicio: repetir una alta no duplica la fila.
create unique index if not exists service_schedule_events_una_por_clave
  on public.service_schedule_events (service_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists service_schedule_events_del_servicio
  on public.service_schedule_events (service_id, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 7. Lo que ningún CHECK puede decir.
-- ------------------------------------------------------------------------- --
-- 7.1 LA ZONA EXISTE en la base de zonas (no solo tiene forma de zona).
create or replace function public.servicios_agenda_zona_valida()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform pg_catalog.timezone(new.timezone, pg_catalog.now());
  return new;
exception
  when invalid_parameter_value then
    raise exception 'La zona horaria % no existe', new.timezone
      using errcode = 'check_violation';
end;
$$;

drop trigger if exists service_schedules_zona_valida on public.service_schedules;
create trigger service_schedules_zona_valida
  before insert or update of timezone on public.service_schedules
  for each row
  execute function public.servicios_agenda_zona_valida();

-- 7.2 EL HISTORIAL NO SE REESCRIBE (la función de la 0090).
drop trigger if exists service_schedule_events_inmutables on public.service_schedule_events;
create trigger service_schedule_events_inmutables
  before update on public.service_schedule_events
  for each row
  execute function public.servicios_catalogo_historial_inmutable();

-- 7.3 NI LA AGENDA NI SU HISTORIAL SE BORRAN SUELTOS: solo en cascada con el
--     servicio (la función de la 0086). Las reglas, excepciones y bloqueos
--     sí los quita el prestador; el historial lo cuenta.
drop trigger if exists service_schedules_solo_en_cascada on public.service_schedules;
create trigger service_schedules_solo_en_cascada
  before delete on public.service_schedules
  for each row
  execute function public.servicios_borrado_solo_en_cascada('services', 'service_id');

drop trigger if exists service_schedule_events_solo_en_cascada on public.service_schedule_events;
create trigger service_schedule_events_solo_en_cascada
  before delete on public.service_schedule_events
  for each row
  execute function public.servicios_borrado_solo_en_cascada('services', 'service_id');

-- ------------------------------------------------------------------------- --
-- 8. Cerradas: solo la API.
-- ------------------------------------------------------------------------- --
alter table public.service_schedules enable row level security;
alter table public.service_schedule_rules enable row level security;
alter table public.service_schedule_exceptions enable row level security;
alter table public.service_schedule_blocks enable row level security;
alter table public.service_schedule_events enable row level security;

revoke all on public.service_schedules from anon, authenticated;
revoke all on public.service_schedule_rules from anon, authenticated;
revoke all on public.service_schedule_exceptions from anon, authenticated;
revoke all on public.service_schedule_blocks from anon, authenticated;
revoke all on public.service_schedule_events from anon, authenticated;

revoke all on function public.servicios_agenda_zona_valida() from public, anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 9. Lo que tiene que quedar, o nada.
-- ------------------------------------------------------------------------- --
do $$
declare
  tablas constant text[] := array[
    'service_schedules', 'service_schedule_rules', 'service_schedule_exceptions',
    'service_schedule_blocks', 'service_schedule_events'
  ];
  t text;
begin
  foreach t in array tablas loop
    if to_regclass('public.' || t) is null then
      raise exception 'La 0092 no dejó %', t;
    end if;
    if not (select relrowsecurity from pg_catalog.pg_class where oid = to_regclass('public.' || t)) then
      raise exception '% sin RLS', t;
    end if;
    if exists (select 1 from pg_catalog.pg_policy where polrelid = to_regclass('public.' || t)) then
      raise exception '% tiene políticas', t;
    end if;
    if exists (
      select 1 from information_schema.table_privileges
       where table_schema = 'public' and table_name = t and grantee in ('anon', 'authenticated')
    ) then
      raise exception '% tiene permisos sueltos', t;
    end if;
  end loop;

  if (select count(*) from pg_catalog.pg_constraint c
       where c.contype = 'x' and c.convalidated
         and c.conname in ('service_schedule_rules_sin_cruces', 'service_schedule_exceptions_sin_cruces')
         and c.conrelid in ('public.service_schedule_rules'::regclass,
                            'public.service_schedule_exceptions'::regclass)) <> 2 then
    raise exception 'La 0092 no dejó las restricciones de exclusión que impiden los cruces';
  end if;

  if (select count(*) from pg_catalog.pg_constraint c
       where c.contype = 'f' and c.confdeltype = 'c'
         and c.conrelid in (
           'public.service_schedules'::regclass, 'public.service_schedule_rules'::regclass,
           'public.service_schedule_exceptions'::regclass, 'public.service_schedule_blocks'::regclass,
           'public.service_schedule_events'::regclass
         )) <> 5 then
    raise exception 'La 0092 no dejó sus cinco claves ajenas en cascada';
  end if;

  if (select count(*) from pg_catalog.pg_trigger g
       where not g.tgisinternal and g.tgenabled in ('O', 'A')
         -- Con su forma: antes de la fila, y en qué operaciones.
         and (g.tgrelid, g.tgname, g.tgfoid, g.tgtype) in (
           ('public.service_schedules'::regclass, 'service_schedules_zona_valida',
            'public.servicios_agenda_zona_valida()'::regprocedure, 23),
           ('public.service_schedules'::regclass, 'service_schedules_solo_en_cascada',
            'public.servicios_borrado_solo_en_cascada()'::regprocedure, 11),
           ('public.service_schedule_events'::regclass, 'service_schedule_events_inmutables',
            'public.servicios_catalogo_historial_inmutable()'::regprocedure, 19),
           ('public.service_schedule_events'::regclass, 'service_schedule_events_solo_en_cascada',
            'public.servicios_borrado_solo_en_cascada()'::regprocedure, 11)
         )) <> 4 then
    raise exception 'La 0092 no dejó sus disparadores';
  end if;

  if to_regclass('public.service_schedule_events_una_por_clave') is null
     or to_regclass('public.service_schedule_rules_de_la_agenda') is null
     or to_regclass('public.service_schedule_exceptions_de_la_agenda') is null
     or to_regclass('public.service_schedule_blocks_de_la_agenda') is null
     or to_regclass('public.service_schedule_events_del_servicio') is null then
    raise exception 'La 0092 no dejó sus índices';
  end if;

  if has_function_privilege('anon', 'public.servicios_agenda_zona_valida()', 'execute')
     or has_function_privilege('authenticated', 'public.servicios_agenda_zona_valida()', 'execute') then
    raise exception 'La función de la zona tiene permisos sueltos';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
