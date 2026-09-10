-- 0064 · Posventa de eventos: políticas, cambios y expedientes.
--
-- SIN APLICAR.
--
-- QUÉ ES Y QUÉ NO ES. Esto crea el sitio donde vivirán las decisiones de
-- posventa de eventos. NO trae ninguna decisión tomada: ni un plazo, ni un
-- porcentaje, ni una aprobación automática. Nace todo vacío, y vacío significa
-- BLOQUEADO: sin una política publicada no se ejecuta dinero, no se revoca una
-- entrada y no se aprueba nada. La operación falla en cerrado y dice que la
-- función todavía no está configurada.
--
-- POR QUÉ TABLAS PROPIAS Y NO LAS DE CURSOS. `refund_requests` tiene clave
-- ajena dura a `courses.id` y sus índices únicos son por `(user_id, course_id)`.
-- Comparten infraestructura —la máquina de estados, el patrón del historial
-- solo-añadir, la conciliación con la pasarela— pero el dominio, las
-- referencias y las reglas son independientes: un expediente de evento no puede
-- acabar tocando el acceso a un curso, ni al revés.
--
-- POR QUÉ LOS PARÁMETROS SON DATO Y NO CÓDIGO. Un plazo escrito en el código
-- cambia cuando alguien despliega, y cambia también para lo ya vendido. Aquí
-- una política se PUBLICA, y lo publicado no se toca: se supersede. Así un
-- expediente puede decir qué reglas exactas se le aplicaron.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE. Esquema antes que código: cinco
-- tablas vacías que nadie lee. Código antes que esquema: las rutas de posventa
-- responden 503 `event_aftersale_not_available`, y eventos, entradas y puerta
-- funcionan exactamente igual.
--
-- BACKFILL: NINGUNO, y se comprueba al final. No hay ninguna posventa anterior
-- que traer, porque no había dónde registrarla.
--
-- ROLLBACK: `drop table` de las cinco en orden inverso. No hay columna añadida
-- a ninguna tabla existente, así que revertir no le quita nada a lo anterior.

-- ------------------------------------------------------------------------- --
-- 1. Políticas: la decisión de la empresa, versionada y publicada.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_policies (
  id uuid primary key default gen_random_uuid(),

  -- QUÉ decide esta política. Cada valor es una decisión distinta que la
  -- empresa todavía no ha tomado; tenerlos separados evita que publicar una
  -- encienda otra sin querer.
  policy_type text not null
    constraint event_policies_tipo check (policy_type in (
      'aftersale_eligibility',
      'refund_execution',
      'ticket_effect',
      'review_window',
      'organizer_reply',
      'settlement_hold',
      'settlement_reserve',
      'dispute_liability',
      'negative_balance'
    )),

  -- Global o para un evento concreto. Lo segundo existe porque un festival
  -- puede necesitar condiciones propias sin cambiar las de todos.
  scope text not null default 'global'
    constraint event_policies_alcance check (scope in ('global', 'event')),
  event_id uuid references public.events(id) on delete cascade,

  jurisdiction text not null default 'PE'
    constraint event_policies_jurisdiccion check (length(trim(jurisdiction)) between 2 and 8),

  version text not null
    constraint event_policies_version check (length(trim(version)) between 1 and 32),

  status text not null default 'draft'
    constraint event_policies_estado
    check (status in ('draft', 'published', 'superseded')),

  -- LOS PARÁMETROS, ESTRUCTURADOS. Un objeto, nunca nulo, y `{}` significa
  -- «sin nada decidido»: quien lo lea tiene que tratarlo como una política que
  -- no habilita nada, no como una llena de ceros.
  params jsonb not null default '{}'::jsonb
    constraint event_policies_parametros check (jsonb_typeof(params) = 'object'),
  -- La huella de lo publicado. Sirve para demostrar dentro de un año qué
  -- números exactos se aplicaron a un expediente.
  params_sha256 text not null
    constraint event_policies_huella check (params_sha256 ~ '^[0-9a-f]{64}$'),

  -- Texto que se le enseña a la persona, si lo hay. Separado de los
  -- parámetros: uno es para leer y el otro para calcular.
  body text,
  locale text not null default 'es'
    constraint event_policies_idioma check (locale in ('es', 'en', 'pt')),

  effective_from timestamptz,
  effective_to timestamptz,
  published_at timestamptz,
  published_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,

  -- EL ALCANCE Y EL EVENTO DICEN LO MISMO. Una política «de evento» sin evento
  -- no se puede aplicar a nada, y una «global» con evento se aplicaría dos
  -- veces por caminos distintos.
  constraint event_policies_alcance_coherente
    check ((scope = 'event') = (event_id is not null)),

  -- PUBLICADA ES PUBLICADA. Sin fecha no se puede decir desde cuándo rige, y
  -- sin saberlo no se puede reconstruir qué se le aplicó a un expediente.
  constraint event_policies_publicada_con_fecha
    check ((status = 'published') = (published_at is not null)),
  constraint event_policies_vigencia
    check (effective_to is null or effective_from is null
           or effective_to > effective_from),

  constraint event_policies_version_unica
    unique (policy_type, scope, event_id, jurisdiction, locale, version)
);

