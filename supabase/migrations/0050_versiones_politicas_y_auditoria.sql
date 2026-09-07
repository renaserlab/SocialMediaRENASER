-- 0050 · Versiones de curso, oferta congelada, políticas versionadas,
--        consentimientos y auditoría compartida.
--
-- QUÉ PROBLEMA CIERRA. Hasta aquí, editar un curso reescribía lo que alguien ya
-- había comprado: la orden congelaba el importe y la moneda, y nada más. No
-- había forma de responder «¿qué compró exactamente esta persona?». Tampoco
-- había dónde guardar qué texto legal se le enseñó, ni quién movió el dinero.
--
-- ES ADITIVA. No borra ni reescribe nada: crea tablas nuevas y añade columnas
-- ANULABLES (o con valor por defecto) a `orders` y `entitlements`. Una API sin
-- actualizar sigue funcionando exactamente igual, que es lo que permite
-- desplegarla antes que el código.
--
-- LO QUE NO HACE, Y ES DELIBERADO:
--
--   * No cambia la política de garantía. Siguen siendo 168 horas desde el
--     primer acceso protegido, una ventana por (usuario, curso) de por vida y
--     un solo reembolso voluntario. `orders.guarantee_hours` nace con 168 por
--     defecto: congela lo que hoy es una constante del código, sin alterar
--     ningún plazo ya empezado.
--   * No rellena `orders.course_version_id` de las órdenes históricas. Ver el
--     apartado de backfill: sería inventar qué se vendió.
--   * No escribe ningún texto legal. Crea la capacidad de guardarlos; el
--     contenido depende de decisiones que no están tomadas (entidad vendedora,
--     jurisdicción, impuestos).
--
-- ROLLBACK. No hay herramienta de migraciones en este proyecto: se aplican a
-- mano. Para volver atrás, en este orden y solo si NINGUNA fila se ha escrito:
--
--   drop trigger if exists audit_events_solo_anadir on public.audit_events;
--   drop trigger if exists consent_records_inmutable on public.consent_records;
--   drop trigger if exists policy_versions_inmutable on public.policy_versions;
--   drop trigger if exists course_versions_inmutable on public.course_versions;
--   drop function if exists public.impedir_reescritura();
--   drop function if exists public.impedir_reescritura_de_publicada();
--   drop function if exists public.sellar_consumo_una_vez();
--   alter table public.entitlements drop column if exists course_version_id;
--   alter table public.orders drop column if exists course_version_id,
--     drop column if exists guarantee_hours, drop column if exists guarantee_policy,
--     drop column if exists terms_version, drop column if exists offer_hash,
--     drop column if exists snapshot_origin;
--   drop table if exists public.audit_events;
--   drop table if exists public.consent_records;
--   drop table if exists public.policy_versions;
--   drop table if exists public.course_versions;
--
-- Con filas escritas, la vuelta atrás real es RETIRAR EL CÓDIGO y dejar las
-- tablas: son historial, y el historial no se borra para deshacer un despliegue.
-- Es la misma regla que fijó la 0045.

-- ========================================================================= --
-- 1. VERSIONES DE CURSO
-- ========================================================================= --

create table if not exists public.course_versions (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,

  -- 1, 2, 3… por curso. Legible para una persona, a diferencia del uuid.
  version integer not null,

  -- 'published' es la vigente; 'superseded', las anteriores. No hay 'draft':
  -- el borrador es el curso mismo, y una versión solo nace al publicar.
  status text not null default 'published',

  -- SHA-256 del snapshot canónico. Sirve para no crear una versión nueva
  -- cuando se republica sin haber cambiado nada.
  content_hash text not null,

  -- La fotografía. Un solo documento porque el contenido vive repartido en tres
  -- sitios —`courses`, las columnas de la 0034 y el temario— y el temario NO
  -- tiene marca temporal: no hay otra forma de reconstruirlo después.
  snapshot jsonb not null,

  published_at timestamptz not null default now(),
  published_by uuid references public.profiles(id) on delete set null,

  -- 'publish' es una versión creada al publicar de verdad. 'backfill' es una
  -- reconstruida a partir del estado actual del curso cuando se aplicó esta
  -- migración: dice lo que el curso ES, no necesariamente lo que fue vendido.
  -- La distinción importa y no debe borrarse.
  origin text not null default 'publish',

  created_at timestamptz not null default now(),

  constraint course_versions_version_positiva check (version >= 1),
  constraint course_versions_status check (status in ('published', 'superseded')),
  constraint course_versions_origin check (origin in ('publish', 'backfill'))
);

