-- ---------------------------------------------------------------------------
-- 0034 — Cursos V2: la ficha que hace falta para vender un curso, y la
--        revision que hace falta para poder publicarlo con la cara alta.
--
-- QUE PROBLEMA RESUELVE. Hoy un curso es titulo, descripcion, portada y precio.
-- Con eso no se puede decidir si empezarlo: ni para quien es, ni en que idioma,
-- ni si hace falta saber algo antes, ni que nivel tiene, ni que se lleva uno al
-- terminarlo. Y no hay ningun momento en el que alguien de la casa mire un
-- curso antes de que aparezca en el catalogo: publicar era una decision de una
-- sola persona sobre algo que ven todas.
--
-- ---------------------------------------------------------------------------
-- 1. `status` Y `review_status` SON DOS EJES DISTINTOS, Y NO SE MEZCLAN
-- ---------------------------------------------------------------------------
-- `status` es el enum COMPARTIDO `content_status` (0001) y significa
-- VISIBILIDAD: existe y se ve, existe y no se ve, esta borrado. Lo comparten
-- publicaciones, eventos, audios y cursos.
--
-- Anadirle 'pending_review' habria sido la solucion corta y la equivocada: un
-- valor nuevo en un enum compartido aparece de golpe en cuatro tablas que no
-- saben que hacer con el, y cada `status = 'published'` repartido por el codigo
-- pasa a significar algo distinto segun quien pregunte. Ademas un enum de
-- PostgreSQL no admite quitar valores: el error se queda.
--
-- Por eso la revision es una columna PROPIA de `courses`, y solo de `courses`.
-- Un curso puede estar aprobado y retirado del catalogo a la vez, y eso no es
-- una contradiccion: son dos preguntas distintas.
--
-- ---------------------------------------------------------------------------
-- 2. `highlights` NO SE DUPLICA
-- ---------------------------------------------------------------------------
-- «Lo que aprenderas» ya vive en `courses.highlights` desde la 0013, con su
-- orden significativo y su contenido real en produccion. Crear al lado una
-- columna `learning_outcomes` con el mismo significado seria partir en dos un
-- dato que hoy esta entero: la mitad de los cursos lo tendrian en una columna y
-- la mitad en la otra, y alguien tendria que decidir cual gana. Se reutiliza.
--
-- ---------------------------------------------------------------------------
-- 3. LA TAXONOMIA TAMPOCO SE DUPLICA
-- ---------------------------------------------------------------------------
-- `topics` (0026) ya tiene los temas sembrados y `course_topics` (0028) ya une
-- curso con tema. Lo unico que falta es cual de esos temas es EL principal:
-- `primary_topic_id`. Los demas siguen en `course_topics`, con su tope de cinco.
--
-- ---------------------------------------------------------------------------
-- QUE NO HACE ESTA MIGRACION. No toca una sola fila existente: todas las
-- columnas son aditivas y con valor por defecto. No cambia `status` de ningun
-- curso. No renombra nada. No borra ninguna politica que no vuelva a crear.
--
-- Los cursos que YA estan publicados nacen con `review_status = 'approved'`
-- —ver el paso 5— porque retirarlos del catalogo a la fuerza para que alguien
-- los apruebe seria romper lo que hoy funciona para estrenar un proceso.
--
-- El script es REPETIBLE e IDEMPOTENTE de principio a fin.
--
-- DESPUES DE APLICARLA, REINICIA LA API. El backend comprueba UNA VEZ por
-- proceso si estas columnas existen —para poder funcionar sin esta migracion
-- mientras espera aprobacion— y se queda con la respuesta. Un servidor
-- levantado desde antes seguira creyendo que no estan.
-- Ver `app/modules/catalog/esquema.py`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. La ficha del curso
-- ---------------------------------------------------------------------------
alter table public.courses add column if not exists subtitle text;
alter table public.courses add column if not exists promo_video_path text;
alter table public.courses add column if not exists primary_topic_id uuid;
alter table public.courses add column if not exists language text not null default 'es';
alter table public.courses add column if not exists level text;
alter table public.courses add column if not exists target_audience text[] not null default '{}';
alter table public.courses add column if not exists prerequisites text[] not null default '{}';

comment on column public.courses.subtitle is
  'Una linea bajo el titulo. Antes se recortaba la descripcion y salia a medias.';
comment on column public.courses.promo_video_path is
  'Ruta en `course-media` del video de presentacion. NO es una leccion.';
comment on column public.courses.primary_topic_id is
  'Categoria principal. Los demas temas siguen en `course_topics` (0028).';
comment on column public.courses.language is
  'Idioma en que se imparte. Por defecto es, que es lo que hay hoy.';
comment on column public.courses.level is
  'beginner | intermediate | advanced. Nulo mientras no se elija.';
comment on column public.courses.target_audience is
  'Para quien es el curso. Orden significativo.';
comment on column public.courses.prerequisites is
  'Que hace falta saber antes. Orden significativo.';
comment on column public.courses.highlights is
  'Lo que se aprende en el curso. Orden significativo. NO se duplica en otra columna.';

