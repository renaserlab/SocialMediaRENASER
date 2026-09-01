-- =============================================================================
-- 0046 — Buscar dentro del texto de los mensajes (índice trigram)
-- =============================================================================
--
-- ESTA MIGRACIÓN NO SE HA APLICADO todavía. Añade UNA extensión y UN índice.
-- No crea tablas, no añade columnas, no toca ni una fila y no cambia ninguna
-- restricción: es la migración menos invasiva de toda la serie.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ EL CÓDIGO FUNCIONA SIN ELLA, Y ADEMÁS SE NOTA POCO. La búsqueda de la     │
-- │ bandeja ya encuentra por NOMBRE y por USUARIO, que es lo que se pidió     │
-- │ como mínimo. Lo único que esta migración añade es encontrar también por   │
-- │ lo que se DIJO dentro de la conversación. Sin ella, quien lo comprueba es │
-- │ `messaging.esquema.hay_busqueda_en_mensajes`, y la búsqueda se queda      │
-- │ exactamente como está hoy: ni un error, ni una consulta de más.           │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- =============================================================================
-- POR QUÉ HACE FALTA UN ÍNDICE, Y POR QUÉ NO SE HIZO SIN ÉL
-- =============================================================================
--
-- Buscar dentro del texto es `body ILIKE '%loquesea%'`. Un patrón que empieza
-- por comodín NO puede usar un índice B-tree corriente: da igual que
-- `messages.body` estuviera indexado, PostgreSQL haría un recorrido secuencial
-- de la tabla más grande de la aplicación en cada tecleo.
--
-- `pg_trgm` parte cada texto en grupos de tres letras y los indexa. Con eso, un
-- `ILIKE '%...%'` sí tiene por dónde entrar. Es la única forma de que esto no
-- se convierta en el cuello de botella de la pantalla más usada.
--
-- =============================================================================
-- LO ÚNICO QUE PUEDE MORDER: EL BLOQUEO AL CREAR EL ÍNDICE
-- =============================================================================
--
-- `CREATE INDEX` toma un bloqueo SHARE sobre la tabla. Leer sigue funcionando,
-- pero **mientras el índice se construye no se puede escribir**: nadie manda un
-- mensaje. Con la tabla de hoy eso son milisegundos y no lo nota nadie.
--
-- SI ALGÚN DÍA `messages` ES GRANDE —digamos cientos de miles de filas— NO se
-- ejecuta esta migración tal cual. Se ejecuta esta única sentencia, a mano y
-- **fuera de cualquier transacción**, que construye el índice sin bloquear las
-- escrituras:
--
--     create index concurrently if not exists messages_body_trgm_idx
--       on public.messages using gin (body gin_trgm_ops);
--
-- No se pone así por defecto porque `CREATE INDEX CONCURRENTLY` **no puede
-- correr dentro de un bloque de transacción**, y no hay forma de saber desde
-- aquí si quien la ejecuta la envuelve en una. Fallaría, y fallar por la forma
-- de ejecutarla es peor que un bloqueo de milisegundos. Si se hace por el
-- camino concurrente y la construcción falla a medias, el índice queda
-- `INVALID`: se borra con `drop index` y se repite. Nada más se rompe.
--
-- =============================================================================
-- LO QUE ESTA MIGRACIÓN **NO** HACE
-- =============================================================================
--
--   * NO crea ni borra tablas, columnas, políticas ni restricciones.
--   * NO toca ni una fila. No hay `insert`, `update`, `delete` ni `truncate`.
--   * NO cambia la RLS de `messages`: quién puede leer qué mensaje se decide
--     exactamente igual que antes. Un índice no concede acceso a nada; solo
--     acelera una consulta que ya estaba permitida.
--   * NO cambia lo que la búsqueda encontraba antes. Es ADITIVA también en el
--     resultado: una conversación que aparecía por nombre sigue apareciendo.
--     Lo único que pasa es que ahora también aparecen las que coinciden por el
--     texto de un mensaje.
--
-- =============================================================================
-- DESPUÉS DE APLICARLA, REINICIA LA API.
-- =============================================================================
--
-- `messaging/esquema.py` comprueba UNA VEZ POR PROCESO qué hay en la base y se
-- queda con la respuesta —preguntarlo en cada petición costaría un viaje por
-- búsqueda—. Mientras el proceso siga vivo con el «no» de antes, la búsqueda
-- seguirá mirando solo nombres y usuarios. No se rompe nada: simplemente no se
-- entera de que ya puede hacer más.
--
-- Es la misma advertencia de la 0044 y de las 0027 a 0030, y este proyecto ya
-- la ha pagado varias veces.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- 1. La extensión
-- -----------------------------------------------------------------------------
-- En Supabase las extensiones viven en el esquema `extensions`, que ya está en
-- el `search_path` por defecto. `if not exists` la deja quieta si alguien ya la
-- instaló —aunque fuera en otro esquema—, así que repetir esta migración no
-- puede mover nada de sitio.
create extension if not exists pg_trgm with schema extensions;


