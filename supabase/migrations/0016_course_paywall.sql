-- ---------------------------------------------------------------------------
-- 0016 — Muro de pago de los cursos
--
-- Hasta ahora el contenido de pago NO estaba protegido. La politica de storage
-- de `course-media` (migracion 0012) permitia leer a CUALQUIER cuenta con
-- sesion, y su propio comentario lo reconocia: "quien decide si firmar es la
-- app al comprobar la matricula". Es decir, el control vivia en el cliente, asi
-- que bastaba pedir una URL firmada de cualquier leccion para ver el video sin
-- haber comprado nada.
--
-- Aqui la puerta se mueve a la base de datos, que es donde manda de verdad.
--
-- QUE SIGUE SIENDO VISIBLE PARA TODOS (a proposito): la portada del curso, su
-- descripcion y el temario con los titulos de las lecciones. Eso es lo que
-- vende el curso; esconderlo dejaria la ficha vacia.
--
-- QUE QUEDA PROTEGIDO: los videos de las lecciones y los documentos
-- descargables, que son el contenido por el que se paga.
--
-- IMPORTANTE — los cursos GRATUITOS (`price_minor = 0`) siguen abiertos. Sin
-- esa condicion, aplicar esta migracion dejaria sin acceso a todo el mundo de
-- golpe, porque hoy no existe ninguna fila en `purchases`.
-- ---------------------------------------------------------------------------

-- 1. Quien puede acceder al contenido de un curso.
--    `security definer` para poder consultar `purchases` sin que la propia RLS
--    de esa tabla recorte el resultado; `search_path` fijado por seguridad.
create or replace function public.has_course_access(target_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.courses c
    where c.id = target_course_id
      and (
        -- Gratuito: no hay nada que cobrar.
        c.price_minor = 0
        -- Quien lo creo siempre entra a su propio material.
        or c.author_id = auth.uid()
        -- La administracion gestiona el catalogo entero.
        or public.is_admin()
        -- Compra confirmada. 'pending' NO basta: un cobro iniciado y no
        -- completado no da acceso.
        or exists (
          select 1 from public.purchases p
          where p.course_id = c.id
            and p.user_id = auth.uid()
            and p.status = 'paid'
        )
      )
  );
$$;

comment on function public.has_course_access(uuid) is
  'true si la sesion actual puede ver el contenido de pago de un curso.';

-- 2. Documentos descargables de las lecciones.
drop policy if exists course_lesson_resources_read on public.course_lesson_resources;
create policy course_lesson_resources_read on public.course_lesson_resources
  for select using (
    exists (
      select 1
      from public.course_lessons l
      join public.course_modules m on m.id = l.module_id
      where l.id = lesson_id
        and public.has_course_access(m.course_id)
    )
  );

-- 3. Archivos del bucket privado `course-media`: videos y documentos.
--
--    Es la politica que de verdad cierra el agujero. Una URL firmada solo se
--    puede emitir si esta politica deja leer el objeto, asi que ya no importa
--    lo que decida la app.
drop policy if exists course_media_read on storage.objects;
create policy course_media_read on storage.objects
  for select to authenticated using (
    bucket_id = 'course-media'
    and (
      public.is_admin()
      -- Video de una leccion.
      or exists (
        select 1
        from public.course_lessons l
        join public.course_modules m on m.id = l.module_id
        where l.media_path = storage.objects.name
          and public.has_course_access(m.course_id)
      )
      -- Documento adjunto de una leccion.
      or exists (
        select 1
        from public.course_lesson_resources r
        join public.course_lessons l on l.id = r.lesson_id
        join public.course_modules m on m.id = l.module_id
        where r.storage_path = storage.objects.name
          and public.has_course_access(m.course_id)
      )
    )
  );

-- 4. Indices para que las comprobaciones de arriba no recorran tablas enteras.
--    Se consultan en CADA lectura de contenido, asi que importan.
create index if not exists purchases_user_course_idx
  on public.purchases (user_id, course_id, status);
create index if not exists course_lessons_media_path_idx
  on public.course_lessons (media_path);
create index if not exists course_lesson_resources_path_idx
  on public.course_lesson_resources (storage_path);

-- 5. Refrescar el cache de esquema de PostgREST.
notify pgrst, 'reload schema';

-- 6. Comprobacion. Deben salir 3 filas, todas en OK.
select
  'funcion has_course_access' as comprobacion,
  case when exists (
    select 1 from pg_proc where proname = 'has_course_access'
  ) then 'OK' else 'FALTA' end as estado
union all
select
  'politica storage course_media_read',
  case when exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'course_media_read'
  ) then 'OK' else 'FALTA' end
union all
select
  'politica recursos de leccion',
  case when exists (
    select 1 from pg_policies
    where tablename = 'course_lesson_resources'
      and policyname = 'course_lesson_resources_read'
  ) then 'OK' else 'FALTA' end;
