-- 0095 · Z Servicios: la política operativa de una reserva, congelada (G18).
--
-- SIN APLICAR. Escrita el 01/10/2026 y probada solo contra PostgreSQL local:
-- desde cero (0001–0095), sobre una base con la 0094 vacía y con reservas,
-- reejecutada, con un fallo a mitad y sin cada una de sus dependencias
-- (`tests/test_servicios_migracion_0095.py`). Requiere la 0086–0094, ya
-- aplicadas en Supabase. Al aplicarla, REINICIAR LA API: la puerta de la
-- reserva recuerda el «no».
--
-- EL ORDEN: PRIMERO ESTA MIGRACIÓN, DESPUÉS EL CÓDIGO. Un servidor con el
-- código nuevo y sin la 0095 contesta 503 en toda la reserva y, con la
-- contratación encendida, no ofrece horarios. Un servidor ANTERIOR que
-- confirmara reservas con la 0095 ya aplicada chocaría con su disparador (no
-- trae la fotografía): hoy no existe ninguno, el código de Servicios no está
-- desplegado y sus banderas están apagadas.
--
-- POR QUÉ. Una reserva ya congelaba el servicio, su versión, el horario, el
-- precio y lo aceptado. Los PLAZOS con los que después se decide qué se puede
-- hacer con ella (reprogramar, llegar, reportar una ausencia, confirmar,
-- abrir un caso, apelar, reseñar) se leían de la configuración del momento:
-- cambiarla cambiaba, hacia atrás, las reservas ya hechas. Desde aquí, cada
-- reserva guarda los suyos al confirmarse y solo se decide con esos.
--
-- QUÉ AÑADE, y nada más (ninguna tabla):
--
--   service_bookings.operating_policy          LA FOTOGRAFÍA: los nueve valores
--                                              vigentes al confirmar (jsonb).
--   service_bookings.operating_policy_version  la versión de su estructura (1).
--   service_bookings.operating_policy_sha256   su huella.
--
--   * cuatro CHECK: las tres columnas van juntas o ninguna; la versión es una
--     que la base conoce; la fotografía tiene exactamente sus claves, cada una
--     un entero dentro de sus cotas; y la huella es LA de esa fotografía (el
--     SHA-256 de su forma canónica, el mismo que calcula la API);
--   * `servicios_reserva_con_politica()` y su disparador: una reserva NUEVA
--     nace con su fotografía, o no nace.
--
-- LA FECHA DE CAPTURA es `confirmed_at`: la fotografía se escribe en el mismo
-- INSERT que la reserva.
--
-- INMUTABLE SIN NADA NUEVO. `servicios_reserva_inmutable()` (0093, con el
-- cuerpo de la 0094) ya rechaza todo cambio de una reserva que no sea
-- cancelarla o reprogramarla, y compara la fila ENTERA: las tres columnas
-- quedan protegidas por ese disparador. No se editan, no se vacían y no se
-- sustituyen. Por eso esta migración exige ese cuerpo exacto, y se niega si
-- no lo encuentra. Se van con su reserva, como el resto de la fila.
--
-- LAS RESERVAS QUE YA EXISTAN SE QUEDAN SIN FOTOGRAFÍA (las tres columnas en
-- NULL). No se les inventa una: nadie guardó con qué política se confirmaron.
-- Y NO PUEDEN GANARLA DESPUÉS: una reserva no se reescribe. La API las trata
-- como lo que son, anteriores a la 0095, y les aplica la política vigente,
-- como hasta ahora. La migración dice cuántas hay.
--
-- LOS VALORES SIGUEN SIENDO PROVISIONALES. Congelarlos no los decide: son los
-- de la «política operativa v1» del alcance, y la empresa puede cambiarlos.
-- El cambio valdrá para las reservas que se confirmen después.
--
-- NO TRAE DINERO, pasarela, permisos ni políticas. `service_bookings` sigue
-- con RLS activa, cero políticas y cero privilegios para `anon` y
-- `authenticated`: solo la API.
--
-- UNA ÚNICA TRANSACCIÓN, que primero comprueba lo anterior y al final
-- verifica lo que dejó. REEJECUTABLE.
--
-- NO SE DESHACE EN PRODUCCIÓN. Si algo falla después de aplicarla, se apaga
-- `FEATURE_SERVICE_BOOKING` y se corrige hacia delante, con otra migración
-- (`docs/Z_SERVICIOS_ARQUITECTURA.md`, §104).

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
      'profiles', 'service_providers', 'services', 'service_versions', 'service_schedules',
      'service_holds', 'service_orders', 'service_bookings', 'service_booking_events',
      'service_attendances', 'service_incidents', 'service_incident_entries', 'service_reviews'
    ]) t
   where to_regclass('public.' || t) is null;
  if faltan is not null then
    raise exception 'La 0095 requiere la 0086–0094 aplicadas: faltan %', faltan;
  end if;

  select string_agg(f, ', ') into faltan
    from unnest(array[
      'public.es_anonimizacion_por_baja(jsonb, jsonb, text[])', 'public.servicios_reserva_inmutable()',
      'public.servicios_reserva_coherente_al_cambiar()'
    ]) f
   where to_regprocedure(f) is null;
  if faltan is not null then
    raise exception 'La 0095 requiere las funciones de la 0089, la 0093 y la 0094: faltan %', faltan;
  end if;

  -- LA INMUTABILIDAD de la fotografía es la de la reserva: el disparador de
  -- la 0093, activo, con el cuerpo de la 0094 (compara la fila entera).
  if not exists (
    select 1 from pg_catalog.pg_trigger g
     where g.tgrelid = 'public.service_bookings'::regclass and g.tgname = 'service_bookings_inmutables'
       and not g.tgisinternal and g.tgenabled in ('O', 'A')
       and g.tgfoid = to_regprocedure('public.servicios_reserva_inmutable()')
  ) then
    raise exception 'La 0095 requiere el disparador service_bookings_inmutables de la 0093, activo';
  end if;
  if (select md5(replace(p.prosrc, E'\r', '')) from pg_catalog.pg_proc p
       where p.oid = to_regprocedure('public.servicios_reserva_inmutable()'))
     is distinct from 'fe2816a52e615d924e794dd28cff8661' then
    raise exception 'La 0095 requiere servicios_reserva_inmutable() con el cuerpo de la 0094';
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. La fotografía: tres columnas de la reserva. Sin valor predeterminado:
--    lo que ya existe se queda en NULL, y lo nuevo la trae o no entra (4).
-- ------------------------------------------------------------------------- --
alter table public.service_bookings
  add column if not exists operating_policy jsonb,
  add column if not exists operating_policy_version integer,
  add column if not exists operating_policy_sha256 text;

