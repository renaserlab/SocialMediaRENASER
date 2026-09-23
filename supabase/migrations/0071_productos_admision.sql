-- 0071 · Admisión y evaluación de productos: postulación, evidencia, matriz y
--        razones de aprobación.
--
-- APLICADA Y VERIFICADA contra la base gestionada el 17/09/2026, junto con la
-- 0070 y la 0072. El cuerpo del disparador `product_evaluations_no_es_propio`
-- se comparo caracter a caracter con el de este fichero. CERO DIVERGENCIAS.
--
-- QUÉ GARANTIZA ESTO, Y NO EL CÓDIGO:
--
--   1. NADIE EVALÚA SU PROPIO PRODUCTO. Lo impone un disparador, no una
--      convención: es la puerta que convierte «solo publicamos lo evaluado» en
--      algo distinto de un sello que se pone uno mismo.
--   2. UNA RAZÓN DE APROBACIÓN SIN EVIDENCIA NO EXISTE. `evidence_id` es NOT
--      NULL, así que las tres razones que lee quien compra salen de una fila
--      que un evaluador registró. Una frase escrita a mano —o generada— no
--      cabe en esta tabla.
--   3. COMO MUCHO TRES RAZONES, y en un orden estable. El blueprint dice
--      exactamente tres; que sean exactamente tres al publicar lo comprueba el
--      código, porque «todavía voy por la segunda» es un estado legítimo de un
--      borrador.
--   4. UN PESO CONGELADO POR DIMENSIÓN. La matriz puede cambiar; lo que ya se
--      decidió no. Guardar el peso en la fila es lo que permite recalcular una
--      decisión pasada con los números con los que se tomó.
--
-- LO QUE NO TRAE: ninguna puntuación de partida, ningún sello automático y
-- ninguna condición de «aprobación condicionada». Qué se le puede exigir a un
-- producto aprobado con condiciones es una decisión que la empresa no ha
-- tomado, así que `conditionally_approved` existe como estado y NO habilita
-- publicar. Falla en cerrado.
--
-- ROLLBACK: `drop table` en orden inverso y `drop function`.

-- ------------------------------------------------------------------------- --
-- 1. La postulación del proveedor.
-- ------------------------------------------------------------------------- --
--
-- ES DEL PERFIL, NO DEL `product_seller`. Se postula antes de tener capacidad
-- comercial; la fila de `product_sellers` es la CONSECUENCIA de una postulación
-- aceptada, no su requisito.
create table if not exists public.seller_applications (
  id uuid primary key default gen_random_uuid(),

  profile_id uuid not null
    references public.profiles(id) on delete cascade,

  status text not null default 'draft'
    constraint seller_applications_estado
    check (status in ('draft', 'submitted', 'under_review', 'accepted', 'rejected', 'withdrawn')),

  -- CON QUÉ NOMBRE QUIERE FIRMAR. Se copia a `product_sellers.display_name` al
  -- aceptar; aquí es lo que pidió, allí es lo que se le concedió.
  display_name text not null
    constraint seller_applications_nombre
    check (length(trim(display_name)) between 2 and 120),

  -- QUÉ PROPONE. Texto de la persona, no un formulario de datos tributarios:
  -- qué documentación exacta se exige depende de la entidad legal y del país,
  -- y eso la empresa no lo ha definido. Lo que se presenta va en
  -- `seller_application_documents`, que admite lo que haga falta sin inventar
  -- columnas.
  proposal text not null
    constraint seller_applications_propuesta
    check (length(trim(proposal)) between 20 and 4000),

  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  -- EL MOTIVO QUE SE LE ENSEÑA. Separado de las notas internas, igual que en
  -- los expedientes de eventos: es lo que hace imposible que una respuesta
  -- lleve dentro lo que alguien anotó para uso interno.
  decision_reason text
    constraint seller_applications_motivo
    check (decision_reason is null or length(decision_reason) <= 2000),
  internal_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint seller_applications_enviada_con_fecha
    check (status = 'draft' or submitted_at is not null),
  constraint seller_applications_decidida_con_fecha
    check (status not in ('accepted', 'rejected') or decided_at is not null),
  -- UN RECHAZO SIN MOTIVO no se le puede enseñar a nadie.
  constraint seller_applications_rechazo_con_motivo
    check (status <> 'rejected' or length(trim(coalesce(decision_reason, ''))) > 0)
);

-- UNA VIVA POR PERFIL. Dos postulaciones abiertas de la misma persona son dos
-- respuestas posibles a la misma pregunta.
create unique index if not exists seller_applications_una_viva
  on public.seller_applications (profile_id)
  where status in ('draft', 'submitted', 'under_review');

create index if not exists seller_applications_bandeja
  on public.seller_applications (status, submitted_at desc, id desc);

