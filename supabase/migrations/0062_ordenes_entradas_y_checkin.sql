-- 0062 · Órdenes de evento, entradas emitidas y check-in.
--
-- SIN APLICAR. Y detrás de banderas: `FEATURE_EVENT_TICKETING` sigue apagada y
-- `FEATURE_EVENT_PAYMENTS` nace apagada aparte. Con el esquema puesto y las dos
-- banderas apagadas, estas cuatro tablas existen vacías y nada las escribe.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE. Código antes que esquema: las rutas
-- nuevas responden 503 `event_orders_not_available` y todo lo anterior
-- —catálogo, ficha, reserva gratuita, tipos de entrada, reservas temporales—
-- funciona exactamente igual. Esquema antes que código: cuatro tablas que nadie
-- lee todavía, sin una sola fila.
--
-- AQUÍ TAMPOCO SE COBRA NADA POR SÍ SOLO. Esta migración crea el sitio donde
-- anotar una compra; quien decide que hubo un cobro es el webhook verificado
-- del proveedor, y el proveedor está apagado. Una orden gratuita —total cero—
-- sí se confirma sin proveedor, y es el único camino que emite entradas hoy.
--
-- LO QUE LA BASE SOSTIENE, y no un `if` de Python:
--
--   * UNA ORDEN POR RESERVA. `unique (hold_id)`. Dos peticiones a la vez sobre
--     el mismo hold no crean dos órdenes aunque las dos pasen la comprobación.
--   * LA ORDEN Y SU RESERVA SON DEL MISMO EVENTO, DEL MISMO COMPRADOR Y EN LA
--     MISMA MONEDA. Una sola clave ajena COMPUESTA de cuatro columnas, en vez
--     de tres comparaciones que hay que acordarse de escribir.
--   * UNA REFERENCIA DEL PROVEEDOR NO CONFIRMA DOS ÓRDENES. Índice único
--     parcial sobre `(provider, environment, external_payment_id)`.
--   * UNA ORDEN PAGADA CON PROVEEDOR TIENE EVIDENCIA. `PAID` con proveedor y
--     sin identificador externo no entra.
--   * EL TOTAL CUADRA CON SUS LÍNEAS, y una orden tiene al menos una. Es una
--     restricción entre filas: disparador DIFERIDO, comprobado al confirmar.
--   * SE EMITEN EXACTAMENTE LAS ENTRADAS COMPRADAS. También diferido, y solo
--     cuando la orden está `PAID`: antes de pagar no hay ninguna que contar.
--   * UNA ENTRADA SE USA UNA VEZ. Índice único parcial sobre el check-in
--     correcto: `where result = 'OK'`. Dos lectores escaneando a la vez pasan
--     los dos por cualquier `if`; por el índice pasa uno.
--   * LA CREDENCIAL NO SE GUARDA. Se guarda su `sha256`. Quien lea la tabla no
--     puede fabricar un QR con lo que ve.
--
-- BACKFILL: NINGUNO, y se declara. No hay ninguna orden anterior que traer: el
-- Incremento 2 no cobra, así que no existe una sola compra de evento. Escribir
-- filas aquí sería inventarse ventas.
--
-- ROLLBACK REALISTA:
--   drop trigger if exists event_order_items_emitidas on public.event_order_items;
--   drop trigger if exists event_tickets_emitidas on public.event_tickets;
--   drop trigger if exists event_orders_emitidas on public.event_orders;
--   drop trigger if exists event_order_items_cuadran on public.event_order_items;
--   drop trigger if exists event_orders_cuadran on public.event_orders;
--   drop function if exists public.exigir_que_la_orden_cuadre();
--   drop function if exists public.exigir_las_entradas_emitidas();
--   drop table if exists public.event_checkins;
--   drop table if exists public.event_tickets;
--   drop table if exists public.event_order_items;
--   drop table if exists public.event_orders;
--   alter table public.event_ticket_holds
--     drop constraint if exists event_ticket_holds_de_su_dueno;
-- Ninguna toca nada anterior, así que deshacerla devuelve la base al estado de
-- la 0061 sin perder un evento, una reserva ni una decisión de admisión.

