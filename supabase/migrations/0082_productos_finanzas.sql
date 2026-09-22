-- 0082 · El saldo de una venta admite un pedido de producto, y aparecen la
--        devolucion y la disputa de Productos.
--
-- SIN APLICAR.
--
-- POR QUE NO SE CREA OTRO MODULO FINANCIERO, otra vez. `owner_sale_balances`
-- ya guarda bruto, comision, comision de pasarela, neto, moneda y version de
-- reglas; `owner_payout_accounts` y `owner_transfers` ya cuelgan del perfil;
-- `owner_sale_reserves` ya representa un importe retenido con su motivo; y el
-- adaptador de transferencias no menciona cursos ni eventos por ninguna parte.
-- La 0068 hizo el trabajo duro: relajo dos columnas NOT NULL y metio un CHECK
-- de «exactamente un origen». Aqui solo hace falta un TERCER origen.
--
-- LA GENERALIZACION ES ADITIVA Y CON CLAVES AJENAS REALES. Se anade
-- `product_order_id`, se amplia el CHECK a tres ramas y se anade su indice
-- unico parcial. No se usa un par `(tipo, id)` polimorfico: eso renuncia a la
-- integridad referencial justo en la tabla del dinero.
--
-- LOS SALDOS EXISTENTES NO SE TOCAN. Siguen con su curso o su evento, y el
-- CHECK nuevo los admite tal cual. Cursos y Eventos no cambian en nada.
--
-- POR QUE `product_disputes` Y `product_refunds` SI SON TABLAS NUEVAS, y no una
-- columna mas en las de Eventos. `event_disputes` se llama asi y sus claves
-- ajenas apuntan a `events` y a `event_orders`; meter dentro disputas de
-- productos dejaria una tabla cuyo nombre miente y cuyas dos claves ajenas
-- sobran en la mitad de las filas. Lo mismo con `refund_requests`, que es de
-- Cursos y cuelga de `orders`. Lo que SI se reutiliza entero es el ADAPTADOR
-- de devoluciones —`RefundProvider`, con su `NoConfigurado` que falla en
-- cerrado— y la maquina de estados del saldo.
--
-- EL EFECTO DE UNA RECLAMACION PUEDE ACABAR EJECUTADO. La 0080 dejo
-- `financial_effect` con dos valores, `PENDING` y `NOT_APPLICABLE`, porque
-- entonces no habia forma de ejecutarlo. Ahora si, asi que el CHECK admite un
-- tercero: `EXECUTED`. Es lo unico que se relaja de una tabla ya aplicada, y se
-- hace ampliando la lista, nunca quitando valores: ninguna fila existente deja
-- de ser valida.
--
-- NI UN PORCENTAJE, NI UN PLAZO, NI UN IMPORTE POR DEFECTO. Cuanto se queda Z,
-- cuanto se devuelve en cada una de las cinco salidas, cuantos dias se retiene
-- y quien paga el porte de vuelta son decisiones que la empresa no ha tomado.
-- Esta migracion no trae ninguna: `platform_fee_bps` nace en -1 —que no es
-- «cero por ciento» sino «sin configurar»— y sin el no se escribe ni un saldo.
--
-- SEGURA EN LOS DOS ORDENES DE DESPLIEGUE. Esquema antes que codigo: una
-- columna nula que nadie escribe, dos columnas nulas en la reserva y cuatro
-- tablas vacias. Codigo antes que esquema: la puerta de esquema contesta 503
-- `product_finance_not_available` y no se crea ningun saldo de producto.
--
-- BACKFILL: NINGUNO, y se comprueba. Ningun saldo existente se reescribe, y no
-- se crea ningun saldo para los pedidos ya pagados: sin comision configurada no
-- habria con que calcularlo, y inventarla es justo lo que no se puede hacer.
--
-- ROLLBACK: al final del fichero.

-- ------------------------------------------------------------------------- --
-- 1. El saldo admite un origen de producto.
-- ------------------------------------------------------------------------- --
alter table public.owner_sale_balances
  add column if not exists product_order_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'owner_sale_balances_pedido_de_producto'
  ) then
    alter table public.owner_sale_balances
      add constraint owner_sale_balances_pedido_de_producto
      foreign key (product_order_id)
      references public.product_orders(id) on delete restrict;
  end if;
