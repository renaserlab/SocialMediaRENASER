-- 0117 · Calidades de video elegidas una vez por video (480/560/720)
--
-- QUÉ RESUELVE. Cada video en S3 puede tener, además de lo que ya sirve
-- (`feed-720` u original), peldaños más ligeros de 480p y 560p. La app elige
-- UNO al empezar según su red y no lo cambia a mitad del video (como TikTok:
-- Dashlet, NSDI 2023, §2.2). La API necesita saber, fila por fila, qué
-- peldaños existen y dónde están: eso es `post_media.variantes`.
--
-- QUÉ HACE. Una columna `variantes jsonb` NULLABLE, sin valor por defecto:
--
--   [{"alto": 480, "clave": "videos/<uid>/<medio>/calidades-v1/480p.mp4",
--     "bitrate": 970000, "bytes": 3658798}, …]
--
-- `alto` es el lado menor (la «p»). El peldaño de arriba NO va aquí: es el
-- `feed_path` o el `storage_path` de siempre.
--
-- LA API FUNCIONA SIN ELLA. Mira una vez si la columna existe
-- (`modules/medios/calidades.py`) y, mientras falte, no genera ni entrega
-- calidades. Y la API ANTERIOR funciona igual con ella aplicada: no la nombra.
-- Además, con `video_calidades_enabled` y `video_calidades_lectura` apagadas
-- (de fábrica), la API ni siquiera pregunta por ella.
--
-- POLÍTICAS: ninguna nueva. La columna se lee con las de la fila; saber la
-- clave de un peldaño no da acceso a nada sin una firma de la API.
--
-- BLOQUEOS. Añadir una columna nullable sin valor por defecto no reescribe la
-- tabla. El CHECK la lee entera para validarla (todas NULL: milisegundos).
--
-- ES REPETIBLE. Se pega entera, como una sola transacción.

set local lock_timeout = '5s';

alter table public.post_media
  add column if not exists variantes jsonb;

alter table public.post_media
  drop constraint if exists post_media_variantes_check;
alter table public.post_media
  add constraint post_media_variantes_check
  check (variantes is null or jsonb_typeof(variantes) = 'array');

notify pgrst, 'reload schema';

-- Comprobación: debe devolver una fila con 'jsonb', 'YES'.
select data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'post_media'
  and column_name = 'variantes';


-- -----------------------------------------------------------------------------
-- VUELTA ATRÁS (rollback)
-- -----------------------------------------------------------------------------
-- Apagar antes `video_calidades_enabled` y `video_calidades_lectura` y
-- REINICIAR la API (recuerda el «sí» de la columna). Los archivos
-- `calidades-v1/` se quedan en S3 sin que nadie los nombre; se borran con la
-- publicación o con la baja de la cuenta, como el resto de la carpeta.
--
--   alter table public.post_media drop constraint if exists post_media_variantes_check;
--   alter table public.post_media drop column if exists variantes;
--   notify pgrst, 'reload schema';
