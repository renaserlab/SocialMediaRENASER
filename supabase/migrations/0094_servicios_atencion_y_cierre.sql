-- 0094 · Z Servicios, Incremento 6: atención, cancelación, reprogramación,
--        posventa y cierre operativo.
--
-- SIN APLICAR. Escrita el 30/09/2026, corregida el 01/10 tras la revisión
-- independiente (el caso retirado) y probada solo contra PostgreSQL local:
-- desde cero (0001–0094), sobre una base con la 0093 vacía y con reservas,
-- reejecutada, con un fallo a mitad y sin cada una de sus dependencias
-- (`tests/test_servicios_migracion_0094.py`). Requiere la 0086–0093, ya
-- aplicadas en Supabase. Al aplicarla, REINICIAR LA API: la puerta de la
-- atención recuerda el «no».
--
-- QUÉ AÑADE (cuatro tablas, y ninguna más):
--
--   service_attendances      LA ATENCIÓN de una reserva: el código de
--                            asistencia, el inicio, el fin, la confirmación de
--                            quien contrata, el cierre y la inasistencia.
--   service_incidents        EL CASO: uno por reserva, sin contar los
--                            retirados. El motivo, su estado, lo que se
--                            resolvió y el efecto económico SOLICITADO.
--   service_incident_entries EL EXPEDIENTE: mensajes, evidencias privadas,
--                            resoluciones y la apelación. Solo se añade.
--   service_reviews          LA RESEÑA VERIFICADA: una por reserva, y solo de
--                            una atención cerrada. Con la respuesta del
--                            prestador y su estado de moderación.
--
-- No hay tabla de cancelaciones, de reprogramaciones ni de efectos
-- financieros: cancelar y reprogramar son un cambio CONTROLADO de la reserva
-- más su línea en `service_booking_events`, y el efecto económico son dos
-- columnas del caso.
--
-- QUÉ CAMBIA DE LA 0093, y nada más (ninguna columna nueva en sus tablas):
--
--   * tres CHECK se amplían: el estado de la reserva admite `cancelled`, y el
--     historial admite las acciones y los roles (`provider`, `admin`) de este
--     incremento;
--   * `servicios_reserva_inmutable()`: una reserva sigue sin reescribirse,
--     salvo dos cambios y solo si la atención no empezó: CANCELARLA (cambia el
--     estado y nada más) y REPROGRAMARLA (cambia su retención y su horario y
--     nada más; la duración es la del contrato);
--   * `servicios_retencion_salto_valido()`: una retención consumida se LIBERA
--     cuando ya no hay una reserva confirmada sobre ella (se canceló o se
--     movió a otro horario);
--   * un disparador diferido nuevo en `service_bookings`: al confirmar la
--     transacción, una reserva cancelada NO sigue ocupando su horario y una
--     reprogramada NO sigue ocupando el anterior (y la confirmada casa con su
--     retención consumida, como en la 0093).
--
-- EL DINERO NO EXISTE AQUÍ. El efecto económico de un caso es una SOLICITUD
-- con su estado: `not_applicable`, `pending` o `blocked`. La base no admite
-- ningún estado que diga que se ejecutó. Un pedido sigue pudiendo ser solo
-- gratuito (0093).
--
-- LA RESEÑA ES VERIFICADA POR LA BASE: no se guarda sin una atención cerrada
-- de esa misma reserva, escrita por quien la contrató.
--
-- DE PASO se cierra un permiso de la 0086: `servicios_borrado_solo_en_cascada()`
-- era ejecutable por PUBLIC. Era inocuo (una función de disparador no se puede
-- llamar directamente), pero no hacía falta.
--
-- RLS activa, CERO políticas y CERO privilegios para `anon` y `authenticated`:
-- solo la API. El depósito de las evidencias es privado y sin políticas.
--
-- UNA ÚNICA TRANSACCIÓN, que primero comprueba lo anterior y al final
-- verifica lo que dejó. REEJECUTABLE.
--
-- ROLLBACK. SOLO SI NO HAY DATOS REALES: el bloque se niega a seguir si
-- alguna tabla tiene filas, si hay una reserva cancelada o si el historial ya
-- tiene acciones de este incremento. Con datos, lo que se hace es apagar
-- `FEATURE_SERVICE_BOOKING`, no borrar.
--   begin;
--   do $$ begin
--     if exists (select 1 from public.service_attendances)
--        or exists (select 1 from public.service_incidents)
--        or exists (select 1 from public.service_reviews)
--        or exists (select 1 from public.service_bookings where status <> 'confirmed')
--        or exists (select 1 from public.service_booking_events
--                    where action not in ('hold_created', 'hold_released', 'hold_expired', 'booking_confirmed')
--                       or actor_role not in ('client', 'system')) then
--       raise exception 'Hay datos de la atención: la 0094 no se deshace';
--     end if;
--   end $$;
--   drop trigger service_bookings_coherentes_al_cambiar on public.service_bookings;
--   drop table public.service_reviews, public.service_incident_entries,
--              public.service_incidents, public.service_attendances;
--   drop function public.servicios_reserva_coherente_al_cambiar(),
--                 public.servicios_atencion_salto_valido(),
--                 public.servicios_incidencia_salto_valido(),
--                 public.servicios_resena_verificada();
--   alter table public.service_bookings drop constraint service_bookings_estado,
--     add constraint service_bookings_estado check (status in ('confirmed'));
--   alter table public.service_booking_events drop constraint service_booking_events_accion,
--     add constraint service_booking_events_accion
--       check (action in ('hold_created', 'hold_released', 'hold_expired', 'booking_confirmed'));
--   alter table public.service_booking_events drop constraint service_booking_events_rol,
--     add constraint service_booking_events_rol check (actor_role in ('client', 'system'));
--   delete from storage.buckets where id = 'service-incident-evidence';
--   commit;
-- Y DESPUÉS, reejecutar la 0093 entera: devuelve a sus dos funciones el cuerpo
-- de la 0093 (es reejecutable y no toca datos). Y REINICIAR LA API.
-- (Si Supabase rechaza el `delete from storage.buckets` —sus versiones
-- recientes protegen esas tablas—, quitar esa línea del bloque y borrar el
-- depósito, ya vacío, desde el panel de Storage. No probado contra Supabase.)

