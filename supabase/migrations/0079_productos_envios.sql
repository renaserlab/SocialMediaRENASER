-- 0079 · El envío de un pedido pagado: preparación, despacho y entrega.
--
-- AL APLICARLA, REINICIAR LA API. La puerta de esquema cachea tambien el «no»
-- en la memoria del proceso: sin reiniciar, las rutas siguen contestando 503
-- aunque las tablas ya esten.
--
-- SIN APLICAR. Requiere la 0070, la 0074 y la 0078.
--
-- POR QUE UNA TABLA APARTE Y NO MAS VALORES EN `product_orders.status`:
--
--   Un pedido tiene cinco cosas que cambian por su cuenta —pedido, pago,
--   envio, incidencia y dinero— y meterlas en un solo enum obliga a inventar
--   valores como `PAID_PREPARING_WITH_INCIDENT`: el numero de valores crece
--   multiplicando en vez de sumando, y al escribir uno se pierde el otro. Un
--   pedido que pasa a «despachado» no deja de estar pagado.
--
--   `product_orders.status` sigue significando donde esta el COBRO y esta
--   migracion NO LE ANADE NI UN VALOR. El envio vive aqui, con su maquina y su
--   historial propios.
--
-- UNA FILA POR PEDIDO, y la clave primaria lo dice. No hay envios parciales:
--   repartir un pedido en dos paquetes obliga a decidir quien paga el segundo
--   porte y que pasa con lo que no salio, y ninguna politica publicada lo dice.
--   Mientras no exista esa decision, un paquete sale entero o no sale.
--
-- LA FILA NACE TARDE, a proposito. No se crea al cobrar: se crea con la primera
--   accion sobre el envio. Un pedido pagado sin fila se lee como `PENDING`, que
--   es exactamente lo que es. Crearla en el webhook meteria una escritura mas
--   en el camino del cobro para no ganar nada.
--
-- LO QUE DE VERDAD IMPIDE UN DOBLE DESPACHO SON DOS CAPAS:
--
--   arriba  `dispatch_settled_at`, puesto bajo el cerrojo de esta fila: quien
--           llega segundo ve que ya se decidio y no hace nada.
--   abajo   la clave de idempotencia del movimiento de inventario, que es un
--           indice unico de `inventory_movements` y aguanta aunque dos
--           procesos se colaran a la vez por la primera capa.
--
--   Una sola no basta: la de arriba no ordena nada entre replicas y la de abajo
--   no sabe cambiar el estado del envio.
--
-- NINGUN TRANSPORTISTA, NINGUNA TARIFA Y NINGUNA FECHA ESTIMADA. La empresa no
--   ha elegido transportista ni cobertura. `carrier_name` y
--   `tracking_reference` son texto libre y NULOS mientras no se escriban: nulo
--   es «no lo dijeron», nunca «no hay» ni «N/A». No hay columna de coste de
--   envio, ni de impuestos, ni de fecha prevista de llegada: una columna vacia
--   «para luego» es una columna que alguien rellena con un cero, y un cero en
--   el coste del envio es una promesa de envio gratis que nadie ha hecho.
--
-- NINGUNA URL DE SEGUIMIENTO. Construirla exige saber el transportista; con
--   uno inventado seria un enlace roto dentro de la ficha de un pedido pagado.
--
-- NI DIRECCION NI NOMBRE EN EL HISTORIAL. El historial se lee para auditar un
--   estado, no para recomponer a quien se le mando que. La direccion ya vive,
--   congelada y en un solo sitio, en `product_order_addresses`.
--
-- LO QUE NO TRAE, Y ES DELIBERADO: incidencia, devolucion, garantia, resena,
--   saldo del proveedor, comision, transferencia y conformidad de las 72 horas.
--   Son los Incrementos 7 a 9. Aqui solo esta que el paquete salio y llego.
--
-- ROLLBACK, en este orden:
--   drop table public.product_shipment_events;
--   drop table public.product_shipment_items;
--   drop table public.product_shipments;
--   drop function public.product_shipment_events_solo_se_anaden();
--
--   LIMITACION DEL ROLLBACK: deshacer esto NO devuelve al almacen las unidades
--   que se despacharon mientras estuvo puesta. El movimiento de salida vive en
--   `inventory_movements`, que es de la 0074 y solo se anade: un paquete que
--   salio, salio. Quien revierta tiene que decidir a mano que hace con esas
--   unidades, y tiene el historial para saber cuales son.

