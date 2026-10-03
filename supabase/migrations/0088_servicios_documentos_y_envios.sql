-- 0088 · Z Servicios, cierre del Incremento 1: depósito privado, ciclo de vida
--        de documentos y credenciales, envíos congelados y coherencia entre
--        postulación y prestador.
--
-- SIN APLICAR. Escrita el 28/09/2026 y probada solo contra PostgreSQL local:
-- desde cero (0001–0088) y sobre una base que ya tenía la 0086 y la 0087
-- (`tests/test_servicios_migracion_0088.py`). Requiere la 0086 y la 0087, que
-- están aplicadas en Supabase y verificadas sin divergencias. NO LAS TOCA.
-- Al aplicarla, REINICIAR LA API: la puerta de esquema cachea el «no».
--
-- POR QUÉ HACE FALTA, Y NADA MÁS:
--
--   1. EL DEPÓSITO PRIVADO `service-provider-documents`, como la 0085: privado,
--      SIN POLÍTICAS, 10 MB y lista cerrada de formatos. La única puerta es la
--      API; administración mira con un enlace firmado de pocos minutos.
--   2. RETIRAR Y REEMPLAZAR sin borrar. La 0086 impide borrar un documento o
--      una credencial suelta (la evidencia solo cae en cascada con la cuenta),
--      así que retirar uno antes de enviar o reemplazarlo necesita un CICLO DE
--      VIDA: `active`, `replaced`, `removed`. Nada se borra.
--   3. OBSERVAR UNA CREDENCIAL sin inventar un estado: sigue `declared`, con
--      `observed_at` y el motivo. Así no se amplía ningún CHECK de la 0086.
--   4. LO QUE SE PIDIÓ CORREGIR, en el historial: `details` (qué campos), sin
--      tocar ninguna fila existente.
--   5. CADA ENVÍO CONGELADO (`service_provider_application_submissions`): la
--      versión y la huella de las condiciones aceptadas, y una foto de lo que
--      se envió. Solo se añade: reenviar crea otra, nunca reescribe la anterior.
--   6. POSTULACIÓN Y PRESTADOR COINCIDEN, y lo comprueba la base al confirmar
--      cada transacción: un prestador está `active` si y solo si su postulación
--      actual está `approved`, y una postulación `suspended` exige un
--      prestador `suspended`. El estado de la POSTULACIÓN es la fuente de
--      verdad; el del prestador se deriva en el código y aquí se verifica.
--   7. RETIRARSE ES ANTES DE LA DECISIÓN, también cuando una aprobada vuelve a
--      revisión tras una suspensión (restricción nueva, sección 3.3).
--
-- ADITIVA: añade columnas con valor por defecto, restricciones con nombre
-- nuevo, una tabla y disparadores nuevos. No elimina ni sustituye nada de la
-- 0086 ni de la 0087, no borra datos y no debilita ninguna restricción.
--
-- UNA ÚNICA TRANSACCIÓN, que primero comprueba que la 0086 y la 0087 están.
-- REEJECUTABLE: `if not exists`, `drop … if exists` + `add`/`create` con
-- nombres propios, `create or replace` y `on conflict do nothing`.
--
-- ROLLBACK (con las tablas vacías): `drop table
-- public.service_provider_application_submissions`; quitar los disparadores y
-- las funciones de la sección 6; quitar las restricciones y columnas añadidas
-- en 3 y 4; y, con el depósito vacío,
--   delete from storage.buckets where id = 'service-provider-documents';

begin;