create unique index if not exists course_versions_numero_unico
  on public.course_versions (course_id, version);

-- UNA SOLA VERSIÓN VIGENTE POR CURSO, y lo garantiza la base.
--
-- `publish_course` no está serializado: lee con `db.get`, valida y escribe.
-- Mientras solo cambiaba `status` era inocuo —dos escrituras idénticas—, pero
-- en cuanto publicar CREA una fila, dos peticiones simultáneas crearían dos
-- versiones vigentes. Un `if` en Python no lo impide; este índice sí.
create unique index if not exists course_versions_vigente_unica
  on public.course_versions (course_id)
  where status = 'published';

create index if not exists course_versions_curso_idx
  on public.course_versions (course_id, version desc);

-- ========================================================================= --
-- 2. LA OFERTA, CONGELADA EN LA ORDEN
-- ========================================================================= --
--
-- Columnas en `orders` y no una tabla aparte: la orden YA es el snapshot
-- —congela importe y moneda desde la 0035—, la relación es uno a uno, y una
-- fila más que puede faltar es una fila más que puede faltar justo donde el
-- dinero no admite «casi».

alter table public.orders
  -- ANULABLE, y no se puede evitar: las órdenes que ya existen no tienen
  -- versión y ponerles una sería afirmar qué se vendió. Ver el backfill.
  add column if not exists course_version_id uuid references public.course_versions(id) on delete restrict,
  -- La promesa de garantía que se enseñó, en horas. 168 por defecto porque es
  -- lo que hoy dice el código para todos los cursos; congelarlo aquí no cambia
  -- ningún plazo vivo y evita una segunda migración sobre órdenes ya pagadas.
  add column if not exists guarantee_hours integer not null default 168,
  add column if not exists guarantee_policy text not null default 'refund_v1',
  -- Reservada. Hoy siempre nula: no hay términos de compra aprobados porque
  -- falta decidir entidad vendedora, jurisdicción e impuestos.
  add column if not exists terms_version text,
  add column if not exists offer_hash text,
  -- 'live' cuando la orden nació con versión; 'legacy' para lo anterior a esta
  -- migración. Que el valor por defecto sea 'legacy' es a propósito: si el
  -- código no lo rellena, lo honesto es decir que no se sabe.
  add column if not exists snapshot_origin text not null default 'legacy';

alter table public.orders
  drop constraint if exists orders_snapshot_origin;
alter table public.orders
  add constraint orders_snapshot_origin check (snapshot_origin in ('live', 'legacy'));

alter table public.orders
  drop constraint if exists orders_guarantee_hours;
alter table public.orders
  add constraint orders_guarantee_hours check (guarantee_hours >= 0);

create index if not exists orders_version_idx
  on public.orders (course_version_id)
  where course_version_id is not null;

-- El derecho es el ÚNICO punto común a las tres vías de acceso: compra,
-- tienda y beta. La beta no crea orden, así que sin esto quedaría fuera.
alter table public.entitlements
  add column if not exists course_version_id uuid references public.course_versions(id) on delete set null;

-- ========================================================================= --
-- 3. POLÍTICAS VERSIONADAS
-- ========================================================================= --
--
-- Hoy el texto de la política de recompra vive en el CÓDIGO
-- (`refunds/politica.py`, `VERSION_ACTUAL = 'v1'`). Eso significa que la huella
-- guardada en una aceptación solo demuestra algo mientras esa versión del
-- código siga en el repositorio. Aquí el texto pasa a ser un dato.

