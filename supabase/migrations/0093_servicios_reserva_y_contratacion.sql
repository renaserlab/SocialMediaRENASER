-- 0093 · Z Servicios, Incremento 5: reserva y contratación protegida.
--
-- SIN APLICAR. Escrita el 30/09/2026 y probada solo contra PostgreSQL local:
-- desde cero (0001–0093), sobre una base con la 0092 y datos, reejecutada,
-- con un fallo a mitad y sin cada una de sus dependencias
-- (`tests/test_servicios_migracion_0093.py`). Requiere la 0086–0092, ya
-- aplicadas en Supabase. NO LAS TOCA salvo en un punto: amplía el CHECK del
-- tipo de `service_policies` (0086) con `booking_terms`, que es como la 0086
-- dice que llegan los tipos nuevos («añadiendo su valor al CHECK»).
-- Al aplicarla, REINICIAR LA API: la puerta de la reserva recuerda el «no».
--
-- QUÉ AÑADE, Y NADA MÁS:
--
--   service_holds                 LA RETENCIÓN de un horario: 10 minutos
--                                 (configurable) en los que ese horario es de
--                                 una persona. ES EL REGISTRO QUE OCUPA: al
--                                 confirmar pasa a `consumed` y sigue ocupando
--                                 por la reserva.
--   service_orders                EL PEDIDO: lo comercial. En este incremento
--                                 SOLO GRATUITO, sin cobro y sin pasarela.
--   service_bookings              LA RESERVA: la cita, con su FOTOGRAFÍA
--                                 (servicio, versión, horario, zona, duración,
--                                 separación, plaza, prestador).
--   service_booking_intakes       LO QUE PIDE LA ATENCIÓN a quien contrata: una
--                                 nota y, a domicilio, la dirección. Privado.
--   service_booking_acceptances   LO QUE SE ACEPTÓ: las condiciones de Z (una
--                                 versión de `service_policies`) y las del
--                                 servicio (la versión publicada), con su huella.
--   service_booking_events        EL HISTORIAL. Solo se añade.
--
-- LA DOBLE RESERVA LA IMPIDE LA BASE, no una consulta previa de Python:
--   * dos sesiones DISTINTAS de un servicio no se pisan, contando preparación
--     y descanso (exclusión `service_holds_sin_cruces`);
--   * una plaza no se da dos veces (`service_holds_una_plaza`) y nunca pasa de
--     la capacidad congelada (CHECK);
--   * una persona no ocupa dos plazas de la misma sesión, ni tiene dos
--     retenciones activas del mismo servicio.
-- Solo ocupan las retenciones `active` y `consumed`. Una `active` que ya
-- venció la marca vencida la propia API, dentro de la misma transacción, antes
-- de ocupar (el barrido es una limpieza, no la autoridad).
--
-- NINGÚN ESTADO A MEDIAS (disparadores diferidos, al confirmar la transacción):
-- ningún pedido sin su reserva ni sin las condiciones de Z aceptadas, ninguna
-- reserva sin su pedido ni sin su retención consumida, y ninguna retención
-- consumida sin su reserva.
--
-- SIN DINERO: un pedido solo puede ser gratuito (`free`), sin cobro
-- (`not_required`) y con la pasarela `none`. Un pedido con precio no puede
-- guardarse todavía: la base no deja fingir un cobro.
--
-- LA BAJA DE UNA CUENTA (0089): una reserva POR VENIR impide borrar la cuenta
-- de quien contrata o de quien presta (409 `account_deletion_blocked`); las
-- pasadas se quedan con la persona en NULL, y los datos de la atención de esa
-- persona (su nota y su dirección) se borran con ella.
--
-- RLS activa, CERO políticas y CERO privilegios para `anon` y `authenticated`:
-- solo la API.
--
-- UNA ÚNICA TRANSACCIÓN, que primero comprueba lo anterior y al final
-- verifica lo que dejó. REEJECUTABLE: `if not exists`, `create or replace`.
--
-- ROLLBACK (se pierden las retenciones, reservas y pedidos de Servicios; nada
-- más depende de ellos):
--   drop table public.service_booking_events, public.service_booking_acceptances,
--              public.service_booking_intakes, public.service_bookings,
--              public.service_orders, public.service_holds;
--   drop function public.servicios_retencion_salto_valido(),
--                 public.servicios_retencion_con_reserva(),
--                 public.servicios_reserva_inmutable(),
--                 public.servicios_reserva_por_venir(),
--                 public.servicios_reserva_coherente(),
--                 public.servicios_pedido_inmutable(),
--                 public.servicios_pedido_completo();
--   delete from public.service_policies where kind = 'booking_terms';
--   alter table public.service_policies drop constraint service_policies_tipo,
--     add constraint service_policies_tipo check (kind in ('provider_terms'));
-- y REINICIAR LA API.

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
     or to_regclass('public.service_providers') is null
     or to_regclass('public.service_policies') is null
     or to_regclass('public.service_schedules') is null
     or to_regclass('public.profiles') is null then
    raise exception 'La 0093 requiere la 0086–0092 aplicadas';
  end if;

  if to_regprocedure('public.servicios_borrado_solo_en_cascada()') is null
     or to_regprocedure('public.servicios_catalogo_historial_inmutable()') is null then
    raise exception 'La 0093 requiere las funciones de la 0086 y la 0090';
  end if;

  if to_regprocedure('public.es_anonimizacion_por_baja(jsonb, jsonb, text[])') is null then
    raise exception 'La 0093 requiere la 0089 (es_anonimizacion_por_baja)';
  end if;

  if not exists (select 1 from pg_catalog.pg_extension where extname = 'btree_gist') then
    raise exception 'La 0093 requiere btree_gist (la instala la 0092)';
  end if;

  select string_agg(format('%s.%s', e.tabla, e.columna), ', ') into faltan
    from (values
      ('services', 'id'), ('services', 'provider_id'), ('services', 'status'),
      ('service_versions', 'duration_minutes'), ('service_versions', 'modality'),
      ('service_versions', 'capacity'), ('service_versions', 'price_model'),
      ('service_versions', 'conditions'), ('service_providers', 'id'),
      ('service_policies', 'kind'), ('service_policies', 'body_sha256'),
      ('service_schedules', 'buffer_before_minutes')
    ) as e(tabla, columna)
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = e.tabla and c.column_name = e.columna
   );
  if faltan is not null then
    raise exception 'La 0093 no encontró las columnas %', faltan;
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. Las condiciones de contratación: un tipo más de `service_policies`.
--    Las publica la empresa desde administración; la 0093 no publica nada.
-- ------------------------------------------------------------------------- --
alter table public.service_policies drop constraint if exists service_policies_tipo;
alter table public.service_policies
  add constraint service_policies_tipo
  check (kind in ('provider_terms', 'booking_terms'));