end;
$$;

-- EL CHECK, AMPLIADO A TRES RAMAS. Se quita y se vuelve a poner porque un CHECK
-- no se puede ampliar en su sitio; las filas existentes siguen cumpliendo las
-- dos primeras ramas, que no cambian ni una letra.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'owner_sale_balances_un_origen'
  ) then
    alter table public.owner_sale_balances
      drop constraint owner_sale_balances_un_origen;
  end if;

  alter table public.owner_sale_balances
    add constraint owner_sale_balances_un_origen
    check (
      (course_id is not null and order_id is not null
       and event_id is null and event_order_id is null
       and product_order_id is null)
      or
      (event_id is not null and event_order_id is not null
       and course_id is null and order_id is null
       and product_order_id is null)
      or
      (product_order_id is not null
       and course_id is null and order_id is null
       and event_id is null and event_order_id is null)
    );
end;
$$;

-- UNA FILA DE SALDO POR PEDIDO, tambien en productos. Es lo unico que protege
-- de dos saldos para la misma venta cuando un aviso de cobro llega dos veces.
create unique index if not exists owner_sale_balances_pedido_de_producto_unico
  on public.owner_sale_balances (product_order_id)
  where product_order_id is not null;

create index if not exists owner_sale_balances_de_productos
  on public.owner_sale_balances (owner_id, created_at desc)
  where product_order_id is not null;

-- ------------------------------------------------------------------------- --
-- 2. La reserva admite un expediente y una politica de Productos.
--
-- SIGUE SIENDO ESTRUCTURA SIN POLITICA: no trae ningun porcentaje ni ninguna
-- duracion. Sin politica publicada no se calcula ninguna reserva y el saldo se
-- queda retenido, que es exactamente lo que dice la 0068.
-- ------------------------------------------------------------------------- --
alter table public.owner_sale_reserves
  add column if not exists product_incident_id uuid;

alter table public.owner_sale_reserves
  add column if not exists product_policy_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'owner_sale_reserves_expediente_de_producto'
  ) then
    alter table public.owner_sale_reserves
      add constraint owner_sale_reserves_expediente_de_producto
      foreign key (product_incident_id)
      references public.product_incidents(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'owner_sale_reserves_politica_de_producto'
  ) then
    alter table public.owner_sale_reserves
      add constraint owner_sale_reserves_politica_de_producto
      foreign key (product_policy_id)
      references public.product_policies(id) on delete restrict;
  end if;

  -- COMO MUCHO UN EXPEDIENTE, Y COMO MUCHO UNA POLITICA. Una reserva que
  -- apuntara a un caso de evento Y a uno de producto no se sabria de quien es.
  if not exists (
    select 1 from pg_constraint
     where conname = 'owner_sale_reserves_un_expediente'
  ) then
    alter table public.owner_sale_reserves
      add constraint owner_sale_reserves_un_expediente
      check (case_id is null or product_incident_id is null);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'owner_sale_reserves_una_politica'
  ) then
    alter table public.owner_sale_reserves
      add constraint owner_sale_reserves_una_politica
      check (policy_id is null or product_policy_id is null);
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 3. El efecto de una reclamacion puede quedar EJECUTADO.
--
-- La 0080 dejo dos valores porque no habia forma de ejecutarlo. Se AMPLIA la
-- lista; no se quita ninguno, asi que ninguna fila existente deja de valer.
-- ------------------------------------------------------------------------- --
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'product_incidents_efecto'
  ) then
    alter table public.product_incidents
      drop constraint product_incidents_efecto;
  end if;

  alter table public.product_incidents
    add constraint product_incidents_efecto
    check (
      financial_effect is null
      or financial_effect in ('PENDING', 'NOT_APPLICABLE', 'EXECUTED')
    );
end;
$$;