create table if not exists public.policy_versions (
  id uuid primary key default gen_random_uuid(),

  -- 'refund_repurchase' es la única que se siembra hoy. 'terms' y 'privacy'
  -- existen como tipo para que el día que haya texto aprobado no haga falta
  -- otra migración; no se crea ninguna fila de esos tipos.
  policy_type text not null,
  jurisdiction text not null default 'PE',
  locale text not null default 'es',
  version text not null,

  body text not null,
  body_sha256 text not null,
  -- Lo que hay que marcar para aceptar, cuando la política lo lleva.
  checkbox_text text,

  status text not null default 'draft',
  effective_from timestamptz,
  effective_to timestamptz,
  published_at timestamptz,
  published_by uuid references public.profiles(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint policy_versions_type check (
    policy_type in ('refund_repurchase', 'terms', 'privacy', 'guarantee')
  ),
  constraint policy_versions_status check (status in ('draft', 'published', 'superseded')),
  -- Una publicada tiene que estar completa. Sin esto, «publicada» podría
  -- significar «publicada sin fecha de vigencia», que no significa nada.
  constraint policy_versions_publicada_completa check (
    status <> 'published'
    or (effective_from is not null and published_at is not null)
  ),
  constraint policy_versions_vigencia check (
    effective_to is null or effective_from is null or effective_to > effective_from
  )
);

create unique index if not exists policy_versions_unica
  on public.policy_versions (policy_type, jurisdiction, locale, version);

-- UNA SOLA VIGENTE por tipo, jurisdicción e idioma. Es lo que impide que el
-- servidor tenga que ELEGIR entre dos: elegir arbitrariamente una política es
-- exactamente lo que no puede pasar.
create unique index if not exists policy_versions_vigente_unica
  on public.policy_versions (policy_type, jurisdiction, locale)
  where status = 'published' and effective_to is null;

-- ========================================================================= --
-- 4. CONSENTIMIENTOS
-- ========================================================================= --
--
-- `refund_policy_acceptances` (0049) SE QUEDA COMO ESTÁ y no se migra: su
-- unicidad `(user_id, course_id, order_id)` es de dominio y no generaliza.
-- Esta tabla es la general; la de devoluciones seguirá siendo la que use el
-- circuito de recompra hasta que se decida moverlo, y entonces será otro
-- cambio con sus propias pruebas.

create table if not exists public.consent_records (
  id uuid primary key default gen_random_uuid(),

  -- `restrict` y no `cascade`: borrar un perfil no puede borrar la prueba de lo
  -- que esa persona aceptó antes de pagar.
  subject_id uuid not null references public.profiles(id) on delete restrict,
  policy_version_id uuid not null references public.policy_versions(id) on delete restrict,

  -- Desnormalizados a propósito: la respuesta tiene que poder darse aunque la
  -- fila de la política cambie de estado.
  policy_type text not null,
  policy_version text not null,
  -- Huella del texto EXACTO que se mostró, con sus huecos ya rellenados.
  policy_hash text not null,

  -- A qué se ata: nada, un curso o una orden concreta.
  scope_kind text not null default 'global',
  scope_id uuid,

  -- Qué consumió esta aceptación. Se sella UNA vez y no se puede reescribir.
  consumed_by_kind text,
  consumed_by_id uuid,
  consumed_at timestamptz,

  accepted_at timestamptz not null default now(),

  -- Contexto de origen. NUNCA en claro: ver el apartado de datos sensibles.
  request_id text,
  ip_hash text,
  ip_prefix text,
  user_agent_family text,
  channel text,

  created_at timestamptz not null default now(),

  constraint consent_records_scope check (scope_kind in ('global', 'course', 'order')),
  constraint consent_records_scope_coherente check (
    (scope_kind = 'global' and scope_id is null) or (scope_kind <> 'global' and scope_id is not null)
  ),
  constraint consent_records_consumo_coherente check (
    (consumed_at is null and consumed_by_id is null and consumed_by_kind is null)
    or (consumed_at is not null and consumed_by_id is not null and consumed_by_kind is not null)
  ),
  -- La IP en claro no cabe aquí ni por accidente: solo huella y prefijo.
  constraint consent_records_ip_sin_claro check (
    ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'
  )
);

-- UNA ACEPTACIÓN NO SE CONSUME DOS VECES. El enlace aceptación→orden se
-- resolvía en Python con un `order_by … limit 1` tras un fallo ya corregido a
-- mano; esto lo sostiene la base.
create unique index if not exists consent_records_consumo_unico
  on public.consent_records (consumed_by_kind, consumed_by_id)
  where consumed_by_id is not null;

-- Y UN DOBLE TOQUE NO CREA DOS. El `select … if ya existe` de Python lo pasan
-- dos peticiones simultáneas; un índice único no.
create unique index if not exists consent_records_pendiente_unico
  on public.consent_records (
    subject_id, policy_type, scope_kind,
    coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    policy_version_id
  )
  where consumed_at is null;

create index if not exists consent_records_sujeto_idx
  on public.consent_records (subject_id, policy_type, accepted_at desc);

-- ========================================================================= --
-- 5. AUDITORÍA COMPARTIDA
-- ========================================================================= --
--
-- NO SUSTITUYE a `refund_request_events`. Esa es la máquina de estados del
-- expediente, con sus claves foráneas, su CHECK y consultas de negocio encima
-- (`_fallos_terminales` cuenta eventos fallidos). Esta es el rastro transversal
-- de las operaciones sensibles que hoy no dejan ninguno: publicar un curso,
-- congelar un saldo, lanzar una transferencia.

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),

  actor_id uuid references public.profiles(id) on delete set null,
  actor_role text not null default 'system',

  -- 'course.published', 'balance.frozen', 'transfer.executed'…
  action text not null,
  entity_type text not null,
  entity_id uuid not null,

  -- Distingue lo intentado de lo conseguido. Un registro que solo sabe contar
  -- éxitos no sirve para investigar nada.
  outcome text not null default 'ok',

  previous_state text,
  new_state text,
  reason text,
  external_reference text,

  -- Identificadores y códigos. NUNCA cuerpos de aviso, cabeceras ni secretos:
  -- misma regla que `refund_request_events.metadata`.
  payload jsonb not null default '{}'::jsonb,

  request_id text,
  ip_hash text,
  ip_prefix text,
  user_agent_family text,

  created_at timestamptz not null default now(),

  constraint audit_events_actor_role check (
    actor_role in ('user', 'admin', 'moderator', 'system')
  ),
  constraint audit_events_outcome check (outcome in ('ok', 'denied', 'error')),
  constraint audit_events_ip_sin_claro check (
    ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'
  )
);