-- ------------------------------------------------------------------------- --
-- 3. Lo que una fotografía tiene que ser.
-- ------------------------------------------------------------------------- --
-- Entera o ninguna.
alter table public.service_bookings drop constraint if exists service_bookings_politica_completa;
alter table public.service_bookings
  add constraint service_bookings_politica_completa
  check (
    (operating_policy is null) = (operating_policy_version is null)
    and (operating_policy is null) = (operating_policy_sha256 is null)
  );

-- De una estructura que la base conoce. Otra estructura, otra migración.
alter table public.service_bookings drop constraint if exists service_bookings_politica_version;
alter table public.service_bookings
  add constraint service_bookings_politica_version
  check (operating_policy_version is null or operating_policy_version = 1);

-- Sus nueve claves y ninguna más, cada una un entero dentro de sus cotas (las
-- de `reserva_politica`). Lo que no se puede evaluar no pasa (`coalesce`).
alter table public.service_bookings drop constraint if exists service_bookings_politica_forma;
alter table public.service_bookings
  add constraint service_bookings_politica_forma
  check (
    operating_policy is null or coalesce(
      jsonb_typeof(operating_policy) = 'object'
      and operating_policy - array[
        'attention_checkin_minutes', 'attention_confirmation_hours', 'attention_tolerance_minutes',
        'booking_reschedule_max', 'booking_reschedule_min_hours', 'incident_appeal_days',
        'incident_appeals_max', 'incident_window_hours', 'review_window_days'
      ] = '{}'::jsonb
      and jsonb_typeof(operating_policy -> 'attention_checkin_minutes') = 'number'
      and (operating_policy ->> 'attention_checkin_minutes') ~ '^[0-9]+$'
      and (operating_policy -> 'attention_checkin_minutes') between '0'::jsonb and '240'::jsonb
      and jsonb_typeof(operating_policy -> 'attention_confirmation_hours') = 'number'
      and (operating_policy ->> 'attention_confirmation_hours') ~ '^[0-9]+$'
      and (operating_policy -> 'attention_confirmation_hours') between '1'::jsonb and '720'::jsonb
      and jsonb_typeof(operating_policy -> 'attention_tolerance_minutes') = 'number'
      and (operating_policy ->> 'attention_tolerance_minutes') ~ '^[0-9]+$'
      and (operating_policy -> 'attention_tolerance_minutes') between '0'::jsonb and '240'::jsonb
      and jsonb_typeof(operating_policy -> 'booking_reschedule_max') = 'number'
      and (operating_policy ->> 'booking_reschedule_max') ~ '^[0-9]+$'
      and (operating_policy -> 'booking_reschedule_max') between '0'::jsonb and '10'::jsonb
      and jsonb_typeof(operating_policy -> 'booking_reschedule_min_hours') = 'number'
      and (operating_policy ->> 'booking_reschedule_min_hours') ~ '^[0-9]+$'
      and (operating_policy -> 'booking_reschedule_min_hours') between '0'::jsonb and '720'::jsonb
      and jsonb_typeof(operating_policy -> 'incident_appeal_days') = 'number'
      and (operating_policy ->> 'incident_appeal_days') ~ '^[0-9]+$'
      and (operating_policy -> 'incident_appeal_days') between '1'::jsonb and '60'::jsonb
      and jsonb_typeof(operating_policy -> 'incident_appeals_max') = 'number'
      and (operating_policy ->> 'incident_appeals_max') ~ '^[0-9]+$'
      and (operating_policy -> 'incident_appeals_max') between '0'::jsonb and '1'::jsonb
      and jsonb_typeof(operating_policy -> 'incident_window_hours') = 'number'
      and (operating_policy ->> 'incident_window_hours') ~ '^[0-9]+$'
      and (operating_policy -> 'incident_window_hours') between '1'::jsonb and '720'::jsonb
      and jsonb_typeof(operating_policy -> 'review_window_days') = 'number'
      and (operating_policy ->> 'review_window_days') ~ '^[0-9]+$'
      and (operating_policy -> 'review_window_days') between '1'::jsonb and '365'::jsonb,
      false
    )
  );

