-- Testimonios: galeria de fotos y videos publicada solo por la administracion.
--
-- A diferencia de posts o historias, aqui NO puede publicar cualquiera: la
-- politica de escritura exige public.is_admin(), asi que el resto de cuentas
-- solo puede mirar. Esa restriccion vive en la base, no en la interfaz: aunque
-- alguien manipule la app, el insert se rechaza.
--
-- Los archivos se guardan en el bucket privado `post-media` (no en `avatars`,
-- que es publico) para que solo se sirvan con URL firmada y de vida corta.

create table public.testimonials (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null,
  media_type text not null check (media_type in ('image', 'video')),
  caption text not null default '' check (char_length(caption) <= 300),
  created_at timestamptz not null default now()
);

-- La galeria se lista por fecha y se filtra por tipo (fotos / videos).
create index testimonials_created_idx on public.testimonials (created_at desc);
create index testimonials_media_type_idx on public.testimonials (media_type);

alter table public.testimonials enable row level security;

-- Cualquier cuenta con sesion puede ver los testimonios.
create policy testimonials_read on public.testimonials
  for select to authenticated using (true);

-- Publicar, editar y borrar: solo administracion.
create policy testimonials_insert_admin on public.testimonials
  for insert to authenticated with check (public.is_admin() and author_id = auth.uid());
create policy testimonials_update_admin on public.testimonials
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy testimonials_delete_admin on public.testimonials
  for delete to authenticated using (public.is_admin());
