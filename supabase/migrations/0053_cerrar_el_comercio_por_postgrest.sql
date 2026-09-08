-- 0053 · Terminar lo que la 0052 dejó a medias: el comercio también.
--
-- QUÉ PASÓ. La 0052 corrigió nueve políticas y dio el problema por cerrado. La
-- verificación posterior, contra la base donde ya está aplicada, encontró que
-- las tres tablas del comercio —las de la 0035, que son las más antiguas y por
-- eso no estaban en la lista— siguen decidiendo con `public.is_admin()`, que es
-- `role in ('moderator', 'admin')`:
--
--     select tablename, policyname from pg_policies where qual like '%is_admin%';
--     -> purchases.purchases_read_own          <- de la 0001, la mas antigua
--        orders.orders_read_own
--        payment_transactions.payment_transactions_read_own
--        entitlements.entitlements_read_own
--        course_enrollments.course_enrollments_read_own
--        provider_products.provider_products_admin_read
--
-- Es decir: con su propio JWT y la clave anónima, una cuenta que solo modera
-- podía pedir `GET /rest/v1/orders?select=*` y llevarse el historial de compras
-- de TODO el mundo, con importe, moneda, proveedor y entorno. La API no le da
-- eso a nadie: `/payments/me` y `/payments/history` filtran por `auth.uid()`, y
-- la bandeja de devoluciones exige `puede_mover_dinero`. Otra vez lo mismo: el
-- reparto era cierto en Python y falso en la RLS, que es la que decide cuando
-- se entra por PostgREST.
--
-- POR QUÉ SE ESCAPÓ, DOS VECES. La primera, porque la lista de tablas a revisar
-- se escribió a partir del incidente anterior en vez de a partir de qué tablas
-- guardan dinero. Se corrigió deduciéndola del esquema… y `purchases` siguió sin
-- aparecer, porque la expresión que busca los `create table` exigía
-- `if not exists` y las 23 tablas de la 0001 no lo llevan. Es decir: la lista
-- que presumía de deducirse del esquema no veía medio esquema, y el fallo de
-- arriba quedaba tapado por el de abajo.
--
-- `purchases` es la tabla de compras original —`amount_minor`, `currency`,
-- `provider_transaction_id`— y sigue viva: la usan `learning/models.py`,
-- `commerce/service.py` y `/payments/me`, que filtra siempre por el propio
-- usuario, incluso para administración. Por PostgREST no filtraba nadie.
--
-- Y HAY UNA SEGUNDA CAPA QUE NO EXISTÍA. Supabase concede por defecto todos los
-- privilegios sobre cada tabla a `anon` y `authenticated`, así que en las tablas
-- de dinero la RLS era la ÚNICA barrera: una política mal escrita mañana no
-- tiene nada detrás. Se retira esa concesión donde no hace falta —el móvil no
-- lee ninguna de estas tablas: habla con FastAPI— y se quitan también los
-- privilegios de escritura, incluido `truncate`, QUE LA RLS NO CONTROLA: una
-- política de escritura no impide vaciar la tabla de auditoría.
--
-- NO TOCA NI UNA FILA. Solo políticas y permisos. Es idempotente.
--
-- ROLLBACK:
--   -- volver a crear las cinco políticas con `public.is_admin()`, con el
--   -- mismo texto que trae la 0035;
--   -- `grant all`, no `grant select`: la seccion 2 hace `revoke all`, asi que
--   -- devolver solo la lectura dejaria la base en un tercer estado, ni el de
--   -- antes ni el de despues.
--   grant all on public.purchases, public.orders, public.payment_transactions,
--     public.entitlements, public.course_enrollments, public.provider_products,
--     public.owner_payout_accounts, public.owner_sale_balances,
--     public.owner_transfers, public.course_refund_windows,
--     public.refund_request_events, public.refund_policy_acceptances,
--     public.payment_events
--     to anon, authenticated;
--   grant insert, update, delete, truncate, references, trigger
--     on public.audit_events, public.consent_records, public.refund_requests
--     to anon, authenticated;
--   -- y, si se aplicó la sección 4:
--   alter default privileges in schema public
--     grant all on tables to anon, authenticated;

