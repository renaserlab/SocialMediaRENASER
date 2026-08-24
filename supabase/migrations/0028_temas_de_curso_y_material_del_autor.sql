-- ---------------------------------------------------------------------------
-- 0028 — Los cursos entran en el recomendador, y su autor puede subir su
--        propio material.
--
-- Tres huecos, y los tres impiden lo mismo: que una persona publique un curso
-- de verdad y que Z sepa a quien le sirve.
--
-- 1. UN CURSO NO DICE DE QUE TRATA.
--
--    Las publicaciones si desde la 0027 (`post_topics`). Los cursos no, asi que
--    no hay forma de cruzar «quiero aprender IA» con un curso de IA salvo
--    mirando el titulo, que es adivinar.
--
--    `course_topics` es la arista que falta: CURSO --tema--> TOPIC, sobre la
--    MISMA taxonomia de la 0026. Tabla propia y no `post_topics` reutilizada:
--    un curso no es una publicacion, y meter los dos en la misma tabla obligaria
--    a que su clave apuntase a dos sitios distintos segun la fila, que es
--    exactamente como se pierde la clave foranea.
--
-- 2. LA ATRIBUCION NO CONTEMPLA UNA SUPERFICIE DE CURSOS.
--
--    El CHECK que puso la 0027 sobre `behavior_events.surface` admite cinco
--    valores y ninguno es «Cursos para ti». Sin ampliarlo, cada impresion de esa
--    seccion seria una fila rechazada. Se AMPLIA la lista; no se quita ninguno.
--
-- 3. EL AUTOR DE UN CURSO NO PUEDE SUBIR EL VIDEO DE SU CURSO.
--
--    Esta es la que de verdad bloqueaba. Desde la 0012 el autor puede crear los
--    modulos y las lecciones de su curso, pero la escritura en el bucket
--    `course-media` quedo reservada a la administracion. Resultado: cualquiera
--    puede montar el esqueleto de un curso y nadie salvo un administrador puede
--    ponerle contenido. Un curso sin video no es un curso.
--
--    NO se abre el bucket. Se anade una politica que exige PROPIEDAD
--    demostrable en la propia ruta del archivo: `<author_id>/<course_id>/...`,
--    comprobando contra la tabla `courses` que ese curso es de quien sube. El
--    cliente puede mandar el `course_id` que quiera; si no es suyo, la base lo
--    rechaza.
--
-- QUE NO HACE ESTA MIGRACION. No toca ninguna fila existente. No clasifica
-- los cursos que ya hay: nadie ha dicho de que tratan, y deducirlo del titulo
-- seria convertir una suposicion en un dato declarado. No mueve ni renombra un
-- solo archivo del almacenamiento: las rutas antiguas (`<uid>/<archivo>`)
-- siguen leyendose exactamente igual. No quita la politica de administracion.
--
-- El script es REPETIBLE e IDEMPOTENTE: aditivo de principio a fin.
--
-- DESPUES DE APLICARLA, REINICIA LA API. El backend comprueba UNA VEZ por
-- proceso si `course_topics` existe —para poder funcionar sin esta migracion
-- mientras espera aprobacion— y se queda con la respuesta. Un servidor
-- levantado desde antes seguira creyendo que no esta.
-- Ver `app/modules/recommendations/esquema.py`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. De que trata cada curso
-- ---------------------------------------------------------------------------
create table if not exists public.course_topics (
  course_id uuid not null references public.courses(id) on delete cascade,
  topic_id  uuid not null references public.topics(id)  on delete cascade,
  -- Como se decidio el tema. Hoy SIEMPRE 'manual': lo elige quien crea el
  -- curso. 'auto' queda reservado para el dia que exista un clasificador de
  -- verdad; escribirlo antes seria firmar como automatico algo que no lo es.
  source text not null default 'manual' check (source in ('manual', 'auto')),
  created_at timestamptz not null default now(),
  primary key (course_id, topic_id)
);

comment on table public.course_topics is
  'De que trata un curso. Misma taxonomia que las personas y las publicaciones.';

-- La consulta del recomendador es «dame los cursos de estos temas», al reves
-- que la clave primaria. Sin este indice recorreria la tabla entera.
create index if not exists course_topics_por_tema_idx
  on public.course_topics (topic_id, course_id);

alter table public.course_topics enable row level security;

-- LECTURA: la misma visibilidad que el curso. Un borrador es de su autor, y sus
-- temas tambien: si se pudieran leer, se sabria que esta preparando alguien
-- antes de que decida ensenarlo.
drop policy if exists course_topics_read on public.course_topics;
create policy course_topics_read on public.course_topics
  for select using (
    exists (
      select 1 from public.courses c
      where c.id = course_id
        and (c.status = 'published' or c.author_id = auth.uid() or public.is_admin())
    )
  );

