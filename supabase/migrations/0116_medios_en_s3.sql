-- 0116 · Videos de publicaciones en S3 + CloudFront (spec «opción B», v3)
--
-- QUÉ RESUELVE. Los videos nuevos de las publicaciones pasan a guardarse en un
-- bucket S3 privado y a servirse por una CloudFront propia con nodos en
-- Sudamérica, con URLs firmadas que da la API después de revisar quién puede
-- ver la publicación. Supabase sigue guardando todo lo demás. Durante la
-- convivencia hay que saber, fila por fila, de dónde sale cada video: eso es
-- `post_media.almacen`.
--
-- QUÉ HACE.
--
--   · `post_media.almacen text not null default 'supabase'`, con su `CHECK`
--     ('supabase' | 's3'). Con 's3', `storage_path`, `poster_path`,
--     `feed_path` y `stream_path` guardan CLAVES DE S3
--     (`videos/<uid>/<media_id>/…`); con 'supabase', rutas del bucket
--     `post-media` como siempre. Todas las filas que ya existen leen
--     'supabase' por el valor por defecto, sin reescribir la tabla.
--   · Un índice PARCIAL sobre las filas 's3': la API pregunta «¿cuáles de
--     estas publicaciones tienen videos en S3?» en cada página del muro (para
--     esconderlas a una app vieja o cuando la lectura está apagada), y con el
--     índice esa pregunta no recorre la tabla. Mientras no haya filas 's3' el
--     índice está vacío.
--   · `medios_subidas`: las subidas abiertas a `pendientes/<uid>/…`. Sirve para
--     reanudar una subida por partes, para el límite de 20 publicaciones con
--     video por hora (contado por `grupo`, el UUID que la app genera por
--     publicación: video y póster cuentan una vez) y para la limpieza diaria.
--   · `post_media_respaldo_supabase`: las rutas viejas de cada video que la
--     fase 4 migre de Supabase a S3, guardadas ANTES de sobrescribirlas. Sin
--     ella, devolver una fila migrada a Supabase sería imposible.
--
-- RLS CERRADA EN LAS DOS TABLAS NUEVAS: activada, sin ninguna política y con
-- `revoke all` a `anon` y `authenticated`. Solo la API (service role / dueño
-- de la conexión) las lee y escribe. Una subida ajena o el mapa de rutas
-- viejas no tienen por qué verse desde PostgREST.
--
-- `post_media` NO cambia de políticas: la columna nueva se lee con las mismas
-- que ya tiene la fila. Saber que un video vive en S3 no da acceso a nada: sin
-- una firma de la API, CloudFront contesta 403.
--
-- LA API FUNCIONA SIN ELLA. Se puede desplegar antes de pegar esto: la API
-- mira una vez por proceso si la columna existe
-- (`modules/medios/esquema.py`) y, mientras falte, se comporta como hoy (todo
-- es Supabase y los endpoints de subida a S3 responden 503). Y la API
-- ANTERIOR funciona igual con ella aplicada: no nombra la columna, y lo que
-- inserta recibe 'supabase' por defecto.
--
-- BLOQUEOS. Añadir la columna con un valor por defecto constante no reescribe
-- la tabla (PostgreSQL 11+), pero el `CHECK` la lee entera para validarla:
-- con las filas de hoy son milisegundos. Con `lock_timeout` se rinde a los 5 s,
-- se revierte entera y se puede volver a lanzar.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada. Se
-- pega entera, como una sola transacción (lo que hace el editor de Supabase);
-- fuera del editor: `psql -1 -f`.
--
-- La comprobación y la vuelta atrás están al final.

set local lock_timeout = '5s';


-- -----------------------------------------------------------------------------
-- 1. De dónde sale cada medio
-- -----------------------------------------------------------------------------
alter table public.post_media
  add column if not exists almacen text not null default 'supabase';

-- Con nombre y por separado, como en la 0113: así se puede volver a declarar
-- sin error y el modelo de la API lo repite con el mismo nombre.
alter table public.post_media
  drop constraint if exists post_media_almacen_check;
alter table public.post_media
  add constraint post_media_almacen_check
  check (almacen in ('supabase', 's3'));

create index if not exists post_media_almacen_idx
  on public.post_media (post_id)
  where almacen = 's3';


