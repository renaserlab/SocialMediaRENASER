-- 0068 · El saldo de una venta admite un evento, y aparecen reserva y disputa.
--
-- SIN APLICAR.
--
-- POR QUÉ NO SE CREA OTRO MÓDULO FINANCIERO. `owner_sale_balances` ya guarda
-- bruto, comisión y neto con su versión de reglas; `owner_payout_accounts` y
-- `owner_transfers` ya cuelgan del perfil y no del curso; el adaptador de
-- transferencias ya no menciona cursos por ninguna parte. Lo único que ataba
-- todo eso a Cursos eran dos columnas NOT NULL: `course_id` y `order_id`.
--
-- LA GENERALIZACIÓN ES ADITIVA Y CON CLAVES AJENAS REALES. Se relajan esas dos,
-- se añaden `event_id` y `event_order_id`, y un CHECK obliga a que un saldo
-- tenga EXACTAMENTE un origen: o curso, o evento. No se usa un par
-- `(tipo, id)` polimórfico: eso renuncia a la integridad referencial justo en
-- la tabla del dinero, y aquí se puede tener de verdad.
--
-- LOS SALDOS EXISTENTES NO SE TOCAN. Siguen con su `course_id` y su `order_id`,
-- y el CHECK los admite tal cual. Cursos no cambia en nada.
--
-- LA RESERVA ES ESTRUCTURA, NO POLÍTICA. `owner_sale_reserves` puede
-- representar un importe retenido con su motivo y su expediente, pero NO trae
-- ningún porcentaje ni ninguna duración: eso lo decide la empresa y vive en
-- `event_policies`. Sin política publicada no se calcula ninguna reserva y el
-- saldo se queda retenido.
--
-- UNA DISPUTA NO ES UNA DEVOLUCIÓN, y por eso tiene tabla propia. La abre el
-- banco del titular, se puede ganar, y quién asume la pérdida no está decidido:
-- bloquea el importe y avisa; no descuenta nada de ningún otro saldo.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE. Esquema antes que código: dos
-- columnas nulas que nadie escribe y dos tablas vacías. Código antes que
-- esquema: no se crea ningún saldo de evento —la puerta de esquema lo impide—
-- y Cursos sigue exactamente igual.
--
-- BACKFILL: NINGUNO, y se comprueba. Ningún saldo existente se reescribe.
--
-- ROLLBACK: `drop table` de las dos nuevas; devolver `course_id` y `order_id` a
-- NOT NULL solo es seguro si no se creó ningún saldo de evento. El comentario
-- del final dice cómo comprobarlo.

-- ------------------------------------------------------------------------- --
-- 1. El saldo admite un origen de evento.
-- ------------------------------------------------------------------------- --
alter table public.owner_sale_balances
  add column if not exists event_id uuid;

alter table public.owner_sale_balances
  add column if not exists event_order_id uuid;

alter table public.owner_sale_balances
  alter column course_id drop not null;

alter table public.owner_sale_balances
  alter column order_id drop not null;

-- EL DINERO CABE. Estas cuatro columnas son `integer` desde la 0049, y el tope
-- de `integer` son 2 147 483 647 unidades menores: 21 474 836,47 en cualquier
-- moneda de dos decimales. `event_orders.total_minor` es `bigint`, así que un
-- pedido corporativo por encima de ese tope reventaba el INSERT del saldo con
-- un `DataError` que nadie captura, y se llevaba por delante el savepoint del
-- webhook: cobro hecho y entradas sin emitir.
--
-- Ensanchar es seguro en los dos sentidos: `integer` cabe en `bigint` sin
-- reescribir ninguna fila —PostgreSQL 11 en adelante no reescribe la tabla al
-- ampliar un entero— y el código no distingue.
alter table public.owner_sale_balances
  alter column gross_amount_minor type bigint,
  alter column platform_fee_minor type bigint,
  alter column provider_fee_minor type bigint,
  alter column net_amount_minor type bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'owner_sale_balances'
      and c.conname = 'owner_sale_balances_event_id_fkey'
  ) then
    alter table public.owner_sale_balances
      add constraint owner_sale_balances_event_id_fkey
      foreign key (event_id) references public.events(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'owner_sale_balances'
      and c.conname = 'owner_sale_balances_event_order_id_fkey'
  ) then
    alter table public.owner_sale_balances
      add constraint owner_sale_balances_event_order_id_fkey
      foreign key (event_order_id) references public.event_orders(id)
      on delete restrict;
  end if;

  -- UN ORIGEN, EXACTAMENTE UNO. Ni los dos —el dinero se contaría dos veces—
  -- ni ninguno, que sería un saldo que nadie puede explicar.
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'owner_sale_balances'
      and c.conname = 'owner_sale_balances_un_origen'
  ) then
    alter table public.owner_sale_balances
      add constraint owner_sale_balances_un_origen
      check (
        (course_id is not null and order_id is not null
         and event_id is null and event_order_id is null)
        or
        (event_id is not null and event_order_id is not null
         and course_id is null and order_id is null)
      );
  end if;
