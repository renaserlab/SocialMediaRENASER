-- 0074 · Inventario físico por SKU: existencias, reservas y movimientos.
--
-- AL APLICARLA, REINICIAR LA API. La puerta de esquema cachea tambien el «no»
-- en la memoria del proceso: sin reiniciar, las rutas siguen contestando 503
-- aunque las tablas ya esten.
--
-- SIN APLICAR. Requiere la 0070.
--
-- POR QUÉ LA EXISTENCIA SE GUARDA POR (PRODUCTO, SKU) Y NO POR VARIANTE. Una
-- variante cuelga de una VERSIÓN INMUTABLE: publicar otra versión crea filas de
-- variante NUEVAS, con identificadores nuevos, para las mismas cajas del mismo
-- almacén. Si el inventario colgara de la fila, cada publicación dejaría las
-- existencias huérfanas y el producto aparecería agotado sin que nadie hubiera
-- vendido nada. Guardar el número en la variante tiene además el problema
-- contrario: editar el borrador reescribe esas filas.
--
-- EL SKU ES, LITERALMENTE, LA UNIDAD DE ALMACÉN. Es lo único estable entre una
-- versión y la siguiente, y es lo que identifica una caja concreta. Por eso la
-- clave es (producto, SKU) y no hay clave ajena a `product_variants`: la
-- variante dice qué se ofrece en esta versión, el SKU dice qué hay guardado.
--
-- LO QUE HAY, QUE SON DOS COSAS:
--
--   * `product_inventory`: el estado de AHORA. Una fila por (producto, SKU),
--     dos números —lo que hay y lo comprometido— y nada más.
--   * `inventory_movements`: cómo se llegó hasta aquí. SOLO SE AÑADE. Un
--     disparador rechaza `update` y `delete`, porque un historial que se puede
--     editar no es un historial: es una opinión sobre el pasado.
--
-- NO HAY COLUMNA `available`, Y ES LA DECISIÓN MÁS IMPORTANTE DE ESTE FICHERO.
-- Lo disponible es `on_hand - reserved`, se calcula, y guardarlo además crearía
-- dos verdades que divergen la primera vez que alguien escriba una y olvide la
-- otra. El día que la resta pese, es una vista o un índice, no una columna.
--
-- NO HAY LOTES. La arquitectura propone `inventory_lots`, y el lote sirve para
-- trazar el origen —blueprint §5.1— no para saber cuántas quedan. Traerlo hoy
-- sería una tabla que nadie consulta; entra cuando exista la trazabilidad que
-- la necesita.
--
-- LA CONCURRENCIA LA RESUELVE POSTGRESQL. Reservar bloquea la fila de
-- `product_inventory` con `for update` y decide con el número ya bloqueado: dos
-- peticiones simultáneas por la última unidad se ordenan, y la segunda ve que no
-- queda. Un candado en memoria del proceso no serviría —hay más de un proceso—
-- y por eso no existe ninguno.
--
-- ESTO NO VENDE NADA. No hay pedido, ni cobro, ni envío: reservar y despachar
-- son operaciones del dominio que el checkout usará cuando exista.
--
-- ROLLBACK: `drop table public.inventory_movements`, luego
-- `drop table public.product_inventory`, luego la función del disparador.

-- ------------------------------------------------------------------------- --
-- 1. El estado de ahora
-- ------------------------------------------------------------------------- --
create table if not exists public.product_inventory (
  product_id uuid not null
    references public.products(id) on delete cascade,

  -- EL SKU, tal y como lo escribió quien vende. Dos filas para el mismo
  -- (producto, SKU) serían dos almacenes que nadie sabría sumar.
  sku text not null
    constraint product_inventory_sku
    check (length(trim(sku)) between 1 and 48),

  on_hand bigint not null default 0
    constraint product_inventory_existencia
    check (on_hand >= 0),

  reserved bigint not null default 0
    constraint product_inventory_reservado
    check (reserved >= 0),

  -- NO SE PUEDE COMPROMETER LO QUE NO HAY. Es lo que impide que lo disponible
  -- —que se calcula— salga negativo.
  constraint product_inventory_reservado_cabe check (reserved <= on_hand),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (product_id, sku)
);

-- LO QUE SE PUEDE VENDER AHORA MISMO. Índice sobre la resta, no columna: el
-- número sigue siendo uno solo y aun así se puede filtrar por él.
create index if not exists product_inventory_disponible
  on public.product_inventory (product_id, (on_hand - reserved))
  where on_hand > reserved;