-- ========================================================================= --
-- 1. El comercio decide con tesorería, no con moderación
-- ========================================================================= --
--
-- Se redefinen con el mismo `using` que traen, cambiando solo quién es el
-- administrador. Cada persona sigue viendo lo suyo exactamente igual.
--
-- `course_enrollments` ENTRA, y es la que más se puede discutir: no guarda
-- importes. Guarda quién tiene acceso a qué curso y por qué vía, y cruzada con
-- el precio del curso dice quién compró qué y por cuánto. Es el mismo dato con
-- otra forma, así que se reparte igual.

drop policy if exists purchases_read_own on public.purchases;
create policy purchases_read_own on public.purchases
  for select using (user_id = auth.uid() or public.puede_mover_dinero());

drop policy if exists orders_read_own on public.orders;
create policy orders_read_own on public.orders
  for select to authenticated
  using (user_id = auth.uid() or public.puede_mover_dinero());

drop policy if exists payment_transactions_read_own on public.payment_transactions;
create policy payment_transactions_read_own on public.payment_transactions
  for select to authenticated
  using (
    public.puede_mover_dinero()
    or exists (
      select 1 from public.orders o
      where o.id = payment_transactions.order_id
        and o.user_id = auth.uid()
    )
  );

drop policy if exists entitlements_read_own on public.entitlements;
create policy entitlements_read_own on public.entitlements
  for select to authenticated
  using (user_id = auth.uid() or public.puede_mover_dinero());

drop policy if exists course_enrollments_read_own on public.course_enrollments;
create policy course_enrollments_read_own on public.course_enrollments
  for select to authenticated
  using (user_id = auth.uid() or public.puede_mover_dinero());

-- El mapeo de un curso a su producto en la pasarela: identificadores externos
-- de Stripe y de las tiendas. No es contenido.
drop policy if exists provider_products_admin_read on public.provider_products;
create policy provider_products_admin_read on public.provider_products
  for select to authenticated
  using (public.puede_mover_dinero());

-- ========================================================================= --
-- 2. El dinero no se sirve por PostgREST, y punto
-- ========================================================================= --
--
-- SEGUNDA BARRERA, no sustituto de la RLS. Hoy estas tablas están tapadas por
-- su política; si mañana alguien escribe una mal, esto sigue en pie.
--
-- SE PUEDE HACER PORQUE EL MÓVIL NO LAS LEE. Las únicas tablas que la aplicación
-- alcanza directamente por PostgREST son `courses`, `course_modules`,
-- `course_lessons`, `course_lesson_resources`, `lessons`, `stories`,
-- `story_views`, `testimonials` y `device_tokens`. Todo el comercio, las
-- devoluciones y la gobernanza pasan por FastAPI, que entra por SQLAlchemy con
-- identidad propia y no se ve afectado por nada de esto.

-- `revoke all` Y NO `revoke select`: de paso se van los privilegios de escritura
-- que Supabase concede por defecto, y con ellos `truncate`, QUE LA RLS NO
-- CONTROLA. Las escrituras ya estaban denegadas por tener RLS activa y ninguna
-- política de escritura; `truncate` no, porque es un privilegio de tabla y nada
-- más. Nadie las necesita: el móvil no las toca.

revoke all on
  public.purchases,
  public.orders,
  public.payment_transactions,
  -- `payment_events` no tiene ninguna politica, a proposito: con RLS activa y
  -- sin politica PostgreSQL deniega todo. Pero seguia con los privilegios de
  -- tabla por defecto, y `truncate` no pasa por la RLS.
  public.payment_events,
  public.entitlements,
  public.course_enrollments,
  public.provider_products,
  public.owner_payout_accounts,
  public.owner_sale_balances,
  public.owner_transfers,
  public.course_refund_windows,
  public.refund_request_events,
  public.refund_policy_acceptances
from anon, authenticated;

