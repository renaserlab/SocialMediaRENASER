-- Audio de presentacion del perfil.
--
-- Una grabacion breve en la que la persona cuenta quien es. Es una pieza
-- central de a donde va Z: leer una biografia de dos lineas no dice si alguien
-- sabe de carpinteria ni si da confianza; oirle treinta segundos, si.
--
-- Se guarda la RUTA dentro del bucket `post-media`, no el audio.
--   - No se mete el fichero en Postgres: un blob de audio en una columna
--     infla cada consulta del perfil, no se puede servir por CDN y convierte
--     una copia de seguridad de la base en decenas de gigas.
--   - No se guarda una URL firmada: caduca. Se firma al leer, como ya se hace
--     con el resto de medios.
--   - Se reutiliza el bucket que ya existe (post-media), con la misma politica
--     de "cada quien escribe en su carpeta". No hace falta un bucket nuevo.
--
-- Todo opcional y sin tocar filas existentes: quien no grabe nada se queda
-- exactamente como esta.
--
-- El script es REPETIBLE.

alter table public.profiles
  add column if not exists intro_audio_path text,
  -- Duracion en segundos. `real` basta: solo sirve para pintar "0:28".
  add column if not exists intro_audio_duration_s real,
  -- Cuando se grabo el que esta puesto. Sirve para invalidar caches del
  -- cliente cuando alguien reemplaza su audio por otro.
  add column if not exists intro_audio_updated_at timestamptz;

comment on column public.profiles.intro_audio_path is
  'Ruta en el bucket post-media del audio de presentacion. Null = no tiene.';
comment on column public.profiles.intro_audio_duration_s is
  'Duracion del audio de presentacion, en segundos.';
comment on column public.profiles.intro_audio_updated_at is
  'Cuando se subio el audio de presentacion vigente.';

notify pgrst, 'reload schema';

-- Comprobacion final.
select
  (select count(*) from public.profiles) as perfiles_conservados,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles'
       and column_name in ('intro_audio_path', 'intro_audio_duration_s',
                           'intro_audio_updated_at')) as columnas_nuevas;
-- Esperado: los perfiles que ya hubiera, y columnas_nuevas = 3.
