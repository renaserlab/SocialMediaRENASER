-- =============================================================================
-- 0041 — El curso al que se refiere una reseña (opcional)
-- =============================================================================
--
-- ESTA MIGRACIÓN NO SE HA APLICADO. Se deja preparada a propósito, igual que la
-- 0037, la 0038 y la 0039: aplicar cambios de esquema contra la base real es una
-- decisión que se toma mirando, no un efecto secundario de arreglar un fallo.
--
-- -----------------------------------------------------------------------------
-- QUÉ AÑADE
-- -----------------------------------------------------------------------------
-- Una reseña puede decir, OPCIONALMENTE, sobre qué curso de la persona reseñada
-- habla. Hoy no puede: «me ayudó muchísimo» no distingue si fue en una sesión
-- 1:1, en su podcast o en un curso concreto, y quien lee un perfil con cinco
-- programas no sabe cuál se está valorando.
--
-- Es OPCIONAL de verdad: la inmensa mayoría de las reseñas no se refieren a
-- ningún curso, y no llevar curso no es un defecto sino la situación normal.
--
-- -----------------------------------------------------------------------------
-- POR QUÉ UNA TABLA APARTE Y NO UNA COLUMNA `course_id` EN `profile_reviews`
-- -----------------------------------------------------------------------------
-- Por la misma razón que explican la 0033 (`message_attachments`) y la 0039
-- (`direct_conversation_pairs`), y que ya costó una producción rota:
--
--   `select(Entidad)` de SQLAlchemy pide TODAS las columnas mapeadas, y
--   `db.add(Entidad(...))` las inserta todas.
--
-- El modelo `ProfileReview` se lee con `select(ProfileReview)` y con `db.get`
-- en cinco sitios del router. Si se le añadiera `course_id` al modelo, TODAS
-- esas consultas empezarían a pedir una columna que la base real no tiene
-- mientras esta migración espera aprobación, y cada listado de reseñas
-- respondería 500. Peor: Starlette no pone cabeceras CORS en una excepción sin
-- capturar, así que en el navegador ese 500 se disfraza de fallo de red.
--
-- El propio `app/modules/reviews/models.py` lo dice con todas las letras:
-- «CADA COLUMNA DE AQUÍ EXISTE EN LA 0030, Y AL REVÉS».
--
-- Con una tabla aparte, el enlace solo se consulta cuando la tabla existe
-- —lo comprueba `esquema.hay_curso_en_resena`, una vez por proceso— y el
-- código funciona igual CON la migración y SIN ella: con ella se puede decir de
-- qué curso se habla, sin ella se reseña como hoy.
--
-- «Opcional / nullable» se expresa aquí como AUSENCIA DE FILA, que es más
-- estricto que una columna nullable: no existe el estado intermedio «hay
-- enlace, pero apunta a nada». O la reseña habla de un curso, o no.
--
-- -----------------------------------------------------------------------------
-- QUÉ NO HACE
-- -----------------------------------------------------------------------------
-- NO borra nada. NO modifica ni una sola fila existente. NO añade columnas a
-- ninguna tabla en uso. NO toca `profile_reviews`, `review_media`, `courses` ni
-- `testimonials`. Las reseñas que ya existan siguen valiendo exactamente igual:
-- simplemente no tienen fila aquí.
--
-- Es ADITIVA, REPETIBLE e IDEMPOTENTE de principio a fin.
--
-- -----------------------------------------------------------------------------
-- QUÉ PASA MIENTRAS ESTO NO ESTÉ APLICADO
-- -----------------------------------------------------------------------------
-- La aplicación funciona exactamente igual que hoy. El backend comprueba UNA
-- VEZ por proceso si la tabla existe:
--
--   - Si NO existe: el selector de curso no se ofrece (`/reviews/availability`
--     responde `courses_available: false`), y si aun así llegara un `course_id`
--     en el cuerpo se IGNORA en silencio. Publicar una reseña no puede fallar
--     por un adorno.
--   - Si existe: el curso se valida contra la base —tiene que ser un curso REAL
--     y de la persona reseñada— y se guarda.
--
-- DESPUÉS DE APLICARLA, REINICIA LA API. La comprobación se cachea por proceso:
-- sin reiniciar, la API seguirá creyendo que la tabla no existe.
--
-- -----------------------------------------------------------------------------
-- SOBRE EL BLOQUEO
-- -----------------------------------------------------------------------------
-- `create table` sobre una tabla que no existe no bloquea nada de lo que ya
-- hay. Las claves ajenas toman un `SHARE ROW EXCLUSIVE` momentáneo sobre
-- `profile_reviews` y `courses` —milisegundos, no bloquean lecturas—. No hay
-- reescritura de tablas ni construcción de índices sobre datos existentes.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La tabla
-- -----------------------------------------------------------------------------
create table if not exists public.review_course (
  -- UNA reseña habla como mucho de UN curso, así que la clave primaria es la
  -- propia reseña. Sin esto haría falta un índice único aparte para impedir que
  -- la misma reseña acabara enlazada a tres cursos distintos.
  review_id uuid primary key references public.profile_reviews(id) on delete cascade,

  -- El curso. `on delete cascade`: si el curso desaparece, lo que se va es el
  -- ENLACE, nunca la reseña — el texto sigue siendo la opinión de alguien y
  -- borrarlo por un cambio de catálogo sería destruir información.
  course_id uuid not null references public.courses(id) on delete cascade,

  created_at timestamptz not null default now()
);

