-- 0070 · Productos físicos: responsable comercial, producto, versión, variantes
--        y galería.
--
-- SIN APLICAR.
--
-- POR QUÉ NO SE REUTILIZA `commerce_products`. Esa tabla NO representa un
-- producto físico: representa el DERECHO DIGITAL que se compra para acceder a
-- un curso (`kind = 'course_lifetime'`). Convertirla en catálogo físico
-- mezclaría dos cosas que no comparten ni ciclo de vida ni entrega ni
-- devolución, y rompería el acceso de quien ya compró un curso. Productos tiene
-- sus propias tablas y reutiliza lo que de verdad es común: perfiles, permisos,
-- auditoría, almacenamiento y avisos.
--
-- POR QUÉ NO HAY TABLA DE «CREADOR». Un creador es un perfil con una capacidad
-- comercial añadida, y eso es `product_sellers`. Una tabla aparte crearía una
-- segunda identidad que se desincroniza del perfil: dos nombres, dos fotos y
-- dos verdades sobre quién es esa persona.
--
-- LO QUE ESTA MIGRACIÓN NO TRAE, Y ES DELIBERADO:
--
--   * NINGÚN IMPUESTO, NINGUNA COMISIÓN, NINGÚN TRANSPORTISTA y ningún plazo
--     de garantía. La empresa no ha definido entidad legal que vende, países,
--     comprobantes, cobertura ni tarifas de envío. Inventarlos aquí los
--     convertiría en decisiones tomadas por descuido, y ninguna prueba lo
--     delataría porque el resultado cuadra.
--   * NINGUNA CATEGORÍA. `product_categories` nace VACÍA porque las categorías
--     iniciales las decide la empresa. Vacía significa que la pantalla de
--     categorías no enseña nada, y eso es la verdad.
--   * NINGÚN PRECIO OBLIGATORIO. `price_minor` y `currency` son nulos hasta que
--     alguien los escriba, y nulo NO es gratis: es «sin precio configurado».
--     La moneda inicial también es una decisión abierta, así que no hay valor
--     por defecto.
--   * NINGUNA VENTA. No hay carrito, ni pedido, ni existencias, ni envío. Eso
--     es de incrementos posteriores, y `feature_product_sales` nace apagada.
--
-- POR QUÉ LAS VARIANTES Y LA GALERÍA CUELGAN DE LA VERSIÓN. Lo que se publica
-- es una versión inmutable, y «lo publicado» incluye las fotos aprobadas y las
-- opciones ofrecidas: si colgaran del producto, cambiar una foto reescribiría en
-- silencio lo que se evaluó y lo que vio quien compró. Una versión nueva copia
-- las filas que conserva —la misma ruta de almacenamiento, sin volver a subir
-- el archivo— y eso es barato.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE. Esquema antes que código: siete
-- tablas vacías que nadie lee. Código antes que esquema: la puerta de esquema
-- apaga el módulo entero y las rutas contestan 503 con su código.
--
-- ROLLBACK: `drop table` en orden inverso. No toca ninguna tabla existente.

-- ------------------------------------------------------------------------- --
-- 1. El responsable comercial: un perfil con capacidad de vender.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_sellers (
  id uuid primary key default gen_random_uuid(),

  -- UNO POR PERFIL. Dos filas para la misma persona serían dos responsables
  -- comerciales de los mismos productos y nadie sabría a cuál reclamar.
  profile_id uuid not null unique
    references public.profiles(id) on delete cascade,

  -- El nombre con el que firma sus productos. Puede no ser el del perfil.
  display_name text not null
    constraint product_sellers_nombre
    check (length(trim(display_name)) between 2 and 120),

  -- NACE `pending`: nadie puede vender por haberse registrado. Quién pasa a
  -- `active` lo decide la admisión (0071), no esta tabla.
  status text not null default 'pending'
    constraint product_sellers_estado
    check (status in ('pending', 'active', 'suspended')),

  -- Quién le dio la capacidad y cuándo. Historia, no pertenencia.
  activated_at timestamptz,
  activated_by uuid references public.profiles(id) on delete set null,
  suspended_at timestamptz,
  suspension_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ACTIVO CON FECHA. Un `active` sin fecha de activación es una capacidad que
  -- nadie concedió.
  constraint product_sellers_activo_con_fecha
    check (status <> 'active' or activated_at is not null),
  constraint product_sellers_suspendido_con_fecha
    check (status <> 'suspended' or suspended_at is not null)
);

create index if not exists product_sellers_activos
  on public.product_sellers (status, created_at desc);

-- ------------------------------------------------------------------------- --
-- 2. Las categorías. VACÍA a propósito.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    constraint product_categories_slug
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 64),
  name text not null
    constraint product_categories_nombre
    check (length(trim(name)) between 2 and 80),
  position integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists product_categories_visibles
  on public.product_categories (active, position, slug);

