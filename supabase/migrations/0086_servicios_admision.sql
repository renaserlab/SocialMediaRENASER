-- 0086 · Z Servicios, Incremento 1 (Bloque 1A): la base de la admisión del
--        prestador.
--
-- SIN APLICAR. Escrita el 28/09/2026 y probada solo contra PostgreSQL local
-- (`tests/test_servicios_migracion_0086.py`). Se aplica a mano en el editor SQL
-- de Supabase cuando se autorice. Al aplicarla, REINICIAR LA API: la puerta de
-- esquema de Servicios cachea también el «no».
--
-- QUÉ TRAE, Y NADA MÁS: quién ofrece servicios y cómo entra. Prestadores,
-- postulaciones, metadatos de documentos privados, credenciales, el historial
-- de estados y decisiones, y las políticas versionadas que se aceptan al
-- postular. NINGUNA tabla de catálogo, horarios, capacidad, franjas,
-- retenciones, reservas, pagos, atención, posventa, reseñas ni finanzas: son de
-- incrementos posteriores y cada uno trae su migración.
--
-- ADITIVA. No altera ni borra ninguna tabla, columna, índice ni restricción
-- existente. Solo crea objetos nuevos con nombre `service_*` / `servicios_*`.
--
-- LO QUE GARANTIZA LA BASE, Y NO SOLO EL CÓDIGO:
--
--   1. LA MÁQUINA DE ESTADOS. Una postulación nace en `draft` y solo cambia de
--      estado por los saltos del mapa de `app/modules/services/states.py`. Lo
--      impone un disparador sobre la postulación y un CHECK sobre el historial:
--      un `update` desde la consola no puede aprobar un borrador.
--   2. NADIE SE ADMITE A SÍ MISMO, ni siendo administrador: ni decide su propia
--      postulación, ni revisa sus documentos, ni verifica sus credenciales, ni
--      firma como revisor en su propio historial.
--   3. EL HISTORIAL SOLO SE AÑADE. Ni `update` ni `delete` directos.
--   4. LA EVIDENCIA NO SE BORRA SUELTA. Prestador, postulación, documentos y
--      credenciales solo desaparecen EN CASCADA desde el perfil: es lo que hace
--      `DELETE /me` (borrar la propia cuenta), y tiene que seguir funcionando.
--      Por eso quién actuó se guarda SIN clave ajena, igual que en Productos:
--      un `on delete set null` sería un `update` sobre el historial.
--   5. UNA POSTULACIÓN VIVA POR PRESTADOR. Solo `rejected` libera el hueco para
--      volver a postular.
--   6. ENVIAR EXIGE HABER ACEPTADO UNA POLÍTICA PUBLICADA y la declaración de
--      veracidad. Mientras la empresa no publique las condiciones del
--      prestador, NO SE PUEDE ENVIAR: falla en cerrado. Esta migración NO
--      SIEMBRA NINGUNA POLÍTICA; una fila de ejemplo sería un texto inventado.
--   7. UNA POLÍTICA PUBLICADA NO SE EDITA NI SE BORRA: se publica otra versión.
--
-- LO QUE NO TRAE, Y ES DELIBERADO:
--
--   * EL DEPÓSITO DE ARCHIVOS. Llega en el Bloque 1B con la subida (su propia
--     migración, como la 0085), junto con el barrido al borrar la cuenta. Aquí
--     solo están los METADATOS: la ruta nunca sale en una respuesta de la API.
--   * `withdrawn` (retirada por el prestador). El mapa aprobado del Bloque 1A no
--     lo incluye; añadirlo es un CHECK más en una migración posterior.
--   * NINGÚN NÚMERO DE CREDENCIAL COMPLETO: solo su forma enmascarada. El
--     número entero está en el documento que la respalda.
--
-- RLS ACTIVA EN LAS SEIS, CERO POLÍTICAS y CERO privilegios para `anon` y
-- `authenticated`: el teléfono no lee ni escribe ninguna directamente. Todo
-- pasa por la API, que decide qué campos devuelve a quién.
--
-- REEJECUTABLE: `if not exists`, `create or replace` y `drop ... if exists`.
--
-- ROLLBACK (con las tablas vacías), en este orden:
--   drop table public.service_provider_application_events,
--              public.service_provider_credentials,
--              public.service_provider_documents,
--              public.service_provider_applications,
--              public.service_providers,
--              public.service_policies;
--   drop function public.servicios_borrado_solo_en_cascada(),
--                 public.servicios_historial_inmutable(),
--                 public.servicios_nadie_se_admite_a_si_mismo(),
--                 public.service_provider_applications_salto_valido(),
--                 public.service_policies_publicada_es_inmutable();

