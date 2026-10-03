-- 0090 · Z Servicios, Incremento 2: el catálogo y la publicación de servicios.
--
-- SIN APLICAR. Escrita el 29/09/2026 y probada solo contra PostgreSQL local:
-- desde cero (0001–0090), sobre una base con la 0089 y datos, reejecutada y con
-- un fallo a mitad (`tests/test_servicios_migracion_0090.py`). Requiere la
-- 0086–0089, aplicadas en Supabase. NO LAS TOCA.
-- Al aplicarla, REINICIAR LA API: la puerta de esquema recuerda el «no».
--
-- QUÉ AÑADE, Y NADA MÁS:
--
--   1. LAS CATEGORÍAS (`service_categories`): una categoría y, como mucho, una
--      subcategoría. Las crea administración; NO SE SIEMBRA NINGUNA (cuáles son
--      las iniciales es una decisión de la empresa). Una inactiva no admite
--      servicios nuevos, pero no se borra ni desaparece de lo que ya existe.
--   2. EL SERVICIO (`services`): la identidad estable de una oferta de un
--      prestador. Su estado: `draft` (nunca publicado), `published`,
--      `suspended` y `retired` (final).
--   3. SUS VERSIONES (`service_versions`): el contenido, separado de la
--      identidad. Solo un BORRADOR se edita; lo enviado queda CONGELADO, y
--      cada decisión dice qué versión revisó. Pedir correcciones cierra esa
--      versión: la corrección es una versión NUEVA. Una sola abierta y una sola
--      publicada por servicio; la publicada anterior sigue visible hasta que se
--      publica la nueva, y entonces pasa a `superseded`.
--   4. SUS IMÁGENES (`service_version_images`), de la VERSIÓN, en el depósito
--      PRIVADO `service-media`. La ruta la pone el servidor y empieza por el
--      perfil del prestador: borrar la cuenta la barre.
--   5. EL HISTORIAL (`service_events`): SOLO SE AÑADE. Motivo visible y nota
--      interna separados.
--
-- NADA DE DINERO: el precio se registra y se muestra. Ni cobro, ni comisión,
-- ni impuestos. Gratis y «sin precio configurado» son estados distintos, y un
-- importe nunca es 0.
--
-- LAS REGLAS QUE IMPONE LA BASE, ADEMÁS DEL CÓDIGO:
--   * los saltos de estado del servicio y de la versión (el mismo mapa que
--     `app/modules/services/catalogo_estados.py`; una prueba compara los dos);
--   * lo enviado no se reescribe, y las imágenes solo cambian en un borrador;
--   * enviar exige lo mínimo completo, imagen de portada incluida;
--   * nadie revisa, aprueba ni publica su propio servicio;
--   * nada de Servicios se borra suelto: solo en cascada con la cuenta;
--   * un servicio publicado tiene una versión publicada (se comprueba al
--     confirmar);
--   * RLS activa y ningún permiso para `anon` ni `authenticated`.
--
-- UNA ÚNICA TRANSACCIÓN, que primero comprueba la 0086–0089 y al final
-- verifica lo que dejó. REEJECUTABLE: `if not exists`, `create or replace`,
-- `drop … if exists` + `create`, `on conflict`.
--
-- ROLLBACK (con las tablas vacías): `drop table public.service_events,
-- public.service_version_images, public.service_versions, public.services,
-- public.service_categories cascade;` y las funciones de la sección 7; con el
-- depósito vacío, `delete from storage.buckets where id = 'service-media';`.

begin;