-- ESCRITURA: el autor del curso o la administracion. Subiendo por la jerarquia
-- como en la 0012, para que no dependa de datos duplicados.
drop policy if exists course_topics_write on public.course_topics;
create policy course_topics_write on public.course_topics
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
-- 2. «Cursos para ti» como superficie medible
-- ---------------------------------------------------------------------------
-- Se REEMPLAZA el CHECK de la 0027 en vez de tocar aquel fichero: una migracion
-- ya aplicada no se edita, porque el que la ejecuto no volveria a ejecutarla y
-- los dos entornos quedarian distintos creyendo que estan iguales.
--
-- La lista nueva CONTIENE la anterior entera. Ninguna fila existente puede
-- dejar de cumplirla, asi que la validacion no puede fallar.
alter table public.behavior_events
  drop constraint if exists behavior_events_surface_check;

alter table public.behavior_events
  add constraint behavior_events_surface_check
  check (
    surface is null or surface in (
      'people_for_you',   -- personas recomendadas
      'courses_for_you',  -- NUEVA: cursos recomendados
      'for_you_feed',     -- el feed vertical de Inicio
      'following_feed',   -- la pestana Siguiendo
      'search',           -- resultados de busqueda
      'profile'           -- llegada directa a un perfil
    )
  );

-- ---------------------------------------------------------------------------
-- 3. El autor sube el material de SU curso
-- ---------------------------------------------------------------------------
-- El bucket sigue siendo PRIVADO y la lectura sigue decidiendola
-- `has_course_access()` (migracion 0016). Aqui solo se abre la ESCRITURA, y
-- solo sobre rutas cuya propiedad se puede demostrar.
--
-- La ruta obligatoria para lo nuevo es:  <author_id>/<course_id>/<archivo>
--
--   (storage.foldername(name))[1] = quien sube
--   (storage.foldername(name))[2] = el curso, que tiene que ser suyo
--
-- `c.id::text = ...` y no un cast al reves a proposito: si la segunda carpeta
-- no es un uuid, comparar como texto simplemente no encuentra nada. Casteando
-- a uuid, la peticion reventaria con un error de conversion.
--
-- Los archivos YA SUBIDOS estan en `<uid>/<archivo>` y NO se tocan: se siguen
-- leyendo igual, y la administracion los sigue pudiendo gestionar con la
-- politica de abajo, que se conserva.
drop policy if exists course_media_write_author on storage.objects;
create policy course_media_write_author on storage.objects
  for all to authenticated
  using (
    bucket_id = 'course-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.courses c
      where c.id::text = (storage.foldername(name))[2]
        and c.author_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'course-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.courses c
      where c.id::text = (storage.foldername(name))[2]
        and c.author_id = auth.uid()
    )
  );

-- Se CONSERVA la de administracion (0012). Es la que permite moderar y la que
-- deja gestionar los archivos que ya estan en las rutas antiguas.
drop policy if exists course_media_write_admin on storage.objects;
create policy course_media_write_admin on storage.objects
  for all to authenticated
  using (bucket_id = 'course-media' and public.is_admin())
  with check (bucket_id = 'course-media' and public.is_admin());

-- Buscar el curso por su id en texto ocurre en CADA subida.
create index if not exists courses_autor_idx on public.courses (author_id, id);

-- PostgREST cachea el esquema; sin esto los cambios tardan en verse.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Comprobacion final. `temas_de_curso` sale 0 la primera vez (nadie ha
-- etiquetado nada todavia) y TODO lo anterior queda INTACTO.
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.course_topics)                     as temas_de_curso,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'course_topics')  as politicas_temas,
  (select count(*) from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname in ('course_media_write_author',
                          'course_media_write_admin',
                          'course_media_read'))                    as politicas_bucket,
  (select count(*) from pg_constraint
     where conname = 'behavior_events_surface_check')              as check_de_superficie,
  (select count(*) from public.courses)                            as cursos_intactos,
  (select count(*) from public.course_modules)                     as modulos_intactos,
  (select count(*) from public.course_lessons)                     as lecciones_intactas,
  (select count(*) from public.purchases)                          as compras_intactas,
  (select count(*) from public.lesson_progress)                    as progreso_intacto,
  (select count(*) from public.behavior_events)                    as senales_intactas,
  (select count(*) from public.profiles)                           as perfiles_intactos,
  (select count(*) from public.posts)                              as publicaciones_intactas;
-- Esperado: 0, 2, 3, 1, y el resto igual que antes de ejecutar el script.