create index if not exists audit_events_entidad_idx
  on public.audit_events (entity_type, entity_id, occurred_at desc);
create index if not exists audit_events_actor_idx
  on public.audit_events (actor_id, occurred_at desc);
create index if not exists audit_events_accion_idx
  on public.audit_events (action, occurred_at desc);

-- ========================================================================= --
-- 6. INMUTABILIDAD, FORZADA POR LA BASE
-- ========================================================================= --
--
-- La RLS no basta: la API entra con la clave de servicio, que se la salta. Un
-- `UPDATE` desde el backend reescribiría el texto que alguien firmó, y el
-- historial dejaría de ser historial. `refund_request_events` es append-only
-- «por convención» desde la 0049 y nada lo impide; aquí sí lo impide algo.

create or replace function public.impedir_reescritura()
returns trigger language plpgsql as $$
begin
  raise exception 'La tabla % es de solo anadir: no admite % ', TG_TABLE_NAME, TG_OP
    using errcode = 'restrict_violation';
end;
$$;

create or replace function public.sellar_consumo_una_vez()
returns trigger language plpgsql as $$
begin
  -- Lo único que puede cambiar de un consentimiento es sellar su consumo, y
  -- una sola vez. Todo lo demás es la prueba de lo que se aceptó.
  if old.consumed_at is not null then
    raise exception 'El consentimiento % ya estaba consumido', old.id
      using errcode = 'restrict_violation';
  end if;
  if (new.subject_id, new.policy_version_id, new.policy_hash, new.accepted_at)
     is distinct from
     (old.subject_id, old.policy_version_id, old.policy_hash, old.accepted_at) then
    raise exception 'No se puede reescribir un consentimiento, solo sellar su consumo'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create or replace function public.impedir_reescritura_de_publicada()