-- ------------------------------------------------------------------------- --
-- 1. Lo que tiene que haber.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
begin
  if to_regclass('public.service_providers') is null
     or to_regclass('public.service_provider_application_submissions') is null
     or to_regprocedure('public.servicios_borrado_solo_en_cascada()') is null
     or to_regprocedure('public.servicios_prestador_coherente()') is null
     or to_regprocedure('public.es_anonimizacion_por_baja(jsonb, jsonb, text[])') is null then
    raise exception 'La 0090 requiere la 0086, la 0087, la 0088 y la 0089 aplicadas';
  end if;

  select string_agg(format('%s.%s', e.tabla, e.columna), ', ') into faltan
    from (values
      ('service_providers', 'id'), ('service_providers', 'profile_id'),
      ('service_providers', 'status'), ('service_providers', 'display_name'),
      ('profiles', 'id'), ('profiles', 'role')
    ) as e(tabla, columna)
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = e.tabla and c.column_name = e.columna
   );
  if faltan is not null then
    raise exception 'La 0090 no encontró las columnas %', faltan;
  end if;

  if to_regclass('storage.buckets') is null then
    raise exception 'La 0090 requiere el esquema storage de Supabase';
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. Las categorías.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_categories (
  id uuid primary key default gen_random_uuid(),
  -- UNA CATEGORÍA Y SU SUBCATEGORÍA, no un árbol: el disparador impide un
  -- tercer nivel.
  parent_id uuid references public.service_categories(id) on delete restrict,
  slug text not null
    constraint service_categories_slug
    check (
      length(slug) between 2 and 60
      and ltrim(slug, 'abcdefghijklmnopqrstuvwxyz0123456789-') = ''
      and substr(slug, 1, 1) <> '-'
    ),
  -- El nombre en español y, si administración los escribe, en inglés y en
  -- portugués. Sin traducción, el teléfono enseña el español.
  name text not null
    constraint service_categories_nombre
    check (length(trim(name)) between 2 and 80),
  name_en text
    constraint service_categories_nombre_en
    check (name_en is null or length(trim(name_en)) between 2 and 80),
  name_pt text
    constraint service_categories_nombre_pt
    check (name_pt is null or length(trim(name_pt)) between 2 and 80),
  description text
    constraint service_categories_descripcion
    check (description is null or length(description) <= 280),
  -- El nombre de un icono del sistema de la app, nunca una URL.
  icon text
    constraint service_categories_icono
    check (
      icon is null
      or (length(icon) between 2 and 40
          and ltrim(icon, 'abcdefghijklmnopqrstuvwxyz0123456789-') = '')
    ),
  -- Nulo: para todos los países.
  country_code text
    constraint service_categories_pais
    check (
      country_code is null
      or (length(country_code) = 2
          and ltrim(country_code, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = '')
    ),
  status text not null default 'active'
    constraint service_categories_estado
    check (status in ('active', 'inactive')),
  sort_order integer not null default 0
    constraint service_categories_orden
    check (sort_order between 0 and 100000),
  -- SIN CLAVE AJENA a propósito, como el personal en la 0086.
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint service_categories_slug_unico unique (slug),
  constraint service_categories_no_es_su_madre
    check (parent_id is null or parent_id <> id)
);

create index if not exists service_categories_por_orden
  on public.service_categories (status, sort_order, id);
create index if not exists service_categories_hijas
  on public.service_categories (parent_id)
  where parent_id is not null;

-- ------------------------------------------------------------------------- --
-- 3. El servicio: la identidad estable.
-- ------------------------------------------------------------------------- --
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  -- Cuelga del prestador: borrar la cuenta se lo lleva (no hay reservas
  -- todavía que conservar).
  provider_id uuid not null
    references public.service_providers(id) on delete cascade,
  category_id uuid not null
    references public.service_categories(id) on delete restrict,
  status text not null default 'draft'
    constraint services_estado
    check (status in ('draft', 'published', 'suspended', 'retired')),
  -- La `Idempotency-Key` de la creación: un doble toque no crea dos.
  creation_key text
    constraint services_clave
    check (creation_key is null or length(creation_key) between 8 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  first_published_at timestamptz,
  published_at timestamptz,
  suspended_at timestamptz,
  retired_at timestamptz,

  constraint services_publicado_con_fecha
    check (status <> 'published' or published_at is not null),
  constraint services_suspendido_con_fecha
    check (status <> 'suspended' or suspended_at is not null),
  constraint services_retirado_con_fecha
    check (status <> 'retired' or retired_at is not null),
  constraint services_publicado_alguna_vez
    check (status not in ('published', 'suspended') or first_published_at is not null)
);

create unique index if not exists services_una_por_clave
  on public.services (provider_id, creation_key)
  where creation_key is not null;
create index if not exists services_del_prestador
  on public.services (provider_id, created_at desc, id desc);
create index if not exists services_por_estado
  on public.services (status, updated_at desc, id desc);
create index if not exists services_de_la_categoria
  on public.services (category_id);

-- ------------------------------------------------------------------------- --
-- 4. Las versiones: el contenido.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_versions (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null
    references public.services(id) on delete cascade,
  version integer not null
    constraint service_versions_numero
    check (version >= 1),
  status text not null default 'draft'
    constraint service_versions_estado
    check (status in (
      'draft', 'submitted', 'under_review', 'changes_requested',
      'approved', 'published', 'superseded', 'withdrawn'
    )),
  -- De qué versión salió (la publicada, o la que volvió con correcciones).
  based_on_version_id uuid,

  title text
    constraint service_versions_titulo
    check (title is null or length(trim(title)) between 3 and 120),
  summary text
    constraint service_versions_resumen
    check (summary is null or length(trim(summary)) between 10 and 280),
  description text
    constraint service_versions_descripcion
    check (description is null or length(trim(description)) between 20 and 5000),
  modality text
    constraint service_versions_modalidad
    check (modality is null or modality in ('virtual', 'in_person', 'at_home')),
  -- Minutos de atención. Los márgenes son técnicos; los de la empresa van en
  -- la configuración de la API.
  duration_minutes integer
    constraint service_versions_duracion
    check (duration_minutes is null or duration_minutes between 5 and 1440),
  -- Cupos por sesión, si es grupal. Nulo: una persona.
  capacity integer
    constraint service_versions_capacidad
    check (capacity is null or capacity between 1 and 1000),
  -- EL PRECIO. Nulo es «sin configurar», que NO es gratis.
  price_model text
    constraint service_versions_modelo_de_precio
    check (price_model is null or price_model in ('free', 'fixed', 'from', 'on_request')),
  price_minor bigint
    constraint service_versions_importe
    check (price_minor is null or price_minor > 0),
  currency text
    constraint service_versions_moneda
    check (
      currency is null
      or (length(currency) = 3 and ltrim(currency, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = '')
    ),
  scope text
    constraint service_versions_alcance
    check (scope is null or length(trim(scope)) between 10 and 2000),
  -- Listas de frases, validadas por la API. `[]` es «todavía nada».
  includes jsonb not null default '[]'::jsonb,
  excludes jsonb not null default '[]'::jsonb,
  requirements text
    constraint service_versions_requisitos
    check (requirements is null or length(trim(requirements)) between 3 and 2000),
  conditions text
    constraint service_versions_condiciones
    check (conditions is null or length(conditions) <= 2000),
  -- Zona general (barrio, distrito, ciudad). Nunca una dirección exacta.
  location_area text
    constraint service_versions_zona
    check (location_area is null or length(trim(location_area)) between 2 and 120),

  -- SIN CLAVE AJENA a propósito: el historial sobrevive a la cuenta del
  -- personal (0086, S10).
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  submitted_by uuid,
  review_started_at timestamptz,
  reviewed_by uuid,
  decided_at timestamptz,
  decided_by uuid,
  published_at timestamptz,
  published_by uuid,
  superseded_at timestamptz,
  withdrawn_at timestamptz,

  constraint service_versions_numero_unico unique (service_id, version),
  constraint service_versions_del_servicio unique (id, service_id),
  constraint service_versions_base_del_mismo_servicio
    foreign key (based_on_version_id, service_id)
    references public.service_versions(id, service_id),
  -- UN IMPORTE SOLO CON PRECIO FIJO O «DESDE». Gratis o a consultar no llevan.
  constraint service_versions_importe_solo_con_precio
    check (price_model in ('fixed', 'from') or (price_minor is null and currency is null)),
  -- LO ENVIADO ESTÁ COMPLETO. La lista exacta la da la API; esto es el suelo.
  constraint service_versions_completa_al_enviar
    check (
      status in ('draft', 'withdrawn')
      or (
        title is not null and summary is not null and description is not null
        and modality is not null and duration_minutes is not null
        and price_model is not null and scope is not null and requirements is not null
        and (price_model not in ('fixed', 'from') or (price_minor is not null and currency is not null))
        and (modality = 'virtual' or location_area is not null)
      )
    ),
  constraint service_versions_enviada_con_fecha
    check (status in ('draft', 'withdrawn') or submitted_at is not null),
  constraint service_versions_revisada_con_fecha
    check (
      status not in ('under_review', 'changes_requested', 'approved', 'published', 'superseded')
      or review_started_at is not null
    ),
  constraint service_versions_decidida_con_fecha
    check (
      status not in ('changes_requested', 'approved', 'published', 'superseded')
      or (decided_at is not null and decided_by is not null)
    ),
  constraint service_versions_publicada_con_fecha
    check (
      status not in ('published', 'superseded')
      or (published_at is not null and published_by is not null)
    ),
  constraint service_versions_superada_con_fecha
    check (status <> 'superseded' or superseded_at is not null),
  constraint service_versions_retirada_con_fecha
    check (status <> 'withdrawn' or withdrawn_at is not null)
);

-- UNA ABIERTA POR SERVICIO: la que se edita, se revisa o espera a publicarse.
-- Dos a la vez serían dos propuestas distintas del mismo servicio.
create unique index if not exists service_versions_una_abierta
  on public.service_versions (service_id)
  where status in ('draft', 'submitted', 'under_review', 'approved');

-- UNA PUBLICADA POR SERVICIO. Publicar la siguiente supera a la anterior en la
-- misma transacción.
create unique index if not exists service_versions_una_publicada
  on public.service_versions (service_id)
  where status = 'published';

create index if not exists service_versions_del_servicio_por_numero
  on public.service_versions (service_id, version desc);
create index if not exists service_versions_en_cola
  on public.service_versions (status, submitted_at, id)
  where status in ('submitted', 'under_review', 'approved');

-- ------------------------------------------------------------------------- --
-- 5. Las imágenes: de la VERSIÓN.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_version_images (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null,
  service_id uuid not null,
  -- LA RUTA, no una URL. La pone el servidor: `<perfil>/<servicio>/<versión>/
  -- <id>.<ext>`. Una versión nueva copia la fila con la misma ruta.
  storage_path text not null
    constraint service_version_images_ruta
    check (
      length(trim(storage_path)) between 3 and 512
      and storage_path not like '/%'
      and storage_path not like '%..%'
    ),
  alt_text text not null
    constraint service_version_images_alternativo
    check (length(trim(alt_text)) between 3 and 300),
  position integer not null default 0
    constraint service_version_images_posicion
    check (position between 0 and 100),
  is_cover boolean not null default false,
  content_type text not null
    constraint service_version_images_tipo
    check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null
    constraint service_version_images_peso
    check (byte_size between 1 and 5242880),
  width integer not null
    constraint service_version_images_ancho
    check (width > 0),
  height integer not null
    constraint service_version_images_alto
    check (height > 0),
  checksum_sha256 text not null
    constraint service_version_images_huella
    check (length(checksum_sha256) = 64 and ltrim(checksum_sha256, '0123456789abcdef') = ''),
  created_by uuid,
  created_at timestamptz not null default now(),

  constraint service_version_images_de_su_version
    foreign key (version_id, service_id)
    references public.service_versions(id, service_id) on delete cascade,
  constraint service_version_images_ruta_unica unique (version_id, storage_path)
);

create unique index if not exists service_version_images_una_portada
  on public.service_version_images (version_id)
  where is_cover;
create index if not exists service_version_images_de_la_version
  on public.service_version_images (version_id, position, id);
create index if not exists service_version_images_por_ruta
  on public.service_version_images (storage_path);

-- ------------------------------------------------------------------------- --
-- 6. El historial: SOLO SE AÑADE.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_events (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null
    references public.services(id) on delete cascade,
  version_id uuid,
  action text not null
    constraint service_events_accion
    check (action in (
      'created', 'draft_opened', 'submitted', 'resubmitted', 'withdrawn',
      'review_started', 'changes_requested', 'approved', 'published',
      'superseded', 'suspended', 'reinstated', 'retired'
    )),
  -- Del servicio en `suspended`, `reinstated` y `retired`; de la versión en
  -- las demás.
  from_status text
    constraint service_events_desde
    check (from_status is null or length(from_status) between 3 and 24),
  to_status text not null
    constraint service_events_hasta
    check (length(to_status) between 3 and 24),
  -- SIN CLAVE AJENA a propósito (0086, S10).
  actor_id uuid,
  actor_role text not null
    constraint service_events_rol
    check (actor_role in ('provider', 'reviewer', 'admin', 'system')),
  -- Lo que lee el prestador.
  visible_note text
    constraint service_events_nota_visible
    check (visible_note is null or length(trim(visible_note)) between 3 and 2000),
  -- Lo que solo lee el equipo de Z.
  internal_note text
    constraint service_events_nota_interna
    check (internal_note is null or length(internal_note) <= 4000),
  -- Lo VISIBLE que acompaña al paso (`{"fields": [...]}`). Nunca notas.
  details jsonb not null default '{}'::jsonb,
  idempotency_key text
    constraint service_events_clave
    check (idempotency_key is null or length(idempotency_key) between 8 and 100),
  created_at timestamptz not null default now(),

  constraint service_events_de_su_version
    foreign key (version_id, service_id)
    references public.service_versions(id, service_id) on delete cascade,
  -- PEDIR CAMBIOS, SUSPENDER, REACTIVAR Y RETIRAR LLEVAN MOTIVO VISIBLE.
  constraint service_events_con_motivo
    check (
      action not in ('changes_requested', 'suspended', 'reinstated', 'retired')
      or visible_note is not null
    ),
  -- QUIÉN DA CADA PASO. Que sea el DUEÑO o alguien AJENO lo imponen los
  -- disparadores.
  constraint service_events_quien
    check (
      (action in ('created', 'draft_opened', 'submitted', 'resubmitted') and actor_role = 'provider')
      or (action = 'withdrawn' and actor_role in ('provider', 'system'))
      or (action in ('review_started', 'changes_requested') and actor_role in ('reviewer', 'admin'))
      or (action in ('approved', 'published', 'suspended', 'reinstated', 'retired') and actor_role = 'admin')
      or (action = 'superseded' and actor_role = 'system')
    )
);

create unique index if not exists service_events_una_por_clave
  on public.service_events (service_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists service_events_del_servicio
  on public.service_events (service_id, created_at, id);

-- ------------------------------------------------------------------------- --
-- 7. Disparadores.
-- ------------------------------------------------------------------------- --

-- 7.1 LAS CATEGORÍAS: dos niveles como mucho, y no se borran.
create or replace function public.service_categories_dos_niveles()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una categoría de Servicios no se borra: se desactiva'
      using errcode = 'restrict_violation';
  end if;
  if new.parent_id is not null then
    if exists (
      select 1 from public.service_categories m
       where m.id = new.parent_id and m.parent_id is not null
    ) then
      raise exception 'Una subcategoría no puede tener subcategorías'
        using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.service_categories h where h.parent_id = new.id) then
      raise exception 'Una categoría con subcategorías no puede ser subcategoría'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists service_categories_dos_niveles on public.service_categories;
create trigger service_categories_dos_niveles
  before insert or update or delete on public.service_categories
  for each row
  execute function public.service_categories_dos_niveles();

-- 7.2 EL SERVICIO: nace en borrador, de un prestador ACTIVO y en una categoría
--     ACTIVA, y solo da los saltos del mapa.
create or replace function public.services_salto_valido()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'Un servicio nace en borrador, no en %', new.status
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.service_providers p where p.id = new.provider_id and p.status = 'active'
    ) then
      raise exception 'Solo un prestador aprobado y activo crea servicios'
        using errcode = 'restrict_violation';
    end if;
    if not exists (
      select 1 from public.service_categories c where c.id = new.category_id and c.status = 'active'
    ) then
      raise exception 'Una categoría inactiva no admite servicios nuevos'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if new.provider_id is distinct from old.provider_id then
    raise exception 'Un servicio no cambia de prestador'
      using errcode = 'restrict_violation';
  end if;
  if new.category_id is distinct from old.category_id then
    if old.first_published_at is not null or old.status <> 'draft' then
      raise exception 'La categoría de un servicio ya publicado no cambia'
        using errcode = 'restrict_violation';
    end if;
    if not exists (
      select 1 from public.service_categories c where c.id = new.category_id and c.status = 'active'
    ) then
      raise exception 'Una categoría inactiva no admite servicios nuevos'
        using errcode = 'restrict_violation';
    end if;
  end if;

  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status = 'published')
    or (old.status = 'published' and new.status = 'suspended')
    or (old.status = 'suspended' and new.status = 'published')
    or (old.status = 'draft' and new.status = 'retired')
    or (old.status = 'published' and new.status = 'retired')
    or (old.status = 'suspended' and new.status = 'retired')
  ) then
    raise exception 'Un servicio % no puede pasar a %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists services_saltos on public.services;