begin;

-- ------------------------------------------------------------------------- --
-- 1. Lo que tiene que haber.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array[
      'services', 'service_providers', 'profiles', 'service_holds', 'service_orders',
      'service_bookings', 'service_booking_events'
    ]) t
   where to_regclass('public.' || t) is null;
  if faltan is not null then
    raise exception 'La 0094 requiere la 0086–0093 aplicadas: faltan %', faltan;
  end if;

  select string_agg(f, ', ') into faltan
    from unnest(array[
      'public.servicios_borrado_solo_en_cascada()', 'public.servicios_catalogo_historial_inmutable()',
      'public.es_anonimizacion_por_baja(jsonb, jsonb, text[])', 'public.servicios_reserva_inmutable()',
      'public.servicios_retencion_salto_valido()'
    ]) f
   where to_regprocedure(f) is null;
  if faltan is not null then
    raise exception 'La 0094 requiere las funciones de la 0086, la 0089, la 0090 y la 0093: faltan %', faltan;
  end if;

  select string_agg(c, ', ') into faltan
    from unnest(array[
      'service_bookings_estado', 'service_booking_events_accion', 'service_booking_events_rol'
    ]) c
   where not exists (select 1 from pg_catalog.pg_constraint k where k.conname = c and k.contype = 'c');
  if faltan is not null then
    raise exception 'La 0094 requiere los CHECK de la 0093: faltan %', faltan;
  end if;

  if to_regclass('storage.buckets') is null then
    raise exception 'La 0094 requiere storage.buckets (el depósito privado de las evidencias)';
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. Lo que se amplía de la 0093: tres CHECK.
-- ------------------------------------------------------------------------- --
alter table public.service_bookings drop constraint if exists service_bookings_estado;
alter table public.service_bookings
  add constraint service_bookings_estado
  check (status in ('confirmed', 'cancelled'));

alter table public.service_booking_events drop constraint if exists service_booking_events_accion;
alter table public.service_booking_events
  add constraint service_booking_events_accion
  check (action in (
    'hold_created', 'hold_released', 'hold_expired', 'booking_confirmed',
    'booking_cancelled', 'booking_rescheduled', 'booking_reminded',
    'attendance_code_issued', 'attendance_started', 'attendance_completed',
    'attendance_confirmed', 'attendance_closed', 'no_show_reported',
    'incident_opened', 'incident_entry_added', 'incident_withdrawn',
    'incident_resolved', 'incident_appealed',
    'review_created', 'review_replied', 'review_moderated'
  ));