returns trigger language plpgsql as $$
begin
  -- De una fila publicada solo se puede cerrar la vigencia o retirarla. El
  -- cuerpo y su huella son intocables: son lo que alguien firmó.
  if old.status = 'published' then
    if new.body is distinct from old.body
       or new.body_sha256 is distinct from old.body_sha256
       or new.version is distinct from old.version then
      raise exception 'Una politica publicada no se edita: publica otra version'
        using errcode = 'restrict_violation';
    end if;
    if new.status not in ('published', 'superseded') then
      raise exception 'Una politica publicada no vuelve a borrador'
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists audit_events_solo_anadir on public.audit_events;
create trigger audit_events_solo_anadir
  before update or delete on public.audit_events
  for each row execute function public.impedir_reescritura();

drop trigger if exists consent_records_no_se_borra on public.consent_records;
create trigger consent_records_no_se_borra
  before delete on public.consent_records
  for each row execute function public.impedir_reescritura();

drop trigger if exists consent_records_inmutable on public.consent_records;
create trigger consent_records_inmutable
  before update on public.consent_records
  for each row execute function public.sellar_consumo_una_vez();

drop trigger if exists policy_versions_no_se_borra on public.policy_versions;
create trigger policy_versions_no_se_borra
  before delete on public.policy_versions
  for each row execute function public.impedir_reescritura();

drop trigger if exists policy_versions_inmutable on public.policy_versions;
create trigger policy_versions_inmutable
  before update on public.policy_versions
  for each row execute function public.impedir_reescritura_de_publicada();

-- Una versión de curso publicada no se edita ni se borra. Retirarla es pasarla
-- a 'superseded', que es lo que hace publicar la siguiente.
create or replace function public.impedir_reescritura_de_version()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Una version de curso no se borra: es lo que alguien compro'
      using errcode = 'restrict_violation';
  end if;
  if new.snapshot is distinct from old.snapshot
     or new.content_hash is distinct from old.content_hash
     or new.version is distinct from old.version
     or new.course_id is distinct from old.course_id then
    raise exception 'Una version de curso es inmutable: publica otra'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists course_versions_inmutable on public.course_versions;
create trigger course_versions_inmutable
  before update or delete on public.course_versions
  for each row execute function public.impedir_reescritura_de_version();

-- ========================================================================= --
-- 7. RLS
-- ========================================================================= --
--
-- Mismo patrón que la 0049: RLS activa, SOLO políticas de lectura, ninguna de
-- escritura. Con RLS puesta y sin política, la clave anónima no escribe nada y
-- escribe únicamente la API, que es la que valida.

alter table public.course_versions enable row level security;
alter table public.policy_versions enable row level security;
alter table public.consent_records enable row level security;
alter table public.audit_events enable row level security;

-- El contenido de una versión publicada es público: es la ficha del curso.
drop policy if exists course_versions_read on public.course_versions;
create policy course_versions_read on public.course_versions
  for select using (status = 'published' or public.is_admin());

-- Un texto legal publicado también. Los borradores, no.
drop policy if exists policy_versions_read on public.policy_versions;
create policy policy_versions_read on public.policy_versions
  for select using (status = 'published' or public.is_admin());

-- Cada quien ve lo suyo. El autor del curso NO aparece en ninguna condición, y
-- eso es lo que lo deja fuera: no tiene por qué ver qué aceptó su alumno ni
-- desde dónde.
drop policy if exists consent_records_read on public.consent_records;
create policy consent_records_read on public.consent_records
  for select using (subject_id = auth.uid() or public.is_admin());

-- La auditoría es solo de administración, como `refund_request_events`.
drop policy if exists audit_events_read on public.audit_events;
create policy audit_events_read on public.audit_events
  for select using (public.is_admin());

-- ========================================================================= --
-- 8. BACKFILL
-- ========================================================================= --
--
-- LO QUE SE PUEDE AFIRMAR y lo que no.
--
-- SE PUEDE: que un curso publicado tiene hoy este contenido. Se crea una v1
-- con `origin = 'backfill'` a partir del estado actual.
--
-- NO SE PUEDE: saber qué contenido se vendió. `course_modules` y
-- `course_lessons` no tienen ninguna marca temporal, y el móvil las edita
-- directamente contra Supabase sin dejar rastro. Por eso
-- `orders.course_version_id` de las órdenes anteriores SE QUEDA NULO y su
-- `snapshot_origin` en 'legacy'. Rellenarlas con esta v1 sería afirmar que se
-- vendió lo que hay hoy, que es justo lo que no se sabe.

