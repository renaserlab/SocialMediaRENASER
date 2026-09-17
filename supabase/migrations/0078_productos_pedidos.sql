-- 0078 · El pedido físico de Productos: líneas congeladas, dirección y reserva.
--
-- AL APLICARLA, REINICIAR LA API. La puerta de esquema cachea tambien el «no»
-- en la memoria del proceso: sin reiniciar, las rutas siguen contestando 503
-- aunque las tablas ya esten.
--
-- SIN APLICAR. Requiere la 0070, la 0074, la 0075 y la 0077.
--
-- POR QUÉ PRODUCTOS TIENE SUS PROPIOS PEDIDOS:
--
--   * `orders` (0035) es de COMERCIO DIGITAL: lo que compra concede un derecho
--     —un curso— y no tiene unidades, ni almacén, ni a dónde enviarse.
--   * `event_orders` (0062) es de ENTRADAS: lo que aparta es aforo, y el aforo
--     no se empaqueta ni viaja.
--
--   Un producto físico tiene dirección, unidades que salen de una caja y una
--   entrega. Meterlo en cualquiera de las dos obligaría a que media tabla
--   estuviera nula según la fila, que es como se acaba enviando un curso.
--
-- LO QUE SÍ SE REUTILIZA, y por eso no hay tablas nuevas de pago: el adaptador
-- de Stripe, la verificación de firma, `payment_events` como barrera
-- anti-repetición y `payment_events.error` como cola de conciliación. Aquí solo
-- viven el pedido y su reserva.
--
-- LA RESERVA VIVE EN EL PEDIDO, NO EN UNA TABLA DE «HOLDS». Eventos necesita un
-- hold aparte porque se aparta aforo ANTES de existir el pedido; aquí el
-- carrito no reserva nada y la reserva nace exactamente con el pedido. Una
-- tabla más sería una tabla con una fila por pedido y la misma vida.
--
-- LO QUE APARTA DE VERDAD ES `product_inventory.reserved`, con su movimiento en
-- `inventory_movements`. `reserved_until` dice HASTA CUÁNDO, y
-- `reservation_settled_at` dice que ya se soltó o se consumió: es lo que hace
-- que liberar ocurra EXACTAMENTE UNA VEZ aunque lleguen a la vez el vencimiento
-- y una cancelación.
--
-- UN PEDIDO, UN PROVEEDOR. El blueprint no define checkout conjunto de varios
-- proveedores, y repartir un cobro entre varios sin que nadie lo haya decidido
-- es inventarse la liquidación. `seller_id` es `not null` y no hay ninguna
-- columna que admita dos: si el carrito mezcla, el servidor pide elegir.
--
-- LAS LÍNEAS NO SE TOCAN. No hay `update` de importes: lo impone el disparador
-- `product_order_items_inmutables`, igual que el del historial de inventario.
-- Un pedido cuyas líneas se pueden editar es un pedido cuyo total se puede
-- cambiar después de cobrarlo.
--
-- LA DIRECCIÓN SE CONGELA EN EL PEDIDO. No es una libreta de direcciones
-- reutilizable: es la dirección de ESTE envío. Editar la libreta después no
-- puede cambiar a dónde se mandó algo que ya salió.
--
-- LO QUE NO TRAE, Y ES DELIBERADO: transportista, guía, seguimiento, entrega,
-- conformidad de 72 horas, incidencia, devolución, garantía, reseña, saldo del
-- proveedor, comisión y transferencia. Son los Incrementos 6 a 9. Una columna
-- vacía «para luego» es una columna que alguien rellena con un cero.
--
-- ROLLBACK, en este orden:
--   drop table public.product_order_events;
--   drop table public.product_order_addresses;
--   drop table public.product_order_items;
--   drop table public.product_orders;
--   drop function public.product_order_items_solo_se_anaden();