create trigger services_saltos
  before insert or update on public.services
  for each row
  execute function public.services_salto_valido();

-- 7.3 LA VERSIÓN: nace en borrador, solo da los saltos del mapa, LO ENVIADO NO
--     SE REESCRIBE, y enviar exige portada e incluidos y excluidos.
create or replace function public.service_versions_salto_valido()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  mutables text[] := array[
    'status', 'updated_at', 'submitted_at', 'submitted_by', 'review_started_at',
    'reviewed_by', 'decided_at', 'decided_by', 'published_at', 'published_by',
    'superseded_at', 'withdrawn_at'
  ];
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'Una versión de servicio nace en borrador, no en %', new.status
        using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.services s where s.id = new.service_id and s.status = 'retired') then
      raise exception 'Un servicio retirado no admite versiones nuevas'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if new.service_id is distinct from old.service_id or new.version is distinct from old.version then
    raise exception 'Una versión no cambia de servicio ni de número'
      using errcode = 'restrict_violation';
  end if;

  -- LO ENVIADO ESTÁ CONGELADO: fuera del borrador solo cambian el estado y
  -- sus fechas. Una decisión revisa exactamente lo que se envió.
  if old.status <> 'draft'
     and (to_jsonb(new) - mutables) is distinct from (to_jsonb(old) - mutables) then
    raise exception 'Una versión % no se edita: lo enviado queda congelado', old.status
      using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'draft' and new.status = 'submitted')
      or (old.status = 'draft' and new.status = 'withdrawn')
      or (old.status = 'submitted' and new.status = 'under_review')
      or (old.status = 'submitted' and new.status = 'withdrawn')
      or (old.status = 'under_review' and new.status = 'changes_requested')
      or (old.status = 'under_review' and new.status = 'approved')
      or (old.status = 'under_review' and new.status = 'withdrawn')
      or (old.status = 'approved' and new.status = 'published')
      or (old.status = 'approved' and new.status = 'withdrawn')
      or (old.status = 'published' and new.status = 'superseded')
    ) then
      raise exception 'Una versión % no puede pasar a %', old.status, new.status
        using errcode = 'check_violation';
    end if;

    if new.status = 'submitted' then
      if not exists (
        select 1 from public.service_version_images i where i.version_id = new.id and i.is_cover
      ) then
        raise exception 'Una versión se envía con su imagen de portada'
          using errcode = 'check_violation';
      end if;
      if jsonb_typeof(new.includes) <> 'array' or jsonb_array_length(new.includes) = 0
         or jsonb_typeof(new.excludes) <> 'array' or jsonb_array_length(new.excludes) = 0 then
        raise exception 'Una versión se envía diciendo qué incluye y qué no'
          using errcode = 'check_violation';
      end if;
      if not exists (
        select 1 from public.services s
          join public.service_providers p on p.id = s.provider_id
          join public.service_categories c on c.id = s.category_id
         where s.id = new.service_id and p.status = 'active' and c.status = 'active'
      ) then
        raise exception 'Solo un prestador activo envía, y a una categoría activa'
          using errcode = 'restrict_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists service_versions_saltos on public.service_versions;
