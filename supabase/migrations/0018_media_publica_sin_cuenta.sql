-- Ver fotos y videos del muro sin haber iniciado sesion.
--
-- La aplicacion ya se recorre sin cuenta, pero las publicaciones salian sin su
-- imagen: el bucket `post-media` solo dejaba leer a cuentas autenticadas, asi
-- que sin sesion no se podian firmar las URLs y el muro quedaba en puro texto.
-- Es justo lo contrario de lo que se busca —que se vea el contenido y por eso
-- merezca la pena registrarse.
--
-- SOLO SE ABREN IMAGENES Y VIDEOS. Los audios viven en el mismo bucket y son
-- los episodios del podcast, que se liberan uno cada ocho horas: dejarlos
-- legibles sin cuenta saltaria ese bloqueo y regalaria el contenido de la
-- membresia. Por eso la politica filtra por tipo de archivo y no por bucket.
--
-- Sigue sin ser un bucket abierto: cada archivo se sirve con una URL firmada y
-- de vida corta, y escribir continua reservado a la persona propietaria.
--
-- El script es REPETIBLE.

-- Lectura anonima, limitada a fotos y videos.
drop policy if exists post_media_anon_read on storage.objects;
create policy post_media_anon_read on storage.objects
  for select to anon
  using (
    bucket_id = 'post-media'
    and coalesce(metadata->>'mimetype', '') similar to '(image|video)/%'
  );

notify pgrst, 'reload schema';

-- Comprobacion final: cuantos archivos quedan visibles sin cuenta y cuantos
-- siguen protegidos.
select
  count(*) filter (
    where coalesce(metadata->>'mimetype', '') similar to '(image|video)/%'
  ) as visibles_sin_cuenta,
  count(*) filter (
    where coalesce(metadata->>'mimetype', '') not similar to '(image|video)/%'
  ) as solo_con_cuenta
from storage.objects
where bucket_id = 'post-media';
-- Esperado: los audios del podcast entre los protegidos.