-- ------------------------------------------------------------------------- --
-- 1. El pedido
-- ------------------------------------------------------------------------- --
create table if not exists public.product_orders (
  id uuid primary key default gen_random_uuid(),

  buyer_id uuid not null
    references public.profiles(id) on delete restrict,
  -- `restrict`: un proveedor con pedidos no se borra. Su ficha es lo que dice
  -- quién tiene que atenderlos.
  seller_id uuid not null
    references public.product_sellers(id) on delete restrict,

  status text not null default 'PENDING_PAYMENT'
    constraint product_orders_estado
    check (
      status in (
        'PENDING_PAYMENT',
        'PAYMENT_PROCESSING',
        'PAID',
        'PAYMENT_FAILED',
        'EXPIRED',
        'CANCELLED',
        'UNDER_REVIEW'
      )
    ),

  currency char(3) not null
    constraint product_orders_moneda check (currency ~ '^[A-Z]{3}$'),

  -- EN LA UNIDAD MENOR Y EN `bigint`. Nunca decimales: un flotante en dinero
  -- acaba en descuadre. El tope no es caprichoso: 2^53-1 es el último entero
  -- que JavaScript representa sin perder precisión, y este importe viaja en un
  -- JSON que lee JavaScript. Por encima, el cliente vería otro número.
  subtotal_minor bigint not null
    constraint product_orders_subtotal
    check (subtotal_minor >= 0 and subtotal_minor <= 9007199254740991),
  total_minor bigint not null
    constraint product_orders_total
    check (total_minor >= 0 and total_minor <= 9007199254740991),

  -- HOY `total = subtotal`. Impuestos, envío y comisión no están decididos, y
  -- un total distinto del subtotal sería un cargo inventado. El CHECK lo dice
  -- para que nadie pueda escribir uno sin quitarlo primero.
  constraint product_orders_total_es_el_subtotal check (total_minor = subtotal_minor),

  provider text not null default 'none'
    constraint product_orders_pasarela
    check (provider in ('none', 'stripe')),
  environment text not null
    constraint product_orders_entorno
    check (environment in ('sandbox', 'production')),
  external_payment_id text
    constraint product_orders_cobro
    check (external_payment_id is null or length(external_payment_id) <= 200),
  operation_ref text
    constraint product_orders_referencia
    check (operation_ref is null or length(operation_ref) <= 200),

  -- LA MISMA CLAVE NO CREA DOS PEDIDOS. Por comprador, que es quien la manda.
  idempotency_key text not null
    constraint product_orders_clave
    check (length(trim(idempotency_key)) between 1 and 200),
  -- LA HUELLA DEL CUERPO. Reutilizar la clave con otro pedido es un conflicto,
  -- no un «te devuelvo el anterior»: quien reintenta con otro contenido no está
  -- reintentando.
  request_fingerprint text not null
    constraint product_orders_huella check (request_fingerprint ~ '^[0-9a-f]{64}$'),

  -- QUÉ POLÍTICA ACEPTÓ, Y LA HUELLA DEL TEXTO. `restrict` porque una política
  -- citada por un pedido no se borra: sin ella, «aceptó la versión 3» no se
  -- puede leer. La huella permite demostrar que ese texto es el que era aunque
  -- alguien tocara la fila por debajo.
  policy_id uuid not null
    references public.product_policies(id) on delete restrict,
  policy_version integer not null
    constraint product_orders_politica_version check (policy_version >= 1),
  policy_terms_sha256 text not null
    constraint product_orders_politica_huella
    check (policy_terms_sha256 ~ '^[0-9a-f]{64}$'),
  policy_country char(2) not null
    constraint product_orders_politica_pais check (policy_country ~ '^[A-Z]{2}$'),
  policy_accepted_at timestamptz not null default now(),

  -- HASTA CUÁNDO APARTA. Lo pone el servidor con una duración que la empresa
  -- tiene que configurar: no hay número de fábrica, porque un número de fábrica
  -- es una decisión comercial tomada por un programador.
  reserved_until timestamptz,
  -- CUÁNDO DEJÓ DE APARTAR, por la razón que sea. Es la marca que hace que
  -- liberar ocurra UNA VEZ: quien la pone la pone con la fila bloqueada.
  reservation_settled_at timestamptz,

  paid_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  expired_at timestamptz,

  -- POR QUÉ ESTE PEDIDO NECESITA QUE LO MIRE UNA PERSONA. Solo con
  -- `UNDER_REVIEW`, y es el caso del pago que llega tarde: el dinero entró y la
  -- reserva ya no está. Ni se cobra en silencio ni se niega en silencio.
  review_reason text
    constraint product_orders_revision
    check (review_reason is null or length(trim(review_reason)) between 3 and 500),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint product_orders_una_clave unique (buyer_id, idempotency_key),

  -- UN PEDIDO PAGADO TIENE CON QUÉ DEMOSTRARLO. Sin esto, un `update` suelto
  -- podría dejar `PAID` sin cobro detrás, que es exactamente lo que un
  -- administrador no debe poder inventarse.
  constraint product_orders_pagada_con_cobro
    check (
      status <> 'PAID'
      or (
        paid_at is not null
        and external_payment_id is not null
        and provider <> 'none'
      )
    ),
  constraint product_orders_cancelada_con_fecha
    check (status <> 'CANCELLED' or cancelled_at is not null),
  constraint product_orders_vencida_con_fecha
    check (status <> 'EXPIRED' or expired_at is not null),
  constraint product_orders_fallida_con_fecha
    check (status <> 'PAYMENT_FAILED' or failed_at is not null),
  constraint product_orders_revision_con_motivo
    check (status <> 'UNDER_REVIEW' or review_reason is not null)
);