-- ------------------------------------------------------------------------- --
-- 3.1. LA CONFORMIDAD, que no es confirmar que llego.
--
-- El Incremento 6 dejo `buyer_confirmed_at`, y la documentacion dice con todas
-- las letras que ESO NO ES LA CONFORMIDAD: confirmar que el paquete llego no es
-- decir que esta bien, y lo segundo libera dinero. Cambiarle el significado
-- ahora seria redefinir en silencio una columna que ya tiene filas.
--
-- Asi que la conformidad es una columna PROPIA. El blueprint §9 la exige:
-- «comprador confirma conformidad -> liberar transferencia de inmediato».
--
-- Y NO SE DA CONFORMIDAD DE ALGO QUE NO LLEGO, que lo impone un CHECK.
-- ------------------------------------------------------------------------- --
alter table public.product_shipments
  add column if not exists conformity_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_shipments_conformidad_con_entrega'
  ) then
    alter table public.product_shipments
      add constraint product_shipments_conformidad_con_entrega
      check (conformity_at is null or delivered_at is not null);
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 4. La devolucion de dinero de un pedido de producto.
--
-- APROBAR NO ES PAGAR, Y ESTA TABLA EXISTE PARA QUE ESO SE VEA. Una fila en
-- `APPROVED` dice que alguien con permiso financiero decidio devolver un
-- importe; que el dinero haya salido lo dice `CONFIRMED`, y eso solo lo escribe
-- el aviso de la pasarela. Entre medias hay `REQUESTED`, `PROCESSING` y
-- `FAILED`, que son cosas distintas y se leen distinto en pantalla.
--
-- EL IMPORTE NO SE CALCULA: LO ESCRIBE UNA PERSONA. Cuanto se devuelve en cada
-- una de las cinco salidas es una decision que la empresa no ha tomado, asi que
-- no hay ninguna formula: lo teclea quien tiene permiso financiero, queda con
-- su nombre y su fecha, y un CHECK impide que pase del bruto de la venta.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_refunds (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.product_orders(id) on delete restrict,
  -- EL EXPEDIENTE QUE LA ORIGINA, cuando lo hay. Nulo para una devolucion que
  -- decide administracion sin reclamacion de por medio —una cancelacion, un
  -- error de cobro— y eso es un caso distinto, no un hueco.
  incident_id uuid
    references public.product_incidents(id) on delete restrict,
  -- EL SALDO AL QUE LE AFECTA. Nulo mientras no exista: sin comision
  -- configurada no hay saldo, y la devolucion se puede registrar igual.
  balance_id uuid
    references public.owner_sale_balances(id) on delete restrict,

  amount_minor bigint not null
    constraint product_refunds_importe check (amount_minor > 0),
  currency char(3) not null
    constraint product_refunds_moneda check (currency ~ '^[A-Z]{3}$'),
  -- SI ES TOTAL O PARCIAL, dicho y no deducido. Comparar el importe con el
  -- bruto para adivinarlo falla en cuanto haya dos devoluciones parciales que
  -- sumen el total, que es una cosa distinta de una total.
  kind text not null
    constraint product_refunds_clase check (kind in ('full', 'partial')),

  status text not null default 'approved'
    constraint product_refunds_estado check (status in (
      'approved', 'requested', 'processing', 'confirmed', 'failed', 'cancelled'
    )),

  -- CON QUE PASARELA Y CON QUE REFERENCIA. Nulos hasta que se pida de verdad.
  provider text not null default 'none',
  environment text not null,
  external_refund_id text,
  -- ESTABLE POR DEVOLUCION. Un reintento reutiliza la misma y no devuelve dos
  -- veces el mismo dinero.
  idempotency_key text not null,

  -- QUIEN LO DECIDIO. Obligatorio: no hay devoluciones que decida el sistema.
  decided_by uuid not null references public.profiles(id) on delete restrict,
  decision_reason text not null
    constraint product_refunds_motivo
    check (length(trim(decision_reason)) between 3 and 1000),

  requested_at timestamptz,
  confirmed_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_message text
    constraint product_refunds_mensaje_del_fallo
    check (failure_message is null or length(failure_message) <= 500),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- UNA CLAVE DE IDEMPOTENCIA NO SE REPITE. Es lo que impide que dos
  -- pulsaciones del mismo boton devuelvan el dinero dos veces.
  constraint product_refunds_clave_unica unique (idempotency_key),

  -- LAS FECHAS Y EL ESTADO CUENTAN LO MISMO.
  constraint product_refunds_confirmada_con_fecha
    check ((status = 'confirmed') = (confirmed_at is not null)),
  constraint product_refunds_fallida_con_fecha
    check ((status = 'failed') = (failed_at is not null)),
  -- Y NO SE CONFIRMA LO QUE NO SE PIDIO: un `confirmed` sin `requested_at`
  -- seria dinero devuelto sin que nadie se lo pidiera a la pasarela.
  constraint product_refunds_confirmada_se_pidio
    check (status not in ('processing', 'confirmed') or requested_at is not null),
  -- UN FALLO DICE POR QUE. Un `failed` sin codigo no le sirve a nadie.
  constraint product_refunds_fallida_con_motivo
    check ((status = 'failed') = (failure_code is not null))
);