-- ------------------------------------------------------------------------- --
-- 3. El producto: identidad estable.
-- ------------------------------------------------------------------------- --
--
-- EL CICLO ES EL DEL BLUEPRINT, letra por letra. Se guarda como texto con un
-- CHECK y no como enum de PostgreSQL porque un enum no admite quitar valores, y
-- este ciclo todavía puede perder alguno cuando la empresa cierre las
-- condiciones de la aprobación condicionada.
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),

  seller_id uuid not null
    references public.product_sellers(id) on delete restrict,
  category_id uuid references public.product_categories(id) on delete set null,

  status text not null default 'draft'
    constraint products_estado
    check (status in (
      'draft', 'submitted', 'document_review', 'sample_requested',
      'evaluation', 'conditionally_approved', 'approved', 'published',
      'observation', 'suspended', 'removed'
    )),

  -- LA VERSIÓN QUE SE ENSEÑA. Nula mientras no haya ninguna publicada, y eso
  -- es lo que hace que un producto sin versión no pueda aparecer en catálogo.
  published_version_id uuid,

  published_at timestamptz,
  suspended_at timestamptz,
  suspension_reason text,
  removed_at timestamptz,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- PUBLICADO EXIGE VERSIÓN PUBLICADA. Sin esto, `status = 'published'` con
  -- `published_version_id` nulo sería un producto en catálogo sin nada que
  -- enseñar, y la ficha reventaría al leerlo.
  constraint products_publicado_con_version
    check (status <> 'published' or published_version_id is not null),
  constraint products_publicado_con_fecha
    check (status <> 'published' or published_at is not null)
);

create index if not exists products_del_responsable
  on public.products (seller_id, status, created_at desc);

-- EL CATÁLOGO. Solo lo publicado, y ordenado por lo más reciente.
create index if not exists products_en_catalogo
  on public.products (published_at desc, id desc)
  where status = 'published';

create index if not exists products_por_categoria
  on public.products (category_id, published_at desc)
  where status = 'published';

-- ------------------------------------------------------------------------- --
-- 4. La versión: lo que se publica, y no se toca.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null
    references public.products(id) on delete cascade,

  version text not null
    constraint product_versions_version
    check (length(trim(version)) between 1 and 32),
  status text not null default 'draft'
    constraint product_versions_estado
    check (status in ('draft', 'published', 'superseded')),

  name text not null
    constraint product_versions_nombre
    check (length(trim(name)) between 3 and 140),
  summary text
    constraint product_versions_resumen
    check (summary is null or length(summary) <= 300),
  description text
    constraint product_versions_descripcion
    check (description is null or length(description) <= 8000),

  -- MATERIALES Y ORIGEN. Texto libre porque quien los escribe es quien fabrica,
  -- y una taxonomía de materiales es una decisión que nadie ha tomado.
  materials text
    constraint product_versions_materiales
    check (materials is null or length(materials) <= 2000),
  origin_country text
    constraint product_versions_pais
    check (origin_country is null or origin_country ~ '^[A-Z]{2}$'),
  manufacturer text
    constraint product_versions_fabricante
    check (manufacturer is null or length(trim(manufacturer)) between 2 and 160),

  -- EL PRECIO ES OPCIONAL, y nulo NO es gratis. Sin moneda decidida por la
  -- empresa no hay valor por defecto posible.
  price_minor bigint
    constraint product_versions_precio
    check (price_minor is null or price_minor >= 0),
  currency text
    constraint product_versions_moneda
    check (currency is null or currency ~ '^[A-Z]{3}$'),

  -- LA HUELLA DE LO PUBLICADO. Es lo que hace demostrable qué texto y qué
  -- números se evaluaron y qué vio quien compró.
  content_sha256 text not null
    constraint product_versions_huella
    check (content_sha256 ~ '^[0-9a-f]{64}$'),

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  published_by uuid references public.profiles(id) on delete set null,
  effective_from timestamptz,
  effective_to timestamptz,

  constraint product_versions_unica
    unique (product_id, version),
  -- PUBLICADA CON FECHA. Una superada conserva la suya: esa fecha es su
  -- historia, así que NO es una equivalencia.
  constraint product_versions_publicada_con_fecha
    check (status <> 'published' or published_at is not null),
  -- EL PRECIO VA CON SU MONEDA. Un importe sin moneda no es un importe.
  constraint product_versions_precio_con_moneda
    check ((price_minor is null) = (currency is null))
);

-- UNA VIGENTE POR PRODUCTO. Dos publicadas sin cerrar serían dos fichas
-- distintas del mismo producto según el orden de lectura.
create unique index if not exists product_versions_vigente
  on public.product_versions (product_id)
  where status = 'published' and effective_to is null;