create trigger service_versions_saltos
  before insert or update on public.service_versions
  for each row
  execute function public.service_versions_salto_valido();

-- 7.4 LAS IMÁGENES SOLO CAMBIAN EN UN BORRADOR, y su ruta es del prestador y
--     de ese servicio. Borrarlas fuera del borrador, solo en cascada.
create or replace function public.service_version_images_solo_en_borrador()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  estado text;
  perfil uuid;
begin
  if tg_op = 'DELETE' then
    select v.status into estado from public.service_versions v where v.id = old.version_id;
    -- La versión ya no está: es la cascada del servicio o de la cuenta.
    if estado is null or estado = 'draft' then
      return old;
    end if;
    raise exception 'Una imagen de una versión % no se quita', estado
      using errcode = 'restrict_violation';
  end if;

  select v.status into estado from public.service_versions v where v.id = new.version_id;
  if estado is distinct from 'draft' then
    raise exception 'Las imágenes solo cambian en un borrador (versión %)', coalesce(estado, '?')
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'INSERT' or new.storage_path is distinct from old.storage_path then
    select p.profile_id into perfil
      from public.services s join public.service_providers p on p.id = s.provider_id
     where s.id = new.service_id;
    if perfil is null
       or new.storage_path not like (perfil::text || '/' || new.service_id::text || '/%') then
      raise exception 'La ruta de una imagen es del prestador y de su servicio'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists service_version_images_solo_en_borrador on public.service_version_images;