-- ------------------------------------------------------------------------- --
-- 3. La retención: el registro que ocupa.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_holds (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null
    references public.services(id) on delete cascade,
  -- La versión PUBLICADA cuando se retuvo: confirmar exige que siga siéndolo.
  version_id uuid not null
    references public.service_versions(id) on delete cascade,
  -- NULL solo tras la baja de la cuenta (0089).
  client_id uuid
    references public.profiles(id) on delete set null,
  status text not null default 'active'
    constraint service_holds_estado
    check (status in ('active', 'consumed', 'released', 'expired')),
  -- La atención (sin la separación) y lo que OCUPA (con ella).
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  occupied_from timestamptz not null,
  occupied_until timestamptz not null,
  -- La zona de la agenda en ese momento, y la fecha local del inicio.
  timezone text not null
    constraint service_holds_zona
    check (length(timezone) between 3 and 64 and timezone like '%/%'),
  local_date date not null,
  modality text not null
    constraint service_holds_modalidad
    check (modality in ('virtual', 'in_person', 'at_home')),
  capacity integer not null
    constraint service_holds_capacidad
    check (capacity between 1 and 1000),
  seat integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  consumed_at timestamptz,
  released_at timestamptz,
  expired_at timestamptz,

  constraint service_holds_horario
    check (
      starts_at < ends_at and occupied_from <= starts_at and ends_at <= occupied_until
    ),
  constraint service_holds_plaza
    check (seat between 1 and capacity),
  constraint service_holds_vence
    check (expires_at > created_at),
  -- Cada estado final, con su momento; y ninguno más.
  constraint service_holds_momentos
    check (
      (status = 'consumed') = (consumed_at is not null)
      and (status = 'released') = (released_at is not null)
      and (status = 'expired') = (expired_at is not null)
    ),
  -- DOS SESIONES DISTINTAS NO SE PISAN (con su preparación y su descanso).
  -- La misma sesión, sí: son sus plazas.
  constraint service_holds_sin_cruces
    exclude using gist (
      service_id with =,
      tstzrange(occupied_from, occupied_until, '[)') with &&,
      starts_at with <>
    ) where (status in ('active', 'consumed'))
);

