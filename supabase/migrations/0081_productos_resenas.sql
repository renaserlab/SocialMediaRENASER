-- 0081 · Resenas verificadas de producto: la respuesta del proveedor y el
--        historial de moderacion.
--
-- SIN APLICAR.
--
-- LA UNIDAD ES LA LINEA DE PEDIDO, y no el producto ni la variante. Lo dice el
-- blueprint §6 con todas las letras: «la valoracion solo se habilita para una
-- linea de pedido entregada y no valorada; una compra genera como maximo una
-- resena por linea de pedido». Asi que la restriccion unica es sobre
-- `order_item_id` y no sobre `(product_id, author_id)`: quien compro el mismo
-- producto dos veces, en dos pedidos, opina dos veces, porque son dos compras
-- distintas y cada una le llego en su caja.
--
-- «COMPRA VERIFICADA» NO ES UNA COLUMNA. No hay ningun booleano `verified` que
-- alguien pueda escribir. Las cuatro condiciones —quien compro, pedido pagado,
-- linea de ese pedido, paquete entregado— las imponen TRES CLAVES AJENAS
-- COMPUESTAS contra las tablas que ya existen:
--
--   (order_id, author_id, order_paid_at)
--        -> product_orders (id, buyer_id, paid_at)
--   (order_item_id, order_id, product_id)
--        -> product_order_items (id, order_id, product_id)
--   (order_id, delivered_at)
--        -> product_shipments (order_id, delivered_at)
--
-- Las columnas del lado hijo son NOT NULL, asi que la clave ajena TIENE que
-- casar: un pedido sin `paid_at` o un envio sin `delivered_at` no pueden
-- emparejar con una resena, y PostgreSQL rechaza el INSERT. No hace falta
-- confiar en ningun `if` del servidor.
--
-- Y HAY UN EFECTO DE VUELTA QUE ES EL QUE MAS IMPORTA: mientras exista la
-- resena, esas filas padre quedan CONGELADAS en lo que se refiere a esas
-- columnas. Nadie puede poner `paid_at` a nulo, ni borrar la fecha de entrega,
-- ni mover la linea a otro pedido: la clave ajena lo impide. Una resena es
-- evidencia, y la evidencia ata tambien lo que la respalda.
--
-- POR ESO HACEN FALTA TRES INDICES UNICOS REDUNDANTES sobre tablas que ya
-- existen. Son redundantes de verdad —`id` ya es clave primaria en las tres—,
-- y existen solo porque una clave ajena compuesta exige que el lado padre sea
-- unico. Es el precio de que la verificacion viva en la base y no en el codigo,
-- y es barato: tres indices sobre tablas que se escriben una vez por compra.
--
-- CINCO PUNTUACIONES, TODAS OBLIGATORIAS. Son las del blueprint §6, y alli las
-- seis filas de la tabla —general, calidad, fidelidad, funcionamiento, valor
-- por el precio y «¿lo recomendarias?»— dicen «Si» en la columna de
-- obligatorio. A diferencia de las resenas de evento, donde los ejes son
-- opcionales, aqui no lo son: el formulario no se envia a medias.
--
-- LA GENERAL NO ES LA MEDIA DE LAS OTRAS. Es otra pregunta. Calcularla
-- obligaria a decidir cuanto pesa cada eje, y eso no lo ha decidido nadie.
--
-- NINGUNA FOTOGRAFIA. El blueprint §6 marca «Multimedia: solo para incidencia».
-- No hay columna de adjuntos ni deposito nuevo, y el bloque de verificacion
-- falla si aparecen.
--
-- MODERAR ES ESCONDER, NUNCA REESCRIBIR. `status` pasa a `hidden` y la fila se
-- queda entera: puntuaciones, texto y autor intactos. El blueprint §15 lo dice
-- de Mediador Z —«no puede editar la resena del comprador»— y aqui vale para
-- todo el mundo. La API no expone ninguna ruta que reescriba una resena ajena,
-- y hay una prueba que recorre el router para que siga sin existir.
--
-- EL PROVEEDOR RESPONDE EN PUBLICO, Y UNA SOLA VEZ VISIBLE. Varias respuestas
-- sobre la misma resena serian una forma de hostigar a quien opino. Indice
-- unico parcial, como en Eventos.
--
-- SEGURA EN LOS DOS ORDENES DE DESPLIEGUE. Esquema antes que codigo: tres
-- tablas vacias que nadie lee y tres indices que nadie consulta. Codigo antes
-- que esquema: las rutas contestan 503 `product_reviews_not_available` y la
-- ficha del producto no pinta ninguna seccion de resenas.
--
-- BACKFILL: NINGUNO, y se comprueba. No hay resenas de producto anteriores: no
-- existia donde guardarlas.
--
-- ROLLBACK: al final del fichero.

