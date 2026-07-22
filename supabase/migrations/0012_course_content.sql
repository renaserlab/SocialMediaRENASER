-- Contenido de los cursos: modulos, lecciones y sus videos.
--
-- Estado previo: `course_modules` y `course_lessons` tenian RLS activada pero
-- SOLO politica de lectura. Sin politica de escritura PostgREST deniega por
-- defecto, asi que no habia forma de crear el contenido de un curso: ni desde
-- la app ni desde la API.
--
-- Ademas el bucket `course-media` se creo en 0001 sin ninguna politica, de modo
-- que tampoco se podia subir ni leer el video de una leccion.
--
-- Criterio de permisos: el mismo que ya usa `courses_write`, el autor del curso
-- o la administracion. Se comprueba subiendo por la jerarquia
-- (leccion -> modulo -> curso) para que no dependa de datos duplicados.
--
-- El script es REPETIBLE: se puede volver a ejecutar entero sin romper nada, y
-- termina informando de si todo quedo en su sitio.

-- ---------------------------------------------------------------------------
-- Modulos
-- ---------------------------------------------------------------------------
drop policy if exists course_modules_write on public.course_modules;
create policy course_modules_write on public.course_modules
  for all to authenticated
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_id and (c.author_id = auth.uid() or public.is_admin())
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = course_id and (c.author_id = auth.uid() or public.is_admin())
    )
  );

-- ---------------------------------------------------------------------------
-- Lecciones
-- ---------------------------------------------------------------------------
drop policy if exists course_lessons_write on public.course_lessons;
create policy course_lessons_write on public.course_lessons
  for all to authenticated
  using (
    exists (
      select 1 from public.course_modules m
      join public.courses c on c.id = m.course_id
      where m.id = module_id and (c.author_id = auth.uid() or public.is_admin())
    )
  )
  with check (
    exists (
      select 1 from public.course_modules m
      join public.courses c on c.id = m.course_id
      where m.id = module_id and (c.author_id = auth.uid() or public.is_admin())
    )
  );

-- ---------------------------------------------------------------------------
-- Videos de leccion (bucket privado `course-media`)
-- ---------------------------------------------------------------------------
-- Lectura: cualquier cuenta con sesion. El control de acceso de pago NO se
-- hace aqui: el bucket es privado y solo se sirve con URL firmada, asi que
-- quien decide si firmar es la app al comprobar la matricula.
drop policy if exists course_media_read on storage.objects;
create policy course_media_read on storage.objects
  for select to authenticated using (bucket_id = 'course-media');

-- Escritura: solo administracion. Los cursos son contenido editorial, no
-- material que suba cualquiera.
drop policy if exists course_media_write_admin on storage.objects;
create policy course_media_write_admin on storage.objects
  for all to authenticated
  using (bucket_id = 'course-media' and public.is_admin())
  with check (bucket_id = 'course-media' and public.is_admin());

-- PostgREST cachea el esquema; sin esto los cambios pueden tardar en verse.
notify pgrst, 'reload schema';

-- Comprobacion final. El editor de Supabase solo muestra el resultado de la
-- ultima sentencia, asi que aqui se resume todo de una vez.
select
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'course_modules'
       and policyname = 'course_modules_write') as modulos_escritura,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'course_lessons'
       and policyname = 'course_lessons_write') as lecciones_escritura,
  (select count(*) from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname in ('course_media_read', 'course_media_write_admin')) as politicas_bucket;
-- Esperado: 1, 1, 2