-- ------------------------------------------------------------------------- --
-- 1. El envio
-- ------------------------------------------------------------------------- --
create table if not exists public.product_shipments (
  -- UNA POR PEDIDO. `restrict` y no `cascade`: un envio despachado es un hecho
  -- del almacen, y borrar el pedido no puede hacerlo desaparecer.
  order_id uuid primary key
    references public.product_orders(id) on delete restrict,

  status text not null default 'PENDING'
    constraint product_shipments_estado
    check (
      status in (
        'PENDING',
        'PREPARING',
        'READY',
        'DISPATCHED',
        'DELIVERED',
        'DELIVERY_FAILED',
        'CANCELLED'
      )
    ),

  -- TEXTO LIBRE Y OPCIONAL. Mientras la empresa no elija transportista, lo
  -- unico honesto es dejar que quien despacha escriba lo que tenga. Y si no
  -- tiene nada, NULO: un «N/A» escrito por defecto se acaba leyendo como si
  -- fuera el nombre de la empresa de transporte.
  carrier_name text
    constraint product_shipments_transportista
    check (carrier_name is null or length(trim(carrier_name)) between 1 and 120),
  tracking_reference text
    constraint product_shipments_referencia
    check (
      tracking_reference is null
      or length(trim(tracking_reference)) between 1 and 120
    ),

  prepared_at timestamptz,
  ready_at timestamptz,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,

  -- QUIEN AFIRMA QUE LLEGO. No es lo mismo que lo diga quien vende que quien
  -- compra, y el dia que haya una disputa de entrega —Incremento 7— es la
  -- primera pregunta. Administracion no aparece: no tiene como saberlo.
  delivered_source text
    constraint product_shipments_origen_de_la_entrega
    check (delivered_source is null or delivered_source in ('seller', 'buyer')),
  -- LA CONFIRMACION DE QUIEN COMPRA, APARTE. Puede confirmar que recibio algo
  -- que ya estaba marcado como entregado por quien vende, y eso es un dato
  -- distinto que conviene no perder.
  --
  -- Y NO ES CONFORMIDAD. Confirmar que llego no es decir que esta bien: lo
  -- segundo libera dinero y es del Incremento 9. Aqui no se libera nada
  -- porque no hay nada que liberar.
  buyer_confirmed_at timestamptz,

  failure_reason text
    constraint product_shipments_motivo_del_fallo
    check (failure_reason is null or length(trim(failure_reason)) between 3 and 500),
  cancellation_reason text
    constraint product_shipments_motivo_de_la_cancelacion
    check (
      cancellation_reason is null
      or length(trim(cancellation_reason)) between 3 and 500
    ),

  -- LAS DOS MARCAS QUE HACEN QUE EL INVENTARIO SE TOQUE UNA SOLA VEZ.
  -- `dispatch_settled_at`: las unidades salieron del almacen.
  -- `release_settled_at`: las unidades volvieron al comun.
  -- Son excluyentes: un envio o sale o se suelta, nunca las dos cosas.
  dispatch_settled_at timestamptz,
  release_settled_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- UN ENVIO QUE SALIO TIENE CON QUE DEMOSTRARLO. `DELIVERED` y
  -- `DELIVERY_FAILED` solo se alcanzan pasando por `DISPATCHED`, asi que los
  -- tres exigen lo mismo.
  constraint product_shipments_despachado_con_salida
    check (
      status not in ('DISPATCHED', 'DELIVERED', 'DELIVERY_FAILED')
      or (dispatched_at is not null and dispatch_settled_at is not null)
    ),
  constraint product_shipments_entregado_con_fecha
    check (status <> 'DELIVERED' or delivered_at is not null),
  -- UNA ENTREGA SIEMPRE DICE QUIEN LA AFIRMA. Sin esto, una fecha de entrega
  -- sin dueno seria imposible de discutir despues.
  constraint product_shipments_entrega_con_origen
    check (delivered_at is null or delivered_source is not null),
  constraint product_shipments_fallo_con_motivo
    check (
      status <> 'DELIVERY_FAILED'
      or (failed_at is not null and failure_reason is not null)
    ),
  -- CANCELAR SUELTA LO APARTADO, Y LAS TRES COSAS VAN JUNTAS.
  constraint product_shipments_cancelado_completo
    check (
      status <> 'CANCELLED'
      or (
        cancelled_at is not null
        and cancellation_reason is not null
        and release_settled_at is not null
      )
    ),
  -- NO SE PUEDE HABER SOLTADO Y CONSUMIDO LO MISMO.
  constraint product_shipments_o_sale_o_se_suelta
    check (dispatch_settled_at is null or release_settled_at is null),
  constraint product_shipments_salida_con_fecha
    check (dispatch_settled_at is null or dispatched_at is not null),
  -- UN ENVIO SOLTADO ESTA CANCELADO. Soltar sin cancelar dejaria un pedido
  -- pagado sin unidades apartadas y sin decirlo en ningun sitio.
  constraint product_shipments_soltado_esta_cancelado
    check (release_settled_at is null or status = 'CANCELLED')
);