-- Una plaza no se da dos veces.
create unique index if not exists service_holds_una_plaza
  on public.service_holds (service_id, starts_at, seat)
  where status in ('active', 'consumed');
-- Una persona, una plaza por sesión.
create unique index if not exists service_holds_una_por_persona
  on public.service_holds (service_id, starts_at, client_id)
  where status in ('active', 'consumed');
-- Una persona, UNA retención activa por servicio.
create unique index if not exists service_holds_una_activa
  on public.service_holds (service_id, client_id)
  where status = 'active';
-- Lo que ocupa un servicio (lo que lee el cálculo de horarios).
create index if not exists service_holds_ocupan
  on public.service_holds (service_id, occupied_until)
  where status in ('active', 'consumed');
-- Las de una persona, y las que el barrido vence.
create index if not exists service_holds_de_la_persona
  on public.service_holds (client_id, status);
create index if not exists service_holds_por_vencer
  on public.service_holds (expires_at)
  where status = 'active';

-- ------------------------------------------------------------------------- --
-- 4. El pedido: lo comercial. SOLO GRATUITO en este incremento.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_orders (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null
    references public.services(id) on delete cascade,
  version_id uuid not null
    references public.service_versions(id) on delete cascade,
  provider_id uuid not null
    references public.service_providers(id) on delete cascade,
  client_id uuid
    references public.profiles(id) on delete set null,
  status text not null default 'confirmed'
    constraint service_orders_estado
    check (status in ('confirmed')),
  -- SIN DINERO. Separado del estado a propósito (arquitectura §5).
  payment_status text not null default 'not_required'
    constraint service_orders_pago
    check (payment_status in ('not_required')),
  payment_provider text not null default 'none'
    constraint service_orders_pasarela
    check (payment_provider in ('none')),
  environment text not null
    constraint service_orders_entorno
    check (environment in ('sandbox', 'production')),
  -- LA FOTOGRAFÍA DEL PRECIO: gratuito, sin importe ni moneda, total cero.
  price_model text not null
    constraint service_orders_modelo
    check (price_model in ('free')),
  price_minor bigint,
  currency char(3),
  total_minor bigint not null default 0,
  title_snapshot text not null
    constraint service_orders_titulo
    check (length(trim(title_snapshot)) between 1 and 300),
  provider_name_snapshot text not null
    constraint service_orders_prestador
    check (length(trim(provider_name_snapshot)) between 1 and 200),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz not null,

  constraint service_orders_sin_dinero
    check (price_minor is null and currency is null and total_minor = 0)
);

create index if not exists service_orders_de_la_persona
  on public.service_orders (client_id, created_at desc, id desc);