create trigger service_version_images_solo_en_borrador
  before insert or update or delete on public.service_version_images
  for each row
  execute function public.service_version_images_solo_en_borrador();

-- 7.5 NADIE REVISA, APRUEBA NI PUBLICA SU PROPIO SERVICIO.
create or replace function public.servicios_catalogo_nadie_se_publica()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  dueno uuid;
begin
  select p.profile_id into dueno
    from public.services s join public.service_providers p on p.id = s.provider_id
   where s.id = new.service_id;
  if dueno is null then
    return new;
  end if;

  if tg_table_name = 'service_events' then
    if new.actor_role in ('reviewer', 'admin') and new.actor_id = dueno then
      raise exception 'Nadie revisa ni publica su propio servicio'
        using errcode = 'restrict_violation';
    end if;
  elsif dueno in (new.reviewed_by, new.decided_by, new.published_by) then
    raise exception 'Nadie revisa ni publica su propio servicio'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists service_versions_ajena on public.service_versions;
create trigger service_versions_ajena
  before insert or update on public.service_versions
  for each row
  execute function public.servicios_catalogo_nadie_se_publica();

drop trigger if exists service_events_ajena on public.service_events;
create trigger service_events_ajena
  before insert on public.service_events
  for each row
  execute function public.servicios_catalogo_nadie_se_publica();