-- ------------------------------------------------------------------------- --
-- 2. El historial
-- ------------------------------------------------------------------------- --
--
-- EL IDENTIFICADOR SE DERIVA DE LA CLAVE DE IDEMPOTENCIA, igual que en el
-- temario de Cursos: la segunda petición con la misma clave choca contra la
-- clave primaria y no llega a mover nada. No es un «mira si existe y si no
-- inserta», que dos peticiones simultáneas se pasan por delante.
create table if not exists public.inventory_movements (
  id uuid primary key,

  -- `restrict` Y NO `cascade`, porque el disparador de mas abajo rechaza los
  -- `delete` sobre esta tabla: un `cascade` que no puede ejecutarse no protege
  -- nada y ademas convierte el borrado del producto en un error incomprensible.
  -- Con `restrict`, borrar un producto con historial de almacen dice justo eso.
  product_id uuid not null
    references public.products(id) on delete restrict,
  sku text not null
    constraint inventory_movements_sku
    check (length(trim(sku)) between 1 and 48),

  kind text not null
    constraint inventory_movements_tipo
    check (kind in ('intake', 'adjustment', 'reservation', 'release', 'dispatch')),

  -- LA CANTIDAD DEL MOVIMIENTO. Con signo solo en el ajuste, que es el único
  -- que puede restar: una entrada negativa sería un ajuste mal nombrado, y el
  -- historial dejaría de poder leerse de un vistazo.
  quantity bigint not null
    constraint inventory_movements_cantidad
    check (quantity <> 0 and abs(quantity) <= 1000000),
  constraint inventory_movements_solo_el_ajuste_resta
    check (kind = 'adjustment' or quantity > 0),

  -- CÓMO QUEDÓ DESPUÉS. Sin esto, reconstruir el pasado exigiría sumar la
  -- cadena entera y confiar en que no falta ninguna.
  on_hand_after bigint not null
    constraint inventory_movements_existencia_despues check (on_hand_after >= 0),
  reserved_after bigint not null
    constraint inventory_movements_reservado_despues check (reserved_after >= 0),

  -- UN AJUSTE SIN MOTIVO NO SE PUEDE AUDITAR. Es el único movimiento que
  -- cambia el número sin que haya ocurrido nada fuera del sistema.
  reason text
    constraint inventory_movements_motivo
    check (reason is null or length(trim(reason)) <= 500),
  constraint inventory_movements_ajuste_con_motivo
    check (
      kind <> 'adjustment'
      or (reason is not null and length(trim(reason)) >= 3)
    ),

  -- SIN CLAVE AJENA, y a proposito: `on delete set null` exige un `update`
  -- sobre esta tabla, y el disparador lo rechaza. Quien firmo un movimiento es
  -- un hecho del pasado; si esa cuenta desaparece, el hecho sigue siendo cierto
  -- y el identificador se queda escrito.
  actor_id uuid,
  actor_role text not null
    constraint inventory_movements_actor
    check (actor_role in ('seller', 'admin', 'system')),

  idempotency_key text not null
    constraint inventory_movements_clave
    check (length(trim(idempotency_key)) between 1 and 200),

  created_at timestamptz not null default now(),

  -- POR (PRODUCTO, SKU) Y NO GLOBAL: dos productos distintos pueden recibir la
  -- misma cadena de un cliente mal escrito —«1» es lo habitual— y no deben
  -- pisarse el movimiento.
  constraint inventory_movements_clave_unica
    unique (product_id, sku, idempotency_key)
);

create index if not exists inventory_movements_de_la_unidad
  on public.inventory_movements (product_id, sku, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 3. El historial SOLO SE AÑADE
-- ------------------------------------------------------------------------- --
--
-- Una rectificación es un movimiento nuevo con su motivo, nunca una edición del
-- anterior. Lo dice el blueprint §14.1 para los registros financieros y vale
-- igual aquí: si una fila se puede editar, «cuántas había el martes» deja de
-- tener respuesta.
create or replace function public.inventory_movements_solo_se_anade()
returns trigger
language plpgsql
as $$
begin
  raise exception 'El historial de inventario solo se añade: % no está permitido', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists inventory_movements_inmutable on public.inventory_movements;
create trigger inventory_movements_inmutable
  before update or delete on public.inventory_movements
  for each row execute function public.inventory_movements_solo_se_anade();

-- ------------------------------------------------------------------------- --
-- 4. RLS y permisos
-- ------------------------------------------------------------------------- --
-- IGUAL QUE EL RESTO DE PRODUCTOS: ninguna política, ningún permiso suelto. La
-- aplicación no habla con estas tablas. Una política de escritura sobre el
-- inventario dejaría al móvil decidiendo cuántas unidades hay.
alter table public.product_inventory enable row level security;
alter table public.inventory_movements enable row level security;

revoke all on public.product_inventory from anon, authenticated;
revoke all on public.inventory_movements from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 5. Verificación
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  permisos bigint;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array['product_inventory', 'inventory_movements']) as t
   where not exists (
     select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
   );
  if faltan is not null then
    raise exception 'La 0074 no dejó estas tablas: %', faltan;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_inventory'
       and column_name = 'available'
  ) then
    raise exception
      'product_inventory tiene una columna available: lo disponible se calcula';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'inventory_movements_inmutable' and not tgisinternal
  ) then
    raise exception 'La 0074 no dejó el disparador que hace el historial inmutable';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'product_inventory_reservado_cabe'
  ) then
    raise exception 'La 0074 no dejó la restricción que impide reservar de más';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in ('product_inventory', 'inventory_movements')
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'El inventario tiene % permisos sueltos', permisos;
  end if;
end;
$$;

notify pgrst, 'reload schema';