create index if not exists service_orders_del_prestador
  on public.service_orders (provider_id, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 5. La reserva: la cita y su fotografía.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_bookings (
  id uuid primary key default gen_random_uuid(),
  -- El código que se lee y se dicta: «ABCD-2345».
  booking_code text not null
    constraint service_bookings_codigo
    check (
      length(booking_code) = 9 and substr(booking_code, 5, 1) = '-'
      and ltrim(replace(booking_code, '-', ''), 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') = ''
    ),
  order_id uuid not null
    references public.service_orders(id) on delete cascade,
  hold_id uuid not null
    references public.service_holds(id) on delete cascade,
  service_id uuid not null
    references public.services(id) on delete cascade,
  version_id uuid not null
    references public.service_versions(id) on delete cascade,
  provider_id uuid not null
    references public.service_providers(id) on delete cascade,
  client_id uuid
    references public.profiles(id) on delete set null,
  status text not null default 'confirmed'
    constraint service_bookings_estado
    check (status in ('confirmed')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  occupied_from timestamptz not null,
  occupied_until timestamptz not null,
  timezone text not null
    constraint service_bookings_zona
    check (length(timezone) between 3 and 64 and timezone like '%/%'),
  local_date date not null,
  modality text not null
    constraint service_bookings_modalidad
    check (modality in ('virtual', 'in_person', 'at_home')),
  duration_minutes integer not null
    constraint service_bookings_duracion
    check (duration_minutes between 5 and 1440),
  buffer_before_minutes integer not null
    constraint service_bookings_preparacion
    check (buffer_before_minutes between 0 and 240),
  buffer_after_minutes integer not null
    constraint service_bookings_descanso
    check (buffer_after_minutes between 0 and 240),
  capacity integer not null
    constraint service_bookings_capacidad
    check (capacity between 1 and 1000),
  seat integer not null,
  title_snapshot text not null
    constraint service_bookings_titulo
    check (length(trim(title_snapshot)) between 1 and 300),
  provider_name_snapshot text not null
    constraint service_bookings_prestador
    check (length(trim(provider_name_snapshot)) between 1 and 200),
  -- Lo PÚBLICO del lugar (la zona que enseña la ficha). Nunca una dirección.
  location_area_snapshot text
    constraint service_bookings_zona_publica
    check (location_area_snapshot is null or length(trim(location_area_snapshot)) between 1 and 200),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz not null,

  constraint service_bookings_horario
    check (
      starts_at < ends_at and occupied_from <= starts_at and ends_at <= occupied_until
    ),
  constraint service_bookings_plaza
    check (seat between 1 and capacity),
  constraint service_bookings_codigo_unico unique (booking_code),
  constraint service_bookings_un_pedido unique (order_id),
  constraint service_bookings_una_retencion unique (hold_id)
);

create index if not exists service_bookings_de_la_persona
  on public.service_bookings (client_id, starts_at, id);
create index if not exists service_bookings_del_prestador
  on public.service_bookings (provider_id, starts_at, id);
create index if not exists service_bookings_del_servicio
  on public.service_bookings (service_id, starts_at);

-- ------------------------------------------------------------------------- --
-- 6. Lo que pide la atención: privado, y de la persona.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_booking_intakes (
  booking_id uuid primary key
    references public.service_bookings(id) on delete cascade,
  -- Se va CON la persona: su nota y su dirección no le sobreviven.
  client_id uuid not null
    references public.profiles(id) on delete cascade,
  note text
    constraint service_booking_intakes_nota
    check (note is null or length(trim(note)) between 1 and 500),
  -- A domicilio. Sin coordenadas, sin documento, sin teléfono.
  district text
    constraint service_booking_intakes_distrito
    check (district is null or length(trim(district)) between 1 and 100),
  address_line text
    constraint service_booking_intakes_direccion
    check (address_line is null or length(trim(address_line)) between 1 and 200),
  address_reference text
    constraint service_booking_intakes_referencia
    check (address_reference is null or length(trim(address_reference)) between 1 and 200),
  created_at timestamptz not null default now(),

  constraint service_booking_intakes_direccion_completa
    check ((district is null) = (address_line is null) and (address_reference is null or address_line is not null)),
  constraint service_booking_intakes_algo
    check (note is not null or address_line is not null)
);

-- ------------------------------------------------------------------------- --
-- 7. Lo que se aceptó, con su huella.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_booking_acceptances (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null
    references public.service_orders(id) on delete cascade,
  -- `booking_terms`: las condiciones de contratación de Z (una versión
  -- publicada de `service_policies`, inmutable). `service_conditions`: las
  -- del servicio (su versión publicada, también inmutable).
  kind text not null
    constraint service_booking_acceptances_tipo
    check (kind in ('booking_terms', 'service_conditions')),
  policy_id uuid
    references public.service_policies(id) on delete restrict,
  policy_version integer,
  version_id uuid
    references public.service_versions(id) on delete cascade,
  sha256 text not null
    constraint service_booking_acceptances_huella
    check (length(sha256) = 64 and ltrim(sha256, '0123456789abcdef') = ''),
  -- SIN CLAVE AJENA a propósito (0086, S10): la historia sobrevive a la cuenta.
  accepted_by uuid,
  accepted_at timestamptz not null,

  constraint service_booking_acceptances_referencia
    check (
      (kind = 'booking_terms' and policy_id is not null and policy_version is not null and version_id is null)
      or (kind = 'service_conditions' and version_id is not null and policy_id is null and policy_version is null)
    ),
  constraint service_booking_acceptances_una unique (order_id, kind)
);

-- ------------------------------------------------------------------------- --
-- 8. El historial: solo se añade.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_booking_events (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null
    references public.services(id) on delete cascade,
  hold_id uuid
    references public.service_holds(id) on delete cascade,
  booking_id uuid
    references public.service_bookings(id) on delete cascade,
  action text not null
    constraint service_booking_events_accion
    check (action in ('hold_created', 'hold_released', 'hold_expired', 'booking_confirmed')),
  from_status text,
  to_status text not null,
  -- SIN CLAVE AJENA a propósito (0086, S10).
  actor_id uuid,
  actor_role text not null
    constraint service_booking_events_rol
    check (actor_role in ('client', 'system')),
  idempotency_key text
    constraint service_booking_events_clave
    check (idempotency_key is null or length(idempotency_key) between 8 and 100),
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),

  constraint service_booking_events_de_algo
    check (hold_id is not null or booking_id is not null)
);

-- Una `Idempotency-Key` por persona: repetir no duplica; otra cosa con la
-- misma clave es un 409.
create unique index if not exists service_booking_events_una_por_clave
  on public.service_booking_events (actor_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists service_booking_events_de_la_retencion
  on public.service_booking_events (hold_id, created_at, id);
create index if not exists service_booking_events_de_la_reserva
  on public.service_booking_events (booking_id, created_at, id);

-- ------------------------------------------------------------------------- --
-- 9. Lo que ningún CHECK puede decir.
-- ------------------------------------------------------------------------- --
-- 9.1 LOS SALTOS DE UNA RETENCIÓN: de `active` a uno final, y de ahí a
--     ninguno. Lo demás (la fotografía) no se reescribe. La baja de una cuenta
--     solo deja a la persona en NULL.
create or replace function public.servicios_retencion_salto_valido()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  momentos constant text[] := array['status', 'updated_at', 'consumed_at', 'released_at', 'expired_at'];
begin
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['client_id']) then
    return new;
  end if;
  if old.status <> 'active' then
    raise exception 'Una retención % ya no cambia', old.status
      using errcode = 'check_violation';
  end if;
  if new.status not in ('consumed', 'released', 'expired') then
    raise exception 'Salto de retención no permitido: active → %', new.status
      using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - momentos) is distinct from (to_jsonb(old) - momentos) then
    raise exception 'Una retención no se reescribe'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists service_holds_salto_valido on public.service_holds;
create trigger service_holds_salto_valido
  before update on public.service_holds
  for each row
  execute function public.servicios_retencion_salto_valido();

-- 9.2 LA RESERVA NO SE REESCRIBE. La baja de quien contrata solo la deja en
--     NULL, y no si la reserva está POR VENIR: esa baja espera (409).
create or replace function public.servicios_reserva_inmutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['client_id']) then
    if old.status = 'confirmed' and old.ends_at > pg_catalog.now() then
      raise exception 'Hay una reserva de Servicios por venir: la cuenta no se borra todavía'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  raise exception 'Una reserva no se reescribe'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists service_bookings_inmutables on public.service_bookings;
