-- Miembros destacados y rol de administrador.
--
-- Objetivo: que un usuario recien registrado no entre a una aplicacion vacia.
-- Tras crear la cuenta se le proponen los perfiles destacados (Darren) para que
-- los siga y su feed tenga contenido desde el primer momento.
--
-- Se separan dos conceptos a proposito:
--   role = 'admin'     -> permisos de gestion (crear cursos, moderar).
--   is_featured = true -> aparece en la pantalla de sugerencias.
-- Asi se puede destacar a un mentor sin darle permisos de administracion.

alter table public.profiles
  add column if not exists is_featured boolean not null default false;

-- Indice parcial: la consulta siempre filtra por is_featured = true y son pocos.
create index if not exists profiles_is_featured_idx
  on public.profiles (is_featured)
  where is_featured;

-- Darren gestiona el aplicativo y es el perfil sugerido inicial.
update public.profiles
set role = 'admin',
    is_featured = true
where email = 'darrensupaoficial@gmail.com';
