-- =============================================================================
-- 0049 — Garantía de 7 días, devoluciones y liquidación al propietario
-- =============================================================================
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │  ESTA MIGRACIÓN ESTÁ PREPARADA Y **NO APLICADA**. Todo lo que crea nace    │
-- │  detrás de interruptores apagados: sin ella, la aplicación sigue exacta-   │
-- │  mente igual que hoy (`esquema.hay_devoluciones()` responde que no y los   │
-- │  endpoints financieros contestan «no disponible» en vez de reventar).      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- =============================================================================
-- QUÉ PROBLEMA RESUELVE
-- =============================================================================
--
-- Hoy se puede COBRAR un curso (0035 + Stripe Checkout) pero no se puede
-- deshacer la compra: no hay dónde anotar cuándo empezó la garantía de quien
-- compró, ni quién pidió devolución, ni qué decidió la administración, ni qué
-- se le debe al propietario del curso. Sin esas cuatro cosas, un reembolso es
-- una operación a mano en el panel de Stripe que nadie puede auditar después.
--
-- Se crean SIETE tablas, en tres grupos:
--
--   GARANTÍA      course_refund_windows
--   DEVOLUCIÓN    refund_requests · refund_request_events
--                 refund_policy_acceptances
--   LIQUIDACIÓN   owner_payout_accounts · owner_sale_balances
--                 owner_transfers
--
-- =============================================================================
-- LA REGLA QUE MANDA
-- =============================================================================
--
--   El proveedor confirma el dinero.
--   Z decide el acceso, la garantía, la devolución, la auditoría y el saldo.
--
-- Stripe NO es la fuente de verdad del acceso. El acceso sigue siendo
-- `entitlements`, igual que desde la 0035. Un `refund.created` de Stripe no
-- revoca nada por sí solo: revoca un reembolso TOTAL y CONFIRMADO, conciliado
-- con la orden y con el entorno correctos.
--
-- =============================================================================
-- POR QUÉ LAS INVARIANTES VAN EN LA BASE Y NO EN PYTHON
-- =============================================================================
--
-- Es la misma lección que dejó escrita la 0035 en `commerce/models.py`: si la
-- protección contra repeticiones se escribe como «mira si ya existe y, si no,
-- insértalo», dos peticiones simultáneas leen las dos antes de que escriba
-- ninguna, las dos ven que no existe y las dos insertan. En dinero eso es un
-- reembolso pagado dos veces.
--
-- Aquí eso importa en seis sitios, y los seis llevan índice único:
--
--   1. UNA ventana de garantía por (usuario, curso).
--   2. UNA solicitud VIVA por orden               → índice parcial.
--   3. UN reembolso con éxito por (usuario, curso) → índice parcial.
--   4. UN saldo por orden.
--   5. UNA transferencia VIVA por saldo            → índice parcial.
--   6. UNA aceptación por (usuario, curso, orden).
--
-- Los parciales son parciales a propósito: el historial no se puede perder.
-- Rechazadas y canceladas puede haber muchas; vivas, una.
--
-- =============================================================================
-- DINERO: ENTEROS, SIEMPRE
-- =============================================================================
--
-- Todos los importes en la unidad MENOR de la moneda y como `integer`, igual
-- que `orders.amount_minor`. Ni un `numeric`, ni un `float`. Un céntimo de
-- error de redondeo multiplicado por mil ventas es una tarde de conciliación.
--
-- =============================================================================
-- LO QUE ESTA MIGRACIÓN **NO** HACE
-- =============================================================================
--
--   * NO borra ni modifica ninguna tabla, columna ni política existente.
--   * NO toca `orders`, `entitlements`, `course_enrollments`, `lesson_progress`
--     ni `payment_transactions`.
--   * NO toca ni una fila de nada: no hay insert, update, delete ni truncate.
--   * NO concede ni revoca ningún acceso.
--
-- Es aditiva e idempotente: volver a pasarla no hace nada.
--
-- PARA DESHACERLA (se pierde el historial de devoluciones, nada más):
--
--     drop table if exists public.owner_transfers;
--     drop table if exists public.owner_sale_balances;
--     drop table if exists public.owner_payout_accounts;
--     drop table if exists public.refund_policy_acceptances;
--     drop table if exists public.refund_request_events;
--     drop table if exists public.refund_requests;
--     drop table if exists public.course_refund_windows;
--
-- El orden importa: las de abajo dependen de las de arriba.
--
-- =============================================================================
-- DESPUÉS DE APLICARLA
-- =============================================================================
--
-- HAY QUE REINICIAR LA API. `esquema.py` cachea por proceso si las tablas
-- existen; sin reiniciar, los procesos que ya miraron seguirían respondiendo
-- «no está» y las devoluciones no aparecerían hasta el siguiente despliegue.
--
-- Y NO SE ENCIENDE NADA POR APLICARLA. Los interruptores
-- `FEATURE_COURSE_REFUNDS`, `STRIPE_REFUNDS_ENABLED`, `STRIPE_CONNECT_ENABLED`
-- y `CREATOR_TRANSFERS_ENABLED` siguen apagados hasta que alguien los encienda
-- a mano. Ver `docs/Z_DEVOLUCIONES_Y_LIQUIDACIONES.md`.
-- -----------------------------------------------------------------------------