end;
$$;

-- UNA FILA DE SALDO POR PEDIDO, también en eventos. El `unique (order_id)` de
-- Cursos sigue donde estaba; este es su gemelo para el otro origen.
create unique index if not exists owner_sale_balances_pedido_de_evento_unico
  on public.owner_sale_balances (event_order_id)
  where event_order_id is not null;

create index if not exists owner_sale_balances_del_evento
  on public.owner_sale_balances (event_id, created_at desc)
  where event_id is not null;

-- ------------------------------------------------------------------------- --
-- 2. La reserva: estructura sin política.
-- ------------------------------------------------------------------------- --
create table if not exists public.owner_sale_reserves (
  id uuid primary key default gen_random_uuid(),

  balance_id uuid not null
    references public.owner_sale_balances(id) on delete restrict,

  amount_minor bigint not null
    constraint owner_sale_reserves_importe check (amount_minor > 0),
  currency char(3) not null
    constraint owner_sale_reserves_moneda check (currency ~ '^[A-Z]{3}$'),

  reason text not null
    constraint owner_sale_reserves_motivo check (reason in (
      'aftersale_case',
      'refund',
      'cancellation',
      'essential_change',
      'dispute',
      'operational_risk'
    )),
  -- El expediente que la origina, cuando lo hay.
  case_id uuid references public.event_aftersale_cases(id) on delete set null,

  status text not null default 'held'
    constraint owner_sale_reserves_estado
    check (status in ('held', 'released', 'consumed')),

  -- LA POLÍTICA QUE LA CALCULÓ. Nula mientras no haya ninguna: una reserva sin
  -- política es una retención que nadie ha decidido, y se dice.
  policy_id uuid references public.event_policies(id) on delete restrict,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  -- QUIÉN LA SOLTÓ. Nulo cuando la soltó el sistema al resolverse la disputa:
  -- eso no lo decidió nadie, y poner ahí un nombre sería mentir.
  released_by uuid references public.profiles(id) on delete set null,
  release_reason text
    constraint owner_sale_reserves_motivo_de_liberacion
    check (release_reason is null or length(release_reason) <= 500),

  constraint owner_sale_reserves_liberada_con_fecha
    check ((status = 'held') = (released_at is null))
);

-- UNA RESERVA VIVA POR SALDO Y MOTIVO. Dos por lo mismo serían el mismo dinero
-- retenido dos veces.
create unique index if not exists owner_sale_reserves_viva_unica
  on public.owner_sale_reserves (balance_id, reason)
  where status = 'held';

create index if not exists owner_sale_reserves_del_saldo
  on public.owner_sale_reserves (balance_id, created_at desc);