create trigger service_bookings_inmutables
  before update on public.service_bookings
  for each row
  execute function public.servicios_reserva_inmutable();

-- 9.3 NI POR LA BAJA DE QUIEN PRESTA: una reserva por venir no se borra.
create or replace function public.servicios_reserva_por_venir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.status = 'confirmed' and old.ends_at > pg_catalog.now() then
    raise exception 'Hay una reserva de Servicios por venir: no se borra'
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists service_bookings_por_venir on public.service_bookings;
create trigger service_bookings_por_venir
  before delete on public.service_bookings
  for each row
  execute function public.servicios_reserva_por_venir();

-- 9.4 EL PEDIDO NO SE REESCRIBE (la baja solo deja a la persona en NULL).
create or replace function public.servicios_pedido_inmutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['client_id']) then
    return new;
  end if;
  raise exception 'Un pedido no se reescribe'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists service_orders_inmutables on public.service_orders;
create trigger service_orders_inmutables
  before update on public.service_orders
  for each row
  execute function public.servicios_pedido_inmutable();

-- 9.5 LA ACEPTACIÓN, LO PEDIDO Y EL HISTORIAL NO SE REESCRIBEN (la función de
--     la 0090).
drop trigger if exists service_booking_acceptances_inmutables on public.service_booking_acceptances;
create trigger service_booking_acceptances_inmutables
  before update on public.service_booking_acceptances
  for each row
  execute function public.servicios_catalogo_historial_inmutable();

