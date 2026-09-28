-- 0087 · Z Servicios: el estado `withdrawn` (la postulación retirada por quien
--        postula).
--
-- SIN APLICAR. Escrita el 28/09/2026 y probada solo contra PostgreSQL local:
-- desde cero (0001–0087) y sobre una base que ya tenía la 0086
-- (`tests/test_servicios_migracion_0087.py`). Requiere la 0086, que YA está
-- aplicada en Supabase y verificada sin divergencias el 28/09/2026. La 0086 es
-- histórica: esta migración NO la edita.
--
-- LA REGLA DE NEGOCIO (aprobada el 28/09/2026):
--
--   * Solo la ejecuta EL PRESTADOR DUEÑO. Administración no retira en su
--     nombre: Z rechaza o suspende, que son otra cosa.
--   * Desde `draft`, `submitted`, `under_review`, `changes_requested` y
--     `resubmitted`. NUNCA desde `approved`, `rejected`, `suspended` ni
--     `withdrawn`: dejar de operar tras ser aprobado es otro flujo (baja del
--     prestador), no una retirada.
--   * Es FINAL y LIBERA EL HUECO de la postulación viva: se puede volver a
--     postular con una postulación nueva e independiente.
--   * Conserva documentos, credenciales e historial. El motivo, si lo hay, va
--     en la nota visible del evento del historial; la fecha y el actor, en el
--     propio evento.
--
-- QUÉ HACE, EN UNA ÚNICA TRANSACCIÓN (`begin` … `commit`): si algo falla, no
-- cambia nada.
--
--   1. COMPRUEBA que existen los objetos de la 0086 que va a sustituir. Sin
--      ellos, se detiene sin tocar nada.
--   2. SUSTITUYE, CON LOS MISMOS NOMBRES, solo lo que tiene que ampliarse para
--      admitir `withdrawn`. Cada protección se conserva tal cual para los
--      estados que ya existían; lo único nuevo es `withdrawn`:
--        - CHECK `service_provider_applications_estado`: + `withdrawn`.
--        - CHECK `service_provider_applications_enviada_completa`: un borrador
--          retirado no tiene por qué estar completo; cualquier otro estado
--          fuera de `draft` sigue exigiendo lo mismo.
--        - CHECK `service_provider_application_events_desde` y `_hasta`:
--          + `withdrawn`.
--        - CHECK `service_provider_application_events_salto_permitido`: los
--          diez saltos de antes + los cinco hacia `withdrawn`.
--        - Función `service_provider_applications_salto_valido()`: los mismos
--          saltos + los cinco hacia `withdrawn`. El disparador que la llama no
--          se toca.
--        - Índice `service_provider_applications_una_viva`: `withdrawn` libera
--          el hueco, igual que `rejected`.
--   3. AÑADE protecciones nuevas:
--        - CHECK `service_provider_application_events_retira_el_prestador`: un
--          evento hacia `withdrawn` lo firma siempre `provider`.
--        - Disparador `service_provider_application_events_retirada_propia`: y
--          ese `provider` es EL DUEÑO de la postulación.
--   4. VERIFICA el resultado.
--
-- ADITIVA: no elimina tablas, columnas ni datos. Ninguna fila cambia.
--
-- REEJECUTABLE: todo se sustituye por nombre (`drop … if exists` + `add` /
-- `create`, y `create or replace`). Volver a pegarla entera deja lo mismo.
--
-- OJO SI ALGUIEN VUELVE A EJECUTAR LA 0086 DESPUÉS DE ESTA: la 0086 reescribe
-- la función de saltos con su versión de ocho estados. Hay que volver a
-- ejecutar esta 0087 a continuación. (No debería pasar: la 0086 está aplicada
-- y no se vuelve a aplicar.)
--
-- ROLLBACK (solo sin filas en `withdrawn`): volver a ejecutar las secciones
-- 2.x con las definiciones de la 0086, y
--   drop trigger service_provider_application_events_retirada_propia
--     on public.service_provider_application_events;
--   drop function public.service_provider_application_events_retirada_propia();
--   alter table public.service_provider_application_events
--     drop constraint service_provider_application_events_retira_el_prestador;

