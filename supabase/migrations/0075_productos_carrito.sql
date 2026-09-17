-- 0075 · El carrito de Productos: persistente, del servidor y sin compra.
--
-- SIN APLICAR. Requiere la 0070 y la 0074.
--
-- NO ES «GUARDADOS», Y POR ESO ES OTRA TABLA. Guardar (0072) es un marcador:
-- sin cantidad, sin variante, sin precio y sin caducidad. El carrito tiene
-- cantidad, variante, moneda y un total que calcula el servidor. Mezclarlos
-- convertiría una lista de deseos en una compra a medias, y el contador del
-- encabezado dejaría de significar nada concreto.
--
-- TODAVÍA NO SE COMPRA. No hay pedido, ni dirección, ni cobro, ni transferencia;
-- `feature_product_sales` sigue apagada y sin código detrás. El carrito es la
-- lista de lo que alguien quiere: el paso siguiente es de otro incremento.
--
-- EL CARRITO NO RESERVA EXISTENCIAS. Tener algo en el carrito no se lo quita a
-- nadie: reservar es del checkout, y una reserva sin caducidad convertiría un
-- carrito olvidado en un producto agotado. Por eso no hay ninguna columna de
-- reserva aquí y ningún movimiento de inventario nace de esta tabla.
--
-- EL PRECIO DE LA LÍNEA NO ES EL PRECIO. `seen_price_minor` es lo que se veía
-- al añadir, y existe para AVISAR de que cambió —no para cobrarlo—. Congelar el
-- precio ocurre al crear el pedido, no al meterlo en la bolsa: si se congelara
-- aquí, un carrito de hace tres semanas pagaría un precio que ya no existe.
--
-- UNA PERSONA, UN CARRITO. La clave primaria de `product_carts` es la persona,
-- así que no hay forma de tener dos. Y es la fila que se bloquea —`for update`—
-- para ordenar cualquier cambio: es lo que hace que un doble toque no sume dos.
--
-- ROLLBACK: `drop table public.product_cart_items`, luego
-- `drop table public.product_carts`.

-- ------------------------------------------------------------------------- --
-- 1. El carrito
-- ------------------------------------------------------------------------- --
create table if not exists public.product_carts (
  user_id uuid primary key
    references public.profiles(id) on delete cascade,

  -- LA MONEDA DEL CARRITO: la de su primera línea. Nula mientras esté vacío, y
  -- nula NO es una moneda por defecto. Una línea en otra moneda se rechaza:
  -- sumar soles con euros da un número que no es dinero.
  currency char(3)
    constraint product_carts_moneda
    check (currency is null or currency ~ '^[A-Z]{3}$'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------------- --
-- 2. Las líneas
-- ------------------------------------------------------------------------- --
create table if not exists public.product_cart_items (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references public.product_carts(user_id) on delete cascade,

  product_id uuid not null
    references public.products(id) on delete cascade,
  -- LA VERSIÓN ENTRA EN LA IDENTIDAD DE LA LÍNEA. Es lo que permite avisar de
  -- que el producto se republicó con otra descripción o otro precio desde que
  -- se metió en la bolsa; sin ella, el cambio sería invisible.
  version_id uuid not null
    references public.product_versions(id) on delete cascade,
  variant_id uuid not null
    references public.product_variants(id) on delete cascade,

  quantity integer not null
    constraint product_cart_items_cantidad
    -- El tope de arriba es TÉCNICO, no una regla comercial: lo que de verdad
    -- limita es la disponibilidad. Está para que un cliente roto no mande 2^31.
    check (quantity >= 1 and quantity <= 1000),

  -- LO QUE SE VEÍA AL AÑADIR. Ver la cabecera: sirve para avisar, no para
  -- cobrar. Va con su moneda porque un importe sin moneda no es un importe.
  seen_price_minor bigint not null
    constraint product_cart_items_precio check (seen_price_minor >= 0),
  seen_currency char(3) not null
    constraint product_cart_items_moneda check (seen_currency ~ '^[A-Z]{3}$'),

  -- LA ÚLTIMA OPERACIÓN QUE SE APLICÓ A ESTA LÍNEA. Un reintento que trae la
  -- misma clave no vuelve a sumar. Es una columna y no una tabla porque lo que
  -- hay que impedir es el DOBLE TOQUE —la misma petición repetida— y para eso
  -- basta recordar la última, no todas.
  last_operation_key text
    constraint product_cart_items_clave
    check (last_operation_key is null or length(last_operation_key) <= 200),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- AÑADIR DOS VECES AJUSTA LA CANTIDAD, NO DUPLICA LA FILA. Lo impone la base,
  -- no un `if`: dos peticiones simultáneas se pasarían por delante de un `if`.
  constraint product_cart_items_una_linea
    unique (user_id, product_id, version_id, variant_id)
);

create index if not exists product_cart_items_del_carrito
  on public.product_cart_items (user_id, created_at, id);

-- PARA PODER PREGUNTAR «¿ESTÁ ESTO EN ALGÚN CARRITO?» al retirar un producto.
create index if not exists product_cart_items_del_producto
  on public.product_cart_items (product_id);

-- ------------------------------------------------------------------------- --
-- 3. RLS y permisos
-- ------------------------------------------------------------------------- --
-- Ninguna política y ningún permiso suelto, como el resto de Productos: los
-- importes los calcula el servidor, y una política de escritura sobre las
-- líneas dejaría al cliente decidiendo cantidades y precios.
alter table public.product_carts enable row level security;
alter table public.product_cart_items enable row level security;

revoke all on public.product_carts from anon, authenticated;
revoke all on public.product_cart_items from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 4. Verificación
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  permisos bigint;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array['product_carts', 'product_cart_items']) as t
   where not exists (
     select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
   );
  if faltan is not null then
    raise exception 'La 0075 no dejó estas tablas: %', faltan;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'product_cart_items_una_linea'
  ) then
    raise exception 'La 0075 no dejó la unicidad de la línea del carrito';
  end if;

  -- EL CARRITO NO RESERVA. Si algún día aparece aquí una columna de reserva,
  -- es que alguien mezcló el carrito con el inventario.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_cart_items'
       and column_name in ('reserved', 'reserved_until', 'reservation_id')
  ) then
    raise exception 'El carrito no reserva existencias';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in ('product_carts', 'product_cart_items')
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'El carrito tiene % permisos sueltos', permisos;
  end if;
end;
$$;

notify pgrst, 'reload schema';