-- 7.6 EL HISTORIAL NO SE REESCRIBE.
create or replace function public.servicios_catalogo_historial_inmutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception
    'El historial de un servicio solo se añade: % no está permitido', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists service_events_inmutables on public.service_events;
create trigger service_events_inmutables
  before update on public.service_events
  for each row
  execute function public.servicios_catalogo_historial_inmutable();

-- 7.7 NADA SE BORRA SUELTO: solo en cascada desde su raíz (la 0086).
drop trigger if exists services_solo_en_cascada on public.services;
create trigger services_solo_en_cascada
  before delete on public.services
  for each row
  execute function public.servicios_borrado_solo_en_cascada('service_providers', 'provider_id');

drop trigger if exists service_versions_solo_en_cascada on public.service_versions;
create trigger service_versions_solo_en_cascada
  before delete on public.service_versions
  for each row
  execute function public.servicios_borrado_solo_en_cascada('services', 'service_id');

drop trigger if exists service_events_solo_en_cascada on public.service_events;
create trigger service_events_solo_en_cascada
  before delete on public.service_events
  for each row
  execute function public.servicios_borrado_solo_en_cascada('services', 'service_id');

-- 7.8 UN SERVICIO PUBLICADO O SUSPENDIDO TIENE SU VERSIÓN PUBLICADA, y uno en
--     borrador no tiene ninguna. Al confirmar: publicar cambia las dos tablas.
create or replace function public.servicios_catalogo_coherente()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  servicio uuid;
  estado text;
  publicadas integer;