-- MIS PEDIDOS, los más nuevos primero.
create index if not exists product_orders_del_comprador
  on public.product_orders (buyer_id, created_at desc, id desc);

-- LOS DEL PROVEEDOR: solo ve los pagados, y los ve por aquí.
create index if not exists product_orders_del_proveedor
  on public.product_orders (seller_id, created_at desc, id desc)
  where status = 'PAID';

-- LO QUE BUSCA EL VENCIMIENTO: toda reserva que no se haya decidido todavía.
--
-- POR LA RESERVA Y NO POR EL ESTADO. Restringirlo a los dos estados «en curso»
-- dejaba fuera los pedidos fallidos y los que esperan a una persona, que son
-- exactamente los que se quedaban con las unidades apartadas sin que nadie las
-- soltara nunca. `PAID` sí se excluye: al cobrar, la reserva se consume y
-- `reservation_settled_at` queda puesto, así que no aparecería igualmente.
create index if not exists product_orders_por_vencer
  on public.product_orders (reserved_until, id)
  where reservation_settled_at is null and status <> 'PAID';

-- CRUZAR UN AVISO DE STRIPE CON SU PEDIDO. `provider` primero porque es la
-- primera columna del índice y sin ella PostgreSQL no puede buscar.
create index if not exists product_orders_por_cobro
  on public.product_orders (provider, environment, external_payment_id)
  where external_payment_id is not null;

-- LA COLA DE CONCILIACIÓN: lo que una persona tiene que mirar.
create index if not exists product_orders_en_revision
  on public.product_orders (created_at desc, id desc)
  where status = 'UNDER_REVIEW';