begin;

-- ------------------------------------------------------------------------- --
-- 1. Lo que la 0086 tiene que haber dejado.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
begin
  select string_agg(esperado, ', ') into faltan
    from (values
      ('service_provider_applications', 'service_provider_applications_estado'),
      ('service_provider_applications', 'service_provider_applications_enviada_completa'),
      ('service_provider_application_events', 'service_provider_application_events_desde'),
      ('service_provider_application_events', 'service_provider_application_events_hasta'),
      ('service_provider_application_events', 'service_provider_application_events_salto_permitido')
    ) as e(tabla, esperado)
   where to_regclass('public.' || e.tabla) is null
      or not exists (
        select 1 from pg_constraint c
         where c.conrelid = to_regclass('public.' || e.tabla)
           and c.conname = e.esperado
           and c.contype = 'c'
      );
  if faltan is not null then
    raise exception 'La 0087 requiere la 0086: faltan las restricciones %', faltan;
  end if;

  if to_regclass('public.service_provider_applications_una_viva') is null then
    raise exception 'La 0087 requiere la 0086: falta el índice service_provider_applications_una_viva';
  end if;

  if to_regprocedure('public.service_provider_applications_salto_valido()') is null then
    raise exception 'La 0087 requiere la 0086: falta la función service_provider_applications_salto_valido()';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.service_provider_applications'::regclass
       and tgname = 'service_provider_applications_saltos'
       and not tgisinternal
  ) then
    raise exception 'La 0087 requiere la 0086: falta el disparador service_provider_applications_saltos';
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. Lo que se amplía para admitir `withdrawn`. MISMOS NOMBRES.
-- ------------------------------------------------------------------------- --

-- 2.1 Los estados de la postulación: los ocho + `withdrawn`.
alter table public.service_provider_applications
  drop constraint if exists service_provider_applications_estado;
alter table public.service_provider_applications
  add constraint service_provider_applications_estado
  check (status in (
    'draft', 'submitted', 'under_review', 'changes_requested',
    'resubmitted', 'approved', 'rejected', 'suspended', 'withdrawn'
  ));

-- 2.2 Completa fuera de borrador. IGUAL que en la 0086 para todos los estados
-- que ya existían; `withdrawn` queda fuera porque se puede retirar un borrador.
alter table public.service_provider_applications
  drop constraint if exists service_provider_applications_enviada_completa;
alter table public.service_provider_applications
  add constraint service_provider_applications_enviada_completa
  check (
    status in ('draft', 'withdrawn')
    or (
      summary is not null
      and submitted_at is not null
      and last_submitted_at is not null
      and terms_policy_id is not null
      and terms_sha256 is not null
      and terms_accepted_at is not null
      and truthfulness_declared_at is not null
    )
  );

-- 2.3 Los estados del historial.
alter table public.service_provider_application_events
  drop constraint if exists service_provider_application_events_desde;
alter table public.service_provider_application_events
  add constraint service_provider_application_events_desde
  check (from_status is null or from_status in (
    'draft', 'submitted', 'under_review', 'changes_requested',
    'resubmitted', 'approved', 'rejected', 'suspended', 'withdrawn'
  ));

alter table public.service_provider_application_events
  drop constraint if exists service_provider_application_events_hasta;
alter table public.service_provider_application_events
  add constraint service_provider_application_events_hasta
  check (to_status in (
    'draft', 'submitted', 'under_review', 'changes_requested',
    'resubmitted', 'approved', 'rejected', 'suspended', 'withdrawn'
  ));

-- 2.4 Los saltos del historial: los diez de la 0086 + los cinco de retirada.
alter table public.service_provider_application_events
  drop constraint if exists service_provider_application_events_salto_permitido;
alter table public.service_provider_application_events
  add constraint service_provider_application_events_salto_permitido
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
    or (from_status = 'draft' and to_status = 'withdrawn')
    or (from_status = 'submitted' and to_status = 'withdrawn')
    or (from_status = 'under_review' and to_status = 'withdrawn')
    or (from_status = 'changes_requested' and to_status = 'withdrawn')
    or (from_status = 'resubmitted' and to_status = 'withdrawn')
  );