begin
  if tg_table_name = 'services' then
    servicio := new.id;
  else
    servicio := new.service_id;
  end if;
  select s.status into estado from public.services s where s.id = servicio;
  if estado is null then
    return null;
  end if;
  select count(*) into publicadas
    from public.service_versions v where v.service_id = servicio and v.status = 'published';
  if estado in ('published', 'suspended') and publicadas <> 1 then
    raise exception 'Un servicio % necesita exactamente una versión publicada', estado
      using errcode = 'check_violation';
  end if;
  if estado = 'draft' and publicadas <> 0 then
    raise exception 'Un servicio en borrador no tiene versiones publicadas'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists services_coherente on public.services;
create constraint trigger services_coherente
  after insert or update on public.services
  deferrable initially deferred
  for each row
  execute function public.servicios_catalogo_coherente();

drop trigger if exists service_versions_coherente on public.service_versions;
create constraint trigger service_versions_coherente
  after insert or update on public.service_versions
  deferrable initially deferred
  for each row
  execute function public.servicios_catalogo_coherente();

-- ------------------------------------------------------------------------- --
-- 8. El depósito privado de las imágenes.
-- ------------------------------------------------------------------------- --
insert into storage.buckets (id, name, public)
values ('service-media', 'service-media', false)
on conflict (id) do nothing;

update storage.buckets
set
  public = false,
  file_size_limit = 5::bigint * 1024 * 1024,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'service-media';

-- ------------------------------------------------------------------------- --
-- 9. RLS y permisos: cerrado.
-- ------------------------------------------------------------------------- --
alter table public.service_categories enable row level security;
alter table public.services enable row level security;
alter table public.service_versions enable row level security;
alter table public.service_version_images enable row level security;
alter table public.service_events enable row level security;

