-- 0059 · Finalización de un curso y certificado verificable.
--
-- SIN APLICAR. El código funciona sin ella: no se emite ningún certificado y
-- los endpoints responden 503 `course_certificates_not_available`. La
-- finalización se sigue CALCULANDO —lecciones completas y evaluación aprobada
-- si la hay—, lo que no queda es su fecha.
--
-- POR QUÉ SE GUARDA LA FINALIZACIÓN si se puede calcular. Porque el certificado
-- dice una FECHA, y recalcularla mañana con las lecciones de mañana daría otra:
-- añadir una lección a un curso movería el día en que alguien lo terminó. La
-- clave primaria compuesta hace el guardado idempotente sin un `if`: la segunda
-- vez que se calcula, la fila ya está y la fecha original no se toca.
--
-- EL IDENTIFICADOR PÚBLICO NO SE PUEDE ADIVINAR. Lo genera la API con
-- `secrets`, no es correlativo y no lleva año ni contador: un código como
-- «ZC-2025-034892» se recorre entero en una tarde y deja consultar los
-- certificados de todo el mundo.
--
-- QUÉ SE COPIA Y POR QUÉ. El nombre de quien lo obtuvo, el título del curso, el
-- del autor y el número de versión se GUARDAN en el certificado. Un certificado
-- que cambia de nombre cuando alguien edita su perfil no certifica nada.
--
-- LO QUE **NO** LLEVA: correo, identificador interno de usuario, número de
-- orden ni referencia de pago. La página de verificación es pública.
--
-- UN CERTIFICADO POR PERSONA Y CURSO: `unique (user_id, course_id)`. Reintentar
-- la emisión devuelve el que ya existe.
--
-- REVOCAR NO BORRA. Una devolución total confirmada revoca el acceso y deja el
-- certificado como `revoked`, con su motivo y su fecha; sigue en el historial y
-- la verificación pública dice que no está vigente.
--
-- ROLLBACK:
--   drop table if exists public.course_certificates;
--   drop table if exists public.course_completions;

create table if not exists public.course_completions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  -- El día en que se terminó. NO se vuelve a tocar: la clave primaria hace que
  -- el segundo cálculo choque en vez de reescribirla.
  completed_at timestamptz not null default now(),
  -- El intento que lo cerró, si el curso tenía evaluación.
  quiz_attempt_id uuid references public.quiz_attempts(id) on delete set null,
  -- La versión que se estudiaba al terminar.
  course_version_id uuid references public.course_versions(id) on delete set null,
  primary key (user_id, course_id)
);

create index if not exists course_completions_por_fecha
  on public.course_completions (user_id, completed_at desc);

create table if not exists public.course_certificates (
  id uuid primary key default gen_random_uuid(),
  -- El código que se comparte. Lo genera la API con `secrets`; no es
  -- correlativo y no se puede recorrer.
  public_id text not null
    constraint course_certificates_codigo_unico unique
    constraint course_certificates_codigo
    check (length(public_id) between 16 and 64),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  -- Copia del momento de la emisión. Un certificado que cambia de nombre
  -- cuando alguien edita su perfil no certifica nada.
  display_name text not null,
  course_title text not null,
  author_name text not null default '',
  course_version integer,
  completed_at timestamptz not null,
  issued_at timestamptz not null default now(),
  status text not null default 'valid'
    constraint course_certificates_status
    check (status in ('valid', 'revoked')),
  revoked_at timestamptz,
  revoked_reason text,
  -- Revocado tiene fecha; vigente no la tiene. Es lo que separa los dos
  -- estados, y de ahí sale lo que dice la verificación pública.
  constraint course_certificates_coherente check (
    (status = 'valid' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  ),
  -- UNO POR PERSONA Y CURSO. Reintentar la emisión devuelve el que ya hay.
  constraint course_certificates_uno_por_curso unique (user_id, course_id)
);

create index if not exists course_certificates_por_persona
  on public.course_certificates (user_id, issued_at desc);

alter table public.course_completions enable row level security;
alter table public.course_certificates enable row level security;

-- La finalización es privada: solo la propia.
drop policy if exists course_completions_propias on public.course_completions;
create policy course_completions_propias on public.course_completions
  for select using (user_id = auth.uid());

-- El certificado también se lee por su código público, pero ESO LO SIRVE LA
-- API, que elige qué columnas salen. Aquí, solo el propio.
drop policy if exists course_certificates_propios on public.course_certificates;
create policy course_certificates_propios on public.course_certificates
  for select using (user_id = auth.uid());

-- Sin política de escritura: escribe la API. Nacen cerradas, como manda la 0053.
revoke all on public.course_completions from anon, authenticated;
revoke all on public.course_certificates from anon, authenticated;

do $$
declare
  faltan text := '';
  t text;
begin
  foreach t in array array['course_completions','course_certificates'] loop
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

  -- TODAS POR NOMBRE, no por el texto de la definición: ver la nota de la 0057.
  if not exists (
    select 1 from pg_constraint where conname = 'course_certificates_codigo_unico'
  ) then faltan := faltan || 'codigo_publico_unico '; end if;
  if not exists (
    select 1 from pg_constraint where conname = 'course_certificates_uno_por_curso'
  ) then faltan := faltan || 'uno_por_persona_y_curso '; end if;
  if not exists (
    select 1 from pg_constraint where conname = 'course_certificates_coherente'
  ) then faltan := faltan || 'coherencia_de_revocacion '; end if;

  if faltan <> '' then
    raise exception '0059 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