drop trigger if exists service_booking_intakes_inmutables on public.service_booking_intakes;
create trigger service_booking_intakes_inmutables
  before update on public.service_booking_intakes
  for each row
  execute function public.servicios_catalogo_historial_inmutable();

drop trigger if exists service_booking_events_inmutables on public.service_booking_events;
create trigger service_booking_events_inmutables
  before update on public.service_booking_events
  for each row
  execute function public.servicios_catalogo_historial_inmutable();

-- 9.6 NADA SE BORRA SUELTO: solo en cascada desde el servicio (o el pedido).
drop trigger if exists service_holds_solo_en_cascada on public.service_holds;
create trigger service_holds_solo_en_cascada
  before delete on public.service_holds
  for each row
  execute function public.servicios_borrado_solo_en_cascada('services', 'service_id');

drop trigger if exists service_orders_solo_en_cascada on public.service_orders;
create trigger service_orders_solo_en_cascada
  before delete on public.service_orders
  for each row
  execute function public.servicios_borrado_solo_en_cascada('services', 'service_id');

drop trigger if exists service_bookings_solo_en_cascada on public.service_bookings;
create trigger service_bookings_solo_en_cascada
  before delete on public.service_bookings
  for each row
  execute function public.servicios_borrado_solo_en_cascada('services', 'service_id');

drop trigger if exists service_booking_acceptances_solo_en_cascada on public.service_booking_acceptances;
create trigger service_booking_acceptances_solo_en_cascada
  before delete on public.service_booking_acceptances
  for each row
  execute function public.servicios_borrado_solo_en_cascada('service_orders', 'order_id');

drop trigger if exists service_booking_events_solo_en_cascada on public.service_booking_events;
create trigger service_booking_events_solo_en_cascada
  before delete on public.service_booking_events
  for each row
  execute function public.servicios_borrado_solo_en_cascada('services', 'service_id');

-- 9.7 NINGÚN ESTADO A MEDIAS, comprobado AL CONFIRMAR la transacción.
--     a) Cada reserva nace de SU retención ya consumida (el mismo servicio,
--        horario, plaza y persona) y de SU pedido confirmado.
create or replace function public.servicios_reserva_coherente()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.service_holds h
     where h.id = new.hold_id and h.status = 'consumed'
       and h.service_id = new.service_id and h.version_id = new.version_id
       and h.starts_at = new.starts_at and h.ends_at = new.ends_at
       and h.occupied_from = new.occupied_from and h.occupied_until = new.occupied_until
       and h.seat = new.seat and h.capacity = new.capacity
       and h.client_id is not distinct from new.client_id
  ) then
    raise exception 'Una reserva nace de su retención consumida'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.service_orders o
     where o.id = new.order_id and o.status = 'confirmed'
       and o.service_id = new.service_id and o.version_id = new.version_id
       and o.provider_id = new.provider_id
       and o.client_id is not distinct from new.client_id
  ) then
    raise exception 'Una reserva tiene su pedido confirmado'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists service_bookings_coherentes on public.service_bookings;
create constraint trigger service_bookings_coherentes
  after insert on public.service_bookings
  deferrable initially deferred
  for each row
  execute function public.servicios_reserva_coherente();

--     b) Ningún pedido sin su reserva, ni sin las condiciones de Z aceptadas.
create or replace function public.servicios_pedido_completo()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.service_bookings b where b.order_id = new.id) then
    raise exception 'Un pedido de Servicios no existe sin su reserva'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.service_booking_acceptances a
     where a.order_id = new.id and a.kind = 'booking_terms'
  ) then
    raise exception 'Un pedido de Servicios no existe sin las condiciones aceptadas'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists service_orders_completos on public.service_orders;
create constraint trigger service_orders_completos
  after insert on public.service_orders
  deferrable initially deferred
  for each row
  execute function public.servicios_pedido_completo();

--     c) Ninguna retención consumida sin su reserva.
create or replace function public.servicios_retencion_con_reserva()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status = 'consumed'
     and not exists (select 1 from public.service_bookings b where b.hold_id = new.id) then
    raise exception 'Una retención consumida tiene su reserva'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists service_holds_con_reserva on public.service_holds;