alter table public.service_booking_events drop constraint if exists service_booking_events_rol;
alter table public.service_booking_events
  add constraint service_booking_events_rol
  check (actor_role in ('client', 'system', 'provider', 'admin'));

-- ------------------------------------------------------------------------- --
-- 3. La atención.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_attendances (
  booking_id uuid primary key
    references public.service_bookings(id) on delete cascade,
  status text not null
    constraint service_attendances_estado
    check (status in ('code_issued', 'in_progress', 'completed', 'closed', 'no_show_client', 'no_show_provider')),
  -- El código que quien contrata enseña y el prestador escribe: seis cifras.
  checkin_code text
    constraint service_attendances_codigo
    check (checkin_code is null or (length(checkin_code) = 6 and ltrim(checkin_code, '0123456789') = '')),
  checkin_attempts integer not null default 0
    constraint service_attendances_intentos
    check (checkin_attempts between 0 and 5),
  started_at timestamptz,
  -- LA SEÑAL FUERTE: empezó con el código de quien contrata.
  started_with_code boolean not null default false,
  completed_at timestamptz,
  -- Quien contrata confirmó que se realizó.
  confirmed_at timestamptz,
  closed_at timestamptz,
  closed_by text
    constraint service_attendances_cierre_de
    check (closed_by is null or closed_by in ('client', 'system', 'admin')),
  no_show_reported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint service_attendances_cierre
    check ((status = 'closed') = (closed_at is not null) and (closed_at is null) = (closed_by is null)),
  constraint service_attendances_inicio
    check (
      (status not in ('in_progress', 'completed') or started_at is not null)
      and (not started_with_code or started_at is not null)
      and (status <> 'completed' or completed_at is not null)
    ),
  constraint service_attendances_ausencia
    check (status not in ('no_show_client', 'no_show_provider') or no_show_reported_at is not null)
);

-- Las terminadas que esperan a quien contrata (lo que mira el barrido).
create index if not exists service_attendances_por_cerrar
  on public.service_attendances (completed_at)
  where status = 'completed';

-- ------------------------------------------------------------------------- --
-- 4. El caso: uno por reserva, sin contar los retirados.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_incidents (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null
    references public.service_bookings(id) on delete cascade,
  -- SIN CLAVE AJENA a propósito (0086, S10): la historia sobrevive a la cuenta.
  opened_by uuid,
  reason text not null
    constraint service_incidents_motivo
    check (reason in (
      'provider_absent', 'client_absent', 'incomplete', 'different_service',
      'quality', 'safety', 'technical', 'other'
    )),
  description text not null
    constraint service_incidents_descripcion
    check (length(trim(description)) between 20 and 2000),
  status text not null default 'open'
    constraint service_incidents_estado
    check (status in ('open', 'resolved', 'appealed', 'closed', 'withdrawn')),
  -- LO QUE SE DECIDIÓ (lo vigente; cada resolución queda en el expediente).
  outcome text
    constraint service_incidents_resultado
    check (outcome is null or outcome in ('upheld', 'partially_upheld', 'rejected')),
  attention_effect text
    constraint service_incidents_efecto_en_la_atencion
    check (attention_effect is null or attention_effect in ('none', 'completed', 'provider_no_show', 'client_no_show')),
  -- EL EFECTO ECONÓMICO es lo que se SOLICITA, y su estado. Ninguno dice
  -- que se ejecutó: eso solo lo podrá decir una pasarela.
  financial_effect text
    constraint service_incidents_efecto_economico
    check (financial_effect is null or financial_effect in ('none', 'full_refund', 'partial_refund')),
  financial_effect_status text
    constraint service_incidents_estado_del_efecto
    check (financial_effect_status is null or financial_effect_status in ('not_applicable', 'pending', 'blocked')),
  resolved_by uuid,
  resolved_at timestamptz,
  resolutions integer not null default 0
    constraint service_incidents_resoluciones
    check (resolutions between 0 and 2),
  appealed_by text
    constraint service_incidents_apela
    check (appealed_by is null or appealed_by in ('client', 'provider')),
  appealed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Resuelto significa resuelto del todo: resultado, efectos y momento.
  constraint service_incidents_resuelta
    check (
      (resolutions = 0) = (outcome is null)
      and (outcome is null) = (resolved_at is null)
      and (outcome is null) = (attention_effect is null)
      and (outcome is null) = (financial_effect is null)
      and (outcome is null) = (financial_effect_status is null)
    ),
  constraint service_incidents_estado_y_resoluciones
    check (
      (status not in ('open', 'withdrawn') or resolutions = 0)
      and (status not in ('resolved', 'appealed') or resolutions = 1)
      and (status <> 'closed' or resolutions = 2)
    ),
  constraint service_incidents_apelacion
    check (
      (appealed_by is null) = (appealed_at is null)
      and (status <> 'appealed' or appealed_by is not null)
      and (resolutions < 2 or appealed_by is not null)
    ),
  -- Sin efecto solicitado no hay nada pendiente.
  constraint service_incidents_sin_efecto
    check (financial_effect is null or financial_effect <> 'none' or financial_effect_status = 'not_applicable')
);