-- UNA VIGENTE POR TIPO Y ALCANCE. Parcial: los borradores y las superadas
-- conviven todas, que es lo que permite conservar el historial de decisiones.
-- Dos globales vigentes del mismo tipo harían que el resultado dependiera del
-- orden de lectura.
create unique index if not exists event_policies_vigente_global
  on public.event_policies (policy_type, jurisdiction, locale)
  where status = 'published' and effective_to is null and scope = 'global';

create unique index if not exists event_policies_vigente_de_evento
  on public.event_policies (policy_type, event_id, jurisdiction, locale)
  where status = 'published' and effective_to is null and scope = 'event';

create index if not exists event_policies_por_tipo
  on public.event_policies (policy_type, status, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 2. Cambios del evento posteriores a la publicación.
--
-- REGISTRAR NO ES CLASIFICAR. Aquí queda que algo cambió y qué decía antes;
-- decidir si ese cambio es esencial —y por tanto si da derecho a algo— es una
-- decisión de la empresa y vive en `classification`, que nace SIN decidir.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_changes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  field text not null
    constraint event_changes_campo check (length(trim(field)) between 1 and 64),
  -- Los valores, como texto, y RECORTADOS. No es un volcado del evento: es lo
  -- justo para que una persona vea qué cambió.
  previous_value text
    constraint event_changes_antes check (previous_value is null or length(previous_value) <= 500),
  new_value text
    constraint event_changes_despues check (new_value is null or length(new_value) <= 500),

  -- `pending` es el estado de fábrica y significa SIN CLASIFICAR. No es
  -- «no esencial»: dar por bueno lo que nadie ha mirado es exactamente cómo un
  -- cambio material reescribe en silencio lo que la gente compró.
  classification text not null default 'pending'
    constraint event_changes_clasificacion check (classification in (
      'pending',
      'editorial',
      'operational',
      'possibly_essential',
      'essential',
      'not_essential'
    )),
  classified_by uuid references public.profiles(id) on delete set null,
  classified_at timestamptz,
  classification_reason text
    constraint event_changes_motivo
    check (classification_reason is null or length(classification_reason) <= 500),

  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint event_changes_clasificada_con_fecha
    check ((classification = 'pending') = (classified_at is null)),
  constraint event_changes_algo_cambio
    check (previous_value is distinct from new_value)
);

create index if not exists event_changes_del_evento
  on public.event_changes (event_id, created_at desc, id desc);
create index if not exists event_changes_sin_clasificar
  on public.event_changes (created_at desc, id desc)
  where classification = 'pending';