create constraint trigger service_holds_con_reserva
  after insert or update of status on public.service_holds
  deferrable initially deferred
  for each row
  execute function public.servicios_retencion_con_reserva();

-- ------------------------------------------------------------------------- --
-- 10. Cerradas: solo la API.
-- ------------------------------------------------------------------------- --
alter table public.service_holds enable row level security;
alter table public.service_orders enable row level security;
alter table public.service_bookings enable row level security;
alter table public.service_booking_intakes enable row level security;
alter table public.service_booking_acceptances enable row level security;
alter table public.service_booking_events enable row level security;

revoke all on public.service_holds from anon, authenticated;
revoke all on public.service_orders from anon, authenticated;
revoke all on public.service_bookings from anon, authenticated;
revoke all on public.service_booking_intakes from anon, authenticated;
revoke all on public.service_booking_acceptances from anon, authenticated;
revoke all on public.service_booking_events from anon, authenticated;

revoke all on function public.servicios_retencion_salto_valido() from public, anon, authenticated;
revoke all on function public.servicios_reserva_inmutable() from public, anon, authenticated;
revoke all on function public.servicios_reserva_por_venir() from public, anon, authenticated;
revoke all on function public.servicios_pedido_inmutable() from public, anon, authenticated;
revoke all on function public.servicios_reserva_coherente() from public, anon, authenticated;
revoke all on function public.servicios_pedido_completo() from public, anon, authenticated;
revoke all on function public.servicios_retencion_con_reserva() from public, anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 11. Lo que tiene que quedar, o nada.
-- ------------------------------------------------------------------------- --
do $$
declare
  tablas constant text[] := array[
    'service_holds', 'service_orders', 'service_bookings',
    'service_booking_intakes', 'service_booking_acceptances', 'service_booking_events'
  ];
  t text;
begin
  foreach t in array tablas loop
    if to_regclass('public.' || t) is null then
      raise exception 'La 0093 no dejó %', t;
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

  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conname = 'service_holds_sin_cruces' and c.contype = 'x' and c.convalidated
       and c.conrelid = 'public.service_holds'::regclass
  ) then
    raise exception 'La 0093 no dejó la exclusión que impide la doble reserva';
  end if;

  if (select count(*) from pg_catalog.pg_index i
       where i.indrelid = 'public.service_holds'::regclass and i.indisunique and not i.indisprimary
         and i.indisvalid and i.indisready) <> 3 then
    raise exception 'La 0093 no dejó los índices únicos de las plazas';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conname = 'service_policies_tipo' and c.convalidated
       and c.conrelid = 'public.service_policies'::regclass
       and pg_catalog.pg_get_constraintdef(c.oid) like '%booking_terms%'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%provider_terms%'
  ) then
    raise exception 'La 0093 no amplió el tipo de las políticas';
  end if;

  if (select count(*) from pg_catalog.pg_trigger g
       where not g.tgisinternal and g.tgenabled in ('O', 'A')
         and g.tgrelid = any (array[
           'public.service_holds'::regclass, 'public.service_orders'::regclass,
           'public.service_bookings'::regclass, 'public.service_booking_intakes'::regclass,
           'public.service_booking_acceptances'::regclass, 'public.service_booking_events'::regclass
         ])) <> 15 then
    raise exception 'La 0093 no dejó sus disparadores';
  end if;

  if (select count(*) from pg_catalog.pg_trigger g
       where not g.tgisinternal and g.tgdeferrable and g.tginitdeferred
         and g.tgname in ('service_bookings_coherentes', 'service_orders_completos', 'service_holds_con_reserva')) <> 3 then
    raise exception 'La 0093 no dejó sus comprobaciones al confirmar';
  end if;

  if (select count(*) from pg_catalog.pg_constraint c
       where c.contype = 'f' and c.conrelid = any (array[
           'public.service_holds'::regclass, 'public.service_orders'::regclass,
           'public.service_bookings'::regclass, 'public.service_booking_intakes'::regclass,
           'public.service_booking_acceptances'::regclass, 'public.service_booking_events'::regclass
         ])) <> 21 then
    raise exception 'La 0093 no dejó sus claves ajenas';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