create index if not exists service_incidents_por_estado
  on public.service_incidents (status, created_at desc, id desc);

-- UNO POR RESERVA, SIN CONTAR LOS RETIRADOS. Vivo o decidido, solo uno; pero
-- quien retira el suyo no le quita el suyo a la otra parte.
create unique index if not exists service_incidents_una_por_reserva
  on public.service_incidents (booking_id)
  where status <> 'withdrawn';

-- Todos los de una reserva (también los retirados), del último al primero.
create index if not exists service_incidents_de_la_reserva
  on public.service_incidents (booking_id, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 5. El expediente: solo se añade.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_incident_entries (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null
    references public.service_incidents(id) on delete cascade,
  author_id uuid,
  author_role text not null
    constraint service_incident_entries_rol
    check (author_role in ('client', 'provider', 'admin')),
  kind text not null
    constraint service_incident_entries_tipo
    check (kind in ('message', 'evidence', 'resolution', 'appeal', 'internal_note')),
  body text
    constraint service_incident_entries_texto
    check (body is null or length(trim(body)) between 1 and 2000),
  -- La evidencia: la ruta la genera el servidor, en el depósito privado.
  storage_path text
    constraint service_incident_entries_ruta
    check (storage_path is null or length(storage_path) between 10 and 300),
  content_type text,
  byte_size integer
    constraint service_incident_entries_peso
    check (byte_size is null or byte_size between 1 and 10485760),
  sha256 text
    constraint service_incident_entries_huella
    check (sha256 is null or (length(sha256) = 64 and ltrim(sha256, '0123456789abcdef') = '')),
  created_at timestamptz not null default now(),

  constraint service_incident_entries_forma
    check (
      (kind = 'evidence') = (storage_path is not null)
      and (storage_path is null) = (content_type is null)
      and (storage_path is null) = (byte_size is null)
      and (storage_path is null) = (sha256 is null)
      and (kind = 'evidence' or body is not null)
    ),
  -- La nota interna y la resolución son de administración; la apelación, de
  -- una de las partes.
  constraint service_incident_entries_quien
    check (
      (kind not in ('internal_note', 'resolution') or author_role = 'admin')
      and (kind <> 'appeal' or author_role in ('client', 'provider'))
    )
);

create index if not exists service_incident_entries_del_caso
  on public.service_incident_entries (incident_id, created_at, id);
-- El mismo archivo no entra dos veces en un caso.
create unique index if not exists service_incident_entries_un_archivo
  on public.service_incident_entries (incident_id, sha256)
  where sha256 is not null;

-- ------------------------------------------------------------------------- --
-- 6. La reseña verificada.
-- ------------------------------------------------------------------------- --
create table if not exists public.service_reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null
    references public.service_bookings(id) on delete cascade,
  -- NO BORRA NADA y se comprueba al confirmar: la reseña se va por UN camino,
  -- el de su reserva (como las claves al prestador de la 0093).
  service_id uuid not null
    references public.services(id) deferrable initially deferred,
  -- NULL solo tras la baja de la cuenta (0089).
  author_id uuid
    references public.profiles(id) on delete set null,
  rating integer not null
    constraint service_reviews_calificacion
    check (rating between 1 and 5),
  fulfillment integer
    constraint service_reviews_cumplimiento
    check (fulfillment is null or fulfillment between 1 and 5),
  quality integer
    constraint service_reviews_calidad
    check (quality is null or quality between 1 and 5),
  punctuality integer
    constraint service_reviews_puntualidad
    check (punctuality is null or punctuality between 1 and 5),
  clarity integer
    constraint service_reviews_claridad
    check (clarity is null or clarity between 1 and 5),
  recommends boolean not null,
  comment text not null
    constraint service_reviews_comentario
    check (length(trim(comment)) between 20 and 2000),
  status text not null
    constraint service_reviews_estado
    check (status in ('pending', 'published', 'hidden')),
  -- La respuesta pública del prestador: una.
  reply text
    constraint service_reviews_respuesta
    check (reply is null or length(trim(reply)) between 1 and 1000),
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint service_reviews_una_por_reserva unique (booking_id),
  constraint service_reviews_respondida
    check ((reply is null) = (replied_at is null))
);

