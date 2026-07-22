-- RENASER Universo - historias (contenido efimero de 24 h)
-- Ejecutar en el SQL Editor de Supabase despues de 0001_initial.sql.
--
-- Los archivos NO usan un bucket propio: se reutiliza `post-media`, cuyas
-- politicas ya restringen la escritura a la carpeta del propio usuario
-- (ver 0001_initial.sql) y cuyos limites de tamano fija 0002_storage_limits.sql.

create table public.stories (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null,
  media_type text not null check (media_type in ('image', 'video')),
  -- Cuanto se muestra el tramo. En video es su duracion real; en imagen, el
  -- tiempo fijo del visor. El tope de 15 s vale para ambos.
  duration_ms integer not null default 5000 check (duration_ms between 1000 and 15000),
  caption text not null default '' check (char_length(caption) <= 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

-- El feed agrupa por autor y ordena por fecha; la caducidad se filtra siempre.
create index stories_author_created_idx on public.stories (author_id, created_at desc);
create index stories_expires_idx on public.stories (expires_at);

create table public.story_views (
  story_id uuid not null references public.stories(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  -- La clave compuesta hace idempotente el registro de una vista.
  primary key (story_id, viewer_id)
);

-- Para resolver "cuales no he visto" sin escanear la tabla entera.
create index story_views_viewer_idx on public.story_views (viewer_id);

alter table public.stories enable row level security;
alter table public.story_views enable row level security;

-- Una historia es visible mientras no caduque. El autor sigue viendo las suyas
-- despues de caducar (asi puede consultar quien las vio).
create policy stories_read on public.stories for select using (
  expires_at > now() or author_id = auth.uid() or public.is_admin()
);
create policy stories_insert_own on public.stories for insert with check (author_id = auth.uid());
create policy stories_delete_own on public.stories for delete using (
  author_id = auth.uid() or public.is_admin()
);

-- Las vistas las lee el autor de la historia (para el "visto por") y el propio
-- espectador (para saber que ya la vio). Nadie mas.
create policy story_views_read on public.story_views for select using (
  viewer_id = auth.uid()
  or exists (select 1 from public.stories s where s.id = story_id and s.author_id = auth.uid())
  or public.is_admin()
);
create policy story_views_insert_own on public.story_views for insert with check (
  viewer_id = auth.uid()
);

-- Limpieza. Las historias caducadas dejan de mostrarse por el filtro de lectura,
-- pero conviene purgarlas para que la tabla no crezca sin fin.
--
-- OJO: esto borra las filas, NO los archivos del bucket post-media. Para
-- liberar el almacenamiento hay que eliminarlos aparte (Storage no cae en
-- cascada desde la base de datos).
create or replace function public.purge_expired_stories(older_than interval default interval '7 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  borradas integer;
begin
  delete from public.stories where expires_at < now() - older_than;
  get diagnostics borradas = row_count;
  return borradas;
end;
$$;

-- Con la extension pg_cron disponible, se puede programar asi:
--   select cron.schedule('purgar-historias', '0 4 * * *', $$select public.purge_expired_stories()$$);