-- ------------------------------------------------------------------------- --
-- 1. Los tres indices unicos que hacen falta para verificar en la base.
--
-- `add constraint ... unique` no admite `if not exists`, asi que van dentro de
-- un bloque que mira antes si estan: la migracion se declara re-ejecutable y
-- tiene que poder correr dos veces.
-- ------------------------------------------------------------------------- --
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_orders_comprador_y_cobro'
  ) then
    alter table public.product_orders
      add constraint product_orders_comprador_y_cobro
      unique (id, buyer_id, paid_at);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'product_order_items_del_pedido_y_producto'
  ) then
    alter table public.product_order_items
      add constraint product_order_items_del_pedido_y_producto
      unique (id, order_id, product_id);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'product_shipments_entrega_del_pedido'
  ) then
    alter table public.product_shipments
      add constraint product_shipments_entrega_del_pedido
      unique (order_id, delivered_at);
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. La resena.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_reviews (
  id uuid primary key default gen_random_uuid(),

  -- QUE SE VALORA. Se copia de la linea, y la clave ajena compuesta de abajo
  -- impide que sea otro: no se puede valorar un producto que no viene en esa
  -- linea del pedido.
  product_id uuid not null references public.products(id) on delete restrict,

  -- LA COMPRA. Las tres columnas siguientes existen para que la verificacion
  -- sea una clave ajena y no un `if`.
  order_id uuid not null,
  order_item_id uuid not null,
  author_id uuid not null references public.profiles(id) on delete cascade,

  -- LAS DOS FECHAS QUE NO SE ESCRIBEN A MANO: tienen que casar con las del
  -- pedido y las del envio, o el INSERT se rechaza.
  order_paid_at timestamptz not null,
  delivered_at timestamptz not null,

  -- «¿Entrego lo que anuncio?». NO es la media de los cuatro ejes.
  overall smallint not null
    constraint product_reviews_general check (overall between 1 and 5),

  -- Los cuatro ejes del blueprint §6. OBLIGATORIOS los cuatro.
  quality smallint not null
    constraint product_reviews_calidad check (quality between 1 and 5),
  fidelity smallint not null
    constraint product_reviews_fidelidad check (fidelity between 1 and 5),
  functioning smallint not null
    constraint product_reviews_funcionamiento check (functioning between 1 and 5),
  value_for_money smallint not null
    constraint product_reviews_valor check (value_for_money between 1 and 5),

  -- «¿Lo recomendarias?». Obligatorio, y NO se deduce de la puntuacion.
  recommends boolean not null,

  comment text
    constraint product_reviews_comentario
    check (comment is null or length(comment) <= 1000),

  status text not null default 'visible'
    constraint product_reviews_estado check (status in ('visible', 'hidden')),

  -- Por que se escondio. INTERNO: no sale en ninguna respuesta publica.
  moderation_reason text
    constraint product_reviews_motivo_moderacion
    check (moderation_reason is null or length(moderation_reason) <= 500),
  moderated_by uuid references public.profiles(id) on delete set null,
  moderated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- UNA POR LINEA DE PEDIDO. Es la unidad del blueprint §6.
  constraint product_reviews_una_por_linea unique (order_item_id),

  constraint product_reviews_escondida_con_fecha
    check ((status = 'hidden') = (moderated_at is not null)),

  -- QUIEN COMPRO, Y QUE ESTABA PAGADO.
  constraint product_reviews_de_su_compra
    foreign key (order_id, author_id, order_paid_at)
    references public.product_orders (id, buyer_id, paid_at)
    on delete restrict,

  -- LA LINEA ES DE ESE PEDIDO, Y ES DE ESE PRODUCTO.
  constraint product_reviews_de_esa_linea
    foreign key (order_item_id, order_id, product_id)
    references public.product_order_items (id, order_id, product_id)
    on delete restrict,

  -- Y EL PAQUETE LLEGO. `delivered_at` es NOT NULL aqui, asi que un envio sin
  -- entregar no puede emparejar.
  constraint product_reviews_con_entrega
    foreign key (order_id, delivered_at)
    references public.product_shipments (order_id, delivered_at)
    on delete restrict
);