-- LO QUE TIENE QUE MIRAR UNA PERSONA: todo lo que no ha llegado todavia.
-- Parcial, porque lo entregado y lo cancelado ya no necesitan a nadie.
create index if not exists product_shipments_sin_cerrar
  on public.product_shipments (created_at, order_id)
  where status not in ('DELIVERED', 'CANCELLED');

-- LO QUE SIGUE APARTANDO UNIDADES: no ha salido y no se ha soltado.
create index if not exists product_shipments_antes_de_salir
  on public.product_shipments (status, order_id)
  where dispatch_settled_at is null and release_settled_at is null;

-- ------------------------------------------------------------------------- --
-- 2. Que se preparo de cada linea
-- ------------------------------------------------------------------------- --
-- POR QUE UNA TABLA Y NO UNA COLUMNA EN `product_order_items`. Esa tabla es
-- INMUTABLE: la 0078 le puso un disparador que rechaza cualquier `update`,
-- porque un importe que se puede editar despues de cobrarlo no es un importe.
-- Lo que se lleva preparado cambia mientras se prepara, asi que vive aparte.
--
-- ESTO NO ES UN HISTORIAL Y NO PRETENDE SERLO. Es la lista de comprobacion de
-- quien empaqueta, y se corrige tantas veces como haga falta. Lo que si es
-- historial —cada cambio de estado, con actor y motivo— esta en
-- `product_shipment_events`, y ese solo se anade.
create table if not exists public.product_shipment_items (
  id uuid primary key default gen_random_uuid(),

  shipment_order_id uuid not null
    references public.product_shipments(order_id) on delete cascade,
  -- `restrict`: la linea que se preparo tiene que seguir siendo legible.
  order_item_id uuid not null
    references public.product_order_items(id) on delete restrict,

  -- CUANTAS SE HAN METIDO EN LA CAJA. Cero es legitimo: es «empezado y todavia
  -- ninguna». Que no pase de lo comprado lo comprueba el servidor, que es
  -- quien tiene delante la linea del pedido.
  prepared_quantity integer not null default 0
    constraint product_shipment_items_cantidad
    check (prepared_quantity >= 0 and prepared_quantity <= 1000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint product_shipment_items_una_linea
    unique (shipment_order_id, order_item_id)
);

create index if not exists product_shipment_items_del_envio
  on public.product_shipment_items (shipment_order_id, order_item_id);

-- ------------------------------------------------------------------------- --
-- 3. El historial del envio
-- ------------------------------------------------------------------------- --
create table if not exists public.product_shipment_events (
  id uuid primary key default gen_random_uuid(),

  shipment_order_id uuid not null
    references public.product_shipments(order_id) on delete restrict,

  from_status text
    constraint product_shipment_events_desde
    check (from_status is null or length(from_status) <= 40),
  to_status text not null
    constraint product_shipment_events_hasta
    check (length(to_status) <= 40),

  -- SIN CLAVE AJENA: quien movio un envio es un hecho del pasado.
  actor_id uuid,
  actor_role text not null
    constraint product_shipment_events_rol
    check (actor_role in ('buyer', 'seller', 'admin', 'system')),

  reason text
    constraint product_shipment_events_motivo
    check (reason is null or length(trim(reason)) between 3 and 500),

  created_at timestamptz not null default now()

  -- NADA DE DATOS PERSONALES AQUI. Ni nombre, ni telefono, ni direccion: el
  -- historial se lee para auditar un estado. La direccion esta, congelada y en
  -- un solo sitio, en `product_order_addresses`.
);

create index if not exists product_shipment_events_del_envio
  on public.product_shipment_events (shipment_order_id, created_at, id);

-- ------------------------------------------------------------------------- --
-- 4. El historial no se reescribe
-- ------------------------------------------------------------------------- --
-- LA MISMA PROTECCION QUE EL HISTORIAL DE INVENTARIO Y EL DEL PEDIDO. Un
-- historial que se puede editar no es un historial: es una version de los
-- hechos. Borrar el envio entero si arrastra sus lineas preparadas
-- —`on delete cascade`—, y eso es otra cosa: no queda media verdad.
create or replace function public.product_shipment_events_solo_se_anaden()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'El historial de un envio solo se anade: % no esta permitido', tg_op;
end;
$$;

drop trigger if exists product_shipment_events_inmutables
  on public.product_shipment_events;
create trigger product_shipment_events_inmutables
  before update or delete on public.product_shipment_events
  for each row execute function public.product_shipment_events_solo_se_anaden();

-- ------------------------------------------------------------------------- --
-- 5. RLS y permisos
-- ------------------------------------------------------------------------- --
-- Ninguna politica y ningun permiso suelto, igual que en la 0078. Un envio
-- dice que salio de que almacen y hacia que pedido; toda la escritura pasa por
-- la API, que es la unica que sabe si quien pide es el proveedor de ese pedido.
alter table public.product_shipments enable row level security;
alter table public.product_shipment_items enable row level security;
alter table public.product_shipment_events enable row level security;

revoke all on public.product_shipments from anon, authenticated;
revoke all on public.product_shipment_items from anon, authenticated;
revoke all on public.product_shipment_events from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 6. Verificacion
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  permisos bigint;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array[
      'product_shipments', 'product_shipment_items', 'product_shipment_events'
    ]) as t
   where not exists (
     select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
   );
  if faltan is not null then
    raise exception 'La 0079 no dejo estas tablas: %', faltan;
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.product_shipment_events'::regclass
       and tgname = 'product_shipment_events_inmutables'
  ) then
    raise exception 'La 0079 no dejo el disparador que congela el historial';
  end if;

  -- LAS DOS MARCAS QUE IMPIDEN TOCAR EL INVENTARIO DOS VECES.
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_shipments_despachado_con_salida'
  ) then
    raise exception 'La 0079 no dejo el CHECK que exige salida para despachar';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_shipments_o_sale_o_se_suelta'
  ) then
    raise exception 'La 0079 no dejo el CHECK que impide soltar lo ya salido';
  end if;

  -- `product_orders.status` NO CAMBIA. Si alguien anade aqui un valor de
  -- envio a ese CHECK, es que junto las dos maquinas sin decirlo.
  if exists (
    select 1 from pg_constraint
     where conname = 'product_orders_estado'
       and pg_get_constraintdef(oid) like '%DISPATCHED%'
  ) then
    raise exception 'El estado del pedido no puede hablar de envios';
  end if;

  -- NI TRANSPORTISTA POR DEFECTO, NI COSTE, NI FECHA PREVISTA. Si aparecen, es
  -- que alguien amplio el alcance sin decirlo.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_shipments'
       and column_name in (
         'shipping_cost_minor', 'tax_minor', 'estimated_delivery_at',
         'tracking_url', 'latitude', 'longitude'
       )
  ) then
    raise exception 'El envio no inventa coste, impuestos ni fecha de llegada';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_shipments'
       and column_name = 'carrier_name'
       and column_default is not null
  ) then
    raise exception 'El transportista no tiene valor por defecto';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in (
       'product_shipments', 'product_shipment_items', 'product_shipment_events'
     )
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Los envios tienen % permisos sueltos', permisos;
  end if;
end;
$$;

notify pgrst, 'reload schema';
