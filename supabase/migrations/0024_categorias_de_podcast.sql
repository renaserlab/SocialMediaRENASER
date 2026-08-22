-- Categorias de podcast propias de cada creador.
--
-- Hasta ahora las categorias eran TRES y estaban escritas en el codigo del
-- movil: «Mente y Emociones», «Cuerpo» y «Dinero». Servian mientras el podcast
-- era de una sola persona, pero no dicen nada del carpintero que quiere
-- ordenar sus audios en «Mis experiencias», «Carpinteria» e «Historias». Cada
-- quien organiza lo suyo.
--
-- NO se toca `posts.category`, que sigue siendo texto libre. Una categoria
-- propia se guarda ahi como el ID de la fila de esta tabla; las etiquetas
-- antiguas ('mente', 'cuerpo', 'dinero') y la reservada del audio privado
-- ('privado') siguen valiendo exactamente igual. Por eso el contenido ya
-- publicado no necesita ninguna conversion y nada deja de verse.
--
-- El script es REPETIBLE.

create table if not exists public.podcast_categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 40),
  -- Orden elegido por su dueno. Empata por fecha para que no dependa del azar.
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dos categorias con el mismo nombre en el mismo perfil no son dos categorias,
-- son un error de dedo: la segunda dejaria episodios repartidos sin motivo.
create unique index if not exists podcast_categories_owner_name_idx
  on public.podcast_categories (owner_id, lower(trim(name)));

create index if not exists podcast_categories_owner_idx
  on public.podcast_categories (owner_id, position, created_at);

-- Buscar los episodios de una categoria es la consulta que mas se repite.
create index if not exists posts_category_idx
  on public.posts (category)
  where category is not null;

alter table public.podcast_categories enable row level security;

/*
  Quien puede que.

  LEER: cualquiera. Las categorias se ven al visitar un perfil, igual que se
  ven sus episodios; esconderlas dejaria la lista de audios sin agrupar para
  todo el que no fuera su dueno.

  ESCRIBIR: solo su dueno, y comprobado en el SERVIDOR. Que el movil solo
  ensene el boton de anadir en el perfil propio es comodidad, no seguridad.
*/
drop policy if exists podcast_categories_select on public.podcast_categories;
create policy podcast_categories_select on public.podcast_categories
  for select using (true);

drop policy if exists podcast_categories_insert on public.podcast_categories;
create policy podcast_categories_insert on public.podcast_categories
  for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists podcast_categories_update on public.podcast_categories;
create policy podcast_categories_update on public.podcast_categories
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists podcast_categories_delete on public.podcast_categories;
create policy podcast_categories_delete on public.podcast_categories
  for delete to authenticated
  using (owner_id = auth.uid());

comment on table public.podcast_categories is
  'Categorias con las que cada creador organiza sus audios. posts.category '
  'guarda el id de una de estas filas (o una etiqueta antigua).';

notify pgrst, 'reload schema';

-- Comprobacion final.
select
  (select count(*) from public.podcast_categories) as categorias,
  (select count(*) from public.posts) as publicaciones_conservadas,
  (select count(*) from pg_policies
     where tablename = 'podcast_categories') as politicas;
-- Esperado: categorias = 0 la primera vez, las publicaciones que ya hubiera,
-- y politicas = 4.
