-- 0058 · Evaluación final de un curso.
--
-- SIN APLICAR. El código funciona sin ella: no se ofrece evaluación en ningún
-- sitio y los endpoints responden 503 `course_quiz_not_available`.
--
-- QUÉ SUSTITUYE. El móvil tenía `QuizScreen` con las preguntas escritas a mano
-- en `data/mockData.ts`: un test de captación que no está atado a ningún curso
-- y cuyo resultado no sale del teléfono. Eso NO es la evaluación de un curso, y
-- dejarlo pasando por una lo era todo menos honesto.
--
-- CERO O UNA POR CURSO, y lo decide `unique (course_id)`, no un `if`.
--
-- LA RESPUESTA CORRECTA NO SALE DE AQUÍ mientras el intento está abierto. Eso
-- lo sostiene la API —selecciona columnas, no filas enteras— y encima estas
-- tablas nacen SIN concesión para `anon` ni `authenticated`, así que PostgREST
-- no las sirve: no hay forma de pedir `is_correct` desde el cliente.
--
-- UNA PREGUNTA TIENE UNA SOLA RESPUESTA CORRECTA. Un índice único parcial, no
-- una comprobación en Python: dos peticiones a la vez marcando dos opciones
-- distintas se pasarían por delante de cualquier `if`.
--
-- EL RESULTADO SE GUARDA, y no es una caché. Editar la evaluación publicada no
-- puede cambiar la nota de quien la hizo el mes pasado, y recalcularla contra
-- las preguntas de hoy sería justo eso.
--
-- REINTENTOS: se permiten, se guarda el historial entero y para la finalización
-- cuenta el MEJOR resultado. Es la regla más simple que no castiga a nadie por
-- volver a intentarlo.
--
-- ROLLBACK:
--   drop table if exists public.quiz_answers;
--   drop table if exists public.quiz_attempts;
--   drop table if exists public.quiz_options;
--   drop table if exists public.quiz_questions;
--   drop table if exists public.course_quizzes;

create table if not exists public.course_quizzes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null
    constraint course_quizzes_un_curso unique
    references public.courses(id) on delete cascade,
  title text not null default '',
  -- Nota mínima para aprobar, en enteros. 70 es el valor por defecto; es una
  -- decisión de producto y por eso es configurable.
  pass_percent smallint not null default 70
    constraint course_quizzes_pass_percent
    check (pass_percent between 1 and 100),
  -- 'draft' mientras se escribe; 'published' cuando el alumno puede verla.
  status text not null default 'draft'
    constraint course_quizzes_status
    check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.course_quizzes(id) on delete cascade,
  prompt text not null
    constraint quiz_questions_prompt
    check (length(trim(prompt)) between 1 and 500),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists quiz_questions_por_orden
  on public.quiz_questions (quiz_id, sort_order);

create table if not exists public.quiz_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  body text not null
    constraint quiz_options_body
    check (length(trim(body)) between 1 and 300),
  is_correct boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists quiz_options_por_orden
  on public.quiz_options (question_id, sort_order);

-- UNA SOLA CORRECTA POR PREGUNTA. Índice único PARCIAL: las incorrectas no se
-- estorban entre sí y la segunda correcta rebota contra la base.
create unique index if not exists quiz_options_una_correcta
  on public.quiz_options (question_id)
  where is_correct;

-- Para que una respuesta pueda apuntar a la PAREJA (pregunta, alternativa) y no
-- a cada una por su lado. Sin esto, responder la pregunta 1 con una alternativa
-- de la pregunta 2 es una fila perfectamente válida para la base.
alter table public.quiz_options
  drop constraint if exists quiz_options_de_su_pregunta;
alter table public.quiz_options
  add constraint quiz_options_de_su_pregunta unique (question_id, id);

