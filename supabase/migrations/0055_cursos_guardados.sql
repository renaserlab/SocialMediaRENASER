-- 0055 · Guardar un curso para después.
--
-- SIN APLICAR. El código funciona con y sin ella: si la tabla no está, guardar
-- responde 503 y la portada no ofrece la sección.
--
-- POR QUÉ UNA TABLA NUEVA Y NO `saved_posts`. Esa tiene `post_id` con clave
-- foránea a `posts` y clave primaria `(post_id, user_id)`: no distingue tipo de
-- entidad, así que reutilizarla exigiría aflojar la foránea y añadir una
-- columna de tipo. Sale más caro y más frágil que una tabla propia de dos
-- columnas.
--
-- LA CLAVE PRIMARIA COMPUESTA ES LA IDEMPOTENCIA. Guardar dos veces no duplica
-- porque la base no deja, no porque el código mire antes.
--
-- ROLLBACK:
--   drop table if exists public.saved_courses;

create table if not exists public.saved_courses (
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, course_id)
);

-- Para listar «mis guardados» por fecha sin recorrer la tabla.
create index if not exists saved_courses_por_fecha
  on public.saved_courses (user_id, created_at desc);

alter table public.saved_courses enable row level security;

-- Cada quien ve lo suyo. Sin política de escritura: se escribe por la API, que
-- es la que comprueba que el curso existe y está publicado.
drop policy if exists saved_courses_read on public.saved_courses;
create policy saved_courses_read on public.saved_courses
  for select using (user_id = auth.uid());

-- Nace cerrada, como manda la 0053: nada para anon ni authenticated.
revoke all on public.saved_courses from anon, authenticated;

do $$
declare
  faltan text := '';
begin
  if to_regclass('public.saved_courses') is null then
    faltan := faltan || 'tabla ';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'saved_courses_por_fecha'
  ) then faltan := faltan || 'indice '; end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'saved_courses'
      and grantee in ('anon', 'authenticated')
  ) then faltan := faltan || 'concesion_indebida '; end if;
  if faltan <> '' then
    raise exception '0055 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