-- =============================================================================
-- 1. GARANTÍA — course_refund_windows
-- =============================================================================
--
-- Cuándo empezó a contar la garantía de una persona en un curso.
--
-- ARRANCA EN EL SERVIDOR, UNA SOLA VEZ, Y NO SE REINICIA. La fecha la pone la
-- API cuando entrega por primera vez contenido PROTEGIDO (el vídeo o el texto
-- de una lección que no es muestra). No la manda el cliente: un `first_access`
-- enviado desde el móvil sería un campo que cualquiera puede retrasar para
-- estirar su plazo indefinidamente.
--
-- UNA FILA POR (usuario, curso) PARA TODA LA VIDA DE LA CUENTA. No por orden.
-- Es lo que hace que recomprar no regale una segunda garantía: la ventana ya
-- existe, con su `refund_used_at` puesto, y la recompra no la toca.
create table if not exists public.course_refund_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  -- La orden que dio origen a ESTA garantía. Se conserva aunque después haya
  -- recompras: dice cuál fue la compra protegida.
  order_id uuid references public.orders(id) on delete set null,
  -- El instante que cuenta. Se escribe UNA vez.
  first_accessed_at timestamptz not null default now(),
  -- Redundante con first_accessed_at + 168h, y a propósito: el plazo de una
  -- garantía ya empezada no puede cambiar porque alguien edite una constante.
  expires_at timestamptz not null,
  -- Cuándo se consumió. Nulo = todavía se puede pedir devolución.
  refund_used_at timestamptz,
  refund_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint course_refund_windows_plazo check (expires_at > first_accessed_at),
  -- Si está usada, tiene fecha de uso; y al revés.
  constraint course_refund_windows_uso_coherente check (
    (refund_used_at is null and refund_request_id is null)
    or (refund_used_at is not null)
  )
);

-- LA INVARIANTE NÚMERO UNO. Sin esto, dos peticiones simultáneas a la primera
-- lección crearían dos ventanas y la persona tendría dos garantías.
create unique index if not exists course_refund_windows_unica
  on public.course_refund_windows (user_id, course_id);

create index if not exists course_refund_windows_curso_idx
  on public.course_refund_windows (course_id);

-- Para el trabajo que libera saldos: «las que ya vencieron y no se usaron».
create index if not exists course_refund_windows_vencimiento_idx
  on public.course_refund_windows (expires_at)
  where refund_used_at is null;