-- UN BORRADOR POR PRODUCTO. Dos `PUT` simultáneos creaban dos y el servicio
-- leía uno: el otro quedaba huérfano y visible en el historial. Esto no lo
-- resuelve una comprobación en Python: entre mirar y escribir cabe la otra
-- petición.
create unique index if not exists product_versions_un_borrador
  on public.product_versions (product_id)
  where status = 'draft';

create index if not exists product_versions_del_producto
  on public.product_versions (product_id, created_at desc, id desc);

-- Y AHORA SÍ, la referencia del producto a su versión publicada. Se añade
-- después porque las dos tablas se apuntan la una a la otra.
alter table public.products
  drop constraint if exists products_version_publicada_fk;
alter table public.products
  add constraint products_version_publicada_fk
  foreign key (published_version_id)
  references public.product_versions(id) on delete set null;

-- ------------------------------------------------------------------------- --
-- 5. Variantes: talla, color, modelo. De la VERSIÓN.
-- ------------------------------------------------------------------------- --
--
-- SIN EXISTENCIAS. Cuántas hay es inventario, y el inventario es de un
-- incremento posterior: escribir aquí una columna `stock` invitaría a venderla
-- sin reservas ni concurrencia.
create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null
    references public.product_versions(id) on delete cascade,

  sku text not null
    constraint product_variants_sku
    check (sku ~ '^[A-Za-z0-9._-]{2,48}$'),
  name text not null
    constraint product_variants_nombre
    check (length(trim(name)) between 1 and 80),

  -- LAS OPCIONES, como datos. `{"talla": "M", "color": "negro"}`. Un objeto y
  -- no columnas fijas porque las opciones dependen del producto, y `{}` NO es
  -- «sin opciones válidas»: es una variante única.
  options jsonb not null default '{}'::jsonb,

  -- LA DIFERENCIA DE PRECIO, si la hay. Puede ser negativa.
  price_delta_minor bigint not null default 0,

  position integer not null default 0,
  created_at timestamptz not null default now(),

  constraint product_variants_sku_unico unique (version_id, sku)
);

create index if not exists product_variants_de_la_version
  on public.product_variants (version_id, position, sku);

-- ------------------------------------------------------------------------- --
-- 6. La galería aprobada. De la VERSIÓN, por lo mismo.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_media (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null
    references public.product_versions(id) on delete cascade,

  kind text not null default 'image'
    constraint product_media_tipo
    check (kind in ('image', 'video')),

  -- LA RUTA EN EL ALMACENAMIENTO, no una URL. Una URL firmada caduca y
  -- guardarla haría que la galería dejara de cargar sin que nadie tocara nada.
  storage_path text not null
    constraint product_media_ruta
    check (length(trim(storage_path)) between 3 and 512),
  alt_text text
    constraint product_media_alternativo
    check (alt_text is null or length(alt_text) <= 300),

  position integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint product_media_ruta_unica unique (version_id, storage_path)
);

create index if not exists product_media_de_la_version
  on public.product_media (version_id, position, id);

-- ------------------------------------------------------------------------- --
-- 7. RLS y permisos.
-- ------------------------------------------------------------------------- --
-- IGUAL QUE POSVENTA DE EVENTOS: la aplicación no habla con estas tablas, y por
-- eso no hay ninguna política de acceso. Se entra por la API, que comprueba la
-- propiedad del producto y el rol de quien llama.
--
-- Ni siquiera el catálogo se lee directo: publicar un producto exige una
-- evaluación aprobada (0071), y una política de lectura sobre `products` dejaría
-- a la aplicación decidiendo qué cuenta como publicado.
alter table public.product_sellers enable row level security;
alter table public.product_categories enable row level security;
alter table public.products enable row level security;
alter table public.product_versions enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_media enable row level security;

revoke all on public.product_sellers from anon, authenticated;
revoke all on public.product_categories from anon, authenticated;
revoke all on public.products from anon, authenticated;
revoke all on public.product_versions from anon, authenticated;
revoke all on public.product_variants from anon, authenticated;
revoke all on public.product_media from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 8. Verificación.
-- ------------------------------------------------------------------------- --
-- NO CUENTA FILAS. Este fichero no escribe ninguna, y contarlas haría que
-- dejara de ser re-ejecutable en cuanto existiera un producto.
do $$
declare
  faltan text;
  permisos bigint;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array[
      'product_sellers', 'product_categories', 'products',
      'product_versions', 'product_variants', 'product_media'
    ]) as t
   where not exists (
     select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
   );
  if faltan is not null then
    raise exception 'La 0070 no dejó estas tablas: %', faltan;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'products_version_publicada_fk'
  ) then
    raise exception 'La 0070 no dejó la clave ajena a la versión publicada';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'product_versions_vigente'
  ) then
    raise exception 'La 0070 no dejó la unicidad de la versión vigente';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name like 'product%'
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Productos tiene % permisos sueltos', permisos;
  end if;
end;
$$;