insert into public.course_versions (
  course_id, version, status, content_hash, snapshot, published_at, origin
)
select
  c.id,
  1,
  'published',
  encode(digest(c.id::text || coalesce(c.title, '') || coalesce(c.description, ''), 'sha256'), 'hex'),
  jsonb_build_object(
    'title', c.title,
    'description', c.description,
    'highlights', coalesce(to_jsonb(c.highlights), '[]'::jsonb),
    'modules', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'title', m.title,
            'sort_order', m.sort_order,
            'lessons', coalesce(
              (
                select jsonb_agg(
                  jsonb_build_object(
                    'title', l.title,
                    'sort_order', l.sort_order,
                    'duration_seconds', l.duration_seconds
                  ) order by l.sort_order
                )
                from public.course_lessons l where l.module_id = m.id
              ),
              '[]'::jsonb
            )
          ) order by m.sort_order
        )
        from public.course_modules m where m.course_id = c.id
      ),
      '[]'::jsonb
    ),
    -- Marca honesta dentro del propio documento, no solo en la columna: quien
    -- lea el snapshot suelto tiene que saber de dónde salió.
    'reconstruido', true
  ),
  now(),
  'backfill'
from public.courses c
where c.status = 'published'
  and not exists (select 1 from public.course_versions v where v.course_id = c.id);

-- ========================================================================= --
-- 9. VERIFICACIÓN
-- ========================================================================= --
--
-- La migración se niega a darse por buena si algo no quedó puesto. Mismo patrón
-- que el bloque final de la 0049: un `if not exists` que no falla es un
-- `if not exists` que se ejecutó sobre una base distinta de la esperada.

do $$
declare
  faltan text := '';
begin
  -- Tablas
  if to_regclass('public.course_versions') is null then faltan := faltan || 'course_versions '; end if;
  if to_regclass('public.policy_versions') is null then faltan := faltan || 'policy_versions '; end if;
  if to_regclass('public.consent_records') is null then faltan := faltan || 'consent_records '; end if;
  if to_regclass('public.audit_events') is null then faltan := faltan || 'audit_events '; end if;

  -- Columnas nuevas
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'course_version_id'
  ) then faltan := faltan || 'orders.course_version_id '; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'guarantee_hours'
  ) then faltan := faltan || 'orders.guarantee_hours '; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'entitlements' and column_name = 'course_version_id'
  ) then faltan := faltan || 'entitlements.course_version_id '; end if;

  -- Los índices que sostienen las invariantes
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'course_versions_vigente_unica')
    then faltan := faltan || 'course_versions_vigente_unica '; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'policy_versions_vigente_unica')
    then faltan := faltan || 'policy_versions_vigente_unica '; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'consent_records_consumo_unico')
    then faltan := faltan || 'consent_records_consumo_unico '; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'consent_records_pendiente_unico')
    then faltan := faltan || 'consent_records_pendiente_unico '; end if;

  -- Los disparadores de inmutabilidad
  if not exists (select 1 from pg_trigger where tgname = 'audit_events_solo_anadir')
    then faltan := faltan || 'trigger:audit_events_solo_anadir '; end if;
  if not exists (select 1 from pg_trigger where tgname = 'course_versions_inmutable')
    then faltan := faltan || 'trigger:course_versions_inmutable '; end if;

  -- RLS
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('course_versions', 'policy_versions', 'consent_records', 'audit_events')
      and c.relrowsecurity = false
  ) then faltan := faltan || 'rls '; end if;

  if faltan <> '' then
    raise exception '0050 incompleta, falta: %', faltan;
  end if;
end $$;

-- PostgREST sirve el esquema que tiene cacheado. Sin esto seguiría sirviendo el
-- anterior hasta reiniciarse solo.
notify pgrst, 'reload schema';
