-- 0060 · Ciclo operativo, versiones y admisión de Eventos.
--
-- SIN APLICAR. El código funciona sin ella: el catálogo, la ficha y la reserva
-- siguen exactamente igual —incluida la corrección del aforo, que no necesita
-- ninguna tabla nueva— y las rutas de organizador y admisión responden 503
-- `events_workflow_not_available`. Ningún evento lleva sello Z, porque no hay
-- dónde guardar una aprobación.
--
-- ADITIVA, Y `events` NO SE TOCA. Ni una columna. No es purismo: una columna
-- nueva en `events` rompe `select(Event)` en el catálogo, en Explorar, en la
-- búsqueda y en el perfil a la vez, desde el despliegue del código hasta que
-- alguien pega este SQL. Una tabla nueva no rompe nada, y además es la
-- separación que se quiere: `events` es la ficha pública que comparte el
-- catálogo; el ciclo, la admisión y las versiones son del dominio de Eventos.
--
-- LAS REGLAS QUE ESTA MIGRACIÓN SOSTIENE, y que no dependen de ningún `if` de
-- Python:
--
--   * `workflow_status` solo admite los SIETE estados que se guardan. Los cinco
--     derivados del blueprint —SOLD_OUT, IN_PROGRESS, COMPLETED_PENDING,
--     MODIFIED, SETTLED— no caben en la columna, así que nadie puede escribir
--     «agotado» a mano y dejarlo mintiendo en cuanto alguien cancele.
--   * Cada criterio de admisión tiene su tope: 20, 15, 15, 15, 15, 10, 5 y 5.
--   * El total tiene que cuadrar con sus ocho sumandos. Un total que no cuadra
--     es la forma silenciosa de subir una nota.
--   * `approved` exige 85 o más y CERO fallas críticas; `conditional`, entre 80
--     y 84. Es la regla del blueprint escrita en la base: ninguna ruta, ni una
--     futura, ni un script, puede aprobar un evento de 70.
--   * Toda decisión lleva motivo no vacío.
--   * Una sola versión vigente por evento (índice parcial).
--   * Una versión NO se reescribe ni se borra: disparador, como en la 0051.
--
-- BACKFILL HONESTO. Los eventos que ya están publicados se quedan publicados y
-- visibles, con `origin = 'legacy'` y `selection_status = 'none'`. No se les
-- regala el sello «Seleccionado por Z», no se les inventa una puntuación y no
-- se les fabrica una versión: no pasaron por una admisión que no existía. Lo
-- que dice `origin` es exactamente eso y nada más.
--
-- ROLLBACK REALISTA:
--   drop trigger if exists event_versions_inmutables on public.event_versions;
--   drop function if exists public.impedir_reescritura_de_version_de_evento();
--   drop table if exists public.event_admission_decisions;
--   drop table if exists public.event_admission_reviews;
--   drop table if exists public.event_documents;
--   drop table if exists public.event_versions;
--   drop table if exists public.event_operations;
-- Ninguna toca `events` ni `event_registrations`, así que deshacerla devuelve
-- la base al estado anterior sin perder un solo evento ni una sola reserva. Lo
-- único que se pierde son las decisiones de admisión tomadas entretanto.

