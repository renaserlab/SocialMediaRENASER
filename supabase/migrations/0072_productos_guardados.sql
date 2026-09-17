-- 0072 · Productos guardados.
--
-- APLICADA Y VERIFICADA contra la base gestionada el 17/09/2026.
-- CERO DIVERGENCIAS.
--
-- ES LO ÚNICO QUE EL CATÁLOGO NECESITA ESCRIBIR. Portada, búsqueda, categorías,
-- selección y ficha solo LEEN; guardar es la única acción del catálogo que deja
-- rastro, y por eso es la única tabla de este incremento.
--
-- NO ES UN CARRITO. Guardar no reserva nada, no tiene cantidad, no tiene
-- variante y no lleva a pagar. El carrito es de un incremento posterior y va a
-- ser otra tabla: mezclarlos convertiría una lista de deseos en una compra a
-- medias.
--
-- ROLLBACK: `drop table public.saved_products`.

create table if not exists public.saved_products (
  user_id uuid not null
    references public.profiles(id) on delete cascade,
  product_id uuid not null
    references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- GUARDAR DOS VECES ES GUARDAR UNA. Lo impone la clave primaria, así que
  -- pulsar el botón repetido —o reintentar la petición— no duplica nada.
  primary key (user_id, product_id)
);

-- LO MÍO, LO MÁS RECIENTE PRIMERO. Es la única consulta que hace la pantalla.
create index if not exists saved_products_mios
  on public.saved_products (user_id, created_at desc, product_id);

-- CUÁNTOS LO GUARDARON. No se enseña como indicador de confianza —eso exige
-- compras verificadas— pero el índice hace que contarlo no cueste una lectura
-- de tabla entera el día que alguien lo pida.
create index if not exists saved_products_del_producto
  on public.saved_products (product_id);

alter table public.saved_products enable row level security;
revoke all on public.saved_products from anon, authenticated;

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'saved_products'
  ) then
    raise exception 'La 0072 no dejó saved_products';
  end if;
  if exists (
    select 1 from information_schema.table_privileges
     where table_schema = 'public' and table_name = 'saved_products'
       and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'saved_products tiene permisos sueltos';
  end if;
end;
$$;