create table if not exists public.seller_application_documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null
    references public.seller_applications(id) on delete cascade,

  -- QUÉ ES. Los del blueprint §5.1, como códigos y no como frases: una lista
  -- en prosa no se puede contar ni exigir.
  kind text not null
    constraint seller_application_documents_tipo
    check (kind in (
      'identity', 'tax_data', 'bank_account', 'manufacturer',
      'materials_and_batch', 'warranty_procedure', 'permits', 'photos', 'other'
    )),
  -- LA RUTA EN EL ALMACENAMIENTO o una nota. Uno de los dos, no los dos vacíos.
  storage_path text,
  note text
    constraint seller_application_documents_nota
    check (note is null or length(note) <= 2000),

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint seller_application_documents_algo
    check (
      length(trim(coalesce(storage_path, ''))) > 0
      or length(trim(coalesce(note, ''))) > 0
    )
);

create index if not exists seller_application_documents_de_la_postulacion
  on public.seller_application_documents (application_id, kind, created_at);

-- ------------------------------------------------------------------------- --
-- 2. La evaluación de una VERSIÓN del producto.
-- ------------------------------------------------------------------------- --
--
-- DE LA VERSIÓN Y NO DEL PRODUCTO. Se evalúa lo que se va a publicar: el texto,
-- las fotos y las variantes concretas. Colgarla del producto haría que una
-- versión nueva heredara el sello de otra que nadie miró.
create table if not exists public.product_evaluations (
  id uuid primary key default gen_random_uuid(),

  product_id uuid not null
    references public.products(id) on delete cascade,
  version_id uuid not null
    references public.product_versions(id) on delete cascade,

  evaluator_id uuid not null
    references public.profiles(id) on delete restrict,

  status text not null default 'draft'
    constraint product_evaluations_estado
    check (status in ('draft', 'decided')),

  -- LA PUNTUACIÓN PONDERADA, en centésimas de punto para no arrastrar
  -- decimales: 9 000 son 90,00. NULA mientras no se decide, y nula NO es cero.
  score_total integer
    constraint product_evaluations_puntuacion
    check (score_total is null or score_total between 0 and 10000),

  decision text
    constraint product_evaluations_decision
    check (decision is null or decision in ('approved', 'conditionally_approved', 'rejected')),

  -- FALLA CRÍTICA. Seguridad, falsificación, publicidad engañosa, procedencia
  -- no verificable, permisos faltantes o evidencia manipulada: rechazo directo
  -- SIN compensación por puntaje. Va en su propia columna porque no es una
  -- puntuación baja, es otra cosa.
  critical_failure text
    constraint product_evaluations_falla
    check (critical_failure is null or critical_failure in (
      'safety', 'counterfeit', 'misleading_advertising',
      'unverifiable_origin', 'missing_permits', 'tampered_evidence'
    )),

  notes text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint product_evaluations_decidida_con_decision
    check (status <> 'decided' or (decision is not null and decided_at is not null)),
  -- UNA FALLA CRÍTICA SOLO PUEDE ACABAR EN RECHAZO. Aprobar con una falla
  -- registrada sería dejar por escrito que se aprobó algo que no debía.
  constraint product_evaluations_falla_rechaza
    check (critical_failure is null or decision is null or decision = 'rejected'),
  -- APROBAR EXIGE PUNTUACIÓN. Un `approved` sin número no se puede explicar.
  constraint product_evaluations_aprobada_con_puntuacion
    check (decision is null or decision = 'rejected' or score_total is not null)
);

-- UNA EVALUACIÓN VIVA POR VERSIÓN. Dos borradores a la vez serían dos
-- veredictos y nadie sabría cuál cuenta.
create unique index if not exists product_evaluations_una_viva
  on public.product_evaluations (version_id)
  where status = 'draft';

create index if not exists product_evaluations_del_producto
  on public.product_evaluations (product_id, created_at desc, id desc);

create index if not exists product_evaluations_bandeja
  on public.product_evaluations (status, created_at desc, id desc);

-- NADIE EVALÚA SU PROPIO PRODUCTO, y lo dice la base.
--
-- En el código también se comprueba, y las dos capas no son una redundancia:
-- entre leer quién es el responsable y escribir la evaluación cabe un cambio de
-- responsable, y un `insert` por otra vía —un script, la consola— no pasa por
-- el código.
create or replace function public.product_evaluations_no_es_propio()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  dueno uuid;
begin
  select s.profile_id into dueno
    from public.products p
    join public.product_sellers s on s.id = p.seller_id
   where p.id = new.product_id;

  if dueno is not null and dueno = new.evaluator_id then
    raise exception 'Nadie evalúa su propio producto'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists product_evaluations_ajena on public.product_evaluations;
create trigger product_evaluations_ajena
  before insert or update on public.product_evaluations
  for each row
  execute function public.product_evaluations_no_es_propio();

