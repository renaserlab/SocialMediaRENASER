-- 0052 · Cerrar la lectura DIRECTA de auditoría y de contexto de origen.
--
-- LO QUE SE ENCONTRÓ AL VERIFICAR LA 0050 CONTRA LA BASE REAL. Dos fugas del
-- mismo tipo, y las dos por el mismo motivo: la API no es el único camino a
-- estas tablas. El móvil habla con PostgREST usando la clave anónima, así que
-- lo que decide de verdad quién lee qué es la RLS, no el esquema de salida de
-- FastAPI.
--
-- 1. `audit_events_read` usaba `public.is_admin()`, que es
--    `role in ('moderator', 'admin')`. Es decir: la cuenta pensada para ocultar
--    una publicación podía hacer `select * from audit_events` y leer quién movió
--    cada euro, con su huella de IP, su prefijo de red y su navegador. La API lo
--    impide con `puede_mover_dinero`; PostgREST no, porque la política decía
--    otra cosa. La separación entre moderar y tesorería existía en un sitio y no
--    en el otro.
--
-- 2. `consent_records_read` deja a cada persona ver su fila —correcto— pero con
--    TODAS sus columnas, incluidas `ip_hash`, `ip_prefix` y
--    `user_agent_family`. El esquema `ConsentimientoPropio` las omite a
--    propósito y dice por qué: no le aportan nada a quien las lee y convierten
--    el endpoint en una forma de comprobar desde dónde se conecta una cuenta.
--    Por PostgREST salían igual.
--
-- Y DE PASO UNA ANTERIOR, de la 0049, que es exactamente el mismo caso:
-- `refund_requests_read` entrega al alumno la fila entera, con el identificador
-- del reembolso en la pasarela y el uuid de quien revisó su expediente.
-- `RefundRequestRead` deja fuera esos campos; `AdminRefundRead` los enseña solo
-- a administración. La RLS no distinguía.
--
-- POR QUÉ CON `revoke` A NIVEL DE COLUMNA Y NO CAMBIANDO LA POLÍTICA. Porque la
-- política decide QUÉ FILAS, no qué columnas. Quitar la fila entera dejaría a la
-- persona sin ver su propio consentimiento, que sí tiene derecho a consultar.
-- Lo que sobra son cuatro columnas, y eso se quita con `revoke`.
--
-- NO TOCA NI UNA FILA. Solo permisos y una política. Es idempotente.
--
-- ROLLBACK:
--   grant select (ip_hash, ip_prefix, user_agent_family)
--     on public.consent_records to anon, authenticated;
--   grant select (external_refund_id, reviewer_id, provider, environment)
--     on public.refund_requests to anon, authenticated;
--   drop policy if exists audit_events_read on public.audit_events;
--   create policy audit_events_read on public.audit_events
--     for select using (public.is_admin());
--   drop function if exists public.puede_mover_dinero();

-- ========================================================================= --
-- 1. Quién puede mover dinero, en la base
-- ========================================================================= --
--
-- El equivalente en SQL de `FINANCE_ROLES` de `shared/permissions.py`. Se
-- declara aparte de `is_admin()` y no se toca aquella: `is_admin()` la usan
-- veinte políticas de moderación y estrecharla ahí dejaría sin trabajar a quien
-- modera.

create or replace function public.puede_mover_dinero()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ========================================================================= --
-- 2. La auditoría, solo para tesorería
-- ========================================================================= --

drop policy if exists audit_events_read on public.audit_events;
create policy audit_events_read on public.audit_events
  for select using (public.puede_mover_dinero());

-- ========================================================================= --
-- 3. El contexto de origen no se sirve a nadie por PostgREST
-- ========================================================================= --
--
-- Ni siquiera a quien lo firmó. Quien tenga que investigar un abuso lo hace
-- contra la base y con motivo, no por una API que cualquiera puede llamar.

revoke select (ip_hash, ip_prefix, user_agent_family)
  on public.consent_records from anon, authenticated;

revoke select (ip_hash, ip_prefix, user_agent_family)
  on public.audit_events from anon, authenticated;

-- ========================================================================= --
-- 4. Lo mismo en el expediente de devolución (viene de la 0049)
-- ========================================================================= --

revoke select (external_refund_id, reviewer_id, provider, environment)
  on public.refund_requests from anon, authenticated;

-- ========================================================================= --
-- 5. Verificación
-- ========================================================================= --

do $$
declare
  faltan text := '';
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'puede_mover_dinero'
  ) then faltan := faltan || 'funcion:puede_mover_dinero '; end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'audit_events'
      and policyname = 'audit_events_read' and qual like '%puede_mover_dinero%'
  ) then faltan := faltan || 'politica:audit_events_read '; end if;

  -- Las columnas de origen ya no se conceden a los roles del cliente.
  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public'
      and table_name in ('consent_records', 'audit_events')
      and column_name in ('ip_hash', 'ip_prefix', 'user_agent_family')
      and grantee in ('anon', 'authenticated')
      and privilege_type = 'SELECT'
  ) then faltan := faltan || 'revoke:contexto_de_origen '; end if;

  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'refund_requests'
      and column_name in ('external_refund_id', 'reviewer_id', 'provider', 'environment')
      and grantee in ('anon', 'authenticated')
      and privilege_type = 'SELECT'
  ) then faltan := faltan || 'revoke:refund_requests '; end if;

  if faltan <> '' then
    raise exception '0052 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