-- ------------------------------------------------------------------------- --
-- 1. Lo que la 0086 y la 0087 tienen que haber dejado.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  incoherentes bigint;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array[
      'service_policies', 'service_providers', 'service_provider_applications',
      'service_provider_documents', 'service_provider_credentials',
      'service_provider_application_events'
    ]) as t
   where to_regclass('public.' || t) is null;
  if faltan is not null then
    raise exception 'La 0088 requiere la 0086: faltan las tablas %', faltan;
  end if;

  if to_regprocedure('public.service_provider_application_events_retirada_propia()') is null then
    raise exception 'La 0088 requiere la 0087: falta la función de retirada propia';
  end if;
  if to_regprocedure('public.servicios_historial_inmutable()') is null
     or to_regprocedure('public.servicios_borrado_solo_en_cascada()') is null then
    raise exception 'La 0088 requiere la 0086: faltan sus funciones de historial';
  end if;

  -- LO QUE YA HUBIERA tiene que cumplir la regla de la sección 6. Los
  -- disparadores diferidos solo miran lo que se escribe DESPUÉS: una fila
  -- incoherente de antes quedaría bloqueada sin avisar. Se para y se cuenta;
  -- qué hacer con ella lo decide una persona, no la migración.
  select count(*) into incoherentes
    from public.service_providers p
    left join lateral (
      select a.status
        from public.service_provider_applications a
       where a.provider_id = p.id
       order by (a.status in ('rejected', 'withdrawn')), a.created_at desc, a.id desc
       limit 1
    ) actual on true
   where (actual.status = 'approved' and p.status <> 'active')
      or (actual.status = 'suspended' and p.status <> 'suspended')
      or (coalesce(actual.status, '') <> 'approved' and p.status = 'active');
  if incoherentes > 0 then
    raise exception 'La 0088 encontró % prestadores cuyo estado no coincide con su postulación; revísalos antes de aplicarla', incoherentes;
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. El depósito privado de los documentos de la postulación.
-- ------------------------------------------------------------------------- --
insert into storage.buckets (id, name, public)
values ('service-provider-documents', 'service-provider-documents', false)
on conflict (id) do nothing;

update storage.buckets
set
  public = false,
  file_size_limit = 10::bigint * 1024 * 1024,
  allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
where id = 'service-provider-documents';

-- SIN POLÍTICAS A PROPÓSITO: se borran por si una ejecución anterior las dejó.
drop policy if exists service_provider_documents_read on storage.objects;
drop policy if exists service_provider_documents_write on storage.objects;

-- ------------------------------------------------------------------------- --
-- 3. El ciclo de vida de documentos y credenciales.
-- ------------------------------------------------------------------------- --

-- 3.1 Documentos: activo, reemplazado por otro o retirado antes de enviar.
alter table public.service_provider_documents
  add column if not exists lifecycle text not null default 'active';
alter table public.service_provider_documents
  add column if not exists lifecycle_changed_at timestamptz;
alter table public.service_provider_documents
  add column if not exists replaced_by uuid;

alter table public.service_provider_documents
  drop constraint if exists service_provider_documents_ciclo;
alter table public.service_provider_documents
  add constraint service_provider_documents_ciclo
  check (lifecycle in ('active', 'replaced', 'removed'));

alter table public.service_provider_documents
  drop constraint if exists service_provider_documents_ciclo_con_fecha;
alter table public.service_provider_documents
  add constraint service_provider_documents_ciclo_con_fecha
  check ((lifecycle = 'active') = (lifecycle_changed_at is null));

-- Reemplazado SI Y SOLO SI dice por cuál, y nunca por sí mismo.
alter table public.service_provider_documents
  drop constraint if exists service_provider_documents_reemplazo_coherente;
alter table public.service_provider_documents
  add constraint service_provider_documents_reemplazo_coherente
  check (
    (lifecycle = 'replaced') = (replaced_by is not null)
    and (replaced_by is null or replaced_by <> id)
  );

-- El reemplazo es un documento DE LA MISMA PERSONA.
alter table public.service_provider_documents
  drop constraint if exists service_provider_documents_reemplazado_por;
alter table public.service_provider_documents
  add constraint service_provider_documents_reemplazado_por
  foreign key (replaced_by, provider_id)
  references public.service_provider_documents (id, provider_id)
  on delete cascade;

create index if not exists service_provider_documents_activos
  on public.service_provider_documents (application_id, kind)
  where lifecycle = 'active';

-- 3.2 Credenciales: activa o retirada; observada sin inventar un estado.
alter table public.service_provider_credentials
  add column if not exists lifecycle text not null default 'active';
alter table public.service_provider_credentials
  add column if not exists lifecycle_changed_at timestamptz;
alter table public.service_provider_credentials
  add column if not exists observed_at timestamptz;

alter table public.service_provider_credentials
  drop constraint if exists service_provider_credentials_ciclo;