-- ------------------------------------------------------------------------- --
-- 3. Las puntuaciones, dimensión por dimensión.
-- ------------------------------------------------------------------------- --
--
-- LAS SEIS DEL BLUEPRINT §5.2 con sus pesos: calidad 25, diseño 20, utilidad
-- 20, durabilidad 15, origen 10, garantía 10. El peso se GUARDA en la fila
-- porque la matriz puede cambiar y una decisión pasada tiene que poder
-- explicarse con los números con los que se tomó.
create table if not exists public.product_evaluation_scores (
  evaluation_id uuid not null
    references public.product_evaluations(id) on delete cascade,
  dimension text not null
    constraint product_evaluation_scores_dimension
    check (dimension in (
      'quality', 'design', 'usefulness', 'durability', 'origin', 'warranty'
    )),

  -- DE 0 A 100. La ponderación la hace quien suma, no esta tabla.
  score integer not null
    constraint product_evaluation_scores_puntuacion
    check (score between 0 and 100),
  weight integer not null
    constraint product_evaluation_scores_peso
    check (weight between 0 and 100),

  note text
    constraint product_evaluation_scores_nota
    check (note is null or length(note) <= 2000),
  created_at timestamptz not null default now(),

  primary key (evaluation_id, dimension)
);

-- ------------------------------------------------------------------------- --
-- 4. La evidencia. Sin ella no hay puntuación que sostener.
-- ------------------------------------------------------------------------- --
create table if not exists public.product_evaluation_evidence (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null
    references public.product_evaluations(id) on delete cascade,

  dimension text not null
    constraint product_evaluation_evidence_dimension
    check (dimension in (
      'quality', 'design', 'usefulness', 'durability', 'origin', 'warranty'
    )),
  kind text not null
    constraint product_evaluation_evidence_tipo
    check (kind in (
      'functional_test', 'inspection', 'usage_review', 'problem_and_result',
      'materials', 'batch', 'warranty_policy', 'photo', 'document', 'sample'
    )),

  -- LO QUE SE MIRÓ. Una descripción, y opcionalmente el archivo.
  summary text not null
    constraint product_evaluation_evidence_resumen
    check (length(trim(summary)) between 10 and 1000),
  storage_path text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists product_evaluation_evidence_de_la_evaluacion
  on public.product_evaluation_evidence (evaluation_id, dimension, created_at);

-- ------------------------------------------------------------------------- --
-- 5. Las tres razones que lee quien compra.
-- ------------------------------------------------------------------------- --
--
-- CADA UNA APUNTA A UNA EVIDENCIA, y es NOT NULL. Es lo que hace imposible que
-- «Por qué está en Z» enseñe una frase que nadie respaldó.
create table if not exists public.product_approval_reasons (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null
    references public.product_versions(id) on delete cascade,
  evaluation_id uuid not null
    references public.product_evaluations(id) on delete cascade,
  evidence_id uuid not null
    references public.product_evaluation_evidence(id) on delete restrict,

  -- EL TEXTO QUE SE ENSEÑA. Lo escribe el evaluador a partir de la evidencia
  -- que eligió; corto a propósito, porque son tres razones y no un informe.
  text text not null
    constraint product_approval_reasons_texto
    check (length(trim(text)) between 10 and 240),

  -- EXACTAMENTE TRES, Y EN ORDEN. El tope lo pone el CHECK; que estén las tres
  -- al publicar lo comprueba el código.
  position integer not null
    constraint product_approval_reasons_posicion
    check (position between 1 and 3),

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint product_approval_reasons_una_por_posicion
    unique (version_id, position)
);

create index if not exists product_approval_reasons_de_la_version
  on public.product_approval_reasons (version_id, position);

-- ------------------------------------------------------------------------- --
-- 6. RLS y permisos.
-- ------------------------------------------------------------------------- --
alter table public.seller_applications enable row level security;
alter table public.seller_application_documents enable row level security;
alter table public.product_evaluations enable row level security;
alter table public.product_evaluation_scores enable row level security;
alter table public.product_evaluation_evidence enable row level security;
alter table public.product_approval_reasons enable row level security;

revoke all on public.seller_applications from anon, authenticated;
revoke all on public.seller_application_documents from anon, authenticated;
revoke all on public.product_evaluations from anon, authenticated;
revoke all on public.product_evaluation_scores from anon, authenticated;
revoke all on public.product_evaluation_evidence from anon, authenticated;
revoke all on public.product_approval_reasons from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 7. Verificación.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  permisos bigint;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array[
      'seller_applications', 'seller_application_documents',
      'product_evaluations', 'product_evaluation_scores',
      'product_evaluation_evidence', 'product_approval_reasons'
    ]) as t
   where not exists (
     select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
   );
  if faltan is not null then
    raise exception 'La 0071 no dejó estas tablas: %', faltan;
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.product_evaluations'::regclass
       and tgname = 'product_evaluations_ajena'
  ) then
    raise exception 'La 0071 no dejó el disparador de «nadie evalúa lo suyo»';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in (
       'seller_applications', 'seller_application_documents',
       'product_evaluations', 'product_evaluation_scores',
       'product_evaluation_evidence', 'product_approval_reasons'
     )
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'La admisión de productos tiene % permisos sueltos', permisos;
  end if;
end;
$$;
