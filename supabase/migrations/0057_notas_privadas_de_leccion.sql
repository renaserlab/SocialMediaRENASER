-- 0057 · Notas privadas de una lección.
--
-- SIN APLICAR. El código funciona sin ella: la pestaña «Notas» no aparece y los
-- endpoints responden 503 `lesson_notes_not_available`.
--
-- QUÉ SON. Los apuntes que alguien toma mientras estudia. NO son comentarios,
-- ni reseñas, ni mensajes: no se publican, no se moderan y nadie más las lee.
-- Por eso no reutilizan ninguna de esas tablas: compartir la tabla habría
-- significado compartir también las políticas, y la política de una nota es la
-- contraria a la de un comentario.
--
-- PRIVADAS DE VERDAD. Ni el autor del curso, ni moderación, ni otro alumno. La
-- única política de lectura es `user_id = auth.uid()`, y encima la tabla nace
-- sin concesión para `anon` ni `authenticated`, así que tampoco se sirve por
-- PostgREST: escribe y lee la API, que vuelve a comprobar la identidad.
--
-- LA VERSIÓN ESTUDIADA queda anotada cuando el curso tiene una publicada. Se
-- queda nula si no la hay —hoy es el caso de todo curso que no se ha vuelto a
-- publicar desde la 0050— porque inventar un número de versión sería peor que
-- no tenerlo. `on delete set null`: si algún día se limpiara una versión, la
-- nota de una persona no se borra con ella.
--
-- VARIAS NOTAS POR LECCIÓN, no una. Cada una lleva el minuto en el que se tomó,
-- que es como se usan: tres apuntes de una misma lección en tres momentos.
--
-- ROLLBACK:
--   drop table if exists public.lesson_notes;

create table if not exists public.lesson_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  lesson_id uuid not null references public.course_lessons(id) on delete cascade,
  -- La versión del curso que se estaba estudiando. Nula si el curso no tiene
  -- ninguna publicada.
  course_version_id uuid references public.course_versions(id) on delete set null,
  -- El texto. El límite lo pone la base, no solo el formulario: 2000 caracteres
  -- son cuatro pantallas de apuntes, y una nota vacía no es una nota.
  body text not null
    check (length(trim(body)) between 1 and 2000),
  -- El minuto del vídeo en el que se tomó. Nulo cuando el reproductor no da una
  -- posición real; NO se pone cero, que diría «al principio».
  position_seconds integer
    check (position_seconds is null or position_seconds >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Listar las notas de una persona en una lección, de la más reciente a la más
-- vieja, sin recorrer la tabla. `user_id` va primero porque NUNCA se consulta
-- sin él: no existe la pregunta «las notas de esta lección».
create index if not exists lesson_notes_por_leccion
  on public.lesson_notes (user_id, lesson_id, created_at desc);

alter table public.lesson_notes enable row level security;

-- Solo las propias. No hay excepción para el autor del curso ni para
-- moderación: una nota privada que administración puede leer no es privada.
drop policy if exists lesson_notes_propias on public.lesson_notes;
create policy lesson_notes_propias on public.lesson_notes
  for select using (user_id = auth.uid());

-- Sin política de escritura: escribe la API. Nace cerrada, como manda la 0053.
revoke all on public.lesson_notes from anon, authenticated;

do $$
declare
  faltan text := '';
begin
  if to_regclass('public.lesson_notes') is null then
    faltan := faltan || 'tabla ';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'lesson_notes_por_leccion'
  ) then faltan := faltan || 'indice_leccion '; end if;
  if not exists (
    select 1 from pg_constraint con join pg_class c on c.oid = con.conrelid
    where c.relname = 'lesson_notes' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%btrim%'
  ) then faltan := faltan || 'limite_de_texto '; end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'lesson_notes' and c.relrowsecurity
  ) then faltan := faltan || 'rls '; end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'lesson_notes'
      and grantee in ('anon', 'authenticated')
  ) then faltan := faltan || 'concesion_indebida '; end if;
  if faltan <> '' then
    raise exception '0057 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