-- =============================================================================
-- 2. SOLICITUDES — refund_requests
-- =============================================================================
--
-- Los estados y sus transiciones están en `refunds/estados.py`; aquí solo se
-- declara el conjunto válido. La máquina de estados vive en el código porque
-- las transiciones permitidas son una regla de negocio, no una restricción de
-- integridad — pero el conjunto de valores sí lo es.
create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,

  status text not null default 'requested',
  reason text not null,
  -- Lo que escribió la persona. PRIVADO: no se le enseña al propietario del
  -- curso, que solo ve el estado comercial.
  explanation text,

  -- Congelado al crear la solicitud, desde la orden. Nunca llega del cliente.
  amount_minor integer not null,
  currency text not null,

  reviewer_id uuid references public.profiles(id) on delete set null,
  -- Motivo del rechazo. Obligatorio al rechazar, y eso lo exige el servicio.
  review_notes text,

  -- Referencia del reembolso en la pasarela. Se rellena al ejecutarlo.
  external_refund_id text,
  provider text,
  environment text,

  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint refund_requests_status check (status in (
    'requested', 'under_review', 'approved', 'refund_processing',
    'refunded', 'rejected', 'failed', 'cancelled'
  )),
  constraint refund_requests_reason check (reason in (
    'not_as_expected', 'content_quality', 'technical_problem', 'other'
  )),
  constraint refund_requests_amount check (amount_minor >= 0),
  constraint refund_requests_environment check (
    environment is null or environment in ('sandbox', 'production')
  )
);

-- UNA SOLICITUD VIVA POR ORDEN. Parcial: rechazadas y canceladas puede haber
-- varias en el historial, y borrarlas sería borrar que ocurrieron. Lo que no
-- puede haber son dos abiertas a la vez sobre el mismo dinero — de ahí salen
-- las dobles aprobaciones y los dobles reembolsos.
create unique index if not exists refund_requests_viva_por_orden
  on public.refund_requests (order_id)
  where status in ('requested', 'under_review', 'approved', 'refund_processing', 'failed');

-- UN REEMBOLSO CON ÉXITO POR (usuario, curso), PARA SIEMPRE. Es la política de
-- una sola devolución, y va aquí y no en un `if`: el `if` se puede saltar con
-- dos pestañas abiertas.
create unique index if not exists refund_requests_exito_unico
  on public.refund_requests (user_id, course_id)
  where status = 'refunded';

create index if not exists refund_requests_usuario_idx
  on public.refund_requests (user_id, requested_at desc);
create index if not exists refund_requests_curso_idx
  on public.refund_requests (course_id, requested_at desc);
-- La bandeja de administración: filtrar por estado y ordenar por antigüedad.
create index if not exists refund_requests_estado_idx
  on public.refund_requests (status, requested_at);


-- =============================================================================
-- 3. HISTORIAL DE ESTADOS — refund_request_events
-- =============================================================================
--
-- Quién movió qué y cuándo. Es la mitad auditable del expediente: sin esto,
-- «la solicitud está rechazada» no dice quién la rechazó ni por qué, y un
-- reembolso de dinero real sin rastro de quién lo autorizó no es defendible.
--
-- Es de solo-añadir. No se actualiza ni se borra.
create table if not exists public.refund_request_events (
  id uuid primary key default gen_random_uuid(),
  refund_request_id uuid not null
    references public.refund_requests(id) on delete cascade,
  from_status text,
  to_status text not null,
  -- Nulo cuando lo movió el sistema (un webhook), no una persona.
  actor_id uuid references public.profiles(id) on delete set null,
  actor_role text not null default 'system',
  reason text,
  notes text,
  external_reference text,
  -- Metadatos TÉCNICOS y seguros: identificadores y códigos, nunca secretos ni
  -- el cuerpo entero de un webhook.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint refund_request_events_actor_role check (
    actor_role in ('user', 'admin', 'system')
  )
);

create index if not exists refund_request_events_solicitud_idx
  on public.refund_request_events (refund_request_id, created_at);


-- =============================================================================
-- 4. ACEPTACIÓN DE RECOMPRA SIN GARANTÍA — refund_policy_acceptances
-- =============================================================================
--
-- Quien ya usó su garantía en un curso puede volver a comprarlo, pero la nueva
-- compra no admite otra devolución. Antes de cobrarle hay que decírselo y que
-- lo acepte, y hay que poder demostrar DESPUÉS qué texto exacto aceptó.
--
-- Por eso se guarda la VERSIÓN y el HASH del texto: si mañana cambia la
-- redacción, las aceptaciones antiguas siguen apuntando a la que se mostró.
create table if not exists public.refund_policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  -- Nulo mientras la orden no existe: se acepta ANTES de crear el checkout.
  order_id uuid references public.orders(id) on delete set null,
  policy_version text not null,
  policy_hash text not null,
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Una aceptación por intento de compra. `order_id` nulo se admite varias veces
-- (se acepta antes de tener orden), y por eso el índice es parcial.
create unique index if not exists refund_policy_acceptances_unica
  on public.refund_policy_acceptances (user_id, course_id, order_id)
  where order_id is not null;