-- ========================================================================= --
-- 3. Las tres de la 0052 conservan su lectura por columnas
-- ========================================================================= --
--
-- AQUÍ NO SE PUEDE USAR `revoke all`, y esa es toda la razón de que esta sección
-- exista aparte: la 0052 concedió en estas tres una lista explícita de columnas
-- visibles, y `revoke all` se la llevaría por delante. Se enumeran los
-- privilegios que sobran y se deja el `select` por columnas donde está.
--
-- El que importa es `truncate`: `audit_events` es una tabla cuyo único valor es
-- ser un rastro que nadie puede alterar, y vaciarla no pasa por la RLS.

revoke insert, update, delete, truncate, references, trigger on
  public.audit_events,
  public.consent_records,
  public.refund_requests
from anon, authenticated;


-- ========================================================================= --
-- 4. Que la próxima tabla no nazca abierta
-- ========================================================================= --
--
-- ESTA SECCIÓN CAMBIA EL COMPORTAMIENTO FUTURO, no el estado actual, y por eso
-- va aparte y al final: se puede aplicar en otro momento sin que las tres
-- anteriores dejen de valer.
--
-- Supabase trae `alter default privileges ... grant all on tables to anon,
-- authenticated`. Comprobado en esta base:
--
--     select defaclacl from pg_default_acl;  -> anon=arwdDxtm/postgres
--
-- Es decir: la próxima tabla financiera nacerá concedida a la clave anónima, y
-- lo único que la salvará es que alguien se acuerde de la RLS. Es exactamente
-- el mecanismo que dejó abiertas las cinco políticas que arregla la sección 1.
--
-- A PARTIR DE AQUÍ HAY QUE CONCEDER A PROPÓSITO. Una tabla nueva que el móvil
-- deba leer necesitará su `grant select`, y si falta, la pantalla fallará
-- durante el desarrollo. Es preferible a que una tabla de dinero se sirva sola.
--
-- Solo afecta a las tablas que cree `postgres`, que es el rol con el que se
-- aplican estas migraciones desde el editor SQL.

alter default privileges in schema public
  revoke all on tables from anon, authenticated;

-- ========================================================================= --
-- 5. Verificación
-- ========================================================================= --

do $$
declare
  faltan text := '';
  pendiente record;
begin
  -- Ninguna tabla con dinero puede seguir decidiendo con `is_admin()`.
  for pendiente in
    select tablename || '.' || policyname as etiqueta
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'purchases', 'orders', 'payment_transactions', 'entitlements',
        'course_enrollments', 'provider_products', 'audit_events', 'consent_records',
        'course_refund_windows', 'refund_requests', 'refund_request_events',
        'refund_policy_acceptances', 'owner_payout_accounts',
        'owner_sale_balances', 'owner_transfers'
      )
      and qual like '%is_admin%'
  loop
    faltan := faltan || 'politica_con_is_admin:' || pendiente.etiqueta || ' ';
  end loop;

  -- Y ninguna puede seguir concedida a los roles del cliente.
  for pendiente in
    select distinct table_name
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and table_name in (
        'purchases', 'orders', 'payment_transactions', 'entitlements',
        'course_enrollments', 'provider_products', 'payment_events', 'owner_payout_accounts',
        'owner_sale_balances', 'owner_transfers', 'course_refund_windows',
        'refund_request_events', 'refund_policy_acceptances'
      )
  loop
    faltan := faltan || 'grant_de_tabla:' || pendiente.table_name || ' ';
  end loop;

  -- Las tres de la 0052 conservan su lectura por columnas y pierden el resto.
  for pendiente in
    select distinct table_name || ':' || privilege_type as etiqueta
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and table_name in ('audit_events', 'consent_records', 'refund_requests')
  loop
    faltan := faltan || 'privilegio_de_sobra:' || pendiente.etiqueta || ' ';
  end loop;

  if not exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'consent_records'
      and column_name = 'policy_hash' and grantee = 'authenticated'
      and privilege_type = 'SELECT'
  ) then
    faltan := faltan || 'se_perdio:consent_records.policy_hash ';
  end if;

  if faltan <> '' then
    raise exception '0053 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
