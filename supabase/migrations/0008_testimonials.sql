-- Testimonios: galeria de fotos y videos publicada solo por la administracion.
--
-- A diferencia de posts o historias, aqui NO puede publicar cualquiera: la
-- politica de escritura exige public.is_admin(), asi que el resto de cuentas
-- solo puede mirar. Esa restriccion vive en la base, no en la interfaz: aunque
-- alguien manipule la app, el insert se rechaza.
--
-- Los archivos se guardan en el bucket privado `post-media` (no en `avatars`,
-- que es publico) para que solo se sirvan con URL firmada y de vida corta.
--
-- El script es REPETIBLE: se puede volver a ejecutar entero sin romper nada, y
-- termina informando de si todo quedo en su sitio.

create table if not exists public.testimonials (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null,
  media_type text not null check (media_type in ('image', 'video')),
  caption text not null default '' check (char_length(caption) <= 300),
  created_at timestamptz not null default now()
);

-- La galeria se lista por fecha y se filtra por tipo (fotos / videos).
create index if not exists testimonials_created_idx
  on public.testimonials (created_at desc);
create index if not exists testimonials_media_type_idx
  on public.testimonials (media_type);

alter table public.testimonials enable row level security;

-- Cualquier cuenta con sesion puede ver los testimonios.
drop policy if exists testimonials_read on public.testimonials;
create policy testimonials_read on public.testimonials
  for select to authenticated using (true);

-- Publicar, editar y borrar: solo administracion.
drop policy if exists testimonials_insert_admin on public.testimonials;
create policy testimonials_insert_admin on public.testimonials
  for insert to authenticated with check (public.is_admin() and author_id = auth.uid());

drop policy if exists testimonials_update_admin on public.testimonials;
create policy testimonials_update_admin on public.testimonials
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists testimonials_delete_admin on public.testimonials;
create policy testimonials_delete_admin on public.testimonials
  for delete to authenticated using (public.is_admin());

-- PostgREST cachea el esquema: sin esto, la tabla recien creada puede seguir
-- dando 404 ("could not find the table ... in the schema cache") un rato.
notify pgrst, 'reload schema';

-- Comprobacion final. El editor de Supabase solo muestra el resultado de la
-- ultima sentencia, asi que aqui se resume todo de una vez.
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'testimonials') as tabla,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'testimonials') as politicas,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_admin') as funcion_is_admin;
-- Esperado: tabla = 1, politicas = 4, funcion_is_admin = 1