-- -----------------------------------------------------------------------------
-- 2. El índice
-- -----------------------------------------------------------------------------
-- GIN y no GiST: para `ILIKE` sobre texto que se escribe una vez y se lee
-- muchas, GIN busca bastante más rápido. GiST solo compensa cuando la columna
-- se actualiza sin parar, y el cuerpo de un mensaje no se edita: se manda una
-- vez y ya está.
--
-- `if not exists` para que volver a pasarla sea un no-op, como las anteriores.
create index if not exists messages_body_trgm_idx
  on public.messages using gin (body gin_trgm_ops);


-- -----------------------------------------------------------------------------
-- 3. Que PostgREST se entere (por costumbre; aquí no cambia ningún contrato)
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';


-- =============================================================================
-- 4. COMPROBACIÓN AUTOMÁTICA — aborta si no quedó como debe
-- =============================================================================
--
-- POR QUÉ SE COMPRUEBA AQUÍ Y NO SOLO EN LOS COMENTARIOS DE ABAJO. Porque hay
-- una forma silenciosa de que esto salga mal: que el índice se cree pero quede
-- `INVALID` —le pasa a una construcción concurrente interrumpida—. Un índice
-- inválido EXISTE para `pg_indexes`, así que la comprobación de esquema de la
-- API diría que sí, y el planificador no lo usaría: la búsqueda dentro de los
-- mensajes se activaría y sería un recorrido secuencial, que es exactamente lo
-- que esta migración venía a evitar.
--
-- Es el mismo razonamiento de la 0044 con el nombre del `CHECK`: lo que falla
-- en silencio se comprueba, no se supone.
do $$
declare
  invalido boolean;
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = 'messages_body_trgm_idx' and n.nspname = 'public'
  ) then
    raise exception
      'La 0046 no ha creado `messages_body_trgm_idx`. Sin el, buscar dentro de '
      'los mensajes seria un recorrido secuencial de la tabla mas grande.';
  end if;

  select not i.indisvalid into invalido
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where c.relname = 'messages_body_trgm_idx';

  if invalido then
    raise exception
      'El indice `messages_body_trgm_idx` existe pero esta INVALID (una '
      'construccion concurrente interrumpida). Borralo con `drop index '
      'public.messages_body_trgm_idx;` y vuelve a crearlo.';
  end if;
end $$;


-- =============================================================================
-- COMPROBACIONES A MANO (ejecutar DESPUÉS, una a una)
-- =============================================================================
--
-- 1. La extensión está.
-- select extname, extnamespace::regnamespace from pg_extension where extname = 'pg_trgm';
-- Esperado: una fila, normalmente en `extensions`.
--
-- 2. El índice existe, es GIN y es válido.
-- select i.indisvalid, am.amname, pg_get_indexdef(i.indexrelid)
-- from pg_index i
-- join pg_class c on c.oid = i.indexrelid
-- join pg_am am on am.oid = c.relam
-- where c.relname = 'messages_body_trgm_idx';
-- Esperado: indisvalid = true, amname = 'gin'.
--
-- 3. NO se ha tocado ninguna fila. El número de mensajes es el mismo de antes.
-- select count(*) from public.messages;
--
-- 4. La RLS de `messages` sigue exactamente igual (esta migración no la toca).
-- select policyname, cmd from pg_policies
-- where schemaname = 'public' and tablename = 'messages' order by policyname;
--
-- 5. El planificador lo usa de verdad. Con la tabla casi vacía puede preferir
--    el recorrido secuencial porque es más barato, y eso es CORRECTO: la
--    comprobación de verdad es que aparezca `Bitmap Index Scan` cuando hay
--    volumen. Para forzarlo y verlo:
-- set enable_seqscan = off;
-- explain select 1 from public.messages where body ilike '%hola%';
-- reset enable_seqscan;
-- Esperado: `Bitmap Index Scan on messages_body_trgm_idx`.