create index if not exists refund_policy_acceptances_usuario_idx
  on public.refund_policy_acceptances (user_id, course_id, accepted_at desc);


-- =============================================================================
-- 5. CUENTA DE COBRO DEL PROPIETARIO — owner_payout_accounts
-- =============================================================================
--
-- Dónde cobra quien vende. Se guarda el identificador EXTERNO de la cuenta
-- conectada; ni un número de tarjeta ni una cuenta bancaria pasan por aquí —de
-- eso se encarga el proveedor, que para eso existe.
create table if not exists public.owner_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'stripe',
  environment text not null default 'production',
  external_account_id text not null,
  onboarding_status text not null default 'pending',
  -- Lo que el proveedor dice que esta cuenta puede hacer ya.
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint owner_payout_accounts_provider check (provider in ('stripe')),
  constraint owner_payout_accounts_environment check (
    environment in ('sandbox', 'production')
  ),
  constraint owner_payout_accounts_onboarding check (
    onboarding_status in ('pending', 'incomplete', 'active', 'restricted', 'disabled')
  )
);

-- Una cuenta por propietario, proveedor y entorno. Con dos, no se sabría a
-- cuál transferir.
create unique index if not exists owner_payout_accounts_unica
  on public.owner_payout_accounts (owner_id, provider, environment);

create unique index if not exists owner_payout_accounts_externa_unica
  on public.owner_payout_accounts (provider, environment, external_account_id);


-- =============================================================================
-- 6. SALDO POR VENTA — owner_sale_balances
-- =============================================================================
--
-- LA FOTOGRAFÍA INMUTABLE DE UNA VENTA. Se escribe cuando el pago se confirma
-- y no se recalcula nunca.
--
-- POR QUÉ UNA FOTO Y NO UN CÁLCULO. Si el neto se calculara al transferir
-- —precio actual del curso × comisión actual, propietario actual—, cambiar
-- cualquiera de las tres cosas reescribiría el pasado: una venta de hace tres
-- meses pasaría a deberle dinero a otra persona. Con la foto, lo que se vendió
-- entonces se liquida como entonces.
create table if not exists public.owner_sale_balances (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  course_id uuid not null references public.courses(id) on delete restrict,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  -- La cuenta que aplicaba EN ESE MOMENTO. Nula si el propietario todavía no
  -- había terminado su alta: el saldo se acumula igual y se transfiere después.
  payout_account_id uuid references public.owner_payout_accounts(id) on delete set null,

  gross_amount_minor integer not null,
  platform_fee_minor integer not null,
  provider_fee_minor integer not null default 0,
  net_amount_minor integer not null,
  currency text not null,
  -- Qué reglas de comisión se aplicaron. Cambiarlas no reescribe lo anterior.
  fee_rules_version text not null,

  status text not null default 'pending',
  -- Cuándo deja de estar retenido, que es cuando vence la garantía.
  available_at timestamptz,
  frozen_by_request_id uuid references public.refund_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint owner_sale_balances_status check (status in (
    'pending', 'frozen', 'eligible', 'transferring', 'transferred',
    'cancelled', 'failed'
  )),
  constraint owner_sale_balances_importes check (
    gross_amount_minor >= 0
    and platform_fee_minor >= 0
    and provider_fee_minor >= 0
    and net_amount_minor >= 0
  ),
  -- El neto es lo que queda. Que cuadre lo comprueba la base, no una prueba.
  constraint owner_sale_balances_cuadra check (
    net_amount_minor = gross_amount_minor - platform_fee_minor - provider_fee_minor
  )
);

-- UN SALDO POR ORDEN. Un webhook repetido no puede deberle el dinero dos veces
-- al propietario.
create unique index if not exists owner_sale_balances_orden_unica
  on public.owner_sale_balances (order_id);