-- ------------------------------------------------------------------------- --
-- 0. La pareja que la orden necesita referenciar.
-- ------------------------------------------------------------------------- --
-- ADITIVA SOBRE LA 0061, que no se toca. Un `unique` sobre un superconjunto de
-- la clave primaria no puede fallar nunca —`id` ya es único—, así que ponerlo
-- es gratis y sin riesgo. Existe para que la orden pueda heredar evento,
-- comprador y moneda de su reserva por clave ajena en vez de por comparación.
-- SE AÑADE SI NO ESTÁ, y no se borra para volver a ponerla: la clave ajena de
-- `event_orders` depende de esta restricción, y un `drop` en la segunda pasada
-- falla —«other objects depend on it»— justo cuando alguien reejecuta la
-- migración para comprobar que es reejecutable.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_ticket_holds'
      and c.conname = 'event_ticket_holds_de_su_dueno'
  ) then
    alter table public.event_ticket_holds
      add constraint event_ticket_holds_de_su_dueno
      unique (id, event_id, user_id, currency);
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 1. La orden. La intención comercial nacida de una reserva vigente.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_orders (
  id uuid primary key default gen_random_uuid(),

  event_id uuid not null references public.events(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,

  -- `restrict`: la reserva es la prueba de qué se apartó y a qué precio. Una
  -- orden sin su reserva no se puede conciliar.
  hold_id uuid not null references public.event_ticket_holds(id) on delete restrict,

  status text not null default 'PENDING_PAYMENT'
    constraint event_orders_estado
    check (status in (
      'PENDING_PAYMENT',
      'PAYMENT_PROCESSING',
      'PAID',
      'PAYMENT_FAILED',
      'EXPIRED',
      'CANCELLED'
    )),

  currency char(3) not null
    constraint event_orders_moneda check (currency ~ '^[A-Z]{3}$'),

  -- EN UNIDAD MENOR Y `bigint`, como en la 0061 y por la misma razón: el
  -- disparador suma líneas, y `int4` se desborda antes de lo que parece.
  subtotal_minor bigint not null
    constraint event_orders_subtotal check (subtotal_minor >= 0),
  -- HOY `total = subtotal`. La columna existe aparte porque comisión e
  -- impuestos son un incremento posterior y cuando lleguen suman por encima;
  -- el CHECK dice justo eso y no que hoy sean cero.
  total_minor bigint not null
    constraint event_orders_total check (total_minor >= subtotal_minor),

  -- `none` es una orden gratuita: no hay pasarela detrás y no la habrá.
  provider text not null default 'none'
    constraint event_orders_proveedor check (provider in ('none', 'stripe')),
  environment text not null default 'sandbox'
    constraint event_orders_entorno check (environment in ('sandbox', 'production')),

  -- El identificador REAL del cobro en la pasarela. Nunca uno derivado.
  external_payment_id text
    constraint event_orders_referencia
    check (external_payment_id is null or length(trim(external_payment_id)) > 0),
  -- La clave que se le manda a la pasarela para que un reintento nuestro no
  -- abra dos cobros. Determinista, y no cambia entre reintentos.
  operation_ref text,

  idempotency_key text not null
    constraint event_orders_clave check (length(trim(idempotency_key)) between 1 and 128),
  -- La huella del pedido, para distinguir un reintento de la MISMA petición de
  -- un intento distinto que reutiliza la clave. Misma idea que en los holds.
  request_fingerprint text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  cancelled_at timestamptz,

  -- LAS FECHAS DICEN LO MISMO QUE EL ESTADO. Una orden `PAID` sin `paid_at` no
  -- se puede conciliar, y una con `paid_at` que no está pagada es peor.
  constraint event_orders_pagada_con_fecha
    check ((status = 'PAID') = (paid_at is not null)),
  constraint event_orders_cerrada_con_fecha
    check ((status in ('CANCELLED', 'EXPIRED')) = (cancelled_at is not null)),

  -- UNA ORDEN PAGADA CON PASARELA TIENE EVIDENCIA. Sin esto, un camino que se
  -- equivoque puede marcar `PAID` sin haber visto nunca un cobro.
  constraint event_orders_pago_con_evidencia
    check (status <> 'PAID' or provider = 'none' or external_payment_id is not null),
  -- Y una orden gratuita no lleva referencia de una pasarela que no se usó.
  constraint event_orders_gratuita_sin_referencia
    check (provider <> 'none' or external_payment_id is null),

  -- UNA ORDEN POR RESERVA. Es la barrera contra dos órdenes simultáneas sobre
  -- el mismo hold: las dos pasan cualquier comprobación previa, por aquí pasa
  -- una. Reintentar el pago es volver sobre ESTA orden, no crear otra.
  constraint event_orders_una_por_reserva unique (hold_id),

  -- Una clave de idempotencia no significa dos cosas para la misma persona.
  constraint event_orders_clave_unica unique (event_id, buyer_id, idempotency_key),

  -- Las parejas que las líneas y las entradas referencian.
  constraint event_orders_de_su_evento unique (id, event_id)
);

-- LA ORDEN HEREDA DE SU RESERVA, POR CLAVE AJENA. Evento, comprador y moneda
-- salen de la misma fila que se apartó: no hay forma de crear una orden a
-- nombre de otro, sobre otro evento, ni en otra divisa.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_orders'
      and c.conname = 'event_orders_de_su_reserva'
  ) then
    alter table public.event_orders
      add constraint event_orders_de_su_reserva
      foreign key (hold_id, event_id, buyer_id, currency)
      references public.event_ticket_holds (id, event_id, user_id, currency)
      on delete restrict;
  end if;
