-- 0054 · La aceptación de recompra sabe por dónde se iba a comprar.
--
-- **ESTA MIGRACIÓN NO ESTÁ APLICADA.** El código que la acompaña funciona con y
-- sin ella: mira si las columnas existen antes de escribirlas, igual que el
-- resto del proyecto hace con `esquema.hay_*`. Aplicarla es una decisión de
-- quien opera la base, no un efecto de desplegar.
--
-- QUÉ PROBLEMA CIERRA. La aceptación de recompra —«sé que esta compra no tiene
-- garantía»— solo se exigía en el checkout web. En iOS y Android, el acceso lo
-- concede `POST /payments/native/sync`, y ahí no se comprobaba nada: la casilla
-- de la aplicación era la única puerta, y una puerta que vive en el teléfono no
-- es una puerta.
--
-- POR QUÉ NO SE ARREGLA RECHAZANDO. Cuando `native/sync` corre, la compra en la
-- tienda YA OCURRIÓ y el dinero YA SE MOVIÓ: Google y Apple cobran antes de que
-- nosotros nos enteremos. Devolver 409 ahí sería cobrar y no entregar, que es
-- peor que el problema. La aceptación tiene que pedirse ANTES de abrir la
-- compra nativa, y en la sincronización lo que se hace es ATARLA y, si falta,
-- DEJAR CONSTANCIA. Nunca retirar una compra pagada.
--
-- QUÉ AÑADE. Tres columnas a `refund_policy_acceptances`, todas opcionales:
--
--   * `provider`             — 'stripe', 'apple', 'google'. Por dónde se iba a
--                              comprar cuando se aceptó.
--   * `external_product_id`  — el identificador del producto en esa tienda.
--   * `operation_ref`        — la referencia de la operación con la que se ató,
--                              para poder responder «qué aceptó exactamente
--                              quien hizo ESTA compra» también en nativo, donde
--                              no hay `order_id` hasta después.
--
-- SON NULAS A PROPÓSITO. Las aceptaciones que ya existen se firmaron sin esos
-- datos y no se inventan: una fila con `provider` nulo significa «se aceptó
-- antes de que esto se guardara», y eso es verdad. Rellenarlas con un valor
-- plausible sería escribir en un registro de consentimientos algo que nadie
-- firmó.
--
-- NO TOCA NI UNA FILA Y ES IDEMPOTENTE.
--
-- ROLLBACK:
--   alter table public.refund_policy_acceptances
--     drop column if exists provider,
--     drop column if exists external_product_id,
--     drop column if exists operation_ref;
--   drop index if exists refund_policy_acceptances_operacion;

alter table public.refund_policy_acceptances
  add column if not exists provider text
    check (provider is null or provider in ('stripe', 'apple', 'google')),
  add column if not exists external_product_id text,
  add column if not exists operation_ref text;

-- Para poder preguntar «¿esta operación de tienda ya consumió una aceptación?»
-- sin recorrer la tabla. Parcial porque la inmensa mayoría de las filas no
-- tendrán referencia de operación: las del checkout web se atan por `order_id`.
create index if not exists refund_policy_acceptances_operacion
  on public.refund_policy_acceptances (user_id, course_id, operation_ref)
  where operation_ref is not null;

-- ========================================================================= --
-- Verificación
-- ========================================================================= --

do $$
declare
  faltan text := '';
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'refund_policy_acceptances'
      and column_name = 'provider'
  ) then faltan := faltan || 'columna:provider '; end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'refund_policy_acceptances'
      and column_name = 'operation_ref'
  ) then faltan := faltan || 'columna:operation_ref '; end if;

  if not exists (
    select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'refund_policy_acceptances_operacion'
  ) then faltan := faltan || 'indice:operacion '; end if;

  -- Las columnas nuevas NO se conceden a la clave anónima. La 0053 dejó esta
  -- tabla sin ninguna concesión para `anon` y `authenticated`, y añadir una
  -- columna no puede deshacer eso.
  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'refund_policy_acceptances'
      and grantee in ('anon', 'authenticated')
  ) then faltan := faltan || 'concesion_inesperada:refund_policy_acceptances '; end if;

  if faltan <> '' then
    raise exception '0054 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