-- 2.5 La función de saltos de la postulación. Todo lo de la 0086 igual —nacer
-- en borrador, no cambiar de prestador— más los cinco saltos de retirada.
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
    or (old.status = 'draft' and new.status = 'withdrawn')
    or (old.status = 'submitted' and new.status = 'withdrawn')
    or (old.status = 'under_review' and new.status = 'withdrawn')
    or (old.status = 'changes_requested' and new.status = 'withdrawn')
    or (old.status = 'resubmitted' and new.status = 'withdrawn')
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

-- 2.6 Una viva por prestador: retirarse libera el hueco, igual que un rechazo.
drop index if exists public.service_provider_applications_una_viva;
create unique index service_provider_applications_una_viva
  on public.service_provider_applications (provider_id)
  where status not in ('rejected', 'withdrawn');

-- ------------------------------------------------------------------------- --
-- 3. Protecciones nuevas de la retirada.
-- ------------------------------------------------------------------------- --

-- 3.1 Un evento hacia `withdrawn` lo firma quien postula, nunca Z.
alter table public.service_provider_application_events
  drop constraint if exists service_provider_application_events_retira_el_prestador;
alter table public.service_provider_application_events
  add constraint service_provider_application_events_retira_el_prestador
  check (to_status <> 'withdrawn' or actor_role = 'provider');

-- 3.2 Y quien lo firma es EL DUEÑO de la postulación, con su identidad.
create or replace function public.service_provider_application_events_retirada_propia()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  dueno uuid;
begin
  if new.to_status <> 'withdrawn' then
    return new;
  end if;
  select p.profile_id into dueno
    from public.service_provider_applications a
    join public.service_providers p on p.id = a.provider_id
   where a.id = new.application_id;
  if new.actor_id is null or dueno is null or new.actor_id <> dueno then
    raise exception 'Solo quien postula retira su propia postulación'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists service_provider_application_events_retirada_propia
  on public.service_provider_application_events;
create trigger service_provider_application_events_retirada_propia
  before insert on public.service_provider_application_events
  for each row
  execute function public.service_provider_application_events_retirada_propia();

-- La tabla ya tiene RLS y cero privilegios (0086); esta migración no crea
-- tablas ni concede nada.

-- ------------------------------------------------------------------------- --
-- 4. Verificación.
-- ------------------------------------------------------------------------- --
do $$
declare
  definicion text;
  permisos bigint;
begin
  select pg_get_constraintdef(oid) into definicion
    from pg_constraint
   where conrelid = 'public.service_provider_applications'::regclass
     and conname = 'service_provider_applications_estado';
  if definicion is null or position('withdrawn' in definicion) = 0 then
    raise exception 'La 0087 no dejó `withdrawn` en los estados de la postulación';
  end if;

  select pg_get_constraintdef(oid) into definicion
    from pg_constraint
   where conrelid = 'public.service_provider_application_events'::regclass
     and conname = 'service_provider_application_events_salto_permitido';
  if definicion is null or position('withdrawn' in definicion) = 0 then
    raise exception 'La 0087 no dejó los saltos de retirada en el historial';
  end if;

  select indexdef into definicion
    from pg_indexes
   where schemaname = 'public' and indexname = 'service_provider_applications_una_viva';
  if definicion is null or position('withdrawn' in definicion) = 0
     or position('UNIQUE' in definicion) = 0 then
    raise exception 'La 0087 no dejó el índice de postulación viva liberando `withdrawn`';
  end if;

  if position('withdrawn' in pg_get_functiondef(
       'public.service_provider_applications_salto_valido()'::regprocedure)) = 0 then
    raise exception 'La 0087 no dejó los saltos de retirada en la función';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.service_provider_application_events'::regclass
       and tgname = 'service_provider_application_events_retirada_propia'
       and not tgisinternal
  ) then
    raise exception 'La 0087 no dejó el disparador de retirada propia';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in ('service_provider_applications', 'service_provider_application_events')
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'La admisión de Servicios tiene % permisos sueltos', permisos;
  end if;
end;
$$;

commit;