-- ------------------------------------------------------------------------- --
-- 3. El expediente de posventa.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_aftersale_cases (
  id uuid primary key default gen_random_uuid(),

  event_id uuid not null references public.events(id) on delete restrict,
  order_id uuid not null references public.event_orders(id) on delete restrict,
  buyer_id uuid not null references public.profiles(id) on delete restrict,
  organizer_id uuid not null references public.profiles(id) on delete restrict,

  kind text not null
    constraint event_aftersale_cases_tipo check (kind in (
      'buyer_cancellation',
      'event_cancelled',
      'event_rescheduled',
      'essential_change',
      'refund_request',
      'exception',
      'dispute'
    )),

  status text not null default 'submitted'
    constraint event_aftersale_cases_estado check (status in (
      'submitted',
      'under_review',
      'awaiting_information',
      'approved',
      'rejected',
      'refund_pending',
      'refund_processing',
      'resolved',
      'cancelled',
      'failed'
    )),

  origin text not null default 'buyer'
    constraint event_aftersale_cases_origen
    check (origin in ('buyer', 'organizer', 'admin', 'system')),

  -- LO QUE DICE EL COMPRADOR Y LO QUE ANOTA QUIEN REVISA, SEPARADOS. La nota
  -- interna no sale en ninguna respuesta del comprador ni del organizador, y
  -- tenerlas en columnas distintas es lo que hace que no se pueda confundir.
  buyer_reason text
    constraint event_aftersale_cases_motivo
    check (buyer_reason is null or length(buyer_reason) <= 1000),
  internal_notes text
    constraint event_aftersale_cases_notas
    check (internal_notes is null or length(internal_notes) <= 4000),

  assignee_id uuid references public.profiles(id) on delete set null,

  -- La política que se le aplicó. NULA mientras no haya decisión: es lo que
  -- permite decir después «con qué reglas se resolvió esto».
  policy_id uuid references public.event_policies(id) on delete restrict,

  outcome text
    constraint event_aftersale_cases_resultado check (outcome is null or outcome in (
      'full_refund',
      'partial_refund',
      'no_refund',
      'credit',
      'ticket_revoked',
      'ticket_kept',
      'escalated'
    )),

  -- Importes: NULOS mientras no haya decisión. Nunca cero, que se leería como
  -- «se decidió no devolver nada».
  refund_amount_minor bigint
    constraint event_aftersale_cases_importe
    check (refund_amount_minor is null or refund_amount_minor >= 0),
  currency char(3)
    constraint event_aftersale_cases_moneda
    check (currency is null or currency ~ '^[A-Z]{3}$'),

  provider text not null default 'none'
    constraint event_aftersale_cases_proveedor
    check (provider in ('none', 'stripe')),
  environment text not null default 'sandbox'
    constraint event_aftersale_cases_entorno
    check (environment in ('sandbox', 'production')),
  external_refund_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,

  constraint event_aftersale_cases_resuelto_con_fecha
    check ((status in ('resolved', 'rejected', 'cancelled')) = (resolved_at is not null)),
  -- SIN POLÍTICA NO HAY RESULTADO. Un expediente no puede acabar diciendo
  -- «devolución total» sin apuntar con qué reglas se decidió.
  constraint event_aftersale_cases_resultado_con_politica
    check (outcome is null or policy_id is not null),
  -- Un importe sin moneda no es un importe.
  constraint event_aftersale_cases_importe_con_moneda
    check ((refund_amount_minor is null) = (currency is null)),
  -- Una referencia externa no cierra dos expedientes.
  constraint event_aftersale_cases_de_su_evento
    unique (id, event_id)
);

create unique index if not exists event_aftersale_cases_referencia_unica
  on public.event_aftersale_cases (provider, environment, external_refund_id)
  where external_refund_id is not null;

-- UN EXPEDIENTE VIVO POR PEDIDO. Dos solicitudes abiertas sobre la misma compra
-- acaban en dos decisiones distintas sobre el mismo dinero.
create unique index if not exists event_aftersale_cases_vivo_por_pedido
  on public.event_aftersale_cases (order_id)
  where status in (
    'submitted', 'under_review', 'awaiting_information',
    'approved', 'refund_pending', 'refund_processing', 'failed'
  );

create index if not exists event_aftersale_cases_del_comprador
  on public.event_aftersale_cases (buyer_id, created_at desc, id desc);
create index if not exists event_aftersale_cases_del_evento
  on public.event_aftersale_cases (event_id, status, created_at desc, id desc);