-- ------------------------------------------------------------------------- --
-- 1. Las políticas versionadas de Servicios.
-- ------------------------------------------------------------------------- --
--
-- POR QUÉ NO SE REUTILIZA `policy_versions` (0050). Su tipo está cerrado por un
-- CHECK a cuatro valores y añadir uno exigiría alterar una restricción aplicada
-- que usa media plataforma. Eventos (0069) y Productos (0077) tomaron la misma
-- decisión por el mismo motivo.
--
-- HOY SOLO UN TIPO: `provider_terms`, las condiciones que acepta quien postula.
-- Cancelación, reprogramación y demás llegan con sus incrementos, añadiendo su
-- valor al CHECK.
create table if not exists public.service_policies (
  id uuid primary key default gen_random_uuid(),

  kind text not null
    constraint service_policies_tipo
    check (kind in ('provider_terms')),

  -- ISO 3166-1 alfa-2, en mayúsculas.
  country_code text not null
    constraint service_policies_pais
    check (
      length(country_code) = 2
      and ltrim(country_code, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = ''
    ),

  -- NULA = vale para todas las categorías. Es texto y no una clave ajena porque
  -- el catálogo de categorías es del Incremento 2.
  category text
    constraint service_policies_categoria
    check (category is null or length(trim(category)) between 2 and 80),

  version integer not null
    constraint service_policies_version check (version >= 1),

  status text not null default 'draft'
    constraint service_policies_estado
    check (status in ('draft', 'published', 'superseded', 'withdrawn')),

  title text not null
    constraint service_policies_titulo
    check (length(trim(title)) between 3 and 200),

  -- EL TEXTO ENTERO, tal y como se le enseña a quien lo acepta, y su huella.
  body text not null
    constraint service_policies_texto
    check (length(trim(body)) >= 50),
  body_sha256 text not null
    constraint service_policies_huella
    check (
      length(body_sha256) = 64
      and ltrim(body_sha256, '0123456789abcdef') = ''
    ),

  -- LOS PARÁMETROS configurables (plazos, umbrales). Vacío = ninguno decidido.
  parameters jsonb not null default '{}'::jsonb,

  effective_at timestamptz,
  published_at timestamptz,
  -- SIN CLAVE AJENA: quién publicó es un hecho del pasado y sobrevive a la
  -- cuenta, igual que en `product_policies`.
  published_by uuid,
  created_by uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- UNA POLÍTICA FUERA DE BORRADOR ESTÁ COMPLETA.
  constraint service_policies_publicada_completa
    check (
      status = 'draft'
      or (effective_at is not null and published_at is not null and published_by is not null)
    )
);

-- UNA VERSIÓN por tipo, país y categoría.
create unique index if not exists service_policies_una_version
  on public.service_policies (kind, country_code, coalesce(category, ''), version);

-- UNA PUBLICADA a la vez por tipo, país y categoría. Publicar la siguiente
-- supera a la anterior en la misma transacción.
create unique index if not exists service_policies_una_publicada
  on public.service_policies (kind, country_code, coalesce(category, ''))
  where status = 'published';

-- ------------------------------------------------------------------------- --
-- 2. El prestador: la capacidad de ofrecer servicios de un perfil.
-- ------------------------------------------------------------------------- --
--
-- NO ES UNA SEGUNDA IDENTIDAD: cuelga del perfil y muere con él. Nace
-- `pending` al empezar la primera postulación; solo una aprobación lo pone
-- `active`. Registrarse no da capacidad de ofrecer nada.
create table if not exists public.service_providers (
  id uuid primary key default gen_random_uuid(),

  profile_id uuid not null
    references public.profiles(id) on delete cascade,

  -- PERSONA NATURAL o EMPRESA (alcance aprobado, decisión 1). La empresa
  -- designa a quién atiende, y aprobarla no verifica a sus trabajadores.
  provider_type text not null
    constraint service_providers_tipo
    check (provider_type in ('individual', 'company')),

  -- CON QUÉ NOMBRE SE PRESENTA.
  display_name text not null
    constraint service_providers_nombre
    check (length(trim(display_name)) between 2 and 120),

  -- NOMBRE LEGAL o RAZÓN SOCIAL. Nulo mientras se escribe el borrador; enviar
  -- lo exige el código.
  legal_name text
    constraint service_providers_nombre_legal
    check (legal_name is null or length(trim(legal_name)) between 2 and 200),

  country_code text
    constraint service_providers_pais
    check (
      country_code is null
      or (
        length(country_code) = 2
        and ltrim(country_code, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = ''
      )
    ),

  -- DATO TRIBUTARIO (RUC en Perú). Privado: solo lo ven su dueño y
  -- administración.
  tax_id text
    constraint service_providers_registro_tributario
    check (tax_id is null or length(trim(tax_id)) between 5 and 20),

  -- QUIÉN REPRESENTA A LA EMPRESA. Solo aplica a `company`.
  representative_name text
    constraint service_providers_representante
    check (representative_name is null or length(trim(representative_name)) between 2 and 200),

  status text not null default 'pending'
    constraint service_providers_estado
    check (status in ('pending', 'active', 'suspended')),

  activated_at timestamptz,
  suspended_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- UN PRESTADOR POR PERFIL.
  constraint service_providers_un_perfil unique (profile_id),

  constraint service_providers_activo_con_fecha
    check (status <> 'active' or activated_at is not null),
  constraint service_providers_suspendido_con_fecha
    check (status <> 'suspended' or suspended_at is not null)
);

create index if not exists service_providers_por_estado
  on public.service_providers (status, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 3. La postulación: el expediente de admisión.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_provider_applications (
  id uuid primary key default gen_random_uuid(),

  provider_id uuid not null
    references public.service_providers(id) on delete cascade,

  -- LOS OCHO ESTADOS DEL BLOQUE 1A. Los saltos los impone el disparador de más
  -- abajo; aquí solo cuáles existen.
  status text not null default 'draft'
    constraint service_provider_applications_estado
    check (status in (
      'draft', 'submitted', 'under_review', 'changes_requested',
      'resubmitted', 'approved', 'rejected', 'suspended'
    )),

  -- QUÉ OFRECE Y CON QUÉ EXPERIENCIA, en palabras de quien postula.
  summary text
    constraint service_provider_applications_resumen
    check (summary is null or length(trim(summary)) between 20 and 4000),

  -- LA CATEGORÍA QUE PIDE. Texto hasta que exista el catálogo (Incremento 2).
  requested_category text
    constraint service_provider_applications_categoria
    check (requested_category is null or length(trim(requested_category)) between 2 and 80),

  -- QUÉ CONDICIONES ACEPTÓ, con la huella del texto que leyó.
  terms_policy_id uuid
    references public.service_policies(id) on delete restrict,
  terms_sha256 text
    constraint service_provider_applications_huella
    check (
      terms_sha256 is null
      or (length(terms_sha256) = 64 and ltrim(terms_sha256, '0123456789abcdef') = '')
    ),
  terms_accepted_at timestamptz,
  -- LA DECLARACIÓN DE VERACIDAD. Obligatoria para enviar (alcance, §2).
  truthfulness_declared_at timestamptz,

  -- EL PRIMER ENVÍO y EL ÚLTIMO (envío o reenvío). La bandeja ordena por el
  -- último: un reenvío vuelve a la cola, no se queda enterrado.
  submitted_at timestamptz,
  last_submitted_at timestamptz,
  review_started_at timestamptz,

  decided_at timestamptz,
  -- SIN CLAVE AJENA: ver la cabecera, punto 4.
  decided_by uuid,
  suspended_at timestamptz,

  -- LO QUE SE LE ENSEÑA a quien postula: qué corregir, por qué se rechazó o
  -- por qué se suspendió. Separado de las notas internas, que nunca salen.
  applicant_message text
    constraint service_provider_applications_mensaje
    check (applicant_message is null or length(trim(applicant_message)) between 3 and 2000),
  internal_notes text
    constraint service_provider_applications_notas
    check (internal_notes is null or length(internal_notes) <= 4000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Para las claves ajenas compuestas de documentos y credenciales.
  constraint service_provider_applications_id_prestador unique (id, provider_id),

  -- FUERA DE BORRADOR, LA POSTULACIÓN ESTÁ COMPLETA: resumen, fechas de envío,
  -- política aceptada con su huella y declaración de veracidad.
  constraint service_provider_applications_enviada_completa
    check (
      status = 'draft'
      or (
        summary is not null
        and submitted_at is not null
        and last_submitted_at is not null
        and terms_policy_id is not null
        and terms_sha256 is not null
        and terms_accepted_at is not null
        and truthfulness_declared_at is not null
      )
    ),
  constraint service_provider_applications_en_revision_con_fecha
    check (status <> 'under_review' or review_started_at is not null),
  constraint service_provider_applications_decidida_con_autor
    check (
      status not in ('approved', 'rejected')
      or (decided_at is not null and decided_by is not null)
    ),
  constraint service_provider_applications_suspendida_con_fecha
    check (status <> 'suspended' or suspended_at is not null),
  -- PEDIR CORRECCIONES, RECHAZAR O SUSPENDER SIN DECIR POR QUÉ no se le puede
  -- enseñar a nadie.
  constraint service_provider_applications_con_motivo
    check (
      status not in ('changes_requested', 'rejected', 'suspended')
      or applicant_message is not null
    )
);

-- UNA VIVA POR PRESTADOR. Solo el rechazo libera el hueco.
create unique index if not exists service_provider_applications_una_viva
  on public.service_provider_applications (provider_id)
  where status <> 'rejected';

-- LA BANDEJA de administración: por estado y por el último envío.
create index if not exists service_provider_applications_bandeja
  on public.service_provider_applications (status, last_submitted_at desc, id desc);

create index if not exists service_provider_applications_del_prestador
  on public.service_provider_applications (provider_id, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 4. Los documentos: SOLO METADATOS. El archivo vive en un depósito privado.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_provider_documents (
  id uuid primary key default gen_random_uuid(),

  provider_id uuid not null
    references public.service_providers(id) on delete cascade,
  application_id uuid not null,

  -- QUÉ ES, como código: una lista en prosa no se puede exigir.
  kind text not null
    constraint service_provider_documents_tipo
    check (kind in (
      'identity', 'legal_representation', 'tax_registration',
      'proof_of_address', 'professional_title', 'professional_license',
      'insurance', 'portfolio', 'other'
    )),

  -- LA RUTA EN EL DEPÓSITO PRIVADO. Nunca sale en una respuesta: se abre con
  -- un enlace firmado de pocos minutos. Única: registrar dos veces el mismo
  -- archivo es un reintento, no un documento nuevo.
  storage_path text not null
    constraint service_provider_documents_ruta
    check (
      length(storage_path) between 3 and 512
      and storage_path not like '/%'
      and storage_path not like '%..%'
    ),

  -- LISTA CERRADA: PDF y fotografías. Nada que pueda llevar scripts.
  content_type text not null
    constraint service_provider_documents_formato
    check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),

  byte_size bigint not null
    constraint service_provider_documents_peso
    check (byte_size between 1 and 10485760),

  checksum_sha256 text
    constraint service_provider_documents_huella
    check (
      checksum_sha256 is null
      or (length(checksum_sha256) = 64 and ltrim(checksum_sha256, '0123456789abcdef') = '')
    ),

  review_status text not null default 'pending'
    constraint service_provider_documents_revision
    check (review_status in ('pending', 'accepted', 'rejected')),
  -- LO QUE SE LE DICE al observar un documento.
  review_note text
    constraint service_provider_documents_nota
    check (review_note is null or length(trim(review_note)) between 3 and 1000),
  reviewed_at timestamptz,
  reviewed_by uuid,
  uploaded_by uuid,

  created_at timestamptz not null default now(),

  constraint service_provider_documents_ruta_unica unique (storage_path),
  constraint service_provider_documents_id_prestador unique (id, provider_id),

  -- EL DOCUMENTO ES DE LA MISMA PERSONA QUE LA POSTULACIÓN.
  constraint service_provider_documents_de_su_postulacion
    foreign key (application_id, provider_id)
    references public.service_provider_applications (id, provider_id)
    on delete cascade,

  constraint service_provider_documents_revisado_con_autor
    check (review_status = 'pending' or (reviewed_at is not null and reviewed_by is not null)),
  constraint service_provider_documents_observado_con_motivo
    check (review_status <> 'rejected' or review_note is not null)
);

create index if not exists service_provider_documents_de_la_postulacion
  on public.service_provider_documents (application_id, kind, created_at);

-- ------------------------------------------------------------------------- --
-- 5. Las credenciales profesionales.
-- ------------------------------------------------------------------------- --
--
-- DEL PRESTADOR, no de una postulación: una colegiatura sigue siendo la misma
-- aunque se vuelva a postular. `application_id` dice en cuál se presentó.
--
-- QUIEN POSTULA DECLARA; SOLO Z VERIFICA. Nace `declared`, y `verified` exige
-- autor, fecha y un documento que la respalde. El prestador no puede afirmar
-- que una credencial está verificada (alcance, §3.2).
create table if not exists public.service_provider_credentials (
  id uuid primary key default gen_random_uuid(),

  provider_id uuid not null
    references public.service_providers(id) on delete cascade,
  application_id uuid,

  kind text not null
    constraint service_provider_credentials_tipo
    check (kind in (
      'professional_title', 'professional_license', 'professional_registration',
      'certification', 'insurance', 'other'
    )),

  title text not null
    constraint service_provider_credentials_titulo
    check (length(trim(title)) between 2 and 200),
  -- LA ENTIDAD EMISORA.
  issuer text not null
    constraint service_provider_credentials_emisor
    check (length(trim(issuer)) between 2 and 200),
  jurisdiction text
    constraint service_provider_credentials_jurisdiccion
    check (jurisdiction is null or length(trim(jurisdiction)) between 2 and 120),
  -- SOLO ENMASCARADO. El número completo está en el documento de respaldo.
  number_masked text
    constraint service_provider_credentials_numero
    check (number_masked is null or length(number_masked) between 1 and 40),
  specialty text
    constraint service_provider_credentials_especialidad
    check (specialty is null or length(trim(specialty)) between 2 and 200),

  issued_on date,
  expires_on date,

  evidence_document_id uuid,

  status text not null default 'declared'
    constraint service_provider_credentials_estado
    check (status in ('declared', 'verified', 'rejected', 'expired')),
  verified_at timestamptz,
  verified_by uuid,
  review_note text
    constraint service_provider_credentials_nota
    check (review_note is null or length(trim(review_note)) between 3 and 1000),

  -- REINTENTAR NO DUPLICA: la misma clave del cliente es la misma credencial.
  idempotency_key text
    constraint service_provider_credentials_clave
    check (idempotency_key is null or length(idempotency_key) between 8 and 100),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint service_provider_credentials_de_su_postulacion
    foreign key (application_id, provider_id)
    references public.service_provider_applications (id, provider_id)
    on delete cascade,
  -- LA EVIDENCIA ES UN DOCUMENTO DE LA MISMA PERSONA.
  constraint service_provider_credentials_evidencia_propia
    foreign key (evidence_document_id, provider_id)
    references public.service_provider_documents (id, provider_id)
    on delete cascade,

  constraint service_provider_credentials_vigencia
    check (issued_on is null or expires_on is null or expires_on >= issued_on),
  constraint service_provider_credentials_verificada_con_evidencia
    check (
      status <> 'verified'
      or (verified_at is not null and verified_by is not null and evidence_document_id is not null)
    ),
  constraint service_provider_credentials_rechazada_con_motivo
    check (status <> 'rejected' or review_note is not null)
);

create unique index if not exists service_provider_credentials_una_por_clave
  on public.service_provider_credentials (provider_id, idempotency_key)
  where idempotency_key is not null;

-- LOS VENCIMIENTOS que habrá que avisar (30, 15 y 7 días).
create index if not exists service_provider_credentials_por_vencimiento
  on public.service_provider_credentials (provider_id, status, expires_on);

-- ------------------------------------------------------------------------- --
-- 6. El historial de estados y decisiones. SOLO SE AÑADE.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_provider_application_events (
  id uuid primary key default gen_random_uuid(),

  application_id uuid not null
    references public.service_provider_applications(id) on delete cascade,

  -- NULO SOLO AL NACER (`draft`). Después, siempre un salto del mapa.
  from_status text
    constraint service_provider_application_events_desde
    check (from_status is null or from_status in (
      'draft', 'submitted', 'under_review', 'changes_requested',
      'resubmitted', 'approved', 'rejected', 'suspended'
    )),
  to_status text not null
    constraint service_provider_application_events_hasta
    check (to_status in (
      'draft', 'submitted', 'under_review', 'changes_requested',
      'resubmitted', 'approved', 'rejected', 'suspended'
    )),

  -- SIN CLAVE AJENA: ver la cabecera, punto 4.
  actor_id uuid,
  -- CON QUÉ FUNCIÓN actuó: la misma persona puede revisar y decidir, pero el
  -- expediente dice en calidad de qué (alcance, §2).
  actor_role text not null
    constraint service_provider_application_events_rol
    check (actor_role in ('provider', 'reviewer', 'admin', 'system')),

  -- LO QUE VE QUIEN POSTULA, y aparte lo que solo ve administración.
  visible_note text
    constraint service_provider_application_events_nota_visible
    check (visible_note is null or length(trim(visible_note)) between 3 and 2000),
  internal_note text
    constraint service_provider_application_events_nota_interna
    check (internal_note is null or length(internal_note) <= 4000),

  -- UN REINTENTO DE LA MISMA ACCIÓN NO ESCRIBE DOS VECES.
  idempotency_key text
    constraint service_provider_application_events_clave
    check (idempotency_key is null or length(idempotency_key) between 8 and 100),

  created_at timestamptz not null default now(),

  -- EL MAPA DE SALTOS, el mismo de `states.TRANSICIONES`. Una prueba compara
  -- los dos: si alguien toca uno, la otra se pone roja.
  constraint service_provider_application_events_salto_permitido
    check (
      (from_status is null and to_status = 'draft')
      or (from_status = 'draft' and to_status = 'submitted')
      or (from_status = 'submitted' and to_status = 'under_review')
      or (from_status = 'under_review' and to_status = 'changes_requested')
      or (from_status = 'under_review' and to_status = 'approved')
      or (from_status = 'under_review' and to_status = 'rejected')
      or (from_status = 'changes_requested' and to_status = 'resubmitted')
      or (from_status = 'resubmitted' and to_status = 'under_review')
      or (from_status = 'approved' and to_status = 'suspended')
      or (from_status = 'suspended' and to_status = 'under_review')
    )
);

create unique index if not exists service_provider_application_events_una_por_clave
  on public.service_provider_application_events (application_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists service_provider_application_events_de_la_postulacion
  on public.service_provider_application_events (application_id, created_at, id);

-- ------------------------------------------------------------------------- --
-- 7. Disparadores.
-- ------------------------------------------------------------------------- --

-- 7.1 LA EVIDENCIA SOLO SE BORRA EN CASCADA DESDE SU RAÍZ.
--
-- `tg_argv[0]` es la tabla de la que cuelga y `tg_argv[1]` la columna que la
-- apunta. Si esa fila YA NO EXISTE, el borrado viene de la cascada —es borrar
-- la propia cuenta— y se deja pasar. Si sigue existiendo, alguien está
-- borrando la evidencia a mano, y eso no.
create or replace function public.servicios_borrado_solo_en_cascada()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  sigue boolean;
begin
  execute format(
    'select exists (select 1 from public.%I r where r.id = ($1).%I)',
    tg_argv[0], tg_argv[1]
  )
  into sigue
  using old;

  if sigue then
    raise exception
      'En Servicios, % no se borra: la admisión conserva su evidencia', tg_table_name
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists service_providers_solo_en_cascada on public.service_providers;
create trigger service_providers_solo_en_cascada
  before delete on public.service_providers
  for each row
  execute function public.servicios_borrado_solo_en_cascada('profiles', 'profile_id');

drop trigger if exists service_provider_applications_solo_en_cascada
  on public.service_provider_applications;
create trigger service_provider_applications_solo_en_cascada
  before delete on public.service_provider_applications
  for each row
  execute function public.servicios_borrado_solo_en_cascada('service_providers', 'provider_id');

drop trigger if exists service_provider_documents_solo_en_cascada
  on public.service_provider_documents;
create trigger service_provider_documents_solo_en_cascada
  before delete on public.service_provider_documents
  for each row
  execute function public.servicios_borrado_solo_en_cascada('service_providers', 'provider_id');

drop trigger if exists service_provider_credentials_solo_en_cascada
  on public.service_provider_credentials;
create trigger service_provider_credentials_solo_en_cascada
  before delete on public.service_provider_credentials
  for each row
  execute function public.servicios_borrado_solo_en_cascada('service_providers', 'provider_id');

drop trigger if exists service_provider_application_events_solo_en_cascada
  on public.service_provider_application_events;
create trigger service_provider_application_events_solo_en_cascada
  before delete on public.service_provider_application_events
  for each row
  execute function public.servicios_borrado_solo_en_cascada(
    'service_provider_applications', 'application_id'
  );

-- 7.2 EL HISTORIAL NO SE REESCRIBE.
create or replace function public.servicios_historial_inmutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception
    'El historial de una postulación de Servicios solo se añade: % no está permitido', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists service_provider_application_events_inmutables
  on public.service_provider_application_events;
create trigger service_provider_application_events_inmutables
  before update on public.service_provider_application_events
  for each row
  execute function public.servicios_historial_inmutable();

-- 7.3 NADIE SE ADMITE A SÍ MISMO.
--
-- En el código también se comprueba, antes que el rol. Las dos capas no son
-- redundantes: un `insert` por otra vía —un script, la consola— no pasa por el
-- código.
create or replace function public.servicios_nadie_se_admite_a_si_mismo()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  dueno uuid;
  quien uuid;
begin
  if tg_table_name = 'service_provider_application_events' then
    if new.actor_role not in ('reviewer', 'admin') then
      return new;
    end if;
    quien := new.actor_id;
    select p.profile_id into dueno
      from public.service_provider_applications a
      join public.service_providers p on p.id = a.provider_id
     where a.id = new.application_id;
  elsif tg_table_name = 'service_provider_applications' then
    quien := new.decided_by;
    select profile_id into dueno from public.service_providers where id = new.provider_id;
  elsif tg_table_name = 'service_provider_documents' then
    quien := new.reviewed_by;
    select profile_id into dueno from public.service_providers where id = new.provider_id;
  elsif tg_table_name = 'service_provider_credentials' then
    quien := new.verified_by;
    select profile_id into dueno from public.service_providers where id = new.provider_id;
  end if;

  if quien is not null and dueno is not null and quien = dueno then
    raise exception 'Nadie revisa ni decide su propia admisión en Servicios'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists service_provider_applications_ajena
  on public.service_provider_applications;
create trigger service_provider_applications_ajena
  before insert or update on public.service_provider_applications
  for each row
  execute function public.servicios_nadie_se_admite_a_si_mismo();

drop trigger if exists service_provider_documents_ajena
  on public.service_provider_documents;
create trigger service_provider_documents_ajena
  before insert or update on public.service_provider_documents
  for each row
  execute function public.servicios_nadie_se_admite_a_si_mismo();

drop trigger if exists service_provider_credentials_ajena
  on public.service_provider_credentials;
create trigger service_provider_credentials_ajena
  before insert or update on public.service_provider_credentials
  for each row
  execute function public.servicios_nadie_se_admite_a_si_mismo();

drop trigger if exists service_provider_application_events_ajena
  on public.service_provider_application_events;
create trigger service_provider_application_events_ajena
  before insert on public.service_provider_application_events
  for each row
  execute function public.servicios_nadie_se_admite_a_si_mismo();

-- 7.4 LA POSTULACIÓN NACE EN BORRADOR Y SOLO DA SALTOS DEL MAPA.
create or replace function public.service_provider_applications_salto_valido()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'Una postulación de Servicios nace en borrador, no en %', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status = 'submitted')
    or (old.status = 'submitted' and new.status = 'under_review')
    or (old.status = 'under_review' and new.status = 'changes_requested')
    or (old.status = 'under_review' and new.status = 'approved')
    or (old.status = 'under_review' and new.status = 'rejected')
    or (old.status = 'changes_requested' and new.status = 'resubmitted')
    or (old.status = 'resubmitted' and new.status = 'under_review')
    or (old.status = 'approved' and new.status = 'suspended')
    or (old.status = 'suspended' and new.status = 'under_review')
  ) then
    raise exception 'Una postulación % no puede pasar a %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- CAMBIAR DE DUEÑO no es un salto de estado: es otra postulación.
  if new.provider_id is distinct from old.provider_id then
    raise exception 'Una postulación no cambia de prestador'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists service_provider_applications_saltos
  on public.service_provider_applications;
create trigger service_provider_applications_saltos
  before insert or update on public.service_provider_applications
  for each row
  execute function public.service_provider_applications_salto_valido();

-- 7.5 UNA POLÍTICA FUERA DE BORRADOR NO SE EDITA NI SE BORRA.
--
-- Lo único que se le permite a una publicada es pasar a superada o retirada,
-- sin tocar nada más. Un expediente que la aceptó tiene que poder leerla tal y
-- como era.
create or replace function public.service_policies_publicada_es_inmutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' then
      return old;
    end if;
    raise exception 'Una política % de Servicios no se borra', old.status
      using errcode = 'restrict_violation';
  end if;

  if old.status = 'draft' then
    return new;
  end if;

  if old.status = 'published' and new.status in ('superseded', 'withdrawn')
     and (new.kind, new.country_code, new.category, new.version, new.title,
          new.body, new.body_sha256, new.parameters, new.effective_at,
          new.published_at, new.published_by, new.created_by, new.created_at)
         is not distinct from
         (old.kind, old.country_code, old.category, old.version, old.title,
          old.body, old.body_sha256, old.parameters, old.effective_at,
          old.published_at, old.published_by, old.created_by, old.created_at)
  then
    return new;
  end if;

  raise exception
    'Una política % de Servicios no se modifica: se publica una versión nueva', old.status
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists service_policies_inmutable on public.service_policies;
create trigger service_policies_inmutable
  before update or delete on public.service_policies
  for each row
  execute function public.service_policies_publicada_es_inmutable();

-- ------------------------------------------------------------------------- --
-- 8. RLS y permisos: cerrado.
-- ------------------------------------------------------------------------- --
alter table public.service_policies enable row level security;
alter table public.service_providers enable row level security;
alter table public.service_provider_applications enable row level security;
alter table public.service_provider_documents enable row level security;
alter table public.service_provider_credentials enable row level security;
alter table public.service_provider_application_events enable row level security;

revoke all on public.service_policies from anon, authenticated;
revoke all on public.service_providers from anon, authenticated;
revoke all on public.service_provider_applications from anon, authenticated;
revoke all on public.service_provider_documents from anon, authenticated;
revoke all on public.service_provider_credentials from anon, authenticated;
revoke all on public.service_provider_application_events from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 9. Verificación.
-- ------------------------------------------------------------------------- --
do $$
declare
  tablas text[] := array[
    'service_policies', 'service_providers', 'service_provider_applications',
    'service_provider_documents', 'service_provider_credentials',
    'service_provider_application_events'
  ];
  faltan text;
  sin_rls text;
  permisos bigint;
  politicas bigint;
  disparadores bigint;
begin
  select string_agg(t, ', ') into faltan
    from unnest(tablas) as t
   where not exists (
     select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
   );
  if faltan is not null then
    raise exception 'La 0086 no dejó estas tablas: %', faltan;
  end if;

  select string_agg(c.relname, ', ') into sin_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = any (tablas)
     and not c.relrowsecurity;
  if sin_rls is not null then
    raise exception 'La 0086 dejó sin RLS: %', sin_rls;
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name = any (tablas)
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'La admisión de Servicios tiene % permisos sueltos', permisos;
  end if;

  select count(*) into politicas
    from pg_policies
   where schemaname = 'public' and tablename = any (tablas);
  if politicas > 0 then
    raise exception 'La admisión de Servicios tiene % políticas RLS; debe tener cero', politicas;
  end if;

  select count(*) into disparadores
    from pg_trigger
   where not tgisinternal
     and tgname in (
       'service_providers_solo_en_cascada',
       'service_provider_applications_solo_en_cascada',
       'service_provider_documents_solo_en_cascada',
       'service_provider_credentials_solo_en_cascada',
       'service_provider_application_events_solo_en_cascada',
       'service_provider_application_events_inmutables',
       'service_provider_applications_ajena',
       'service_provider_documents_ajena',
       'service_provider_credentials_ajena',
       'service_provider_application_events_ajena',
       'service_provider_applications_saltos',
       'service_policies_inmutable'
     );
  if disparadores <> 12 then
    raise exception 'La 0086 dejó % de sus 12 disparadores', disparadores;
  end if;
end;
$$;
