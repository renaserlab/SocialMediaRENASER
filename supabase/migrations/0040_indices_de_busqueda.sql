-- =============================================================================
-- 0040 — Índices para la búsqueda global (`GET /api/v1/search`)
-- =============================================================================
--
-- ESTA MIGRACIÓN NO SE HA APLICADO. Se deja preparada a propósito: aplicar
-- cambios de esquema contra la base real es una decisión que se toma mirando,
-- no un efecto secundario de una tarea de producto.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ EL CÓDIGO FUNCIONA SIN ESTA MIGRACIÓN. Aplicarla no cambia NI UN           │
-- │ resultado: cambia lo que tarda en salir. La búsqueda entera está escrita   │
-- │ con `ilike` y con las tablas de temas que ya existen (0026/0027/0028), así │
-- │ que sin estos índices PostgreSQL hace un recorrido secuencial y devuelve   │
-- │ exactamente lo mismo, más despacio. No hay ninguna consulta del backend    │
-- │ que necesite algo de aquí para poder escribirse.                           │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- QUÉ HACE Y QUÉ NO HACE. Habilita una extensión de contrib (`pg_trgm`, que
-- viene con PostgreSQL y está disponible en Supabase) y crea índices. No borra,
-- no altera ninguna columna, no toca una sola fila y no cambia el
-- comportamiento de nada. Es aditiva y repetible: todo `if not exists`.
--
-- POR QUÉ TRIGRAMAS Y NO OTRA COSA. La búsqueda pregunta
-- `columna ilike '%carpinteria%'`. Un índice btree NO sirve para un patrón que
-- empieza por comodín —solo cubre prefijos—, así que hoy cada búsqueda recorre
-- `profiles`, `posts`, `courses` y `events` enteras. El índice GIN de trigramas
-- es la respuesta estándar de PostgreSQL a exactamente ese patrón, y es
-- contrib: no es un proveedor nuevo, no es un servicio que mantener y no añade
-- coste.
--
-- LO QUE NO SE HA HECHO Y POR QUÉ, que importa tanto como lo que sí:
--
--   · NO se crea `to_tsvector('spanish', …)` ni ninguna columna generada de
--     texto completo. El FTS no existe en SQLite, que es la base sobre la que
--     corre la suite entera; usarlo obligaría a escribir dos consultas por cada
--     búsqueda —una para producción y otra para las pruebas— y entonces lo que
--     se prueba deja de ser lo que se despliega. Además, lo que de verdad hacía
--     falta del FTS (que «muebles» tenga que ver con carpintería) NO lo resuelve
--     el diccionario del castellano: lo resuelve la taxonomía de `topics`, que
--     ya está aplicada. Ver `app/modules/search/vocabulario.py`.
--   · NO se toca `pgvector`, ni embeddings, ni ningún proveedor externo.
--   · NO se crean índices para los patrones «tolerantes a tildes»
--     (`c_rp_nt_r__`, ver `normalizacion._esqueleto`): un patrón lleno de
--     comodines de una letra no puede usar el índice de trigramas. Esos
--     seguirán costando un recorrido, y por eso el patrón exacto se prueba
--     SIEMPRE primero y el tolerante solo a partir de cinco letras.
--
-- HONESTIDAD SOBRE LA MEDICIÓN. Igual que la 0037: estos índices están
-- justificados leyendo las consultas de `app/modules/search/repositorio.py`, NO
-- con EXPLAIN ANALYZE contra producción, porque hacerlo requiere credenciales
-- de la base que no estaban disponibles. Hoy las tablas son pequeñas y el
-- planificador elegirá recorrido secuencial igualmente porque le sale más
-- barato; el valor aparece cuando crezcan. Antes de aplicar, conviene
-- comprobar cada bloque con:
--
--   explain analyze select id from public.posts
--    where status = 'published' and body ilike '%carpinteria%' limit 10;
--
-- SOBRE EL COSTE. Un índice GIN de trigramas ocupa bastante (del orden del
-- tamaño del texto indexado) y encarece las escrituras de esa columna. Se ha
-- limitado a las columnas que la búsqueda consulta DE VERDAD, y `posts` va con
-- índice parcial (`where status = 'published'`) porque lo retirado y los
-- borradores no se buscan nunca.
--
-- SOBRE EL BLOQUEO. `create index` bloquea las ESCRITURAS de esa tabla mientras
-- se construye. Con el tamaño actual son milisegundos. Si `posts` creciera
-- mucho antes de aplicarlo, usar `create index concurrently` (que no se puede
-- ejecutar dentro de una transacción, así que habría que lanzarlo suelto).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. La extensión
-- -----------------------------------------------------------------------------
-- `pg_trgm` viene con PostgreSQL (contrib) y Supabase la trae disponible. Se
-- instala en el esquema `extensions`, que es donde Supabase pone las suyas,
-- para no ensuciar `public`.
--
-- SI ESTA LÍNEA FALLA POR PERMISOS, el resto de la migración no se puede
-- aplicar —y no pasa nada: la búsqueda sigue funcionando igual de bien, solo
-- que más lenta. No hay que buscar un plan B ni cambiar el código.
create extension if not exists pg_trgm with schema extensions;