-- LO QUE SE LEE AL PINTAR LA FICHA: las visibles de un producto, en orden
-- estable. `id` desempata para que la paginacion no repita ni se salte filas
-- cuando dos resenas comparten segundo.
create index if not exists product_reviews_del_producto
  on public.product_reviews (product_id, created_at desc, id desc)
  where status = 'visible';

-- EL RESUMEN. Sin esto, calcular el promedio de un producto con muchas resenas
-- recorre la tabla entera.
create index if not exists product_reviews_resumen_del_producto
  on public.product_reviews (product_id, overall)
  where status = 'visible';

create index if not exists product_reviews_de_la_persona
  on public.product_reviews (author_id, created_at desc, id desc);

-- LAS DOS COLAS DE MODERACION, y son dos a proposito.
--
-- La primera version solo indexaba las visibles, con el comentario «las
-- escondidas no vuelven a ella». Eso convertia esconder en una decision de un
-- solo sentido: una resena escondida por error no se podia encontrar otra vez
-- sin haber apuntado su identificador a mano. Lo encontro la revision
-- independiente.
create index if not exists product_reviews_por_moderar
  on public.product_reviews (created_at desc, id desc)
  where status = 'visible';

create index if not exists product_reviews_escondidas
  on public.product_reviews (moderated_at desc, id desc)
  where status = 'hidden';

-- Para saber que lineas de un pedido ya se valoraron sin recorrer nada.
create index if not exists product_reviews_del_pedido
  on public.product_reviews (order_id);

-- ------------------------------------------------------------------------- --
-- 3. La respuesta del proveedor. Publica, y una sola visible.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_review_replies (
  id uuid primary key default gen_random_uuid(),

  review_id uuid not null
    references public.product_reviews(id) on delete cascade,

  -- Quien respondio. Que sea el proveedor del producto se comprueba en el
  -- servicio contra `product_sellers.owner_id`; aqui queda constancia de quien
  -- escribio, que es lo que hace falta si despues hay que moderarlo.
  author_id uuid not null references public.profiles(id) on delete cascade,

  body text not null
    constraint product_review_replies_texto
    check (length(trim(body)) between 1 and 1000),

  status text not null default 'visible'
    constraint product_review_replies_estado
    check (status in ('visible', 'hidden')),

  moderation_reason text
    constraint product_review_replies_motivo
    check (moderation_reason is null or length(moderation_reason) <= 500),
  moderated_by uuid references public.profiles(id) on delete set null,
  moderated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint product_review_replies_escondida_con_fecha
    check ((status = 'hidden') = (moderated_at is not null))
);

-- UNA RESPUESTA VISIBLE POR RESENA. Las escondidas conviven en el historial.
create unique index if not exists product_review_replies_una_visible
  on public.product_review_replies (review_id)
  where status = 'visible';

