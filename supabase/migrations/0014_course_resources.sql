-- Documentos de una leccion y estado "Proximamente" del curso.
--
-- 1) courses.coming_soon
--    Se anuncia el curso (portada, titulo, precio) pero su contenido aun no
--    esta disponible. NO se usa `status = 'draft'` para esto: la politica
--    courses_read solo deja ver los publicados, asi que un borrador
--    desapareceria por completo para el alumno en vez de mostrarse como
--    proximo. `status` sigue significando "existe y es visible"; `coming_soon`
--    significa "visible pero todavia sin contenido".
--
-- 2) course_lesson_resources
--    Material descargable de cada leccion (PDF, plantillas...). A diferencia de
--    los testimonios, aqui la descarga SI se quiere: son materiales del curso.
--    El control de acceso de pago no vive en la RLS; se decidira al firmar la
--    URL, cuando exista el flujo de compra.
--
-- El script es REPETIBLE y termina informando de si quedo aplicado.

alter table public.courses
  add column if not exists coming_soon boolean not null default false;

comment on column public.courses.coming_soon is
  'Curso anunciado cuyo contenido aun no esta disponible (se muestra "Proximamente").';

create table if not exists public.course_lesson_resources (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.course_lessons(id) on delete cascade,
  title text not null,
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists course_lesson_resources_lesson_idx
  on public.course_lesson_resources (lesson_id, sort_order);

alter table public.course_lesson_resources enable row level security;

-- Lectura: cualquier cuenta con sesion (el muro de pago llegara despues).
drop policy if exists course_lesson_resources_read on public.course_lesson_resources;
create policy course_lesson_resources_read on public.course_lesson_resources
  for select to authenticated using (true);

-- Escritura: autor del curso o administracion, subiendo por la jerarquia
-- recurso -> leccion -> modulo -> curso, igual que en 0012.
drop policy if exists course_lesson_resources_write on public.course_lesson_resources;
create policy course_lesson_resources_write on public.course_lesson_resources
  for all to authenticated
  using (
    exists (
      select 1 from public.course_lessons l
      join public.course_modules m on m.id = l.module_id
      join public.courses c on c.id = m.course_id
      where l.id = lesson_id and (c.author_id = auth.uid() or public.is_admin())
    )
  )
  with check (
    exists (
      select 1 from public.course_lessons l
      join public.course_modules m on m.id = l.module_id
      join public.courses c on c.id = m.course_id
      where l.id = lesson_id and (c.author_id = auth.uid() or public.is_admin())
    )
  );

notify pgrst, 'reload schema';

select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'courses'
      and column_name = 'coming_soon') as columna_coming_soon,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'course_lesson_resources') as tabla_recursos,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'course_lesson_resources') as politicas;
-- Esperado: 1, 1, 2