alter table public.service_provider_credentials
  add constraint service_provider_credentials_ciclo
  check (lifecycle in ('active', 'removed'));

alter table public.service_provider_credentials
  drop constraint if exists service_provider_credentials_ciclo_con_fecha;
alter table public.service_provider_credentials
  add constraint service_provider_credentials_ciclo_con_fecha
  check ((lifecycle = 'active') = (lifecycle_changed_at is null));

-- OBSERVADA = declarada, con motivo y fecha. No es un estado nuevo.
alter table public.service_provider_credentials
  drop constraint if exists service_provider_credentials_observada_coherente;
alter table public.service_provider_credentials
  add constraint service_provider_credentials_observada_coherente
  check (observed_at is null or (status = 'declared' and review_note is not null));

-- 3.3 Retirarse es ANTES DE LA DECISIÓN. La 0087 permite `under_review →
-- withdrawn`, y una aprobada que se suspende vuelve a `under_review` para
-- investigarse: sin esto, retirarla sería salir de la investigación por la
-- puerta de atrás. `decided_at` solo lo escriben la aprobación y el rechazo.
-- Nombre nuevo: no sustituye ninguna restricción de la 0086 ni de la 0087.
alter table public.service_provider_applications
  drop constraint if exists service_provider_applications_retirada_antes_de_decidir;
alter table public.service_provider_applications
  add constraint service_provider_applications_retirada_antes_de_decidir
  check (status <> 'withdrawn' or decided_at is null);

-- ------------------------------------------------------------------------- --
-- 4. Lo que se pidió corregir, en el historial.
-- ------------------------------------------------------------------------- --
--
-- Una columna nueva con valor por defecto: ninguna fila existente se reescribe
-- y el disparador de solo añadir no se activa. Su forma (`{"fields": [...]}`)
-- la valida el código.
alter table public.service_provider_application_events
  add column if not exists details jsonb not null default '{}'::jsonb;

-- ------------------------------------------------------------------------- --
-- 5. Cada envío, congelado. SOLO SE AÑADE.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_provider_application_submissions (
  id uuid primary key default gen_random_uuid(),

  application_id uuid not null
    references public.service_provider_applications(id) on delete cascade,

  -- EL PRIMER ENVÍO es el 1; cada reenvío, el siguiente.
  sequence integer not null
    constraint service_provider_application_submissions_secuencia
    check (sequence >= 1),

  kind text not null
    constraint service_provider_application_submissions_tipo
    check (kind in ('submitted', 'resubmitted')),

  -- LAS CONDICIONES QUE ACEPTÓ, congeladas: versión y huella del texto.
  terms_policy_id uuid not null
    references public.service_policies(id) on delete restrict,
  terms_version integer not null
    constraint service_provider_application_submissions_version
    check (terms_version >= 1),
  terms_sha256 text not null
    constraint service_provider_application_submissions_huella_de_terminos
    check (length(terms_sha256) = 64 and ltrim(terms_sha256, '0123456789abcdef') = ''),

  -- LO QUE SE ENVIÓ. Datos, documentos (sin rutas) y credenciales (solo
  -- enmascaradas). Y su huella, para demostrar que no se tocó.
  snapshot jsonb not null,
  snapshot_sha256 text not null
    constraint service_provider_application_submissions_huella_del_envio
    check (length(snapshot_sha256) = 64 and ltrim(snapshot_sha256, '0123456789abcdef') = ''),

  -- SIN CLAVE AJENA: quién envió sobrevive a la cuenta, como en el historial.
  submitted_by uuid,

  created_at timestamptz not null default now(),

  constraint service_provider_application_submissions_una_por_secuencia
    unique (application_id, sequence)
);

create index if not exists service_provider_application_submissions_de_la_postulacion
  on public.service_provider_application_submissions (application_id, sequence desc);

drop trigger if exists service_provider_application_submissions_inmutables
  on public.service_provider_application_submissions;
create trigger service_provider_application_submissions_inmutables
  before update on public.service_provider_application_submissions
  for each row
  execute function public.servicios_historial_inmutable();

drop trigger if exists service_provider_application_submissions_solo_en_cascada
  on public.service_provider_application_submissions;