create index if not exists product_review_replies_de_la_resena
  on public.product_review_replies (review_id, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 3.1. NADIE ESCONDE LO SUYO, y lo impone la base.
--
-- Es la misma regla que gobierna evaluar y publicar desde el Incremento 2
-- —«nadie evalua ni publica su propio producto, ni siendo administrador»— y
-- faltaba aqui. `profiles.role` incluye `moderator`, asi que un proveedor al
-- que se le diera rol de curaduria podia esconder todas las resenas malas de
-- su catalogo. Lo encontro la revision independiente del Incremento 8.
--
-- POR QUE UN DISPARADOR Y NO SOLO UN `if` EN LA RUTA. La ruta comprueba antes
-- que el rol, para dar el motivo de verdad y no un 403 generico. Pero el `if`
-- se puede esquivar desde cualquier otro sitio que escriba la fila, y el dia
-- que alguien relaje el rol la puerta desaparece. Esta capa no se esquiva.
--
-- UN CHECK NO SIRVE: el dueno esta a dos saltos —producto, vendedor, perfil— y
-- un CHECK no cruza tablas. Un disparador si.
-- ------------------------------------------------------------------------- --
create or replace function public.product_reviews_nadie_esconde_lo_suyo()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  dueno uuid;
  producto uuid;
begin
  if new.moderated_by is null then
    return new;
  end if;

  if tg_table_name = 'product_reviews' then
    producto := new.product_id;
  else
    select r.product_id into producto
      from public.product_reviews r
     where r.id = new.review_id;
  end if;

  select s.profile_id into dueno
    from public.products p
    join public.product_sellers s on s.id = p.seller_id
   where p.id = producto;

  if dueno is not null and dueno = new.moderated_by then
    raise exception
      'Nadie modera las resenas de su propio producto'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists product_reviews_no_modera_lo_suyo on public.product_reviews;
create trigger product_reviews_no_modera_lo_suyo
before insert or update on public.product_reviews
for each row execute function public.product_reviews_nadie_esconde_lo_suyo();

drop trigger if exists product_review_replies_no_modera_lo_suyo
  on public.product_review_replies;
create trigger product_review_replies_no_modera_lo_suyo
before insert or update on public.product_review_replies
for each row execute function public.product_reviews_nadie_esconde_lo_suyo();

-- ------------------------------------------------------------------------- --
-- 4. El historial de moderacion. SOLO SE ANADE.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_review_moderation (
  id uuid primary key default gen_random_uuid(),
  review_id uuid references public.product_reviews(id) on delete cascade,
  reply_id uuid references public.product_review_replies(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  from_status text,
  to_status text not null,
  reason text
    constraint product_review_moderation_motivo
    check (reason is null or length(reason) <= 500),
  created_at timestamptz not null default now(),

  -- Una fila habla de una resena O de una respuesta, nunca de las dos ni de
  -- ninguna: si no, no se sabe que se modero.
  constraint product_review_moderation_de_algo
    check ((review_id is null) <> (reply_id is null))
);

create index if not exists product_review_moderation_de_la_resena
  on public.product_review_moderation (review_id, created_at);

create index if not exists product_review_moderation_de_la_respuesta
  on public.product_review_moderation (reply_id, created_at);

create or replace function public.product_review_moderation_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'El historial de moderacion no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists product_review_moderation_inmutable
  on public.product_review_moderation;
create trigger product_review_moderation_inmutable
before update or delete on public.product_review_moderation
for each row execute function public.product_review_moderation_solo_anadir();

-- ------------------------------------------------------------------------- --
-- 5. RLS y permisos: cerrado. El movil pregunta por la API.
--
-- Una resena es publica, pero DE QUE COMPRA sale no lo es. `order_id`,
-- `order_item_id` y las dos fechas atan a una persona con un pedido concreto,
-- su direccion y su importe. Una politica `for select` sobre esta tabla
-- pondria eso a un `select` de distancia desde cualquier telefono.
-- ------------------------------------------------------------------------- --
alter table public.product_reviews enable row level security;
alter table public.product_review_replies enable row level security;
alter table public.product_review_moderation enable row level security;

revoke all on public.product_reviews from anon, authenticated;
revoke all on public.product_review_replies from anon, authenticated;
revoke all on public.product_review_moderation from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 6. Verificacion posterior.
-- ------------------------------------------------------------------------- --
do $$
declare
  permisos bigint;
begin
  -- ESTE FICHERO NO ESCRIBE NINGUNA FILA, y no se comprueba contando: contar
  -- y abortar haria que la migracion dejara de ser re-ejecutable en cuanto
  -- existiera una resena. Se comprueba leyendo el fichero, donde no hay ni un
  -- `insert`. La version anterior de este bloque contaba las filas y ejecutaba
  -- `null`, que no comprobaba nada; lo encontro la revision independiente.

  -- LAS TRES CLAVES AJENAS COMPUESTAS. Si falta una, «compra verificada» vuelve
  -- a depender de que el servidor se acuerde de comprobarlo.
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_reviews_de_su_compra' and contype = 'f'
  ) then
    raise exception 'La 0081 no ato la resena a su compra pagada';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_reviews_de_esa_linea' and contype = 'f'
  ) then
    raise exception 'La 0081 no ato la resena a su linea de pedido';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_reviews_con_entrega' and contype = 'f'
  ) then
    raise exception 'La 0081 no ato la resena a una entrega real';
  end if;

  -- Y QUE LAS DOS FECHAS SEAN NOT NULL. Con una nula, la clave ajena compuesta
  -- se cumple sola —MATCH SIMPLE— y la verificacion desaparece sin ruido.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_reviews'
       and column_name in ('order_paid_at', 'delivered_at')
       and is_nullable = 'YES'
  ) then
    raise exception 'Las fechas que verifican la compra no pueden ser nulas';
  end if;

  -- UNA POR LINEA DE PEDIDO.
  if not exists (
    select 1 from pg_constraint where conname = 'product_reviews_una_por_linea'
  ) then
    raise exception 'La 0081 no dejo la restriccion de una resena por linea';
  end if;

  -- NINGUN BOOLEANO ESCRIBIBLE QUE DIGA «VERIFICADA», y ninguna columna de
  -- adjuntos: el blueprint deja la multimedia para las incidencias.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_reviews'
       and column_name in (
         'verified', 'is_verified', 'verified_purchase',
         'media_path', 'media_url', 'attachments', 'photo_path'
       )
  ) then
    raise exception 'La resena no lleva sello escribible ni adjuntos';
  end if;

  -- NI IMPORTES NI NADA FINANCIERO. Una resena no mueve dinero.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_reviews'
       and column_name in (
         'amount_minor', 'refund_amount_minor', 'transfer_status', 'currency'
       )
  ) then
    raise exception 'La resena no habla de dinero';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'product_review_replies_una_visible'
  ) then
    raise exception 'La 0081 no dejo el indice de una respuesta visible';
  end if;

  -- EL HISTORIAL NO SE REESCRIBE.
  if not exists (
    select 1 from pg_trigger
     where tgname = 'product_review_moderation_inmutable' and not tgisinternal
  ) then
    raise exception 'La 0081 no dejo el disparador del historial';
  end if;

  -- Y NADIE MODERA LO SUYO. Sin estos dos, un proveedor con rol de curaduria
  -- entierra las resenas malas de su catalogo.
  if not exists (
    select 1 from pg_trigger
     where tgname = 'product_reviews_no_modera_lo_suyo' and not tgisinternal
  ) then
    raise exception 'La 0081 no dejo el disparador de la resena propia';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgname = 'product_review_replies_no_modera_lo_suyo'
       and not tgisinternal
  ) then
    raise exception 'La 0081 no dejo el disparador de la respuesta propia';
  end if;

  -- Y LAS DOS COLAS DE MODERACION, para que esconder no sea de un solo sentido.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'product_reviews_escondidas'
  ) then
    raise exception 'La 0081 no dejo el indice de las escondidas';
  end if;

  -- LAS OTRAS CUATRO MAQUINAS NO SE ENTERAN DE ESTA. Ni el pedido, ni el envio,
  -- ni la incidencia ganan un estado de resena. Se buscan valores concretos y
  -- no la palabra «REVIEW» suelta: `product_orders.status` ya tiene
  -- `UNDER_REVIEW`, que es del cobro y no tiene nada que ver con esto.
  if exists (
    select 1 from pg_constraint
     where conname in (
       'product_orders_estado', 'product_shipments_estado',
       'product_incidents_estado'
     )
       and (pg_get_constraintdef(oid) like '%REVIEWED%'
            or pg_get_constraintdef(oid) like '%RATED%'
            or pg_get_constraintdef(oid) like '%AWAITING_REVIEW%')
  ) then
    raise exception 'Ningun estado existente puede hablar de resenas';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in (
       'product_reviews', 'product_review_replies', 'product_review_moderation'
     )
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Las resenas de producto tienen % permisos sueltos', permisos;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------------------- --
-- 7. ROLLBACK.
--
--   drop table public.product_review_moderation;
--   drop table public.product_review_replies;
--   drop table public.product_reviews;
--   drop function public.product_review_moderation_solo_anadir();
--   drop function public.product_reviews_nadie_esconde_lo_suyo();
--
-- Y SOLO DESPUES, si de verdad se quiere deshacer entero, los tres indices
-- unicos redundantes. Quitarlos no es obligatorio —no estorban a nadie— y
-- dejarlos puestos es lo prudente: el dia que se vuelva a aplicar la 0081 ya
-- estan.
--
--   alter table public.product_shipments
--     drop constraint product_shipments_entrega_del_pedido;
--   alter table public.product_order_items
--     drop constraint product_order_items_del_pedido_y_producto;
--   alter table public.product_orders
--     drop constraint product_orders_comprador_y_cobro;
--
-- DESHACER ESTO BORRA LO QUE ESCRIBIO GENTE. Las resenas no son datos
-- derivados: son texto y puntuaciones que escribieron personas sobre lo que
-- compraron, y no se pueden reconstruir. Quien revierta tiene que decidir
-- antes si las exporta.
-- ------------------------------------------------------------------------- --