-- ------------------------------------------------------------------------- --
-- 2. Las líneas, congeladas
-- ------------------------------------------------------------------------- --
create table if not exists public.product_order_items (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.product_orders(id) on delete cascade,

  -- `restrict` en los tres: un producto, una versión o una variante que alguien
  -- compró no se borran. Lo comprado tiene que seguir siendo legible.
  product_id uuid not null
    references public.products(id) on delete restrict,
  version_id uuid not null
    references public.product_versions(id) on delete restrict,
  variant_id uuid not null
    references public.product_variants(id) on delete restrict,

  -- EL SKU ES LA UNIDAD DE ALMACÉN, y por eso se copia aquí: la variante
  -- pertenece a una versión inmutable, pero la caja del almacén es la misma
  -- entre publicaciones. Es la columna con la que se reserva y se despacha.
  sku text not null
    constraint product_order_items_sku
    check (length(trim(sku)) between 1 and 48),

  -- LO QUE SE ENSEÑÓ, copiado. Releer el nombre o el precio al pintar el
  -- histórico haría que un pedido de hace un mes cambiara de contenido cuando
  -- el proveedor republica.
  name_snapshot text not null
    constraint product_order_items_nombre
    check (length(trim(name_snapshot)) between 1 and 300),
  variant_name_snapshot text
    constraint product_order_items_variante
    check (variant_name_snapshot is null or length(variant_name_snapshot) <= 300),

  unit_price_minor bigint not null
    constraint product_order_items_precio
    check (unit_price_minor >= 0 and unit_price_minor <= 9007199254740991),
  quantity integer not null
    constraint product_order_items_cantidad
    check (quantity >= 1 and quantity <= 1000),
  subtotal_minor bigint not null
    constraint product_order_items_subtotal
    check (subtotal_minor >= 0 and subtotal_minor <= 9007199254740991),

  created_at timestamptz not null default now(),

  -- UNA LÍNEA POR UNIDAD COMPRADA. La misma variante dos veces en el mismo
  -- pedido sería la misma línea con más cantidad.
  constraint product_order_items_una_linea
    unique (order_id, product_id, version_id, variant_id)
);

create index if not exists product_order_items_del_pedido
  on public.product_order_items (order_id, created_at, id);

-- QUÉ SE VENDIÓ DE CADA UNIDAD DE ALMACÉN. Lo necesita el proveedor para
-- preparar, y el vencimiento para saber qué soltar.
create index if not exists product_order_items_de_la_unidad
  on public.product_order_items (product_id, sku);

-- ------------------------------------------------------------------------- --
-- 3. La dirección de ESTE envío
-- ------------------------------------------------------------------------- --
create table if not exists public.product_order_addresses (
  -- UNA POR PEDIDO, y la clave primaria lo dice. No es una libreta.
  order_id uuid primary key
    references public.product_orders(id) on delete cascade,

  recipient_name text not null
    constraint product_order_addresses_nombre
    check (length(trim(recipient_name)) between 2 and 150),
  phone text not null
    constraint product_order_addresses_telefono
    check (length(trim(phone)) between 5 and 30),

  country_code char(2) not null
    constraint product_order_addresses_pais check (country_code ~ '^[A-Z]{2}$'),
  region text not null
    constraint product_order_addresses_region
    check (length(trim(region)) between 1 and 120),
  city text not null
    constraint product_order_addresses_ciudad
    check (length(trim(city)) between 1 and 120),
  -- DISTRITO: obligatorio donde la dirección no se entiende sin él, y eso lo
  -- decide el servidor por país. La base solo acota la longitud.
  district text
    constraint product_order_addresses_distrito
    check (district is null or length(trim(district)) between 1 and 120),

  address_line text not null
    constraint product_order_addresses_calle
    check (length(trim(address_line)) between 5 and 300),
  reference text
    constraint product_order_addresses_referencia
    check (reference is null or length(reference) <= 300),
  postal_code text
    constraint product_order_addresses_codigo
    check (postal_code is null or length(trim(postal_code)) between 2 and 20),
  instructions text
    constraint product_order_addresses_indicaciones
    check (instructions is null or length(instructions) <= 500),

  created_at timestamptz not null default now()

  -- NI LATITUD NI LONGITUD. Una coordenada es la ubicación exacta de la casa de
  -- alguien; para entregar un paquete basta la dirección escrita. Guardar lo
  -- que no hace falta es guardar lo que se puede filtrar.
);