end;
$$;

-- UNA REFERENCIA DE LA PASARELA NO CONFIRMA DOS ÓRDENES. Parcial: las órdenes
-- sin cobro —gratuitas, o pendientes— no compiten por este índice.
create unique index if not exists event_orders_referencia_unica
  on public.event_orders (provider, environment, external_payment_id)
  where external_payment_id is not null;

create index if not exists event_orders_del_comprador
  on public.event_orders (buyer_id, created_at desc, id desc);
create index if not exists event_orders_del_evento
  on public.event_orders (event_id, status, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 2. Las líneas de la orden. Copia comercial, no referencia viva.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_order_items (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null references public.event_orders(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  ticket_type_id uuid not null,

  -- CONGELADO. El organizador puede renombrar o retirar el tipo después, y lo
  -- que se compró tiene que seguir diciendo lo mismo dentro de diez meses.
  ticket_type_name_snapshot text not null
    constraint event_order_items_nombre
    check (length(trim(ticket_type_name_snapshot)) between 1 and 80),

  unit_price_minor bigint not null
    constraint event_order_items_precio check (unit_price_minor >= 0),
  quantity integer not null
    constraint event_order_items_cantidad check (quantity > 0),
  subtotal_minor bigint not null
    constraint event_order_items_subtotal check (subtotal_minor >= 0),

  created_at timestamptz not null default now(),

  -- `subtotal = cantidad × precio`. El `::bigint` no es decorativo: sin él la
  -- multiplicación se hace en `int4` y desborda con cifras que sí caben en las
  -- columnas.
  constraint event_order_items_cuadra
    check (subtotal_minor = quantity::bigint * unit_price_minor),

  -- Dos líneas del mismo tipo son dos formas de decir lo mismo.
  constraint event_order_items_un_tipo unique (order_id, ticket_type_id),
  -- La pareja que las entradas referencian.
  constraint event_order_items_de_su_orden unique (id, order_id),

  -- LA LÍNEA ES DEL MISMO EVENTO QUE SU ORDEN.
  constraint event_order_items_del_evento_de_la_orden
    foreign key (order_id, event_id)
    references public.event_orders (id, event_id)
    on delete cascade,

  -- Y EL TIPO ES DE ESE EVENTO. Misma clave compuesta que usan las líneas de
  -- reserva en la 0061. `restrict`: un tipo con ventas no se borra.
  constraint event_order_items_del_evento
    foreign key (event_id, ticket_type_id)
    references public.event_ticket_types (event_id, id)
    on delete restrict
);

create index if not exists event_order_items_de_la_orden
  on public.event_order_items (order_id);

-- ------------------------------------------------------------------------- --
-- 3. Las entradas emitidas. Una fila por entrada.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_tickets (
  id uuid primary key default gen_random_uuid(),

  event_id uuid not null references public.events(id) on delete cascade,
  order_id uuid not null references public.event_orders(id) on delete cascade,
  order_item_id uuid not null references public.event_order_items(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  ticket_type_id uuid not null,
  ticket_type_name_snapshot text not null
    constraint event_tickets_nombre
    check (length(trim(ticket_type_name_snapshot)) between 1 and 80),

  -- EL CÓDIGO QUE SE TECLEA cuando la cámara no funciona. Corto, legible y NO
  -- secuencial. No sirve por sí solo para entrar: la credencial es la de abajo.
  code text not null
    constraint event_tickets_codigo check (code ~ '^[A-Z0-9]{10,24}$'),

  -- LA CREDENCIAL NO SE GUARDA: se guarda su `sha256` en hexadecimal. El valor
  -- en claro se le entrega una vez a quien compró, viaja dentro del QR y no
  -- vuelve a existir en el servidor. Quien consiga leer esta tabla —una copia
  -- de seguridad, un volcado, una consulta de más— no puede fabricar un QR con
  -- lo que ve. Guardar el secreto en claro convierte cada respaldo en un juego
  -- completo de entradas.
  credential_hash text not null
    constraint event_tickets_credencial check (credential_hash ~ '^[0-9a-f]{64}$'),

  status text not null default 'VALID'
    constraint event_tickets_estado check (status in ('VALID', 'USED', 'REVOKED')),

  issued_at timestamptz not null default now(),
  checked_in_at timestamptz,
  checked_in_by uuid references public.profiles(id) on delete set null,
  revoked_at timestamptz,
  revoked_reason text
    constraint event_tickets_motivo
    check (revoked_reason is null or length(revoked_reason) <= 200),

  -- EL ESTADO Y LAS FECHAS DICEN LO MISMO. Una entrada `USED` sin hora de
  -- entrada no sirve para nada operativo, y una con hora que sigue `VALID`
  -- vuelve a dejar pasar a quien ya entró.
  constraint event_tickets_usada_con_fecha
    check ((status = 'USED') = (checked_in_at is not null)),
  constraint event_tickets_revocada_con_fecha
    check ((status = 'REVOKED') = (revoked_at is not null)),

  constraint event_tickets_codigo_unico unique (code),
  constraint event_tickets_credencial_unica unique (credential_hash),

  -- LA ENTRADA ES DE SU ORDEN Y DE SU EVENTO, por clave ajena y no por
  -- comparación: una entrada del evento equivocado no entra.
  constraint event_tickets_del_evento_de_la_orden
    foreign key (order_id, event_id)
    references public.event_orders (id, event_id)
    on delete cascade,
  constraint event_tickets_de_su_linea
    foreign key (order_item_id, order_id)
    references public.event_order_items (id, order_id)
    on delete cascade,
  constraint event_tickets_del_evento
    foreign key (event_id, ticket_type_id)
    references public.event_ticket_types (event_id, id)
    on delete restrict
);

create index if not exists event_tickets_de_quien_compro
  on public.event_tickets (owner_id, issued_at desc, id desc);
create index if not exists event_tickets_del_evento
  on public.event_tickets (event_id, status, issued_at desc, id desc);
create index if not exists event_tickets_de_la_linea
  on public.event_tickets (order_item_id);

-- ------------------------------------------------------------------------- --
-- 4. El historial de check-in.
-- ------------------------------------------------------------------------- --
-- POR QUÉ UNA TABLA Y NO LA AUDITORÍA COMPARTIDA. La auditoría guarda el hecho
-- en un `payload` JSON, y eso sirve para investigar pero no para la pantalla
-- que la puerta necesita: «quién ha entrado, a qué hora, de qué tipo», paginado
-- y filtrado, sin abrir un JSON por fila. Y hace falta una INVARIANTE —un solo
-- check-in correcto por entrada— que un `payload` no puede sostener. La
-- auditoría se escribe ADEMÁS, para lo que es: el rastro de quién hizo qué.
create table if not exists public.event_checkins (
  id uuid primary key default gen_random_uuid(),

  -- Anulable a propósito: un intento con una credencial inexistente también se
  -- registra, y no tiene entrada a la que apuntar.
  ticket_id uuid references public.event_tickets(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  operator_id uuid references public.profiles(id) on delete set null,

  result text not null
    constraint event_checkins_resultado
    check (result in (
      'OK',
      'ALREADY_USED',
      'REVOKED',
      'NOT_FOUND',
      'WRONG_EVENT',
      'NOT_ADMITTING'
    )),
  reason text
    constraint event_checkins_motivo
    check (reason is null or length(reason) <= 200),

  created_at timestamptz not null default now()
);

-- UNA ENTRADA SE USA UNA VEZ, y lo dice la base. Dos lectores escaneando el
-- mismo QR en el mismo segundo pasan los dos por cualquier comprobación
-- previa; por este índice pasa uno. Parcial: los intentos rechazados se
-- registran todos, que es justo lo que hay que poder mirar después.
create unique index if not exists event_checkins_uno_correcto
  on public.event_checkins (ticket_id)
  where result = 'OK';

create index if not exists event_checkins_del_evento
  on public.event_checkins (event_id, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 5. El total cuadra con sus líneas, y una orden tiene al menos una.
-- ------------------------------------------------------------------------- --
-- Misma forma que el disparador de la 0061, y por la misma razón: es una
-- restricción ENTRE FILAS, así que no cabe en un CHECK y se comprueba al
-- CONFIRMAR, cuando la cabecera y todas sus líneas ya están escritas.
create or replace function public.exigir_que_la_orden_cuadre()
returns trigger
language plpgsql
as $$
declare
  objetivo uuid;
  suma bigint;
  cabecera bigint;
  lineas integer;
begin
  if TG_TABLE_NAME = 'event_orders' then
    objetivo := new.id;
  elsif TG_OP = 'DELETE' then
    objetivo := old.order_id;
  else
    objetivo := new.order_id;
  end if;

  select subtotal_minor into cabecera
  from public.event_orders where id = objetivo;

  -- La cabecera puede haberse borrado en la misma transacción (cascada).
  if cabecera is null then
    return null;
  end if;

  select count(*), coalesce(sum(subtotal_minor), 0) into lineas, suma
  from public.event_order_items where order_id = objetivo;

  if lineas = 0 then
    raise exception 'Una orden sin lineas no compra nada'
      using errcode = 'check_violation';
  end if;

  if suma <> cabecera then
    raise exception
      'El subtotal de la orden (%) no cuadra con sus lineas (%)', cabecera, suma
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists event_order_items_cuadran on public.event_order_items;
create constraint trigger event_order_items_cuadran
after insert or update or delete on public.event_order_items
deferrable initially deferred
for each row execute function public.exigir_que_la_orden_cuadre();

-- Sobre la cabecera, y solo cuando cambia el subtotal: una orden que pasa a
-- `PAID` no tiene por qué revalidar sus líneas, y reescribir el subtotal sin
-- tocarlas era la otra forma de descuadrar sin que nadie mirase.
drop trigger if exists event_orders_cuadran on public.event_orders;
create constraint trigger event_orders_cuadran
after insert or update of subtotal_minor on public.event_orders
deferrable initially deferred
for each row execute function public.exigir_que_la_orden_cuadre();

-- ------------------------------------------------------------------------- --
-- 6. Se emiten exactamente las entradas compradas.
-- ------------------------------------------------------------------------- --
-- SOLO CUANDO LA ORDEN ESTÁ `PAID`. Antes de pagar no hay ninguna entrada que
-- contar y la orden es perfectamente válida sin ellas; después, que falte una o
-- sobre una es una diferencia entre lo que alguien pagó y lo que puede usar.
-- Diferido: la orden se marca pagada y las entradas se insertan en la misma
-- transacción, y el orden entre esas dos cosas no debería importar.
create or replace function public.exigir_las_entradas_emitidas()
returns trigger
language plpgsql
as $$
declare
  objetivo uuid;
  estado text;
  compradas bigint;
  emitidas bigint;
begin
  if TG_TABLE_NAME = 'event_orders' then
    objetivo := new.id;
  elsif TG_OP = 'DELETE' then
    objetivo := old.order_id;
  else
    objetivo := new.order_id;
  end if;

  select status into estado from public.event_orders where id = objetivo;
  if estado is null or estado <> 'PAID' then
    return null;
  end if;

  select coalesce(sum(quantity), 0) into compradas
  from public.event_order_items where order_id = objetivo;

  select count(*) into emitidas
  from public.event_tickets where order_id = objetivo;

  if emitidas <> compradas then
    raise exception
      'La orden pagada tiene % entradas compradas y % emitidas', compradas, emitidas
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

-- `update of order_id` y no `update` a secas: un check-in cambia el estado de la
-- entrada y no tiene nada que revalidar aqui, y son tres consultas por fila.
drop trigger if exists event_tickets_emitidas on public.event_tickets;
create constraint trigger event_tickets_emitidas
after insert or delete or update of order_id on public.event_tickets
deferrable initially deferred
for each row execute function public.exigir_las_entradas_emitidas();

-- Y SOBRE LAS LÍNEAS. Cambiar la cantidad de una línea de una orden ya `PAID`
-- movía lo comprado sin mover lo emitido, y en una orden gratuita el disparador
-- del cuadre tampoco protestaba porque el subtotal no cambia.
drop trigger if exists event_order_items_emitidas on public.event_order_items;
create constraint trigger event_order_items_emitidas
after insert or delete or update of quantity on public.event_order_items
deferrable initially deferred
for each row execute function public.exigir_las_entradas_emitidas();

drop trigger if exists event_orders_emitidas on public.event_orders;
create constraint trigger event_orders_emitidas
after insert or update of status on public.event_orders
deferrable initially deferred
for each row execute function public.exigir_las_entradas_emitidas();

-- ------------------------------------------------------------------------- --
-- 7. RLS y concesiones. Nacen cerradas, como manda la 0053.
-- ------------------------------------------------------------------------- --
alter table public.event_orders enable row level security;
alter table public.event_order_items enable row level security;
alter table public.event_tickets enable row level security;
alter table public.event_checkins enable row level security;

revoke all on public.event_orders from anon, authenticated;
revoke all on public.event_order_items from anon, authenticated;
revoke all on public.event_tickets from anon, authenticated;
revoke all on public.event_checkins from anon, authenticated;

-- NINGUNA POLÍTICA, y aquí menos que en ninguna otra tabla del módulo. Esto es
-- dinero y es acceso a un recinto: una política `for select` sobre
-- `event_tickets` pondría la credencial —aunque sea su hash— y el histórico de
-- compras de otras personas a un `select` de distancia desde el teléfono. El
-- móvil no lee estas tablas: pregunta por la API, que además de comprobar quién
-- pregunta decide qué campos devuelve.

-- ------------------------------------------------------------------------- --
-- 8. Backfill: ninguno, y se comprueba.
-- ------------------------------------------------------------------------- --
do $$
declare
  cuantas bigint;
begin
  select
      (select count(*) from public.event_orders)
    + (select count(*) from public.event_order_items)
    + (select count(*) from public.event_tickets)
    + (select count(*) from public.event_checkins)
  into cuantas;

  if cuantas > 0 then
    -- Sin `errcode`: el nombre que se le pondria no es un SQLSTATE valido y el
    -- mensaje ya dice exactamente que pasa.
    raise exception 'La 0062 no escribe ninguna fila y hay %: algo mas las puso', cuantas;
  end if;
end;
$$;
