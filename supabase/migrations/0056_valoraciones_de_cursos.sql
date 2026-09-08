-- 0056 · Valoraciones de cursos, con compra verificada.
--
-- SIN APLICAR. El código funciona sin ella: el detalle no pinta el bloque de
-- valoraciones y los endpoints responden 503.
--
-- POR QUÉ UNA TABLA NUEVA Y NO `profile_reviews`. Esa valora PERSONAS
-- (`reviewer_id` → `reviewed_user_id`), no lleva puntuación, y `review_course`
-- solo enlaza opcionalmente una reseña con un curso. Meter aquí un `rating` y
-- cambiar la entidad valorada sería rehacer esa tabla, no reutilizarla.
--
-- LO QUE **NO** SE GUARDA: si la compra está verificada. Se deriva al leer,
-- contra el comercio. Guardarlo lo dejaría obsoleto en cuanto alguien devuelve,
-- y entonces la ficha diría «compra verificada» sobre una compra reembolsada.
-- Tampoco se guardan promedio ni conteo: se calculan.
--
-- UNA RESEÑA ACTIVA POR PERSONA Y CURSO. Una recompra no da un segundo voto.
--
-- ROLLBACK:
--   drop table if exists public.course_reviews;

create table if not exists public.course_reviews (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text,
  -- 'visible' o 'hidden'. La moderación NO borra: oculta, y una reseña oculta
  -- deja de contar en el promedio público.
  status text not null default 'visible'
    check (status in ('visible', 'hidden')),
  -- Por qué se ocultó. INTERNO: no sale por ninguna respuesta pública.
  moderation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, course_id)
);

-- Listar por curso y ordenar por fecha sin recorrer la tabla.
create index if not exists course_reviews_por_curso
  on public.course_reviews (course_id, created_at desc);

alter table public.course_reviews enable row level security;

-- Se leen las visibles; la propia se ve siempre, aunque esté oculta.
drop policy if exists course_reviews_read on public.course_reviews;
create policy course_reviews_read on public.course_reviews
  for select using (status = 'visible' or user_id = auth.uid());

-- Sin política de escritura: escribe la API, que es la que comprueba la compra.
-- Nace cerrada, como manda la 0053.
revoke all on public.course_reviews from anon, authenticated;

do $$
declare
  faltan text := '';
begin
  if to_regclass('public.course_reviews') is null then
    faltan := faltan || 'tabla ';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'course_reviews_por_curso'
  ) then faltan := faltan || 'indice '; end if;
  if not exists (
    select 1 from pg_constraint con join pg_class c on c.oid = con.conrelid
    where c.relname = 'course_reviews' and con.contype = 'u'
  ) then faltan := faltan || 'unicidad '; end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'course_reviews'
      and grantee in ('anon', 'authenticated')
  ) then faltan := faltan || 'concesion_indebida '; end if;
  if faltan <> '' then
    raise exception '0056 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
