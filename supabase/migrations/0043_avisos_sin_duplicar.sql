-- =============================================================================
-- 0043 — Un aviso por acción lógica (`public.notifications`)
-- =============================================================================
--
-- ESTA MIGRACIÓN NO SE HA APLICADO. Se deja preparada a propósito: aplicar
-- cambios de esquema contra la base real es una decisión que se toma mirando,
-- no un efecto secundario de una tarea de producto.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ EL CÓDIGO FUNCIONA SIN ESTA MIGRACIÓN. Sin ella, `add_notification`        │
-- │ comprueba con un SELECT antes de escribir (ver `_ya_existe` en             │
-- │ `app/modules/notifications/service.py`): quita los duplicados que se ven   │
-- │ de verdad en la bandeja, pero NO cierra la carrera de dos peticiones       │
-- │ simultáneas, porque entre comprobar y escribir siempre queda una ventana.  │
-- │ Con ella, el duplicado lo impide la BASE y deja de depender de un `if`.    │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- QUÉ ARREGLA. La bandeja mostraba dos veces «Luis empezó a seguirte». No era
-- un fallo de pintado: eran dos filas en `notifications`, y llegaban por dos
-- caminos distintos.
--
--   1. Seguir, dejar de seguir y volver a seguir. `POST /profiles/{id}/follow`
--      escribía el aviso dentro de un `if existing is None` sobre `follows`, y
--      al dejar de seguir esa fila SE BORRA: la vez siguiente la comprobación
--      volvía a decir que era la primera. El aviso viejo seguía en la bandeja.
--      Lo mismo con el «me gusta»: `post_likes` también se borra al retirarlo.
--   2. Dos peticiones a la vez (doble toque, o el reintento del móvil al
--      cambiar de red). Las dos leen antes de que ninguna escriba, las dos ven
--      que no hay nada y las dos insertan.
--
-- POR QUÉ UNA COLUMNA NUEVA Y NO UN ÍNDICE ÚNICO SOBRE LAS QUE YA HAY. Ésta es
-- la decisión que importa, y es lo que hace que esta migración sea aplicable:
--
--     create unique index … on notifications (user_id, type, actor_id, entity_id)
--
-- NO SE PUEDE CREAR. En la base real ya hay duplicados guardados, y un índice
-- único falla si encuentra dos filas iguales. Para crearlo habría que BORRAR
-- filas primero, y una migración de este proyecto no puede exigir borrar
-- información de nadie (es la misma regla que la de que una vuelta atrás no
-- puede pedir borrar datos).
--
-- Con una columna nueva, las filas que ya existen se quedan a NULL. Y en
-- PostgreSQL —igual que en SQLite— dos NULL NO son iguales para un índice
-- único: ninguna fila existente choca con ninguna otra, el índice se crea sobre
-- la tabla llena sin tocar un solo dato, y sólo los avisos nuevos entran en el
-- reparto. Los duplicados que ya están se quedan como están, que es lo honesto:
-- ocurrieron.
--
-- QUÉ ENTRA EN LA CLAVE Y QUÉ NO. La calcula
-- `notifications.service.clave_de_aviso` y vale `user_id|type|actor_id|entity_id`
-- sólo para los tipos donde repetir no añade nada: `follow`, `like` y los seis
-- de la agenda. `comment` y `post_mention` NO llevan clave —quedan a NULL, y un
-- NULL nunca choca—: dos comentarios de la misma persona en la misma
-- publicación son dos cosas distintas que han pasado, y desetiquetar a alguien
-- y volver a etiquetarlo es una mención nueva, no un aviso repetido (está
-- decidido y probado). Deduplicarlos no quitaría un duplicado: escondería un
-- aviso legítimo.
--
-- POR QUÉ LA CLAVE SE CALCULA EN LA APLICACIÓN Y NO CON UNA COLUMNA GENERADA.
-- Una columna generada la calcularía también para las filas viejas, y entonces
-- volverían a chocar entre ellas y el índice no se podría crear: exactamente el
-- problema que esto evita. Además, qué tipos se deduplican es una regla de
-- producto, y su sitio es el código donde se lee y se prueba.
--
-- ES ADITIVA Y REPETIBLE. Añade una columna que admite nulos y un índice; no
-- borra, no altera ninguna columna existente, no toca una sola fila y no cambia
-- lo que devuelve ningún endpoint. Todo con `if not exists`.
--
-- SOBRE EL BLOQUEO. `create index` bloquea las escrituras de `notifications`
-- mientras se construye; con el tamaño actual son milisegundos. Si la tabla
-- creciera mucho antes de aplicarlo, usar `create index concurrently` (que no
-- se puede ejecutar dentro de una transacción, así que habría que lanzarlo
-- suelto, fuera de este script).
--
-- LA RLS NO CAMBIA. `notifications_own` y `notifications_update_own` siguen
-- igual: la columna nueva se escribe desde la API con la clave de servicio, y
-- nadie la lee desde el cliente.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La columna
-- -----------------------------------------------------------------------------
-- Admite nulos a propósito, y ésa es toda la gracia: es lo que permite crear el
-- índice único con la tabla llena de duplicados. Ver arriba.
alter table public.notifications
  add column if not exists dedupe_key text;

comment on column public.notifications.dedupe_key is
  'Identifica la ACCION LOGICA del aviso (usuario|tipo|actor|entidad). NULL en '
  'los avisos anteriores a la 0043 y en los tipos que no se deduplican, como '
  'comment: dos NULL no chocan en un indice unico. La calcula '
  'notifications.service.clave_de_aviso.';


-- -----------------------------------------------------------------------------
-- 2. El índice único
-- -----------------------------------------------------------------------------
-- Esto es la garantía. Dos peticiones simultáneas de «seguir» ejecutan las dos
-- su INSERT; la segunda no escribe nada porque este índice se lo impide, y el
-- backend lo pide con `on conflict (dedupe_key) do nothing`, así que la segunda
-- no recibe un error: recibe «no he escrito», que es lo que necesita saber para
-- no mandar también el push.
create unique index if not exists notifications_dedupe_key_uidx
  on public.notifications (dedupe_key);


-- -----------------------------------------------------------------------------
-- 3. Que PostgREST se entere del cambio de esquema
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';


-- -----------------------------------------------------------------------------
-- 4. Comprobación
-- -----------------------------------------------------------------------------
-- Debe devolver una fila con la columna y una con el índice. Si el índice no
-- aparece, NO forzar nada: revisar antes si hay filas con `dedupe_key` repetida
-- (no debería haberlas, porque acaban de nacer todas a NULL).
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications'
      and column_name = 'dedupe_key') as columna,
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'notifications_dedupe_key_uidx')
    as indice;