-- ------------------------------------------------------------------------- --
-- 4. El historial de estados
-- ------------------------------------------------------------------------- --
create table if not exists public.product_order_events (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.product_orders(id) on delete restrict,

  from_status text
    constraint product_order_events_desde
    check (from_status is null or length(from_status) <= 40),
  to_status text not null
    constraint product_order_events_hasta
    check (length(to_status) <= 40),

  -- SIN CLAVE AJENA: quién movió un pedido es un hecho del pasado.
  actor_id uuid,
  actor_role text not null
    constraint product_order_events_rol
    check (actor_role in ('buyer', 'seller', 'admin', 'system')),

  reason text
    constraint product_order_events_motivo
    check (reason is null or length(trim(reason)) <= 500),

  created_at timestamptz not null default now()

  -- NADA DE DATOS PERSONALES AQUÍ. Ni nombre, ni teléfono, ni dirección: el
  -- historial se lee para auditar un estado, no para recomponer a quién se le
  -- mandó qué.
);

create index if not exists product_order_events_del_pedido
  on public.product_order_events (order_id, created_at, id);

-- ------------------------------------------------------------------------- --
-- 5. Lo que se escribe no se reescribe
-- ------------------------------------------------------------------------- --
-- LAS LÍNEAS Y EL HISTORIAL SOLO SE AÑADEN. Es la misma protección que el
-- historial de inventario y por la misma razón: un importe que se puede editar
-- después de cobrarlo no es un importe, es una propuesta. Borrar el pedido
-- entero sí arrastra sus líneas —`on delete cascade`—, y eso es otra cosa: no
-- queda media verdad.
create or replace function public.product_order_items_solo_se_anaden()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Las líneas de un pedido solo se añaden: % no está permitido', tg_op;
end;
$$;

drop trigger if exists product_order_items_inmutables on public.product_order_items;
create trigger product_order_items_inmutables
  before update on public.product_order_items
  for each row execute function public.product_order_items_solo_se_anaden();

drop trigger if exists product_order_events_inmutables on public.product_order_events;
create trigger product_order_events_inmutables
  before update or delete on public.product_order_events
  for each row execute function public.product_order_items_solo_se_anaden();

-- ------------------------------------------------------------------------- --
-- 6. RLS y permisos
-- ------------------------------------------------------------------------- --
-- Ninguna política y ningún permiso suelto. Los importes los calcula el
-- servidor y las direcciones no las ve nadie más que quien compra, quien tiene
-- que entregar y una revisión auditada: una política de lectura sobre estas
-- tablas sería repartir domicilios.
alter table public.product_orders enable row level security;
alter table public.product_order_items enable row level security;
alter table public.product_order_addresses enable row level security;
alter table public.product_order_events enable row level security;

revoke all on public.product_orders from anon, authenticated;
revoke all on public.product_order_items from anon, authenticated;
revoke all on public.product_order_addresses from anon, authenticated;
revoke all on public.product_order_events from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 7. Verificación
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  permisos bigint;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array[
      'product_orders', 'product_order_items',
      'product_order_addresses', 'product_order_events'
    ]) as t
   where not exists (
     select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
   );
  if faltan is not null then
    raise exception 'La 0078 no dejó estas tablas: %', faltan;
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.product_order_items'::regclass
       and tgname = 'product_order_items_inmutables'
  ) then
    raise exception 'La 0078 no dejó el disparador que congela las líneas';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'product_orders_pagada_con_cobro'
  ) then
    raise exception 'La 0078 no dejó el CHECK que exige cobro para pagar';
  end if;

  -- NI COORDENADAS NI DOCUMENTO DE IDENTIDAD EN LA DIRECCIÓN. Si aparecen, es
  -- que alguien amplió el alcance sin decirlo.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_order_addresses'
       and column_name in ('latitude', 'longitude', 'geo', 'document_number')
  ) then
    raise exception 'La dirección de entrega no guarda ubicación exacta';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in (
       'product_orders', 'product_order_items',
       'product_order_addresses', 'product_order_events'
     )
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Los pedidos tienen % permisos sueltos', permisos;
  end if;
end;
$$;

notify pgrst, 'reload schema';