create index if not exists owner_sale_balances_propietario_idx
  on public.owner_sale_balances (owner_id, status);
create index if not exists owner_sale_balances_curso_idx
  on public.owner_sale_balances (course_id, created_at desc);
-- El trabajo que libera saldos vencidos pregunta exactamente esto.
create index if not exists owner_sale_balances_liberables_idx
  on public.owner_sale_balances (available_at)
  where status = 'pending';


-- =============================================================================
-- 7. TRANSFERENCIAS — owner_transfers
-- =============================================================================
create table if not exists public.owner_transfers (
  id uuid primary key default gen_random_uuid(),
  balance_id uuid not null
    references public.owner_sale_balances(id) on delete restrict,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  payout_account_id uuid
    references public.owner_payout_accounts(id) on delete set null,

  amount_minor integer not null,
  currency text not null,
  provider text not null default 'stripe',
  environment text not null default 'production',
  external_transfer_id text,
  -- La clave que se le manda al proveedor para que un reintento no pague dos
  -- veces. La generamos nosotros y es estable por saldo.
  idempotency_key text not null,

  status text not null default 'processing',
  failure_code text,
  failure_message text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint owner_transfers_status check (
    status in ('processing', 'completed', 'failed', 'cancelled')
  ),
  constraint owner_transfers_amount check (amount_minor >= 0),
  constraint owner_transfers_environment check (
    environment in ('sandbox', 'production')
  )
);

-- UNA TRANSFERENCIA VIVA POR SALDO. Parcial porque un fallo se puede
-- reintentar, y los intentos fallidos son historial.
create unique index if not exists owner_transfers_viva_por_saldo
  on public.owner_transfers (balance_id)
  where status in ('processing', 'completed');

create unique index if not exists owner_transfers_idempotencia
  on public.owner_transfers (provider, environment, idempotency_key);

create index if not exists owner_transfers_propietario_idx
  on public.owner_transfers (owner_id, created_at desc);


-- =============================================================================
-- RLS — el dinero SOLO lo escribe el backend
-- =============================================================================
--
-- Las siete tablas llevan RLS activada. La regla general es la misma en todas:
--
--   LECTURA   lo tuyo, y `public.is_admin()`.
--   ESCRITURA NADIE con la clave pública. Ni el dueño de la fila.
--
-- POR QUÉ NINGUNA POLÍTICA DE INSERT O UPDATE. Porque con RLS activada y sin
-- política, la operación queda negada para todo el que entre con la clave
-- anónima o la de un usuario. La API entra con la clave de servicio, que se
-- salta la RLS, y es la única que escribe. Dejar un `insert ... with check
-- (user_id = auth.uid())` permitiría a cualquiera crearse una fila de saldo
-- desde el navegador con su propio id: correcta según la política, y aun así
-- dinero inventado.
--
-- Ni el propietario ni el alumno tienen por qué escribir esto directamente:
-- todo pasa por endpoints que revalidan estado, plazo y permisos.
alter table public.course_refund_windows enable row level security;
alter table public.refund_requests enable row level security;
alter table public.refund_request_events enable row level security;
alter table public.refund_policy_acceptances enable row level security;
alter table public.owner_payout_accounts enable row level security;
alter table public.owner_sale_balances enable row level security;
alter table public.owner_transfers enable row level security;

-- Tu garantía es tuya.
drop policy if exists course_refund_windows_read on public.course_refund_windows;
create policy course_refund_windows_read on public.course_refund_windows
  for select using (user_id = auth.uid() or public.is_admin());

-- Tus solicitudes son tuyas. El propietario del curso NO las ve por aquí: lo
-- que él puede ver es una vista comercial agregada que sirve la API, sin el
-- motivo privado de nadie.
drop policy if exists refund_requests_read on public.refund_requests;
create policy refund_requests_read on public.refund_requests
  for select using (user_id = auth.uid() or public.is_admin());

-- El historial de estados es AUDITORÍA: solo administración. Contiene notas
-- internas de revisión que no son para el alumno.
drop policy if exists refund_request_events_read on public.refund_request_events;
create policy refund_request_events_read on public.refund_request_events
  for select using (public.is_admin());