revoke all on public.service_categories from anon, authenticated;
revoke all on public.services from anon, authenticated;
revoke all on public.service_versions from anon, authenticated;
revoke all on public.service_version_images from anon, authenticated;
revoke all on public.service_events from anon, authenticated;

revoke all on function public.service_categories_dos_niveles() from public, anon, authenticated;
revoke all on function public.services_salto_valido() from public, anon, authenticated;
revoke all on function public.service_versions_salto_valido() from public, anon, authenticated;
revoke all on function public.service_version_images_solo_en_borrador() from public, anon, authenticated;
revoke all on function public.servicios_catalogo_nadie_se_publica() from public, anon, authenticated;
revoke all on function public.servicios_catalogo_historial_inmutable() from public, anon, authenticated;
revoke all on function public.servicios_catalogo_coherente() from public, anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 10. Verificación.
-- ------------------------------------------------------------------------- --
do $$
declare
  tablas text[] := array[
    'service_categories', 'services', 'service_versions',
    'service_version_images', 'service_events'
  ];
  faltan text;
  permisos bigint;
  politicas bigint;
begin
  if not exists (
    select 1 from storage.buckets
     where id = 'service-media' and public = false and file_size_limit = 5242880
  ) then
    raise exception 'La 0090 no dejó el depósito privado de imágenes';
  end if;

  if exists (
    select 1 from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relname = any (tablas)
       and not c.relrowsecurity
  ) then
    raise exception 'La 0090 dejó una tabla del catálogo sin RLS';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public' and table_name = any (tablas)
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'El catálogo tiene % permisos sueltos', permisos;
  end if;

  select count(*) into politicas
    from pg_policies where schemaname = 'public' and tablename = any (tablas);
  if politicas > 0 then
    raise exception 'El catálogo tiene % políticas RLS; debe tener cero', politicas;
  end if;

  select string_agg(format('%s.%s', e.tabla, e.disparador), ', ') into faltan
    from (values
      ('service_categories', 'service_categories_dos_niveles', 'service_categories_dos_niveles', 31),
      ('services', 'services_saltos', 'services_salto_valido', 23),
      ('services', 'services_solo_en_cascada', 'servicios_borrado_solo_en_cascada', 11),
      ('services', 'services_coherente', 'servicios_catalogo_coherente', 21),
      ('service_versions', 'service_versions_saltos', 'service_versions_salto_valido', 23),
      ('service_versions', 'service_versions_ajena', 'servicios_catalogo_nadie_se_publica', 23),
      ('service_versions', 'service_versions_solo_en_cascada', 'servicios_borrado_solo_en_cascada', 11),
      ('service_versions', 'service_versions_coherente', 'servicios_catalogo_coherente', 21),
      ('service_version_images', 'service_version_images_solo_en_borrador', 'service_version_images_solo_en_borrador', 31),
      ('service_events', 'service_events_ajena', 'servicios_catalogo_nadie_se_publica', 7),
      ('service_events', 'service_events_inmutables', 'servicios_catalogo_historial_inmutable', 19),
      ('service_events', 'service_events_solo_en_cascada', 'servicios_borrado_solo_en_cascada', 11)
    ) as e(tabla, disparador, funcion, tipo)
   where not exists (
     select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal
        and t.tgrelid = to_regclass('public.' || e.tabla)
        and t.tgname = e.disparador
        and p.proname = e.funcion
        and t.tgtype = e.tipo
        and t.tgenabled = 'O'
   );
  if faltan is not null then
    raise exception 'La 0090 no dejó como esperaba los disparadores: %', faltan;
  end if;

  select string_agg(i, ', ') into faltan
    from unnest(array[
      'service_versions_una_abierta', 'service_versions_una_publicada',
      'service_version_images_una_portada', 'services_una_por_clave',
      'service_events_una_por_clave'
    ]) as i
   -- Que EXISTAN no basta: un índice con ese nombre que no sea único no
   -- impide dos publicadas ni dos abiertas.
   where not exists (
     select 1 from pg_catalog.pg_index x
      where x.indexrelid = to_regclass('public.' || i) and x.indisunique
   );
  if faltan is not null then
    raise exception 'La 0090 no dejó los índices únicos %', faltan;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