-- ------------------------------------------------------------------------- --
-- 1. El ciclo operativo. Una fila por evento.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_operations (
  event_id uuid primary key references public.events(id) on delete cascade,

  -- Los SIETE que se guardan. Ver la cabecera.
  workflow_status text not null default 'DRAFT'
    constraint event_operations_ciclo
    check (workflow_status in (
      'DRAFT', 'SUBMITTED', 'CONDITIONAL', 'APPROVED',
      'PUBLISHED', 'SUSPENDED', 'CANCELLED'
    )),

  -- El sello. `approved` solo lo escribe una decisión de admisión real.
  selection_status text not null default 'none'
    constraint event_operations_seleccion
    check (selection_status in ('none', 'pending', 'approved', 'rejected')),

  category text,
  -- La promesa: qué vivirá quien vaya. Es lo segundo de la ficha del blueprint
  -- y hoy no cabe en ninguna columna de `events`.
  promise text,
  -- La zona horaria REAL del evento («America/Lima»), que `starts_at` no
  -- guarda: un `timestamptz` guarda el instante, no dónde ocurre.
  timezone text,

  -- El aforo que la admisión autorizó. DISTINTO de `events.capacity`, que es el
  -- que el organizador declara: se puede pedir 300 y aprobarse 200, y admitir
  -- 300 sería admitir lo que nadie aprobó.
  approved_capacity integer
    constraint event_operations_aforo
    check (approved_capacity is null or approved_capacity >= 0),

  current_version integer,
  -- `legacy` para los que ya estaban publicados cuando esto no existía.
  origin text not null default 'events_v2'
    constraint event_operations_origen check (origin in ('events_v2', 'legacy')),

  submitted_at timestamptz,
  decided_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_operations_por_estado
  on public.event_operations (workflow_status);

-- ------------------------------------------------------------------------- --
-- 2. Versiones: la fotografía inmutable de lo comprometido.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_versions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  version integer not null
    constraint event_versions_positiva check (version >= 1),
  status text not null default 'submitted'
    constraint event_versions_estado
    check (status in ('submitted', 'approved', 'published', 'superseded')),
  -- Solo lo comprometido. NO lleva datos financieros —no hay— ni rutas
  -- sensibles: una versión se lee en la ficha de revisión.
  snapshot jsonb not null,
  changed_fields text[],
  reason text not null default '',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint event_versions_correlativa unique (event_id, version)
);

-- UNA SOLA VERSIÓN VIGENTE POR EVENTO. Índice PARCIAL: las superadas no
-- estorban, y sin la condición no se podría guardar más de una versión nunca.
create unique index if not exists event_versions_una_vigente
  on public.event_versions (event_id)
  where status <> 'superseded';

-- La inmutabilidad NO la guarda Python. Igual que la 0051 con las versiones de
-- curso: una versión no se borra y no se reescribe. Lo único que puede cambiar
-- es `status`, que es cómo una versión queda superada o pasa a publicada.
create or replace function public.impedir_reescritura_de_version_de_evento()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    -- SI EL EVENTO YA NO ESTA, esto es la cascada de su borrado y no un intento
    -- de arrancarle una version. Sin esta salida el disparador impide borrar el
    -- evento entero, y por la cascada de `events.organizer_id` tambien impide
    -- dar de baja la cuenta de quien lo organizo. Lo que se protege es que
    -- nadie borre una version SUELTA, dejando un expediente que ya no cuadra.
    if not exists (select 1 from public.events where id = old.event_id) then
      return old;
    end if;
    raise exception 'Una version de evento no se borra: es lo que se reviso'
      using errcode = 'restrict_violation';
  end if;
  if new.snapshot is distinct from old.snapshot
     or new.version is distinct from old.version
     or new.event_id is distinct from old.event_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Una version de evento es inmutable: congela otra'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists event_versions_inmutables on public.event_versions;
create trigger event_versions_inmutables
before update or delete on public.event_versions
for each row execute function public.impedir_reescritura_de_version_de_evento();

-- ------------------------------------------------------------------------- --
-- 3. La evaluación de curaduría: ocho criterios, evidencia y falla crítica.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_admission_reviews (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  version integer not null,
  reviewer_id uuid references public.profiles(id) on delete set null,

  -- Los ocho pesos del blueprint §4.2. Cada uno con SU tope: la base no admite
  -- un 30 sobre 20 aunque el formulario se rompa.
  propuesta smallint not null
    constraint event_admission_reviews_propuesta check (propuesta between 0 and 20),
  trayectoria smallint not null
    constraint event_admission_reviews_trayectoria check (trayectoria between 0 and 15),
  programa smallint not null
    constraint event_admission_reviews_programa check (programa between 0 and 15),
  recinto smallint not null
    constraint event_admission_reviews_recinto check (recinto between 0 and 15),
  seguridad smallint not null
    constraint event_admission_reviews_seguridad check (seguridad between 0 and 15),
  precio smallint not null
    constraint event_admission_reviews_precio check (precio between 0 and 10),
  accesibilidad smallint not null
    constraint event_admission_reviews_accesibilidad check (accesibilidad between 0 and 5),
  afinidad smallint not null
    constraint event_admission_reviews_afinidad check (afinidad between 0 and 5),

  total smallint not null
    constraint event_admission_reviews_total_cuadra
    check (total = propuesta + trayectoria + programa + recinto
                 + seguridad + precio + accesibilidad + afinidad),

  critical_failure boolean not null default false,
  critical_reason text not null default ''
    constraint event_admission_reviews_falla_con_motivo
    check (critical_failure = false or length(trim(critical_reason)) >= 1),

  -- Evidencia obligatoria: una nota sin por qué no es evidencia.
  evidence text not null
    constraint event_admission_reviews_evidencia
    check (length(trim(evidence)) >= 1),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_admission_reviews_una_por_version unique (event_id, version)
);