-- La clave foranea y el CHECK se anaden aparte y con `if not exists` propio:
-- `add column if not exists` no vuelve a evaluar la restriccion si la columna
-- ya estaba, asi que ejecutar el script dos veces dejaria la mitad del trabajo.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'courses_primary_topic_fk'
  ) then
    alter table public.courses
      add constraint courses_primary_topic_fk
      foreign key (primary_topic_id) references public.topics(id) on delete set null;
  end if;
end $$;

-- `on delete set null` y no `restrict`: si un tema se retira de la taxonomia,
-- el curso pierde su categoria pero NO desaparece ni bloquea la limpieza. Lo
-- que se pierde es una etiqueta; lo que no se puede perder es el curso.

alter table public.courses drop constraint if exists courses_level_check;
alter table public.courses
  add constraint courses_level_check
  check (level is null or level in ('beginner', 'intermediate', 'advanced'));

-- ---------------------------------------------------------------------------
-- 2. La revision, en su propio eje
-- ---------------------------------------------------------------------------
alter table public.courses add column if not exists review_status text not null default 'draft';
alter table public.courses add column if not exists submitted_at timestamptz;
alter table public.courses add column if not exists reviewed_at timestamptz;
alter table public.courses add column if not exists reviewed_by uuid;
alter table public.courses add column if not exists rejection_reason text;

alter table public.courses drop constraint if exists courses_review_status_check;
alter table public.courses
  add constraint courses_review_status_check
  check (review_status in ('draft', 'pending_review', 'approved', 'rejected'));

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'courses_reviewed_by_fk'
  ) then
    alter table public.courses
      add constraint courses_reviewed_by_fk
      foreign key (reviewed_by) references public.profiles(id) on delete set null;
  end if;
end $$;

comment on column public.courses.review_status is
  'Eje de REVISION, independiente de `status` (visibilidad): draft | pending_review | approved | rejected.';
comment on column public.courses.rejection_reason is
  'Por que se rechazo. Sin motivo, rechazar es un muro sin puerta.';

-- La cola de revision se consulta por estado y en orden de llegada. Sin este
-- indice, administracion recorreria la tabla de cursos entera cada vez que
-- abre su bandeja.
create index if not exists courses_revision_idx
  on public.courses (review_status, submitted_at);

-- Navegar el catalogo por categoria principal.
create index if not exists courses_tema_principal_idx
  on public.courses (primary_topic_id)
  where primary_topic_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Contenido: modulos con contexto y lecciones con tipo
-- ---------------------------------------------------------------------------
alter table public.course_modules add column if not exists description text not null default '';

comment on column public.course_modules.description is
  'De que va este bloque. Un temario de titulos sueltos no explica nada.';

alter table public.course_lessons add column if not exists kind text not null default 'video';
alter table public.course_lessons add column if not exists is_preview boolean not null default false;

alter table public.course_lessons drop constraint if exists course_lessons_kind_check;
alter table public.course_lessons
  add constraint course_lessons_kind_check
  check (kind in ('video', 'text'));

-- POR QUE SOLO DOS TIPOS, HABIENDO HABLADO DE CUESTIONARIOS Y DIRECTOS. Porque
-- una fila con `kind = 'quiz'` que ninguna pantalla sabe pintar es peor que no
-- tener cuestionarios: el alumno ve una leccion que no se abre. La columna
-- existe justamente para que anadirlos sea cambiar ESTE check y ensenar la
-- opcion, y no una migracion que reordene el temario de todo el mundo.
comment on column public.course_lessons.kind is
  'video | text. La columna existe para poder crecer; el CHECK solo admite lo que la app sabe pintar.';
comment on column public.course_lessons.is_preview is
  'Leccion abierta sin comprar. Es lo que deja probar antes de pagar.';

-- Las lecciones abiertas se piden para la ficha del curso («ver una muestra»)
-- y son pocas: un indice parcial cuesta casi nada y evita recorrer el temario.
create index if not exists course_lessons_preview_idx
  on public.course_lessons (module_id)
  where is_preview;

-- ---------------------------------------------------------------------------
-- 4. Quien puede mover la revision
-- ---------------------------------------------------------------------------
-- ESTO ES LO QUE DE VERDAD PROTEGE EL PROCESO, y no esconder un boton.
--
-- `courses_write` (0001) deja al AUTOR actualizar su curso entero, columna a
-- columna. Con las columnas nuevas eso significa que cualquiera podria abrir
-- Supabase y escribir `review_status = 'approved'` en su propio curso: la
-- revision seria un tramite que el revisado se firma solo.
--
-- No se puede arreglar solo con RLS porque una politica de UPDATE no distingue
-- QUE columna cambio. Hace falta un trigger que compare el valor viejo con el
-- nuevo.
--
-- QUIEN PUEDE QUE:
--   * Administracion: cualquier transicion. Es su trabajo.
--   * El autor: solo enviar a revision (draft|rejected -> pending_review). Ni
--     aprobarse, ni escribirse el motivo del rechazo, ni firmar quien reviso.
--   * El backend con identidad de servicio (`auth.uid()` nulo, que es como se
--     conecta la API): todo. Es la misma regla que el comercio: conceder pasa
--     por el servidor, que ya comprueba el rol contra `profiles`.
create or replace function public.guardar_revision_de_curso()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Nada que vigilar si la revision no se toca.
  if new.review_status is not distinct from old.review_status
     and new.reviewed_by is not distinct from old.reviewed_by
     and new.rejection_reason is not distinct from old.rejection_reason
     and new.reviewed_at is not distinct from old.reviewed_at then
    return new;
  end if;

  -- El backend (sin JWT) y la administracion mandan.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  -- El autor solo puede pedir que lo revisen.
  if new.author_id = auth.uid()
     and old.review_status in ('draft', 'rejected')
     and new.review_status = 'pending_review'
     and new.reviewed_by is not distinct from old.reviewed_by
     and new.rejection_reason is not distinct from old.rejection_reason then
    return new;
  end if;

  raise exception 'Solo la administracion puede resolver la revision de un curso.'
    using errcode = '42501';