-- -----------------------------------------------------------------------------
-- 2. Subidas a S3 abiertas
-- -----------------------------------------------------------------------------
-- `uid` con borrado en cascada: si la cuenta se va, su registro de subidas se
-- va con ella (los objetos de `pendientes/<uid>/` los borra la baja y, si no,
-- el ciclo de vida del bucket a las 24 h).
--
-- `estado`:
--   abierta    la URL de subida (simple) o el multipart (partes) existen;
--   subida     el multipart se cerró con `completar` (una simple pasa directo
--              de abierta a usada: S3 no avisa cuando termina un PUT);
--   usada      se publicó: el objeto se copió a `videos/…` (`media_id`);
--   cancelada  la app la canceló (`DELETE`);
--   vencida    la limpieza diaria la cerró por vieja.
create table if not exists public.medios_subidas (
  id uuid primary key default gen_random_uuid(),
  uid uuid not null references public.profiles (id) on delete cascade,
  grupo uuid not null,
  tipo text not null,
  clave_pendiente text not null,
  content_type text not null,
  bytes_declarados bigint not null,
  upload_id text,
  partes_totales integer,
  estado text not null default 'abierta',
  media_id uuid,
  creada timestamptz not null default now(),
  expira timestamptz not null,
  constraint medios_subidas_tipo_check check (tipo in ('video', 'poster')),
  constraint medios_subidas_estado_check
    check (estado in ('abierta', 'subida', 'usada', 'cancelada', 'vencida')),
  constraint medios_subidas_bytes_check check (bytes_declarados > 0),
  constraint medios_subidas_clave_check check (clave_pendiente like 'pendientes/%')
);

-- El límite por hora cuenta los grupos de una cuenta en la última hora.
create index if not exists medios_subidas_uid_creada_idx
  on public.medios_subidas (uid, creada desc);
-- La limpieza diaria busca las abiertas vencidas.
create index if not exists medios_subidas_vivas_idx
  on public.medios_subidas (expira)
  where estado in ('abierta', 'subida');

alter table public.medios_subidas enable row level security;
revoke all on public.medios_subidas from anon, authenticated;


-- -----------------------------------------------------------------------------
-- 3. Respaldo de rutas de la fase 4
-- -----------------------------------------------------------------------------
-- Una fila por medio migrado. Sin clave ajena a `post_media` a propósito: si
-- la publicación se borra de verdad, el respaldo sigue diciendo dónde estaban
-- los archivos de Supabase que quedan por limpiar.
create table if not exists public.post_media_respaldo_supabase (
  media_id uuid primary key,
  storage_path text not null,
  poster_path text,
  feed_path text,
  stream_path text,
  migrado_en timestamptz not null default now()
);

alter table public.post_media_respaldo_supabase enable row level security;
revoke all on public.post_media_respaldo_supabase from anon, authenticated;


notify pgrst, 'reload schema';

-- Comprobación: debe devolver una fila con 'supabase', true, true, true.
select
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'post_media'
      and column_name = 'almacen') as almacen_por_defecto,
  (select relrowsecurity from pg_class
    where oid = 'public.medios_subidas'::regclass) as subidas_con_rls,
  (select relrowsecurity from pg_class
    where oid = 'public.post_media_respaldo_supabase'::regclass) as respaldo_con_rls,
  not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('medios_subidas', 'post_media_respaldo_supabase')
  ) as sin_politicas;


-- -----------------------------------------------------------------------------
-- VERIFICACIÓN A MANO (no se ejecuta sola)
-- -----------------------------------------------------------------------------
-- Cuántos medios hay en cada almacén:
--
--   select almacen, media_type, count(*) from public.post_media group by 1, 2;
--
-- -----------------------------------------------------------------------------
-- VUELTA ATRÁS (rollback)
-- -----------------------------------------------------------------------------
-- SOLO MIENTRAS NO HAYA FILAS 's3' (y antes de la fase 4). Con filas 's3', borrar
-- la columna convertiría esos videos en rutas de Supabase que no existen: antes
-- hay que devolverlas con `post_media_respaldo_supabase` o borrarlas.
--
--   select count(*) from public.post_media where almacen = 's3';  -- debe ser 0
--
-- Después hay que REINICIAR LA API (recuerda el «sí» de la columna). No se
-- pierde ninguna publicación: la API anterior no conoce nada de esto.
--
--   drop table if exists public.post_media_respaldo_supabase;
--   drop table if exists public.medios_subidas;
--   drop index if exists public.post_media_almacen_idx;
--   alter table public.post_media drop constraint if exists post_media_almacen_check;
--   alter table public.post_media drop column if exists almacen;
--   notify pgrst, 'reload schema';