create index if not exists event_aftersale_cases_por_estado
  on public.event_aftersale_cases (status, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 4. Qué entradas toca cada expediente.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_aftersale_case_tickets (
  case_id uuid not null references public.event_aftersale_cases(id) on delete cascade,
  ticket_id uuid not null references public.event_tickets(id) on delete restrict,
  -- El estado que tenía la entrada al abrirse el expediente. Congelado: si
  -- después se usa o se revoca, sigue constando qué había cuando se pidió.
  status_at_open text not null
    constraint event_aftersale_case_tickets_estado
    check (status_at_open in ('VALID', 'USED', 'REVOKED')),
  created_at timestamptz not null default now(),
  primary key (case_id, ticket_id)
);

create index if not exists event_aftersale_case_tickets_de_la_entrada
  on public.event_aftersale_case_tickets (ticket_id);

-- ------------------------------------------------------------------------- --
-- 5. Historial inmutable del expediente.
--
-- SOLO AÑADIR. El disparador lo impone la base: sin él, «historial inmutable»
-- es una promesa que depende de que nadie escriba un UPDATE.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_aftersale_case_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.event_aftersale_cases(id) on delete cascade,

  from_status text
    constraint event_aftersale_case_events_desde
    check (from_status is null or length(from_status) <= 32),
  to_status text not null
    constraint event_aftersale_case_events_hasta
    check (length(trim(to_status)) between 1 and 32),

  actor_id uuid references public.profiles(id) on delete set null,
  actor_role text not null default 'system'
    constraint event_aftersale_case_events_rol
    check (actor_role in ('buyer', 'organizer', 'support', 'admin', 'system')),

  reason text
    constraint event_aftersale_case_events_motivo
    check (reason is null or length(reason) <= 500),
  -- Nota interna del paso. NO se le enseña al comprador ni al organizador.
  notes text
    constraint event_aftersale_case_events_notas
    check (notes is null or length(notes) <= 2000),
  external_reference text,

  created_at timestamptz not null default now()
);

create index if not exists event_aftersale_case_events_del_caso
  on public.event_aftersale_case_events (case_id, created_at, id);

create or replace function public.event_aftersale_case_events_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'El historial de un expediente no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists event_aftersale_case_events_inmutables
  on public.event_aftersale_case_events;
create trigger event_aftersale_case_events_inmutables
before update or delete on public.event_aftersale_case_events
for each row execute function public.event_aftersale_case_events_solo_anadir();

-- ------------------------------------------------------------------------- --
-- 6. RLS y permisos: cerrado. El móvil no lee ninguna de estas tablas.
--
-- Aquí hay dinero, notas internas y motivos personales. Una política `for
-- select` pondría el expediente de otra persona a un `select` de distancia
-- desde el teléfono. Se pregunta por la API, que además de comprobar quién
-- pregunta decide qué campos devuelve —y las notas internas no están entre
-- ellos—.
-- ------------------------------------------------------------------------- --
alter table public.event_policies enable row level security;
alter table public.event_changes enable row level security;
alter table public.event_aftersale_cases enable row level security;
alter table public.event_aftersale_case_tickets enable row level security;
alter table public.event_aftersale_case_events enable row level security;

revoke all on public.event_policies from anon, authenticated;
revoke all on public.event_changes from anon, authenticated;
revoke all on public.event_aftersale_cases from anon, authenticated;
revoke all on public.event_aftersale_case_tickets from anon, authenticated;
revoke all on public.event_aftersale_case_events from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 7. Verificación posterior.
-- ------------------------------------------------------------------------- --
do $$
declare
  cuantas bigint;
  politicas bigint;
  permisos bigint;
begin
  select
      (select count(*) from public.event_policies)
    + (select count(*) from public.event_changes)
    + (select count(*) from public.event_aftersale_cases)
    + (select count(*) from public.event_aftersale_case_tickets)
    + (select count(*) from public.event_aftersale_case_events)
  into cuantas;
  if cuantas > 0 then
    raise exception 'La 0064 no escribe ninguna fila y hay %: algo más las puso', cuantas;
  end if;

  -- NINGUNA POLÍTICA PUBLICADA, y esto es el criterio de aceptación entero:
  -- si la migración dejara una, estaría tomando una decisión de la empresa.
  select count(*) into politicas
    from public.event_policies where status = 'published';
  if politicas > 0 then
    raise exception 'La 0064 dejó % políticas publicadas: no le toca decidir', politicas;
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in (
       'event_policies', 'event_changes', 'event_aftersale_cases',
       'event_aftersale_case_tickets', 'event_aftersale_case_events'
     )
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'La posventa tiene % permisos para anon/authenticated', permisos;
  end if;

  if not exists (
    select 1 from pg_trigger tg
    join pg_class t on t.oid = tg.tgrelid
    where t.relname = 'event_aftersale_case_events'
      and tg.tgname = 'event_aftersale_case_events_inmutables'
  ) then
    raise exception 'La 0064 no dejó el disparador de historial inmutable';
  end if;
end;
$$;
