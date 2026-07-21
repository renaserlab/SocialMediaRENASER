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

update storage.buckets
set file_size_limit = 500 * 1024 * 1024,          -- 500 MB
    allowed_mime_types = array['image/*', 'video/*', 'audio/*']
where id = 'post-media';

update storage.buckets
set file_size_limit = 5 * 1024 * 1024,            -- 5 MB, sobra para un avatar
    allowed_mime_types = array['image/*']
where id = 'avatars';

update storage.buckets
set file_size_limit = 2048 * 1024 * 1024,         -- 2 GB, video de curso largo
    allowed_mime_types = array['image/*', 'video/*', 'audio/*', 'application/pdf']
where id = 'course-media';

update storage.buckets
set file_size_limit = 500 * 1024 * 1024,          -- 500 MB
    allowed_mime_types = array['audio/*']
where id = 'audio-private';
