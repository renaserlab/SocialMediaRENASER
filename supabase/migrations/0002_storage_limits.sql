-- Limites de subida por bucket.
--
-- Contexto: los buckets se crearon sin `file_size_limit`, por lo que heredaban
-- el limite global del proyecto (50 MB en el plan free) y cualquier video real
-- se rechazaba con un 413 disfrazado de HTTP 400.
--
-- IMPORTANTE: el limite de un bucket NO puede superar el limite global del
-- proyecto. Antes (o despues) de aplicar esto hay que subirlo en el dashboard:
--   Storage -> Settings -> Upload file size limit
-- En el plan Pro admite hasta 50 GB.

-- Los tamanos van con ::bigint: `file_size_limit` es bigint, pero Postgres
-- evalua la multiplicacion como integer y 2048 * 1024 * 1024 se pasa por 1 byte
-- del maximo de int4 (2147483647) -> ERROR 22003 integer out of range.

update storage.buckets
set file_size_limit = 500::bigint * 1024 * 1024,   -- 500 MB
    allowed_mime_types = array['image/*', 'video/*', 'audio/*']
where id = 'post-media';

update storage.buckets
set file_size_limit = 5::bigint * 1024 * 1024,     -- 5 MB, sobra para un avatar
    allowed_mime_types = array['image/*']
where id = 'avatars';

update storage.buckets
set file_size_limit = 2048::bigint * 1024 * 1024,  -- 2 GB, video de curso largo
    allowed_mime_types = array['image/*', 'video/*', 'audio/*', 'application/pdf']
where id = 'course-media';

update storage.buckets
set file_size_limit = 500::bigint * 1024 * 1024,   -- 500 MB
    allowed_mime_types = array['audio/*']
where id = 'audio-private';

-- Comprobacion: deberia listar los 4 buckets con su limite en MB.
select id, file_size_limit / 1024 / 1024 as limite_mb, allowed_mime_types
from storage.buckets
order by id;