create index if not exists service_reviews_del_servicio
  on public.service_reviews (service_id, status, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 7. Lo que ningún CHECK puede decir.
-- ------------------------------------------------------------------------- --
-- 7.1 LA RESERVA sigue sin reescribirse, salvo CANCELARLA o REPROGRAMARLA, y
--     solo si la atención no empezó. (Sustituye el cuerpo de la 0093.)
create or replace function public.servicios_reserva_inmutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  horario constant text[] := array[
    'hold_id', 'starts_at', 'ends_at', 'occupied_from', 'occupied_until', 'timezone', 'local_date',
    'buffer_before_minutes', 'buffer_after_minutes', 'capacity', 'seat'
  ];
begin
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['client_id']) then
    if old.status = 'confirmed' and old.ends_at > pg_catalog.now() then
      raise exception 'Hay una reserva de Servicios por venir: la cuenta no se borra todavía'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if old.status = 'confirmed' and (
       (new.status = 'cancelled' and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status'))
       or (new.status = 'confirmed' and new.hold_id <> old.hold_id
           and (to_jsonb(new) - horario) = (to_jsonb(old) - horario)
           and new.ends_at - new.starts_at = old.ends_at - old.starts_at)
     ) then
    if exists (
      select 1 from public.service_attendances a
       where a.booking_id = old.id and a.status <> 'code_issued'
    ) then
      raise exception 'Una atención que ya empezó no se cancela ni se reprograma'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  raise exception 'Una reserva no se reescribe'
    using errcode = 'restrict_violation';
end;
$$;

-- 7.2 UNA RETENCIÓN CONSUMIDA SE LIBERA cuando su reserva se canceló o se
--     movió a otro horario: nunca mientras una reserva confirmada dependa de
--     ella. (Sustituye el cuerpo de la 0093.)
create or replace function public.servicios_retencion_salto_valido()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  momentos constant text[] := array['status', 'updated_at', 'consumed_at', 'released_at', 'expired_at'];
begin
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['client_id']) then
    return new;
  end if;
  -- LO NUEVO: liberar lo que ocupaba una reserva que ya no depende de ella.
  if old.status = 'consumed' and new.status = 'released'
     and (to_jsonb(new) - momentos) is not distinct from (to_jsonb(old) - momentos) then
    if exists (
      select 1 from public.service_bookings b
       where b.hold_id = old.id and b.status = 'confirmed'
    ) then
      raise exception 'Una retención con su reserva confirmada no se libera'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- Lo demás, como en la 0093.
  if old.status <> 'active' then
    raise exception 'Una retención % ya no cambia', old.status
      using errcode = 'check_violation';
  end if;
  if new.status not in ('consumed', 'released', 'expired') then
    raise exception 'Salto de retención no permitido: active → %', new.status
      using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - momentos) is distinct from (to_jsonb(old) - momentos) then
    raise exception 'Una retención no se reescribe'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- 7.3 AL CONFIRMAR LA TRANSACCIÓN: una reserva cancelada no sigue ocupando su