-- ------------------------------------------------------------------------- --
-- 4. La decisión, con el puntaje que la sostenía.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_admission_decisions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  version integer not null,

  decision text not null
    constraint event_admission_decisions_valores
    check (decision in ('approved', 'conditional', 'rejected', 'changes_requested')),

  -- Obligatorio. «Nadie puede modificar un puntaje sin motivo, evidencia y
  -- auditoría», y una decisión sin motivo es lo mismo un escalón más arriba.
  reason text not null
    constraint event_admission_decisions_motivo check (length(trim(reason)) >= 1),

  -- El total Y la falla DEL MOMENTO en que se decidió, copiados. Mirando la
  -- evaluación, una revisión posterior cambiaría por qué se aprobó algo.
  total smallint
    constraint event_admission_decisions_total
    check (total is null or total between 0 and 100),
  critical_failure boolean not null default false,

  decided_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  -- LA REGLA DE APROBACIÓN DEL BLUEPRINT, EN LA BASE.
  -- `total is not null` NO SOBRA, aunque lo parezca. En SQL una comparacion
  -- contra NULL no da FALSO: da NULL, y un CHECK que evalua a NULL SE CUMPLE.
  -- Sin ese `is not null`, `decision = 'approved'` con el total vacio pasaba la
  -- restriccion entera: quedaba aprobado un evento sin ninguna puntuacion, que
  -- es justo lo que esta linea existe para impedir. Lo encontro
  -- `test_aprobar_sin_puntaje_tampoco`.
  constraint event_admission_decisions_umbral check (
    (decision = 'approved' and critical_failure = false
     and total is not null and total >= 85)
    or (decision = 'conditional' and critical_failure = false
        and total is not null and total between 80 and 84)
    or decision in ('rejected', 'changes_requested')
  )
);

create index if not exists event_admission_decisions_por_evento
  on public.event_admission_decisions (event_id, created_at);

-- ------------------------------------------------------------------------- --
-- 5. Requisitos documentales. El registro y su estado, NO un gestor.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_documents (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  kind text not null
    constraint event_documents_tipo check (length(trim(kind)) >= 1),
  status text not null default 'pending'
    constraint event_documents_estado
    check (status in ('pending', 'received', 'approved', 'rejected', 'expired')),
  expires_at timestamptz,
  required boolean not null default true,
  blocks_publication boolean not null default true,
  note text not null default '',
  -- Ruta en Storage, NUNCA una URL firmada: una URL guardada es una llave que
  -- caduca en la base y sigue pareciendo válida.
  file_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_documents_uno_por_tipo unique (event_id, kind)
);

-- ------------------------------------------------------------------------- --
-- 6. Backfill. Los eventos que ya existen NO desaparecen ni cambian.
-- ------------------------------------------------------------------------- --
--
-- `PUBLISHED` para los que hoy se ven; `DRAFT` para los que no. Es su estado
-- real, escrito en la columna nueva. `origin = 'legacy'` dice la verdad
-- incómoda: están publicados sin haber pasado por la admisión, porque cuando se
-- publicaron la admisión no existía.
--
-- LO QUE EL BACKFILL **NO** HACE, y cada omisión es la misma decisión:
--   * No pone `selection_status = 'approved'`. Nadie aprobó nada.
--   * No crea versiones. No hay ninguna que congelar hacia atrás.
--   * No inventa evaluaciones ni puntajes.
--   * No toca `approved_capacity`: sigue mandando el `capacity` declarado.
insert into public.event_operations (
  event_id, workflow_status, selection_status, origin, published_at
)
select
  e.id,
  case when e.status = 'published' then 'PUBLISHED' else 'DRAFT' end,
  'none',
  'legacy',
  case when e.status = 'published' then e.created_at end