drop policy if exists refund_policy_acceptances_read on public.refund_policy_acceptances;
create policy refund_policy_acceptances_read on public.refund_policy_acceptances
  for select using (user_id = auth.uid() or public.is_admin());

-- Tu cuenta de cobro es tuya.
drop policy if exists owner_payout_accounts_read on public.owner_payout_accounts;
create policy owner_payout_accounts_read on public.owner_payout_accounts
  for select using (owner_id = auth.uid() or public.is_admin());

-- Tus ventas son tuyas.
drop policy if exists owner_sale_balances_read on public.owner_sale_balances;
create policy owner_sale_balances_read on public.owner_sale_balances
  for select using (owner_id = auth.uid() or public.is_admin());

drop policy if exists owner_transfers_read on public.owner_transfers;
create policy owner_transfers_read on public.owner_transfers
  for select using (owner_id = auth.uid() or public.is_admin());


-- =============================================================================
-- COMPROBACIÓN AUTOMÁTICA — aborta si no quedó como debe
-- =============================================================================
--
-- Se comprueba lo que puede fallar EN SILENCIO: una tabla sin RLS, o un índice
-- único que no llegó a crearse. Lo segundo es lo peligroso: sin él todo parece
-- funcionar hasta el día que dos peticiones coinciden y se paga dos veces.
do $$
declare
  faltan text;
  sin_rls text;
begin
  select string_agg(t, ', ') into faltan
  from unnest(array[
    'course_refund_windows', 'refund_requests', 'refund_request_events',
    'refund_policy_acceptances', 'owner_payout_accounts',
    'owner_sale_balances', 'owner_transfers'
  ]) as t
  where not exists (
    select 1 from pg_class
    where relname = t and relnamespace = 'public'::regnamespace
  );
  if faltan is not null then
    raise exception 'La 0049 no creo: %.', faltan;
  end if;

  select string_agg(t, ', ') into sin_rls
  from unnest(array[
    'course_refund_windows', 'refund_requests', 'refund_request_events',
    'refund_policy_acceptances', 'owner_payout_accounts',
    'owner_sale_balances', 'owner_transfers'
  ]) as t
  where not (
    select relrowsecurity from pg_class
    where relname = t and relnamespace = 'public'::regnamespace
  );
  if sin_rls is not null then
    raise exception
      'Quedaron SIN RLS: %. Con la clave publica cualquiera podria leer o '
      'escribir movimientos de dinero ajenos.', sin_rls;
  end if;

  select string_agg(i, ', ') into faltan
  from unnest(array[
    'course_refund_windows_unica', 'refund_requests_viva_por_orden',
    'refund_requests_exito_unico', 'owner_sale_balances_orden_unica',
    'owner_transfers_viva_por_saldo', 'owner_transfers_idempotencia',
    'refund_policy_acceptances_unica'
  ]) as i
  where not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = i
  );
  if faltan is not null then
    raise exception
      'Faltan indices unicos: %. Sin ellos la idempotencia del dinero es un '
      '«if» de Python, que dos peticiones simultaneas se saltan.', faltan;
  end if;
end
$$;


-- =============================================================================
-- COMPROBACIONES A MANO (ejecutar DESPUÉS, una a una)
-- =============================================================================
--
-- 1. Las siete tablas, con RLS.
-- select relname, relrowsecurity from pg_class
-- where relname in ('course_refund_windows','refund_requests',
--   'refund_request_events','refund_policy_acceptances',
--   'owner_payout_accounts','owner_sale_balances','owner_transfers');
-- Esperado: relrowsecurity = true en las siete.
--
-- 2. Ninguna política de escritura (debe salir vacío).
-- select tablename, policyname, cmd from pg_policies
-- where schemaname = 'public'
--   and tablename like any (array['refund%','owner_%','course_refund%'])
--   and cmd <> 'SELECT';
--
-- 3. Nada de lo que ya había se ha tocado.
-- select count(*) from public.orders;
-- select count(*) from public.entitlements;
-- select count(*) from public.course_enrollments;
-- select count(*) from public.lesson_progress;