--     horario, una reprogramada no sigue ocupando el anterior, y la
--     confirmada casa con su retención consumida y con su pedido.
create or replace function public.servicios_reserva_coherente_al_cambiar()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled' then
    if exists (
      select 1 from public.service_holds h
       where h.id = new.hold_id and h.status in ('active', 'consumed')
    ) then
      raise exception 'Una reserva cancelada no sigue ocupando su horario'
        using errcode = 'check_violation';
    end if;
    return null;
  end if;
  if not exists (
    select 1 from public.service_holds h
     where h.id = new.hold_id and h.status = 'consumed'
       and h.service_id = new.service_id and h.version_id = new.version_id
       and h.starts_at = new.starts_at and h.ends_at = new.ends_at
       and h.occupied_from = new.occupied_from and h.occupied_until = new.occupied_until
       and h.seat = new.seat and h.capacity = new.capacity
       and h.client_id is not distinct from new.client_id
  ) then
    raise exception 'Una reserva confirmada casa con su retención consumida'
      using errcode = 'check_violation';
  end if;
  if new.hold_id <> old.hold_id and exists (
    select 1 from public.service_holds h
     where h.id = old.hold_id and h.status in ('active', 'consumed')
  ) then
    raise exception 'Al reprogramar, el horario anterior se libera'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists service_bookings_coherentes_al_cambiar on public.service_bookings;
create constraint trigger service_bookings_coherentes_al_cambiar
  after update on public.service_bookings
  deferrable initially deferred
  for each row
  execute function public.servicios_reserva_coherente_al_cambiar();

-- 7.4 LOS SALTOS DE LA ATENCIÓN. Nace de una reserva confirmada; `closed` es
--     final; de una reserva no se cambia.
create or replace function public.servicios_atencion_salto_valido()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.service_bookings b
       where b.id = new.booking_id and b.status = 'confirmed'
    ) then
      raise exception 'La atención es de una reserva confirmada'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.booking_id <> old.booking_id or new.created_at <> old.created_at then
    raise exception 'La atención no cambia de reserva'
      using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not (
       (old.status = 'code_issued' and new.status in ('in_progress', 'closed', 'no_show_client', 'no_show_provider'))
       or (old.status = 'in_progress' and new.status in ('completed', 'closed', 'no_show_client', 'no_show_provider'))
       or (old.status = 'completed' and new.status in ('closed', 'no_show_client', 'no_show_provider'))
       or (old.status = 'no_show_client' and new.status in ('closed', 'no_show_provider'))
       or (old.status = 'no_show_provider' and new.status in ('closed', 'no_show_client'))
     ) then
    raise exception 'Salto de atención no permitido: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists service_attendances_salto_valido on public.service_attendances;
create trigger service_attendances_salto_valido
  before insert or update on public.service_attendances
  for each row
  execute function public.servicios_atencion_salto_valido();

-- 7.5 LOS SALTOS DE UN CASO. Lo que se abrió no se reescribe; `closed` y
--     `withdrawn` son finales; nunca se resuelve hacia atrás.
create or replace function public.servicios_incidencia_salto_valido()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if (new.booking_id, new.opened_by, new.reason, new.description, new.created_at)
     is distinct from (old.booking_id, old.opened_by, old.reason, old.description, old.created_at) then
    raise exception 'Lo que abrió el caso no se reescribe'
      using errcode = 'check_violation';
  end if;
  if new.resolutions < old.resolutions then
    raise exception 'Una resolución no se borra'
      using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not (
       (old.status = 'open' and new.status in ('resolved', 'withdrawn'))
       or (old.status = 'resolved' and new.status = 'appealed')
       or (old.status = 'appealed' and new.status = 'closed')
     ) then
    raise exception 'Salto de caso no permitido: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists service_incidents_salto_valido on public.service_incidents;
create trigger service_incidents_salto_valido
  before update on public.service_incidents
  for each row
  execute function public.servicios_incidencia_salto_valido();

-- 7.6 LA RESEÑA ES VERIFICADA: de una atención CERRADA de esa reserva, de
--     quien la contrató. Después solo cambian su estado (moderación) y la
--     respuesta del prestador, que se escribe una vez.
create or replace function public.servicios_resena_verificada()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  cambia constant text[] := array['status', 'reply', 'replied_at', 'updated_at'];
begin
  if tg_op = 'INSERT' then
    if new.author_id is null or new.status = 'hidden' or new.reply is not null or not exists (
      select 1 from public.service_bookings b
        join public.service_attendances a on a.booking_id = b.id
       where b.id = new.booking_id and b.service_id = new.service_id
         and b.client_id = new.author_id and a.status = 'closed'
    ) then
      raise exception 'Una reseña es de una atención cerrada, de quien la contrató'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['author_id']) then
    return new;
  end if;
  if (to_jsonb(new) - cambia) is distinct from (to_jsonb(old) - cambia) then
    raise exception 'Una reseña no se reescribe'
      using errcode = 'check_violation';
  end if;
  if old.reply is not null and new.reply is distinct from old.reply then
    raise exception 'La respuesta a una reseña se escribe una vez'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists service_reviews_verificadas on public.service_reviews;
