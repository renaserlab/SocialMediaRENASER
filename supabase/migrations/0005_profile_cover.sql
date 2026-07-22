-- Foto de portada del perfil.
--
-- `avatar_path` ya existia desde 0001; la portada se quedo sin columna, asi que
-- la imagen elegida solo vivia en el dispositivo y se perdia al cerrar sesion.
-- Igual que avatar_path, guarda la RUTA dentro del bucket `avatars`
-- (uid/cover-<ts>.jpg), no una URL: asi el bucket puede cambiar de publico a
-- privado sin reescribir los datos.

alter table public.profiles
  add column if not exists cover_path text;