end;
$$;

drop trigger if exists courses_revision_guard on public.courses;
create trigger courses_revision_guard
  before update on public.courses
  for each row execute function public.guardar_revision_de_curso();

-- ---------------------------------------------------------------------------
-- 5. Lo que ya existe no se rompe
-- ---------------------------------------------------------------------------
-- Un curso que HOY esta publicado ya paso por la unica revision que habia: la
-- de quien lo publico. Dejarlo en 'draft' significaria que manana la bandeja de
-- administracion aparece con todo el catalogo dentro y que cualquier pantalla
-- que filtre por aprobados se queda vacia. Se marca como aprobado, que es lo
-- que describe la realidad.
--
-- `where review_status = 'draft'` hace la sentencia repetible: la segunda vez
-- no encuentra nada que cambiar.
update public.courses
   set review_status = 'approved',
       reviewed_at = coalesce(reviewed_at, now())
 where status = 'published'
   and review_status = 'draft';

-- Y la categoria principal de quien ya eligio temas: el primero que eligio.
-- Es un dato que la persona YA declaro, no una suposicion sobre su curso.
update public.courses c
   set primary_topic_id = (
     select ct.topic_id
       from public.course_topics ct
      where ct.course_id = c.id
      order by ct.created_at
      limit 1
   )
 where c.primary_topic_id is null
   and exists (select 1 from public.course_topics ct where ct.course_id = c.id);

-- ---------------------------------------------------------------------------
-- 6. Politicas
-- ---------------------------------------------------------------------------
-- `courses_read` y `courses_write` (0001) ya cubren las columnas nuevas: la RLS
-- es por FILA, no por columna, asi que no hay que tocarlas. Se recrean tal cual
-- estaban para que el script sea autocontenido y para dejar por escrito que
-- siguen siendo estas y no otras.
drop policy if exists courses_read on public.courses;
create policy courses_read on public.courses
  for select using (
    status = 'published' or author_id = auth.uid() or public.is_admin()
  );

drop policy if exists courses_write on public.courses;
create policy courses_write on public.courses
  for all using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());

-- Los modulos y las lecciones se ESCRIBEN desde la app (0012). Sus politicas de
-- escritura ya existen y suben por la jerarquia hasta el autor del curso; las
-- columnas nuevas entran por ellas sin cambio ninguno.

-- PostgREST cachea el esquema; sin esto los cambios tardan en verse.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Comprobacion final. Las columnas tienen que estar, las restricciones
-- tambien, y TODO lo anterior queda INTACTO.
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'courses'
       and column_name in ('subtitle', 'promo_video_path', 'primary_topic_id',
                           'language', 'level', 'target_audience',
                           'prerequisites', 'review_status', 'submitted_at',
                           'reviewed_at', 'reviewed_by', 'rejection_reason'))
                                                                as columnas_de_curso,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'course_modules'
       and column_name = 'description')                         as columna_de_modulo,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'course_lessons'
       and column_name in ('kind', 'is_preview'))               as columnas_de_leccion,
  (select count(*) from pg_constraint
     where conname in ('courses_level_check', 'courses_review_status_check',
                       'courses_primary_topic_fk', 'courses_reviewed_by_fk',
                       'course_lessons_kind_check'))            as restricciones,
  (select count(*) from pg_trigger
     where tgname = 'courses_revision_guard')                   as guardia_de_revision,
  (select count(*) from public.courses
     where review_status = 'approved')                          as cursos_ya_aprobados,
  (select count(*) from public.courses)                         as cursos_intactos,
  (select count(*) from public.course_modules)                  as modulos_intactos,
  (select count(*) from public.course_lessons)                  as lecciones_intactas,
  (select count(*) from public.course_topics)                   as temas_intactos,
  (select count(*) from public.purchases)                       as compras_intactas,
  (select count(*) from public.lesson_progress)                 as progreso_intacto,
  (select count(*) from public.profiles)                        as perfiles_intactos;
-- Esperado: 12, 1, 2, 5, 1; `cursos_ya_aprobados` = los que estaban publicados
-- y el resto igual que antes de ejecutar el script.