comment on table public.review_course is
  'De qué curso habla una reseña. OPCIONAL: la mayoría no tiene fila aquí.';

-- Por curso: es la pregunta «¿qué se ha dicho de este programa?» y es como lo
-- barrería el borrado de un curso. PostgreSQL no indexa las claves ajenas por su
-- cuenta, y la primaria es `review_id`, así que no sirve para esta pregunta.
create index if not exists review_course_curso_idx
  on public.review_course (course_id);


-- -----------------------------------------------------------------------------
-- 2. RLS
--
-- El enlace sigue a su reseña, igual que `review_media`: si se puede leer la
-- reseña, se puede saber de qué curso habla. Repetir aquí las condiciones de
-- visibilidad de `profile_reviews` las dejaría libres de desincronizarse con
-- las de la 0030 en el próximo cambio, así que se delega en un `exists`.
--
-- Escribir: solo quien escribió la reseña, y solo sobre la suya; la moderación
-- también, para poder retirar un enlace equivocado sin borrar el texto. La
-- persona reseñada NO aparece, igual que en toda la 0030: no puede tocar lo que
-- se dice de ella.
-- -----------------------------------------------------------------------------
alter table public.review_course enable row level security;

drop policy if exists review_course_read on public.review_course;
create policy review_course_read on public.review_course
  for select to authenticated using (
    exists (
      select 1 from public.profile_reviews r
      where r.id = review_course.review_id
    )
  );

drop policy if exists review_course_write on public.review_course;
create policy review_course_write on public.review_course
  for all to authenticated
  using (
    exists (
      select 1 from public.profile_reviews r
      where r.id = review_course.review_id
        and (r.reviewer_id = auth.uid() or public.is_admin())
    )
  )
  with check (
    exists (
      select 1 from public.profile_reviews r
      where r.id = review_course.review_id
        and (r.reviewer_id = auth.uid() or public.is_admin())
      -- El curso tiene que ser de la persona reseñada. Sin esta condición,
      -- cualquiera podría colgar su opinión sobre Ana del curso de Bruno y
      -- aparecería como valoración de un programa que Ana nunca dio. El backend
      -- lo comprueba también (`app/modules/reviews/router.py`), pero la regla
      -- que manda es esta: la aplicación escribe contra PostgREST para otras
      -- cosas y una comprobación que solo viva en el servidor se salta.
      and exists (
        select 1 from public.courses c
        where c.id = review_course.course_id
          and c.author_id = r.reviewed_user_id
      )
    )
  );

-- PostgREST cachea el esquema: sin esto, la tabla recién creada puede seguir
-- dando 404 ("could not find the table ... in the schema cache") un rato.
notify pgrst, 'reload schema';


-- =============================================================================
-- 3. COMPROBACIONES — ejecutar DESPUÉS. Todas de SOLO LECTURA.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.a La tabla existe y sale a 0: nadie ha enlazado todavía ninguna reseña con
--     ningún curso, y TODO lo anterior queda INTACTO.
-- -----------------------------------------------------------------------------
-- select
--   (select count(*) from public.review_course)                          as enlaces,
--   (select count(*) from public.profile_reviews)                        as resenas,
--   (select count(*) from public.review_media)                           as medios,
--   (select count(*) from public.courses)                                as cursos;

-- -----------------------------------------------------------------------------
-- 3.b Las restricciones están puestas.
-- -----------------------------------------------------------------------------
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.review_course'::regclass
-- order by conname;
-- Esperado: PRIMARY KEY (review_id) y las dos claves ajenas con ON DELETE CASCADE.

-- -----------------------------------------------------------------------------
-- 3.c Las políticas están puestas y son las dos esperadas.
-- -----------------------------------------------------------------------------
-- select policyname, cmd
-- from pg_policies
-- where schemaname = 'public' and tablename = 'review_course'
-- order by policyname;
-- Esperado: review_course_read (SELECT) y review_course_write (ALL).

-- -----------------------------------------------------------------------------
-- 3.d DESPUÉS de aplicar y de REINICIAR la API: escribir una reseña eligiendo un
--     curso escribe su fila. Si esto sigue vacío después de hacerlo, la API no
--     se ha reiniciado y sigue creyendo que la tabla no existe.
-- -----------------------------------------------------------------------------
-- select count(*) from public.review_course;