create trigger service_provider_application_submissions_solo_en_cascada
  before delete on public.service_provider_application_submissions
  for each row
  execute function public.servicios_borrado_solo_en_cascada(
    'service_provider_applications', 'application_id'
  );

-- ------------------------------------------------------------------------- --
-- 6. Postulación y prestador coinciden, comprobado al confirmar.
-- ------------------------------------------------------------------------- --
--
-- DIFERIDO a propósito: una aprobación actualiza la postulación y el
-- prestador en la misma transacción, en dos sentencias. Se comprueba al final,
-- cuando las dos están escritas. Solo en altas y cambios: el borrado de la
-- cuenta cae en cascada y no hay nada que comprobar.
create or replace function public.servicios_prestador_coherente()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  prestador uuid;
  estado_del_prestador text;
  estado_actual text;
begin
  if tg_table_name = 'service_providers' then
    prestador := new.id;
  else
    prestador := new.provider_id;
  end if;

  select status into estado_del_prestador
    from public.service_providers where id = prestador;
  if not found then
    return null;
  end if;

  -- LA POSTULACIÓN ACTUAL: la viva si la hay; si no, la última.
  select a.status into estado_actual
    from public.service_provider_applications a
   where a.provider_id = prestador
   order by (a.status in ('rejected', 'withdrawn')), a.created_at desc, a.id desc
   limit 1;

  if (estado_actual = 'approved' and estado_del_prestador <> 'active')
     or (estado_actual = 'suspended' and estado_del_prestador <> 'suspended')
     or (coalesce(estado_actual, '') <> 'approved' and estado_del_prestador = 'active')
  then
    raise exception 'La postulación (%) y el prestador (%) no coinciden',
      coalesce(estado_actual, 'ninguna'), estado_del_prestador
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists service_provider_applications_prestador_coherente
  on public.service_provider_applications;
create constraint trigger service_provider_applications_prestador_coherente
  after insert or update on public.service_provider_applications
  deferrable initially deferred
  for each row
  execute function public.servicios_prestador_coherente();

drop trigger if exists service_providers_coherente_con_su_postulacion
  on public.service_providers;
create constraint trigger service_providers_coherente_con_su_postulacion
  after insert or update on public.service_providers
  deferrable initially deferred
  for each row
  execute function public.servicios_prestador_coherente();

-- ------------------------------------------------------------------------- --
-- 7. RLS y permisos: cerrado, como el resto de Servicios.
-- ------------------------------------------------------------------------- --
alter table public.service_provider_application_submissions enable row level security;
revoke all on public.service_provider_application_submissions from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 8. Verificación.
-- ------------------------------------------------------------------------- --
do $$
declare
  tablas text[] := array[
    'service_policies', 'service_providers', 'service_provider_applications',
    'service_provider_documents', 'service_provider_credentials',
    'service_provider_application_events', 'service_provider_application_submissions'
  ];
  permisos bigint;
  politicas bigint;
  disparadores bigint;
begin
  if not exists (
    select 1 from storage.buckets
     where id = 'service-provider-documents' and public = false
       and file_size_limit = 10485760
  ) then
    raise exception 'La 0088 no dejó el depósito privado de documentos';
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any (tablas) and not c.relrowsecurity
  ) then
    raise exception 'La 0088 dejó una tabla de Servicios sin RLS';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public' and table_name = any (tablas)
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Servicios tiene % permisos sueltos', permisos;
  end if;

  select count(*) into politicas
    from pg_policies where schemaname = 'public' and tablename = any (tablas);
  if politicas > 0 then
    raise exception 'Servicios tiene % políticas RLS; debe tener cero', politicas;
  end if;

  select count(*) into disparadores
    from pg_trigger
   where not tgisinternal
     and tgname in (
       'service_provider_application_submissions_inmutables',
       'service_provider_application_submissions_solo_en_cascada',
       'service_provider_applications_prestador_coherente',
       'service_providers_coherente_con_su_postulacion'
     );
  if disparadores <> 4 then
    raise exception 'La 0088 dejó % de sus 4 disparadores', disparadores;
  end if;
end;
$$;

commit;
