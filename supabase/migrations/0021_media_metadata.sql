-- Metadata de los medios y rutas de sus versiones optimizadas.
--
-- Hasta ahora `post_media` solo guardaba la ruta del archivo original. La
-- aplicacion no sabia ni cuanto media (saltos de layout al cargar cada foto),
-- ni cuanto duraba un video, ni tenia miniatura que ensenar mientras el video
-- descarga: cada tarjeta del muro era un hueco negro hasta tener bytes del
-- MP4. Y como no habia sitio donde apuntar una version optimizada, el movil
-- descargaba SIEMPRE el original (hay videos de 96-161 MB y fotos de 6 MB
-- subidos antes de la compresion en el dispositivo).
--
-- Todo opcional y sin tocar filas existentes: el contenido viejo sigue
-- funcionando con el original como respaldo. Las columnas nuevas las rellenan
-- (1) el movil al subir, con lo que calcula en el dispositivo, y (2) el
-- pipeline del backend / los scripts de reproceso para lo ya publicado.
--
-- El script es REPETIBLE.

alter table public.post_media
  add column if not exists width integer,
  add column if not exists height integer,
  -- Duracion en segundos (video/audio). `real` basta: no se factura con esto.
  add column if not exists duration_s real,
  add column if not exists bytes bigint,
  -- Miniatura/poster (imagen) del video: se pinta al instante en muro y shorts.
  add column if not exists poster_path text,
  -- Version optimizada para el feed: foto recomprimida o MP4 ligero (720p).
  -- El original NUNCA se toca; esto es una ruta adicional.
  add column if not exists feed_path text,
  -- Raiz del empaquetado HLS (master.m3u8 + renditions), si se genero.
  add column if not exists stream_path text,
  -- uploaded → processing → ready | failed. Para el contenido ya existente se
  -- da por 'ready': se sirve el original, como hasta ahora.
  add column if not exists processing_status text not null default 'ready';

-- El muro ordena lo publicado por fecha. El indice actual sobre created_at
-- tambien recorre borradores y eliminados; este es el recorrido exacto de la
-- consulta del feed.
create index if not exists posts_published_created_idx
  on public.posts (created_at desc)
  where status = 'published';

notify pgrst, 'reload schema';

-- Comprobacion: columnas nuevas visibles y cuantos medios quedan por procesar.
select
  count(*) as medios,
  count(*) filter (where poster_path is not null) as con_poster,
  count(*) filter (where feed_path is not null) as con_version_feed
from public.post_media;
