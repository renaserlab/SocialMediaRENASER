-- =============================================================================
-- 0037 — Índices para las consultas calientes
-- =============================================================================
--
-- ESTA MIGRACIÓN NO SE HA APLICADO. Se deja preparada a propósito: aplicar
-- cambios de esquema contra la base real es una decisión que se toma mirando,
-- no un efecto secundario de una tarea de rendimiento.
--
-- QUÉ HACE Y QUÉ NO HACE. Solo crea índices. No borra, no altera ninguna
-- columna, no toca una sola fila y no cambia el comportamiento de nada. Un
-- índice de más cuesta espacio en disco y un poco de escritura; un índice que
-- falta cuesta un recorrido completo de la tabla en cada lectura.
--
-- POR QUÉ HACEN FALTA, EN GENERAL. PostgreSQL NO indexa las claves ajenas por
-- su cuenta, y una clave primaria compuesta solo sirve para su PRIMERA
-- columna: `follows` tiene la primaria `(follower_id, following_id)`, así que
-- preguntar «¿quién sigue a esta persona?» —que filtra por la segunda— no
-- puede usarla. Cada índice de abajo lleva la consulta concreta que lo pide.
--
-- HONESTIDAD SOBRE LA MEDICIÓN. Estos índices están justificados leyendo las
-- consultas y el inventario de índices existente, NO con EXPLAIN ANALYZE
-- contra producción: hacerlo requiere credenciales de la base que no estaban
-- disponibles. Hoy las tablas son pequeñas y el planificador elegirá
-- recorrido completo igualmente porque le sale más barato; el valor de esto
-- aparece cuando crezcan. Antes de aplicar, conviene comprobar cada uno con:
--
--   explain analyze <la consulta de la sección correspondiente>;
--
-- SOBRE EL BLOQUEO. `create index` bloquea las ESCRITURAS de esa tabla
-- mientras se construye. Con el tamaño actual son milisegundos. Si alguna de
-- estas tablas creciera mucho antes de aplicarlo, usar
-- `create index concurrently` (que no se puede ejecutar dentro de una
-- transacción, así que habría que lanzarlo suelto).
--
-- Todos son `if not exists`: repetir la migración no rompe nada.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. post_media — la tabla más leída que no tenía NI UN índice
-- -----------------------------------------------------------------------------
-- `post_media` se creó en la 0001 con la primaria en `id` y nada más. La 0021
-- le añadió columnas y tampoco añadió índices.
--
-- La pide CADA carga del muro: `_load_media_map` busca
-- `where post_media.post_id in (…20 ids…)` para adjuntar los medios de la
-- página (apps/api/app/modules/content/router.py). También la ficha de una
-- publicación, la página de una etiqueta y el muro recomendado.
create index if not exists post_media_post_idx
  on public.post_media (post_id);

-- El muro por defecto EXCLUYE el audio con
-- `posts.id not in (select post_id from post_media where media_type = 'audio')`,
-- y la cuadrícula del perfil filtra por `media_type`. Sin este índice, las dos
-- recorren la tabla entera en cada petición.
create index if not exists post_media_tipo_idx
  on public.post_media (media_type, post_id);


-- -----------------------------------------------------------------------------
-- 2. follows — «¿quién sigue a esta persona?»
-- -----------------------------------------------------------------------------
-- La primaria es `(follower_id, following_id)`: sirve para «a quién sigue X»
-- pero NO para el sentido contrario. Y el sentido contrario es el que se pinta
-- en cada perfil (el número de seguidores) y el que resuelve la lista de
-- seguidores.
create index if not exists follows_following_idx
  on public.follows (following_id);


-- -----------------------------------------------------------------------------
-- 3. user_blocks — se consulta en CADA petición del muro
-- -----------------------------------------------------------------------------
-- Los bloqueos se miran en los dos sentidos (ni yo veo a quien bloqueé, ni
-- quien me bloqueó me ve a mí), y eso es una unión de dos consultas. La
-- primaria `(blocker_id, blocked_id)` solo cubre la primera mitad; la segunda
-- —«¿quién me ha bloqueado?»— recorre la tabla entera.
create index if not exists user_blocks_blocked_idx
  on public.user_blocks (blocked_id);


-- -----------------------------------------------------------------------------
-- 4. conversation_members — la lista de Mensajes
-- -----------------------------------------------------------------------------
-- La primaria es `(conversation_id, user_id)`, pero la pantalla de Mensajes
-- pregunta al revés: «¿en qué conversaciones estoy YO?». Es la consulta que
-- abre la pantalla y la que cuenta los no leídos.
create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id);


-- -----------------------------------------------------------------------------
-- 5. course_modules / course_lessons — el temario de un curso
-- -----------------------------------------------------------------------------
-- Las dos se crearon en la 0001 con la primaria en `id` y sin índice por su
-- clave ajena. Se recorren al abrir un curso, al pintar la biblioteca y al
-- calcular el progreso.
create index if not exists course_modules_curso_idx
  on public.course_modules (course_id);

-- OJO: existe `course_lessons_preview_idx` (0034), pero es PARCIAL
-- (`where is_preview`), así que no sirve para buscar las lecciones de un
-- módulo en general.
create index if not exists course_lessons_modulo_idx
  on public.course_lessons (module_id);


-- -----------------------------------------------------------------------------
-- 6. purchases — cuántas personas tienen cada curso
-- -----------------------------------------------------------------------------
-- El índice que hay es `purchases_user_course_idx (user_id, course_id, status)`
-- y empieza por `user_id`. El recomendador de cursos pregunta por el otro
-- lado: agrupa por `course_id` filtrando por `status = 'paid'`, sin mencionar
-- `user_id`, así que no puede usarlo.
create index if not exists purchases_curso_estado_idx
  on public.purchases (course_id, status);


-- -----------------------------------------------------------------------------
-- 7. notifications — la bolita de «no leídas»
-- -----------------------------------------------------------------------------
-- `notifications_user_created_idx (user_id, created_at desc)` sirve para
-- LISTAR, pero para CONTAR las no leídas obliga a leer todos los avisos que
-- esa persona ha recibido en su vida para descartar los ya leídos.
--
-- Parcial a propósito: solo indexa las que están sin leer, que son unas pocas
-- y son justo las que se cuentan. Ocupa una fracción del índice completo.
create index if not exists notifications_sin_leer_idx
  on public.notifications (user_id)
  where read_at is null;