-- -----------------------------------------------------------------------------
-- 1. profiles — buscar personas por nombre, usuario y biografía
-- -----------------------------------------------------------------------------
-- La consulta: `repositorio.personas` hace
--   `profiles.username ilike '%x%' or profiles.full_name ilike '%x%'`
-- y, solo para perfiles públicos, también `profiles.bio ilike '%x%'`.
--
-- `profiles` la recorre HOY cada pulsación de tecla de la pantalla de buscar
-- (con el rebote de 300 ms, varias veces por búsqueda), y también
-- `/mentions/candidates` mientras alguien escribe una mención. Es la tabla que
-- más se beneficia de esto.
create index if not exists profiles_full_name_trgm_idx
  on public.profiles using gin (full_name extensions.gin_trgm_ops);

create index if not exists profiles_username_trgm_idx
  on public.profiles using gin (username extensions.gin_trgm_ops);

-- La biografía es texto largo y solo se consulta para perfiles públicos, así
-- que el índice va parcial: un perfil privado no se descubre por su biografía
-- (es la regla de `repositorio.personas`) y por tanto no hace falta indexarla.
create index if not exists profiles_bio_publica_trgm_idx
  on public.profiles using gin (bio extensions.gin_trgm_ops)
  where is_private = false;


-- -----------------------------------------------------------------------------
-- 2. posts — buscar publicaciones por su cuerpo
-- -----------------------------------------------------------------------------
-- La consulta: `repositorio.publicaciones` hace `posts.body ilike '%x%'`
-- filtrando siempre por `status = 'published'`.
--
-- ES EL ÍNDICE QUE MÁS IMPORTA DE TODA LA MIGRACIÓN, porque es el que hace
-- posible lo que antes no existía: buscar sobre TODAS las publicaciones y no
-- sobre las veinte que el teléfono ya se había descargado. Sin él, cada
-- búsqueda lee `posts` entera.
--
-- Parcial a propósito: los borradores y lo retirado no salen nunca en una
-- búsqueda, así que indexarlos sería pagar espacio y escrituras por filas que
-- el índice jamás va a devolver.
create index if not exists posts_body_publicados_trgm_idx
  on public.posts using gin (body extensions.gin_trgm_ops)
  where status = 'published';


-- -----------------------------------------------------------------------------
-- 3. courses — buscar cursos por título y descripción
-- -----------------------------------------------------------------------------
-- La consulta: `repositorio.cursos` hace
--   `courses.title ilike '%x%' or courses.description ilike '%x%'`
-- con `status = 'published'`.
--
-- Esto sustituye a descargarse el catálogo entero en el teléfono y filtrarlo
-- con un `includes`. Parciales por el mismo motivo que `posts`.
create index if not exists courses_title_publicados_trgm_idx
  on public.courses using gin (title extensions.gin_trgm_ops)
  where status = 'published';

create index if not exists courses_description_publicados_trgm_idx
  on public.courses using gin (description extensions.gin_trgm_ops)
  where status = 'published';

-- El subtítulo lo añadió la 0034. `if not exists` sobre una columna que no
-- existe SÍ falla, así que va condicionado: sin la 0034 esta parte se salta
-- sola y la búsqueda por subtítulo no ocurre de todas formas (el backend ya lo
-- comprueba con `catalog.esquema.hay_cursos_v2`).
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'courses'
       and column_name = 'subtitle'
  ) then
    create index if not exists courses_subtitle_trgm_idx
      on public.courses using gin (subtitle extensions.gin_trgm_ops);
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 4. events — buscar eventos por título, descripción y lugar
-- -----------------------------------------------------------------------------
-- La consulta: `repositorio.eventos`. Los eventos ya estaban en la búsqueda,
-- también filtrando el listado completo en el cliente.
--
-- Un solo índice sobre las tres columnas concatenadas y no tres índices: son
-- pocas filas, siempre se consultan las tres a la vez con `or`, y así se paga
-- un índice en vez de tres. `coalesce` porque `description` y `location` son
-- opcionales y `null || texto` es `null`.
create index if not exists events_texto_publicados_trgm_idx
  on public.events using gin (
    (title || ' ' || coalesce(description, '') || ' ' || coalesce(location, ''))
    extensions.gin_trgm_ops
  )
  where status = 'published';


-- -----------------------------------------------------------------------------
-- 5. user_topic_relations — quién OFRECE un tema
-- -----------------------------------------------------------------------------
-- La consulta: `repositorio._oferta_publica` hace
--   `where topic_id in (…) and relation in ('can_help','teach','experienced')`.
--
-- La 0026 ya creó `user_topic_relations_topic_idx (topic_id)`. Este añade
-- `relation` como segunda columna para que el filtro se resuelva dentro del
-- índice: en un tema popular, la mitad de las filas son demanda («learn») y
-- hoy hay que leerlas todas de la tabla solo para descartarlas.
--
-- LEER LA DEMANDA PARA DESCARTARLA NO ES UN PROBLEMA DE PRIVACIDAD —el filtro
-- está en la consulta y en la respuesta, ver `repositorio._oferta_publica` y
-- `_temas_ofrecidos`— pero sí es trabajo tirado.
create index if not exists user_topic_relations_oferta_idx
  on public.user_topic_relations (topic_id, relation, user_id);