create trigger service_reviews_verificadas
  before insert or update on public.service_reviews
  for each row
  execute function public.servicios_resena_verificada();

-- 7.7 EL EXPEDIENTE NO SE REESCRIBE (la función de la 0090).
drop trigger if exists service_incident_entries_inmutables on public.service_incident_entries;
create trigger service_incident_entries_inmutables
  before update on public.service_incident_entries
  for each row
  execute function public.servicios_catalogo_historial_inmutable();

-- 7.8 NADA SE BORRA SUELTO: solo en cascada desde la reserva (o el caso).
drop trigger if exists service_attendances_solo_en_cascada on public.service_attendances;
create trigger service_attendances_solo_en_cascada
  before delete on public.service_attendances
  for each row
  execute function public.servicios_borrado_solo_en_cascada('service_bookings', 'booking_id');

drop trigger if exists service_incidents_solo_en_cascada on public.service_incidents;
create trigger service_incidents_solo_en_cascada
  before delete on public.service_incidents
  for each row
  execute function public.servicios_borrado_solo_en_cascada('service_bookings', 'booking_id');

drop trigger if exists service_incident_entries_solo_en_cascada on public.service_incident_entries;
create trigger service_incident_entries_solo_en_cascada
  before delete on public.service_incident_entries
  for each row
  execute function public.servicios_borrado_solo_en_cascada('service_incidents', 'incident_id');

drop trigger if exists service_reviews_solo_en_cascada on public.service_reviews;
create trigger service_reviews_solo_en_cascada
  before delete on public.service_reviews
  for each row
  execute function public.servicios_borrado_solo_en_cascada('service_bookings', 'booking_id');

-- ------------------------------------------------------------------------- --
-- 8. El depósito privado de las evidencias de un caso.
-- ------------------------------------------------------------------------- --
insert into storage.buckets (id, name, public)
values ('service-incident-evidence', 'service-incident-evidence', false)
on conflict (id) do nothing;

update storage.buckets
set
  public = false,
  file_size_limit = 10::bigint * 1024 * 1024,
  allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
where id = 'service-incident-evidence';

-- ------------------------------------------------------------------------- --
-- 9. Cerradas: solo la API.
-- ------------------------------------------------------------------------- --
alter table public.service_attendances enable row level security;
alter table public.service_incidents enable row level security;
alter table public.service_incident_entries enable row level security;
alter table public.service_reviews enable row level security;

revoke all on public.service_attendances from anon, authenticated;
revoke all on public.service_incidents from anon, authenticated;
revoke all on public.service_incident_entries from anon, authenticated;
revoke all on public.service_reviews from anon, authenticated;

revoke all on function public.servicios_reserva_coherente_al_cambiar() from public, anon, authenticated;
revoke all on function public.servicios_atencion_salto_valido() from public, anon, authenticated;
revoke all on function public.servicios_incidencia_salto_valido() from public, anon, authenticated;
revoke all on function public.servicios_resena_verificada() from public, anon, authenticated;
-- De paso, la de la 0086 (ver la cabecera).
revoke all on function public.servicios_borrado_solo_en_cascada() from public, anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 10. Lo que tiene que quedar, o nada.
-- ------------------------------------------------------------------------- --
do $$
declare
  tablas constant text[] := array[
    'service_attendances', 'service_incidents', 'service_incident_entries', 'service_reviews'
  ];
  funciones constant text[] := array[
    'public.servicios_reserva_coherente_al_cambiar()', 'public.servicios_atencion_salto_valido()',
    'public.servicios_incidencia_salto_valido()', 'public.servicios_resena_verificada()',
    'public.servicios_reserva_inmutable()', 'public.servicios_retencion_salto_valido()',
    'public.servicios_borrado_solo_en_cascada()'
  ];
  t text;