-- LA HUELLA ES LA DE ESA FOTOGRAFÍA: el SHA-256 de su forma canónica (las
-- claves en orden y sin espacios, con la versión de la estructura). La API
-- calcula la misma (`reserva_politica.huella_de_la_fotografia`); la base no
-- guarda otra. `sha256(bytea)` es del núcleo: sin extensiones.
alter table public.service_bookings drop constraint if exists service_bookings_politica_huella;
alter table public.service_bookings
  add constraint service_bookings_politica_huella
  check (
    operating_policy_sha256 is null or coalesce(
      operating_policy_sha256 = encode(sha256(convert_to(
        '{"schema_version":' || operating_policy_version::text || ',"values":{"attention_checkin_minutes":'
        || (operating_policy ->> 'attention_checkin_minutes')
        || ',"attention_confirmation_hours":' || (operating_policy ->> 'attention_confirmation_hours')
        || ',"attention_tolerance_minutes":' || (operating_policy ->> 'attention_tolerance_minutes')
        || ',"booking_reschedule_max":' || (operating_policy ->> 'booking_reschedule_max')
        || ',"booking_reschedule_min_hours":' || (operating_policy ->> 'booking_reschedule_min_hours')
        || ',"incident_appeal_days":' || (operating_policy ->> 'incident_appeal_days')
        || ',"incident_appeals_max":' || (operating_policy ->> 'incident_appeals_max')
        || ',"incident_window_hours":' || (operating_policy ->> 'incident_window_hours')
        || ',"review_window_days":' || (operating_policy ->> 'review_window_days')
        || '}}', 'UTF8')), 'hex'),
      false
    )
  );