-- ------------------------------------------------------------------------- --
-- 3. La disputa: expediente propio, no una marca en el saldo.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_disputes (
  id uuid primary key default gen_random_uuid(),

  provider text not null
    constraint event_disputes_proveedor check (provider in ('stripe')),
  environment text not null
    constraint event_disputes_entorno check (environment in ('sandbox', 'production')),
  -- La referencia de la disputa en la pasarela. Es la identidad real.
  external_id text not null,

  event_id uuid references public.events(id) on delete restrict,
  order_id uuid references public.event_orders(id) on delete restrict,
  organizer_id uuid references public.profiles(id) on delete restrict,
  balance_id uuid references public.owner_sale_balances(id) on delete restrict,

  amount_minor bigint
    constraint event_disputes_importe check (amount_minor is null or amount_minor >= 0),
  currency char(3)
    constraint event_disputes_moneda check (currency is null or currency ~ '^[A-Z]{3}$'),

  reason text
    constraint event_disputes_motivo check (reason is null or length(reason) <= 200),

  status text not null default 'open'
    constraint event_disputes_estado check (status in (
      'open',
      'needs_response',
      'under_review',
      'won',
      'lost',
      'closed'
    )),

  -- Hasta cuándo hay para responder, si la pasarela lo dice. NO se inventa.
  evidence_due_at timestamptz,
  evidence_required text
    constraint event_disputes_evidencia
    check (evidence_required is null or length(evidence_required) <= 1000),
  assignee_id uuid references public.profiles(id) on delete set null,

  -- Quién asume la pérdida NO se decide aquí: es una política que nadie ha
  -- aprobado. Nulo hasta entonces.
  liability text
    constraint event_disputes_responsabilidad
    check (liability is null or liability in ('platform', 'organizer', 'shared')),
  policy_id uuid references public.event_policies(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,

  constraint event_disputes_resuelta_con_fecha
    check ((status in ('won', 'lost', 'closed')) = (resolved_at is not null)),
  -- SIN POLÍTICA NO HAY RESPONSABLE. Decidir quién paga sin regla aprobada es
  -- inventarse la regla.
  constraint event_disputes_responsable_con_politica
    check (liability is null or policy_id is not null)
);

-- UNA DISPUTA POR REFERENCIA DE LA PASARELA. El aviso se reintenta.
create unique index if not exists event_disputes_referencia_unica
  on public.event_disputes (provider, environment, external_id);

create index if not exists event_disputes_abiertas
  on public.event_disputes (status, created_at desc)
  where status in ('open', 'needs_response', 'under_review');

create index if not exists event_disputes_del_evento
  on public.event_disputes (event_id, created_at desc);

-- ------------------------------------------------------------------------- --
-- 4. El historial de la disputa. SOLO AÑADIR.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_dispute_events (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.event_disputes(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_role text not null default 'system'
    constraint event_dispute_events_rol
    check (actor_role in ('admin', 'system')),
  notes text
    constraint event_dispute_events_notas
    check (notes is null or length(notes) <= 2000),
  created_at timestamptz not null default now()
);

create index if not exists event_dispute_events_de_la_disputa
  on public.event_dispute_events (dispute_id, created_at, id);

create or replace function public.event_dispute_events_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'El historial de una disputa no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists event_dispute_events_inmutable on public.event_dispute_events;
create trigger event_dispute_events_inmutable
before update or delete on public.event_dispute_events
for each row execute function public.event_dispute_events_solo_anadir();

-- ------------------------------------------------------------------------- --
-- 5. RLS y permisos.
--
-- `owner_sale_balances` ya tiene una política de LECTURA para su dueño; no se
-- toca. Las tablas nuevas quedan cerradas: una reserva y una disputa son
-- operación interna, y el organizador las ve por la API, que decide qué campos
-- devuelve —y `liability` o las notas no están entre ellos—.
-- ------------------------------------------------------------------------- --
alter table public.owner_sale_reserves enable row level security;
alter table public.event_disputes enable row level security;
alter table public.event_dispute_events enable row level security;

revoke all on public.owner_sale_reserves from anon, authenticated;
revoke all on public.event_disputes from anon, authenticated;
revoke all on public.event_dispute_events from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 6. Verificación posterior.
-- ------------------------------------------------------------------------- --
do $$
declare
  cuantas bigint;
  huerfanos bigint;
  permisos bigint;
begin
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'owner_sale_balances'
      and c.conname = 'owner_sale_balances_un_origen'
  ) then
    raise exception 'La 0068 no dejó la restricción de origen único';
  end if;

  -- NINGÚN SALDO EXISTENTE SE REESCRIBE, y esto lo comprueba: todos los que
  -- había siguen siendo de curso y con su pedido.
  select count(*) into huerfanos
    from public.owner_sale_balances
   where course_id is null and event_id is null;
  if huerfanos > 0 then
    raise exception 'Hay % saldos sin origen', huerfanos;
  end if;

  -- ESTE FICHERO NO ESCRIBE NINGUNA FILA EN LAS TABLAS NUEVAS, y se comprueba
  -- leyéndolo: aquí no hay ningún `insert`. La verificación que SÍ importa —que
  -- ningún saldo se quede sin origen— está justo arriba y esa sí se vuelve a
  -- correr sin problema. Contar las filas de las tablas nuevas y abortar hacía
  -- que la migración dejara de ser re-ejecutable en cuanto hubiera una reserva.

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'owner_sale_balances_pedido_de_evento_unico'
  ) then
    raise exception 'La 0068 no dejó el índice de un saldo por pedido de evento';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in (
       'owner_sale_reserves', 'event_disputes', 'event_dispute_events'
     )
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Las finanzas de eventos tienen % permisos sueltos', permisos;
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 7. ROLLBACK. Antes de devolver `course_id` y `order_id` a NOT NULL:
--
--      select count(*) from public.owner_sale_balances where event_id is not null;
--
--    Si devuelve algo distinto de cero, hay saldos de evento y revertir la
--    columna dejaría filas que la restricción ya no admite.
-- ------------------------------------------------------------------------- --