from public.events e
on conflict (event_id) do nothing;

-- ------------------------------------------------------------------------- --
-- 7. RLS y concesiones. Nacen cerradas, como manda la 0053.
-- ------------------------------------------------------------------------- --
alter table public.event_operations enable row level security;
alter table public.event_versions enable row level security;
alter table public.event_admission_reviews enable row level security;
alter table public.event_admission_decisions enable row level security;
alter table public.event_documents enable row level security;

-- Escribe la API, con identidad comprobada. Ninguna política de escritura.
revoke all on public.event_operations from anon, authenticated;
revoke all on public.event_versions from anon, authenticated;
revoke all on public.event_admission_reviews from anon, authenticated;
revoke all on public.event_admission_decisions from anon, authenticated;
revoke all on public.event_documents from anon, authenticated;

-- NINGUNA DE LAS CINCO TIENE POLÍTICA, y es a propósito.
--
-- Una política `for select` entrega la FILA ENTERA, no las columnas que uno
-- tenía en mente. Se probó a dejar tres:
--
--   * `event_admission_reviews` nunca la tuvo: esa fila es la deliberación de
--     curaduría, los ocho puntajes y la evidencia.
--   * `event_admission_decisions` iba a tener una para que el organizador
--     leyera lo que le piden. Pero la fila lleva también `total` —el puntaje
--     agregado— y `decided_by`, que es justo lo que `ObservacionRead` omite a
--     propósito: la API decide qué sale y para quién.
--   * `event_operations` iba a tener otra «porque el sello es público». La
--     fila lleva además `approved_capacity`, `submitted_at`, `decided_at` y
--     `origin`, que dice qué eventos publicados nunca pasaron por admisión.
--
-- Hoy los `revoke` de arriba las hacen inalcanzables, así que dejarlas no
-- rompía nada. Pero una política escrita es una decisión escrita: el día que
-- alguien conceda un `grant select` «para leer solo el sello», se lleva el
-- resto sin enterarse. Nada de esto lo lee el móvil: todo pasa por la API.

-- ------------------------------------------------------------------------- --
-- 8. Comprobación final.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text := '';
  t text;
begin
  foreach t in array array[
    'event_operations', 'event_versions', 'event_admission_reviews',
    'event_admission_decisions', 'event_documents'
  ] loop
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

  -- TODAS POR NOMBRE, no por el texto de la definición: leerlo de vuelta
  -- depende de la versión de PostgreSQL y eso ya hizo fallar la 0057.
  foreach t in array array[
    'event_operations_ciclo',
    'event_operations_seleccion',
    'event_operations_origen',
    'event_versions_correlativa',
    'event_versions_estado',
    'event_admission_reviews_total_cuadra',
    'event_admission_reviews_evidencia',
    'event_admission_reviews_falla_con_motivo',
    'event_admission_reviews_una_por_version',
    'event_admission_decisions_umbral',
    'event_admission_decisions_motivo',
    'event_documents_uno_por_tipo'
  ] loop
    if not exists (select 1 from pg_constraint where conname = t) then
      faltan := faltan || t || ' ';
    end if;
  end loop;

  if to_regclass('public.event_versions_una_vigente') is null then
    faltan := faltan || 'indice_una_version_vigente ';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'event_versions_inmutables'
  ) then faltan := faltan || 'disparador_de_inmutabilidad '; end if;

  -- Y que ningún evento se haya quedado sin ciclo: el backfill los cubre todos.
  if exists (
    select 1 from public.events e
    left join public.event_operations o on o.event_id = e.id
    where o.event_id is null
  ) then faltan := faltan || 'backfill_incompleto '; end if;

  if faltan <> '' then
    raise exception '0060 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