-- ------------------------------------------------------------------------- --
-- 4. Una reserva NUEVA nace con su fotografía. Las que ya había no la tienen
--    ni la pueden ganar (una reserva no se reescribe): por eso es un
--    disparador al insertar y no un NOT NULL.
-- ------------------------------------------------------------------------- --
create or replace function public.servicios_reserva_con_politica()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.operating_policy is null then
    raise exception 'Una reserva nace con su política operativa congelada'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists service_bookings_con_politica on public.service_bookings;
create trigger service_bookings_con_politica
  before insert on public.service_bookings
  for each row
  execute function public.servicios_reserva_con_politica();

-- ------------------------------------------------------------------------- --
-- 5. Cerrada: solo la API.
-- ------------------------------------------------------------------------- --
revoke all on function public.servicios_reserva_con_politica() from public, anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 6. Lo que tiene que quedar, o nada.
-- ------------------------------------------------------------------------- --
do $$
declare
  reservas constant regclass := 'public.service_bookings'::regclass;
  sin_fotografia bigint;
begin
  -- Las tres columnas, con su tipo, sin NOT NULL y SIN valor predeterminado.
  if (select count(*) from pg_catalog.pg_attribute a
       where a.attrelid = reservas and a.attnum > 0 and not a.attisdropped and not a.attnotnull
         and (a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)) in (
           ('operating_policy', 'jsonb'), ('operating_policy_version', 'integer'), ('operating_policy_sha256', 'text')
         )
         and not exists (select 1 from pg_catalog.pg_attrdef d where d.adrelid = a.attrelid and d.adnum = a.attnum)
     ) <> 3 then
    raise exception 'La 0095 no dejó las tres columnas de la fotografía';
  end if;

  if (select count(*) from pg_catalog.pg_constraint c
       where c.conrelid = reservas and c.contype = 'c' and c.convalidated
         and c.conname in (
           'service_bookings_politica_completa', 'service_bookings_politica_version',
           'service_bookings_politica_forma', 'service_bookings_politica_huella'
         )) <> 4 then
    raise exception 'La 0095 no dejó sus cuatro CHECK, validados';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger g
     where g.tgrelid = reservas and g.tgname = 'service_bookings_con_politica' and not g.tgisinternal
       and g.tgenabled in ('O', 'A') and g.tgtype = 7
       and g.tgfoid = to_regprocedure('public.servicios_reserva_con_politica()')
  ) then
    raise exception 'La 0095 no dejó el disparador que exige la fotografía al insertar';
  end if;

  if exists (
    select 1 from pg_catalog.pg_roles r
     where r.rolname in ('anon', 'authenticated')
       and pg_catalog.has_function_privilege(
             r.oid, to_regprocedure('public.servicios_reserva_con_politica()'), 'EXECUTE')
  ) then
    raise exception 'public.servicios_reserva_con_politica() es ejecutable desde fuera';
  end if;

  -- La reserva sigue cerrada: RLS, cero políticas, nadie de fuera.
  if not (select relrowsecurity from pg_catalog.pg_class where oid = reservas) then
    raise exception 'service_bookings sin RLS';
  end if;
  if exists (select 1 from pg_catalog.pg_policy where polrelid = reservas) then
    raise exception 'service_bookings tiene políticas';
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles r
     where r.rolname in ('anon', 'authenticated')
       and (pg_catalog.has_table_privilege(
              r.oid, reservas, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            or pg_catalog.has_any_column_privilege(r.oid, reservas, 'SELECT, INSERT, UPDATE, REFERENCES'))
  ) then
    raise exception 'service_bookings tiene permisos sueltos';
  end if;

  -- Lo que ya había: sin fotografía, y dicho.
  select count(*) into sin_fotografia from public.service_bookings where operating_policy is null;
  raise notice 'La 0095: % reserva(s) anteriores, sin fotografía (se rigen por la política vigente)', sin_fotografia;
end;
$$;

notify pgrst, 'reload schema';

commit;