create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.course_quizzes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  -- La versión que se estaba estudiando. Nula si el curso no tiene ninguna.
  course_version_id uuid references public.course_versions(id) on delete set null,
  -- 'in_progress' mientras se responde; 'submitted' es definitivo.
  status text not null default 'in_progress'
    constraint quiz_attempts_status
    check (status in ('in_progress', 'submitted')),
  -- La nota, calculada por el SERVIDOR al enviar. Nula mientras no se envía:
  -- un 0 diría «lo hizo y sacó cero».
  score_percent smallint
    constraint quiz_attempts_nota
    check (score_percent is null or score_percent between 0 and 100),
  passed boolean,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  -- Un intento enviado tiene nota y fecha; uno abierto no tiene ninguna de las
  -- dos. Lo comprueba la base porque es lo que separa «lo está haciendo» de
  -- «lo hizo», y de ahí sale la finalización del curso.
  constraint quiz_attempts_coherente check (
    (status = 'in_progress' and score_percent is null and passed is null
      and submitted_at is null)
    or
    (status = 'submitted' and score_percent is not null and passed is not null
      and submitted_at is not null)
  )
);

-- UN SOLO INTENTO ABIERTO POR PERSONA Y EVALUACIÓN. Índice único parcial: los
-- enviados se acumulan como historial, el abierto es uno.
create unique index if not exists quiz_attempts_uno_abierto
  on public.quiz_attempts (quiz_id, user_id)
  where status = 'in_progress';

create index if not exists quiz_attempts_historial
  on public.quiz_attempts (user_id, quiz_id, submitted_at desc);

create table if not exists public.quiz_answers (
  attempt_id uuid not null references public.quiz_attempts(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  option_id uuid not null references public.quiz_options(id) on delete cascade,
  answered_at timestamptz not null default now(),
  -- UNA RESPUESTA POR PREGUNTA Y POR INTENTO, y lo dice la clave primaria.
  primary key (attempt_id, question_id),
  -- Y LA ALTERNATIVA ES DE ESA PREGUNTA, y lo dice la base. La API ya lo
  -- comprueba (422 `quiz_option_unknown`), pero un `if` en Python no es un
  -- invariante: cualquier otra vía de escritura se lo salta.
  constraint quiz_answers_alternativa_de_la_pregunta
    foreign key (question_id, option_id)
    references public.quiz_options (question_id, id) on delete cascade
);

alter table public.course_quizzes enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_options enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.quiz_answers enable row level security;

-- Ninguna política de lectura para el cliente, y a propósito: `quiz_options`
-- lleva `is_correct`, y una política de SELECT sobre la tabla entrega la fila
-- entera. La evaluación se sirve SOLO por la API, que elige las columnas.
revoke all on public.course_quizzes from anon, authenticated;
revoke all on public.quiz_questions from anon, authenticated;
revoke all on public.quiz_options from anon, authenticated;
revoke all on public.quiz_attempts from anon, authenticated;
revoke all on public.quiz_answers from anon, authenticated;

do $$
declare
  faltan text := '';
  t text;
begin
  foreach t in array array['course_quizzes','quiz_questions','quiz_options',
                           'quiz_attempts','quiz_answers'] loop
    if to_regclass('public.' || t) is null then
      faltan := faltan || 'tabla_' || t || ' ';
    end if;
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relrowsecurity
    ) then faltan := faltan || 'rls_' || t || ' '; end if;
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t
        and grantee in ('anon', 'authenticated')
    ) then faltan := faltan || 'concesion_' || t || ' '; end if;
  end loop;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'quiz_options_una_correcta'
  ) then faltan := faltan || 'indice_una_correcta '; end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'quiz_attempts_uno_abierto'
  ) then faltan := faltan || 'indice_uno_abierto '; end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'quiz_attempts_coherente'
  ) then faltan := faltan || 'coherencia_del_intento '; end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'quiz_answers_alternativa_de_la_pregunta'
  ) then faltan := faltan || 'alternativa_de_su_pregunta '; end if;
  if not exists (
    select 1 from pg_constraint where conname = 'course_quizzes_un_curso'
  ) then faltan := faltan || 'una_evaluacion_por_curso '; end if;
  -- Por nombre, no por el texto del CHECK: ver la nota de la 0057.
  if not exists (
    select 1 from pg_constraint where conname = 'quiz_options_body'
  ) then faltan := faltan || 'limite_de_alternativa '; end if;
  if not exists (
    select 1 from pg_constraint where conname = 'quiz_questions_prompt'
  ) then faltan := faltan || 'limite_de_enunciado '; end if;

  if faltan <> '' then
    raise exception '0058 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