-- UNA DEVOLUCION VIVA POR EXPEDIENTE. Dos serian el mismo dinero dos veces.
create unique index if not exists product_refunds_viva_por_expediente
  on public.product_refunds (incident_id)
  where incident_id is not null
    and status in ('approved', 'requested', 'processing', 'confirmed');

create index if not exists product_refunds_del_pedido
  on public.product_refunds (order_id, created_at desc);

create index if not exists product_refunds_por_atender
  on public.product_refunds (created_at, id)
  where status in ('approved', 'requested', 'processing');

-- ------------------------------------------------------------------------- --
-- 5. El historial de la devolucion. SOLO SE ANADE.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_refund_events (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null
    references public.product_refunds(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_role text not null,
  reason text
    constraint product_refund_events_motivo
    check (reason is null or length(reason) <= 500),
  -- LO QUE DIJO LA PASARELA, tal cual, para poder conciliar despues.
  provider_reference text,
  created_at timestamptz not null default now()
);

create index if not exists product_refund_events_de_la_devolucion
  on public.product_refund_events (refund_id, created_at);

-- ------------------------------------------------------------------------- --
-- 6. La disputa: expediente propio, no una marca en el saldo.
--
-- LA ABRE EL BANCO DE QUIEN COMPRO, se puede ganar, y quien asume la perdida no
-- esta decidido: bloquea el importe y avisa; no descuenta nada de ningun otro
-- saldo. Es la misma decision que tomo la 0068 para Eventos.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_disputes (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.product_orders(id) on delete restrict,
  balance_id uuid references public.owner_sale_balances(id) on delete restrict,

  -- LA REFERENCIA DE LA PASARELA. Es la identidad de la disputa: dos avisos del
  -- mismo contracargo tienen la misma, y por eso no se duplica.
  provider text not null,
  external_dispute_id text not null,

  amount_minor bigint not null
    constraint product_disputes_importe check (amount_minor > 0),
  currency char(3) not null
    constraint product_disputes_moneda check (currency ~ '^[A-Z]{3}$'),

  reason text,
  status text not null
    constraint product_disputes_estado check (status in (
      'open', 'needs_response', 'under_review', 'won', 'lost', 'withdrawn'
    )),

  opened_at timestamptz not null default now(),
  due_at timestamptz,
  closed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint product_disputes_cerrada_con_fecha
    check ((status in ('won', 'lost', 'withdrawn')) = (closed_at is not null))
);

create unique index if not exists product_disputes_referencia_unica
  on public.product_disputes (provider, external_dispute_id);

create index if not exists product_disputes_abiertas
  on public.product_disputes (order_id)
  where status in ('open', 'needs_response', 'under_review');

create table if not exists public.product_dispute_events (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null
    references public.product_disputes(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_role text not null,
  reason text
    constraint product_dispute_events_motivo
    check (reason is null or length(reason) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists product_dispute_events_de_la_disputa
  on public.product_dispute_events (dispute_id, created_at);

-- ------------------------------------------------------------------------- --
-- 7. LOS DOS HISTORIALES SOLO SE ANADEN, y lo imponen disparadores.
--
-- Es el registro de por que salio o no salio dinero. Es exactamente lo que se
-- mira cuando dos personas cuentan lo mismo de dos maneras, y el blueprint
-- §14.1 lo dice: «los registros financieros e incidencias no se eliminan; solo
-- se rectifican mediante eventos posteriores».
-- ------------------------------------------------------------------------- --
create or replace function public.product_finanzas_solo_se_anaden()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'El historial financiero no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists product_refund_events_inmutables on public.product_refund_events;
create trigger product_refund_events_inmutables
before update or delete on public.product_refund_events
for each row execute function public.product_finanzas_solo_se_anaden();

drop trigger if exists product_dispute_events_inmutables on public.product_dispute_events;
create trigger product_dispute_events_inmutables
before update or delete on public.product_dispute_events
for each row execute function public.product_finanzas_solo_se_anaden();

-- ------------------------------------------------------------------------- --
-- 8. RLS y permisos: cerrado. El movil pregunta por la API.
--
-- Aqui vive el dinero de un tercero. Una politica `for select` sobre esto
-- pondria importes, comisiones y referencias de pasarela a un `select` de
-- distancia desde cualquier telefono.
-- ------------------------------------------------------------------------- --
alter table public.product_refunds enable row level security;
alter table public.product_refund_events enable row level security;
alter table public.product_disputes enable row level security;
alter table public.product_dispute_events enable row level security;

revoke all on public.product_refunds from anon, authenticated;
revoke all on public.product_refund_events from anon, authenticated;
revoke all on public.product_disputes from anon, authenticated;
revoke all on public.product_dispute_events from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 9. Verificacion posterior.
-- ------------------------------------------------------------------------- --
do $$
declare
  permisos bigint;
  huerfanos bigint;
begin
  -- EL TERCER ORIGEN EXISTE Y ES UNA CLAVE AJENA DE VERDAD.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'owner_sale_balances'
       and column_name = 'product_order_id'
  ) then
    raise exception 'La 0082 no anadio product_order_id al saldo';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'owner_sale_balances_pedido_de_producto' and contype = 'f'
  ) then
    raise exception 'La 0082 no ato el saldo al pedido de producto';
  end if;

  -- Y EL CHECK ADMITE LAS TRES RAMAS, NO DOS NI CUATRO. Si se quedara en dos,
  -- ningun saldo de producto podria escribirse; si admitiera una fila sin
  -- origen, el dinero no sabria de que venta es.
  if not exists (
    select 1 from pg_constraint
     where conname = 'owner_sale_balances_un_origen'
       and pg_get_constraintdef(oid) like '%product_order_id IS NOT NULL%'
  ) then
    raise exception 'El CHECK del origen no admite un pedido de producto';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'owner_sale_balances_pedido_de_producto_unico'
  ) then
    raise exception 'La 0082 no dejo el indice de un saldo por pedido';
  end if;

  -- LA RESERVA ADMITE UN EXPEDIENTE DE PRODUCTO, Y SOLO UNO.
  if not exists (
    select 1 from pg_constraint where conname = 'owner_sale_reserves_un_expediente'
  ) then
    raise exception 'La 0082 no dejo el CHECK de un solo expediente';
  end if;

  -- EL EFECTO ADMITE EJECUTADO, y sigue admitiendo los dos de antes.
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_incidents_efecto'
       and pg_get_constraintdef(oid) like '%EXECUTED%'
       and pg_get_constraintdef(oid) like '%PENDING%'
       and pg_get_constraintdef(oid) like '%NOT_APPLICABLE%'
  ) then
    raise exception 'El CHECK del efecto no admite los tres valores';
  end if;

  -- LA CONFORMIDAD EXISTE Y NO SE PUEDE DAR SIN ENTREGA.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_shipments'
       and column_name = 'conformity_at'
  ) then
    raise exception 'La 0082 no anadio la conformidad al envio';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_shipments_conformidad_con_entrega'
  ) then
    raise exception 'Se podria dar conformidad de algo que no llego';
  end if;

  -- LAS CUATRO TABLAS NUEVAS.
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'product_refunds'
  ) then
    raise exception 'La 0082 no creo product_refunds';
  end if;
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'product_disputes'
  ) then
    raise exception 'La 0082 no creo product_disputes';
  end if;

  -- NI UN PORCENTAJE NI UN PLAZO DENTRO DE LA DEVOLUCION. Si aparecen, alguien
  -- metio una politica que nadie ha decidido.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_refunds'
       and column_name in (
         'refund_percent_bps', 'retention_days', 'return_shipping_payer',
         'platform_fee_minor'
       )
  ) then
    raise exception 'La devolucion no trae ninguna politica dentro';
  end if;

  -- Y EL IMPORTE NO TIENE VALOR POR DEFECTO: lo teclea una persona.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_refunds'
       and column_name = 'amount_minor'
       and column_default is not null
  ) then
    raise exception 'El importe de la devolucion tiene un valor por defecto';
  end if;

  -- LA CLAVE DE IDEMPOTENCIA ES UNICA. Sin esto, dos pulsaciones del mismo
  -- boton devuelven el dinero dos veces.
  if not exists (
    select 1 from pg_constraint where conname = 'product_refunds_clave_unica'
  ) then
    raise exception 'La 0082 no dejo la clave unica de la devolucion';
  end if;

  -- UNA DEVOLUCION VIVA POR EXPEDIENTE.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'product_refunds_viva_por_expediente'
  ) then
    raise exception 'La 0082 no dejo el indice de una devolucion viva';
  end if;

  -- LOS DOS HISTORIALES NO SE REESCRIBEN.
  if not exists (
    select 1 from pg_trigger
     where tgname = 'product_refund_events_inmutables' and not tgisinternal
  ) then
    raise exception 'La 0082 no dejo el disparador del historial de devoluciones';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgname = 'product_dispute_events_inmutables' and not tgisinternal
  ) then
    raise exception 'La 0082 no dejo el disparador del historial de disputas';
  end if;

  -- BACKFILL NINGUNO: ni un saldo de producto escrito por esta migracion.
  select count(*) into huerfanos
    from public.owner_sale_balances
   where product_order_id is not null;
  if huerfanos > 0 then
    raise exception
      'La 0082 no escribe saldos y hay %: sin comision configurada no se puede',
      huerfanos;
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in (
       'product_refunds', 'product_refund_events',
       'product_disputes', 'product_dispute_events'
     )
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Las finanzas de productos tienen % permisos sueltos', permisos;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------------------- --
-- 10. ROLLBACK, y su limite.
--
--   drop table public.product_dispute_events;
--   drop table public.product_disputes;
--   drop table public.product_refund_events;
--   drop table public.product_refunds;
--   drop function public.product_finanzas_solo_se_anaden();
--
-- Y SOLO DESPUES, si de verdad se quiere deshacer entero:
--
--   alter table public.owner_sale_reserves
--     drop constraint owner_sale_reserves_una_politica,
--     drop constraint owner_sale_reserves_un_expediente,
--     drop constraint owner_sale_reserves_politica_de_producto,
--     drop constraint owner_sale_reserves_expediente_de_producto,
--     drop column product_policy_id,
--     drop column product_incident_id;
--
-- DEVOLVER EL CHECK DEL ORIGEN A DOS RAMAS SOLO ES SEGURO SI NO SE ESCRIBIO
-- NINGUN SALDO DE PRODUCTO. Se comprueba antes:
--
--   select count(*) from public.owner_sale_balances
--    where product_order_id is not null;   -- tiene que dar 0
--
-- Y EL CHECK DEL EFECTO, IGUAL: volverlo a dos valores rompe cualquier
-- reclamacion que ya haya quedado en `EXECUTED`.
--
--   select count(*) from public.product_incidents
--    where financial_effect = 'EXECUTED';  -- tiene que dar 0
--
-- DESHACER ESTO NO DEVUELVE NINGUN DINERO NI LO RECLAMA. Una devolucion
-- confirmada por la pasarela ya salio: borrar su fila borra el unico registro
-- que hay de que salio, y la pasarela sigue diciendo lo contrario. Quien
-- revierta tiene que exportar `product_refunds` antes.
-- ------------------------------------------------------------------------- --