begin
  foreach t in array tablas loop
    if to_regclass('public.' || t) is null then
      raise exception 'La 0094 no dejó %', t;
    end if;
    if not (select relrowsecurity from pg_catalog.pg_class where oid = to_regclass('public.' || t)) then
      raise exception '% sin RLS', t;
    end if;
    if exists (select 1 from pg_catalog.pg_policy where polrelid = to_regclass('public.' || t)) then
      raise exception '% tiene políticas', t;
    end if;
    if exists (
      select 1 from information_schema.table_privileges
       where table_schema = 'public' and table_name = t and grantee in ('anon', 'authenticated', 'PUBLIC')
    ) then
      raise exception '% tiene permisos sueltos', t;
    end if;
  end loop;

  foreach t in array funciones loop
    if exists (
      select 1 from pg_catalog.pg_roles r
       where r.rolname in ('anon', 'authenticated')
         and pg_catalog.has_function_privilege(r.oid, to_regprocedure(t), 'EXECUTE')
    ) then
      raise exception '% es ejecutable desde fuera', t;
    end if;
  end loop;

  if (select count(*) from pg_catalog.pg_trigger g
       where not g.tgisinternal and g.tgenabled in ('O', 'A')
         and g.tgrelid = any (array[
           'public.service_attendances'::regclass, 'public.service_incidents'::regclass,
           'public.service_incident_entries'::regclass, 'public.service_reviews'::regclass
         ])) <> 8 then
    raise exception 'La 0094 no dejó sus disparadores';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger g
     where g.tgname = 'service_bookings_coherentes_al_cambiar' and not g.tgisinternal
       and g.tgrelid = 'public.service_bookings'::regclass and g.tgdeferrable and g.tginitdeferred
  ) then
    raise exception 'La 0094 no dejó la comprobación al confirmar de la reserva';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conname = 'service_bookings_estado' and c.convalidated
       and c.conrelid = 'public.service_bookings'::regclass
       and pg_catalog.pg_get_constraintdef(c.oid) like '%cancelled%'
  ) or not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conname = 'service_booking_events_rol' and c.convalidated
       and c.conrelid = 'public.service_booking_events'::regclass
       and pg_catalog.pg_get_constraintdef(c.oid) like '%provider%'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%admin%'
  ) or not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conname = 'service_booking_events_accion' and c.convalidated
       and c.conrelid = 'public.service_booking_events'::regclass
       and pg_catalog.pg_get_constraintdef(c.oid) like '%review_moderated%'
  ) then
    raise exception 'La 0094 no amplió los CHECK de la reserva y de su historial';
  end if;

  -- Un caso por reserva sin contar los retirados: único, parcial y válido.
  if not exists (
    select 1 from pg_catalog.pg_index i
     where i.indexrelid = to_regclass('public.service_incidents_una_por_reserva')
       and i.indrelid = 'public.service_incidents'::regclass
       and i.indisunique and i.indisvalid
       and pg_catalog.pg_get_expr(i.indpred, i.indrelid) like '%withdrawn%'
  ) then
    raise exception 'La 0094 no dejó la unicidad del caso por reserva';
  end if;

  -- El efecto económico NUNCA puede decir que se ejecutó.
  if exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conname = 'service_incidents_estado_del_efecto'
       and (pg_catalog.pg_get_constraintdef(c.oid) like '%executed%'
            or pg_catalog.pg_get_constraintdef(c.oid) like '%confirmed%'
            or pg_catalog.pg_get_constraintdef(c.oid) like '%refunded%')
  ) then
    raise exception 'El efecto económico de un caso no admite un estado ejecutado';
  end if;

  if (select count(*) from pg_catalog.pg_constraint c
       where c.contype = 'f' and c.conrelid = any (array[
           'public.service_attendances'::regclass, 'public.service_incidents'::regclass,
           'public.service_incident_entries'::regclass, 'public.service_reviews'::regclass
         ])) <> 6 then
    raise exception 'La 0094 no dejó sus claves ajenas';
  end if;

  if not exists (
    select 1 from storage.buckets
     where id = 'service-incident-evidence' and public = false and file_size_limit = 10485760
  ) then
    raise exception 'La 0094 no dejó el depósito privado de las evidencias';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
