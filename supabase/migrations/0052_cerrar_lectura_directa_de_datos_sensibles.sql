-- 0052 · Cerrar la lectura DIRECTA de auditoría y de contexto de origen.
--
-- LO QUE SE ENCONTRÓ AL VERIFICAR LA 0050 CONTRA LA BASE REAL. Tres fugas del
-- mismo tipo, y las tres por el mismo motivo: la API no es el único camino a
-- estas tablas. El móvil habla con PostgREST usando la clave anónima, así que
-- lo que decide de verdad quién lee qué es la RLS y los permisos, no el esquema
-- de salida de FastAPI.
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
-- 3. Y una anterior, de la 0049, que es exactamente el mismo caso:
--    `refund_requests_read` entrega al alumno la fila entera, con el
--    identificador del reembolso en la pasarela y el uuid de quien revisó su
--    expediente. `RefundRequestRead` deja fuera esos campos; `AdminRefundRead`
--    los enseña solo a administración. La RLS no distinguía.
--
-- POR QUÉ POR COLUMNAS Y NO CAMBIANDO LA POLÍTICA. Porque la política decide QUÉ
-- FILAS, no qué columnas. Quitar la fila entera dejaría a la persona sin ver su
-- propio consentimiento, que sí tiene derecho a consultar. Lo que sobra son
-- unas columnas.
--
-- Y POR QUÉ SE REVOCA LA TABLA ENTERA ANTES DE VOLVER A CONCEDER COLUMNA A
-- COLUMNA. Este es el punto que hay que entender o la migración no sirve de
-- nada: en PostgreSQL, los permisos de una persona sobre una columna son la
-- SUMA de los de columna y los de tabla. `revoke select (ip_hash) on t from
-- anon` NO quita nada si `anon` tiene `select` sobre `t` entera —que es
-- justamente lo que Supabase concede por defecto a `anon` y `authenticated`—.
-- La concesión de tabla sigue en pie y se leen todas las columnas igual. Por eso
-- aquí se retira la concesión de tabla y se vuelve a conceder la lista explícita
-- de columnas visibles.
--
-- La lista se calcula del catálogo en vez de escribirla a mano, para que no
-- envejezca. Efecto secundario buscado: una columna que se añada en el futuro
-- NO queda concedida hasta que alguien lo decida. Es lo correcto para tablas que
-- guardan rastro de personas: se abre a propósito, no por omisión.
--
-- NO TOCA NI UNA FILA. Solo permisos y una política. Es idempotente.
--
-- ROLLBACK:
--   grant select on public.consent_records to anon, authenticated;
--   grant select on public.audit_events   to anon, authenticated;
--   grant select on public.refund_requests to anon, authenticated;
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
-- 3. Las columnas que no se sirven por PostgREST a ningún cliente
-- ========================================================================= --
--
-- El contexto de origen, ni siquiera a quien lo firmó: quien tenga que
-- investigar un abuso lo hace contra la base y con motivo, no por una API que
-- cualquiera puede llamar. Y del expediente de devolución, lo que solo le
-- incumbe a administración.
--
-- `service_role` y el propietario no se tocan: por ahí entra la API, que ya
-- decide con sus propios esquemas de salida qué enseña a quién.

do $$
declare
  objetivo record;
  visibles text;
begin
  for objetivo in
    select * from (values
      ('consent_records', array['ip_hash', 'ip_prefix', 'user_agent_family']),
      ('audit_events',    array['ip_hash', 'ip_prefix', 'user_agent_family']),
      ('refund_requests', array['external_refund_id', 'reviewer_id',
                                'provider', 'environment'])
    ) as v(tabla, ocultas)
  loop
    -- La tabla puede no existir todavía (`refund_requests` viene de la 0049).
    -- Si no está, no hay nada que cerrar y no se inventa nada.
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = objetivo.tabla
    ) then
      continue;
    end if;

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into visibles
      from information_schema.columns
     where table_schema = 'public'
       and table_name = objetivo.tabla
       and not (column_name = any (objetivo.ocultas));

    if visibles is null then
      raise exception '0052: % se quedaria sin ninguna columna visible',
        objetivo.tabla;
    end if;

    -- PRIMERO SE RETIRA LA CONCESIÓN DE TABLA. Sin esto, lo de abajo no cambia
    -- nada: los permisos de columna se SUMAN a los de tabla, no los recortan.
    execute format(
      'revoke select on public.%I from anon, authenticated', objetivo.tabla
    );
    execute format(
      'grant select (%s) on public.%I to anon, authenticated',
      visibles, objetivo.tabla
    );
  end loop;
end $$;

-- ========================================================================= --
-- 4. Verificación
-- ========================================================================= --
--
-- Se comprueban las dos mitades: que lo sensible ya no se concede Y que lo
-- demás se sigue concediendo. Solo la primera dejaría pasar el error opuesto
-- —cerrar la tabla entera y romper la pantalla de consentimientos— sin que
-- nadie se entere hasta que alguien la abra.

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

  -- Lo sensible, fuera. `column_privileges` incluye tanto los permisos de
  -- columna como los derivados de un permiso de tabla, asi que esta consulta ve
  -- el caso que rompia la version anterior de esta migracion.
  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and privilege_type = 'SELECT'
      and (
        (table_name in ('consent_records', 'audit_events')
         and column_name in ('ip_hash', 'ip_prefix', 'user_agent_family'))
        or
        (table_name = 'refund_requests'
         and column_name in ('external_refund_id', 'reviewer_id',
                             'provider', 'environment'))
      )
  ) then faltan := faltan || 'siguen_concedidas:columnas_sensibles '; end if;

  -- Y lo que sí hace falta, dentro.
  if not exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'consent_records'
      and column_name = 'id' and grantee = 'authenticated'
      and privilege_type = 'SELECT'
  ) then faltan := faltan || 'perdida:lectura_de_consent_records '; end if;

  if faltan <> '' then
    raise exception '0052 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
