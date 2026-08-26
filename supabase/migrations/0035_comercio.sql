-- ---------------------------------------------------------------------------
-- 0035 — Dominio comercial neutral
--
-- POR QUE HACE FALTA UN DOMINIO NUEVO Y NO BASTA `purchases`.
--
-- `purchases` (migracion 0001) mezcla tres cosas distintas en una sola fila:
-- la INTENCION de comprar, el COBRO y el DERECHO de acceso. Mientras hubo un
-- solo canal de venta —la web— eso se sostenia. Con tienda de Apple, tienda de
-- Google y web a la vez deja de sostenerse:
--
--   * El mismo curso tiene un identificador de producto DISTINTO en cada
--     tienda. En `purchases` no hay donde escribirlo.
--   * Un reembolso de Apple llega como un aviso sobre una TRANSACCION, no
--     sobre una fila de compra nuestra. Sin tabla de transacciones no hay
--     donde conciliarlo.
--   * Una compra puede reintentarse: el aviso llega dos y tres veces. La
--     idempotencia tiene que vivir en un UNIQUE, no en un `if` del backend,
--     porque dos peticiones simultaneas pasan las dos por el `if`.
--   * `sandbox` y `production` conviven. Sin la columna, una compra de prueba
--     regala un curso de verdad.
--
-- QUE SE HACE AQUI: se anaden SIETE tablas y NADA mas. No se toca `purchases`
-- —ni sus filas, ni sus politicas, ni su nombre—, no se toca `courses` y no se
-- toca ninguna funcion de acceso. El acceso lo cambia la 0036; esta migracion
-- solo pone donde guardar las cosas. Aplicada sola, la aplicacion se comporta
-- EXACTAMENTE igual que hoy.
--
-- LAS DOS IDEAS QUE SOSTIENEN EL DISENO:
--
--   1. El acceso lo decide `entitlements`, NO el proveedor. RevenueCat, Apple,
--      Google o Stripe validan que hubo un pago; quien dice si esta persona
--      puede ver el curso es esta base. Si manana se cambia de pasarela, el
--      acceso concedido no se mueve.
--   2. El importe NUNCA llega del cliente. `orders.amount_minor` lo escribe el
--      servidor leyendo el catalogo. En unidad MENOR (centimos) y entera:
--      un flotante en dinero acaba en descuadres.
--
-- ---------------------------------------------------------------------------
-- LA RLS DE ESTA MIGRACION, Y ES LO MAS IMPORTANTE DEL FICHERO
--
-- **NINGUNA de las siete tablas tiene politica de INSERT, UPDATE o DELETE para
-- usuarios.** Ni una. Conceder y revocar pasa SIEMPRE por el backend, que se
-- conecta con identidad de servicio y no pasa por la RLS.
--
-- No es celo: la clave `anon` de Supabase viaja dentro de la aplicacion movil y
-- se puede leer descompilandola. Cualquiera puede abrir un cliente con su
-- propia sesion y hacer un `insert` contra PostgREST. Si `entitlements`
-- aceptara escrituras de `authenticated`, bastaria una linea para regalarse el
-- catalogo entero, y quedaria registrado como una concesion legitima.
--
-- Lectura: cada quien la suya. `provider_products` solo administracion —los
-- identificadores de producto de las tiendas no son asunto del usuario— y
-- `payment_events` NADIE: ni lee ni escribe. El payload de un aviso trae datos
-- del cobro y a veces del comprador.
--
-- Habilitar RLS sin escribir ninguna politica NO es un olvido: en PostgreSQL
-- una tabla con RLS activa y sin politica que aplique deniega todo. Es
-- exactamente lo que se quiere para `payment_events`.
--
-- ---------------------------------------------------------------------------
-- El script es REPETIBLE e IDEMPOTENTE: aditivo de principio a fin.
--
-- DESPUES DE APLICARLA, REINICIA LA API. El backend comprueba UNA VEZ por
-- proceso si estas tablas existen —para poder funcionar sin ellas mientras la
-- migracion espera aprobacion— y se queda con la respuesta.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Que se vende (neutral respecto al proveedor)
-- ---------------------------------------------------------------------------
--
-- Un producto comercial es «el derecho que se compra», no «el archivo que se
-- descarga». Hoy solo existe una forma: acceso permanente a un curso. La
-- columna `kind` existe igualmente porque el dia que haya otra —un pack, un
-- acceso temporal— anadirla a una tabla ya llena obliga a decidir que
-- significan las filas viejas, y esa decision se toma mal con prisa.
create table if not exists public.commerce_products (
  id uuid primary key default gen_random_uuid(),

  kind text not null default 'course_lifetime' check (kind in ('course_lifetime')),

  -- Nulo para un producto futuro que no sea de curso. Para `course_lifetime`
  -- es obligatorio, y eso lo exige el CHECK de abajo.
  course_id uuid references public.courses(id) on delete restrict,

  -- Apagado por defecto no: un producto se crea para venderse. Lo que si esta
  -- apagado por defecto es la venta entera (`payments_enabled` en el backend).
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint commerce_products_curso_obligatorio
    check (kind <> 'course_lifetime' or course_id is not null)
);

-- Un curso, un producto de acceso permanente. Parcial porque el dia que
-- `kind` tenga mas valores, dos productos distintos del mismo curso seran
-- legitimos: lo que no puede haber son dos «acceso permanente» del mismo curso,
-- porque entonces comprar uno u otro daria derechos distintos al mismo
-- contenido y nadie sabria cual mirar.
create unique index if not exists commerce_products_curso_unico
  on public.commerce_products (course_id)
  where kind = 'course_lifetime';

drop trigger if exists commerce_products_set_updated_at on public.commerce_products;
create trigger commerce_products_set_updated_at
  before update on public.commerce_products
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 2. Como se llama ese producto en cada tienda
-- ---------------------------------------------------------------------------
--
-- Esta es la tabla que `purchases` no tenia y por la que hacia falta rehacer
-- el dominio. El mismo curso es `com.zexcelencia.curso.x` en Apple, otro id en
-- Google y un `price_id` en Stripe. Sin esta tabla, el backend no puede
-- traducir «me han comprado ESTE producto de la tienda» a «esta persona tiene
-- derecho a ESTE curso», y esa traduccion es todo el trabajo del webhook.
--
-- `environment` no es un adorno: las tiendas mandan compras de prueba con la
-- misma forma que las de verdad. Sin separar los identificadores, una compra
-- en sandbox concede acceso real.
create table if not exists public.provider_products (
  id uuid primary key default gen_random_uuid(),

  commerce_product_id uuid not null
    references public.commerce_products(id) on delete cascade,

  provider text not null
    check (provider in ('revenuecat_test', 'google', 'apple', 'stripe')),

  environment text not null check (environment in ('sandbox', 'production')),

  -- El identificador TAL Y COMO lo conoce la tienda.
  external_product_id text not null,

  active boolean not null default true,

  created_at timestamptz not null default now(),

  -- Un identificador de tienda apunta a UN producto nuestro. Sin esto, dos
  -- filas podrian mandar la misma compra a dos cursos distintos y cual gana
  -- dependeria del orden de lectura.
  unique (provider, environment, external_product_id),

  -- Y al reves: un producto nuestro tiene UN identificador por tienda y
  -- entorno. Con dos, la pantalla no sabria cual pedirle a la tienda.
  unique (commerce_product_id, provider, environment)
);

create index if not exists provider_products_producto_idx
  on public.provider_products (commerce_product_id, provider, environment);


-- ---------------------------------------------------------------------------
-- 3. La intencion de compra
-- ---------------------------------------------------------------------------
--
-- Una orden es «esta persona quiso comprar esto, por aqui, y por este importe».
-- No concede nada. Se separa del cobro a proposito: la orden la crea nuestro
-- servidor ANTES de hablar con la tienda, y es donde se congela el importe.
-- Si el precio del curso sube mientras alguien esta pagando, paga lo que se le
-- enseño.
--
-- `channel` es DONDE ocurre (el sistema desde el que se compra) y `provider`
-- es QUIEN cobra. No son lo mismo: una compra en Android puede cobrarla Google
-- o Stripe segun como este configurado el producto.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.profiles(id) on delete cascade,

  commerce_product_id uuid not null
    references public.commerce_products(id) on delete restrict,

  provider text not null,
  channel text not null check (channel in ('ios', 'android', 'web')),
  environment text not null default 'production',

  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'cancelled', 'refunded')),

  -- Unidad MENOR de la moneda y entero. Nunca coma flotante: en dinero eso
  -- acaba en descuadres de un centimo que nadie sabe explicar.
  amount_minor integer not null default 0 check (amount_minor >= 0),
  currency text not null default 'PEN' check (char_length(currency) = 3),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Se rellena SOLO cuando el cobro se confirma servidor a servidor. Un
  -- «success» del cliente no lo escribe.
  paid_at timestamptz
);

create index if not exists orders_usuario_idx
  on public.orders (user_id, created_at desc);
create index if not exists orders_producto_estado_idx
  on public.orders (commerce_product_id, status);

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 4. El cobro que de verdad ocurrio
-- ---------------------------------------------------------------------------
--
-- Aqui vive la IDEMPOTENCIA del dinero, y vive en el UNIQUE de abajo, no en el
-- backend. Las tiendas reintentan sus avisos: si dos llegan a la vez, las dos
-- peticiones pasarian por cualquier comprobacion escrita en Python —leen antes
-- de que la otra escriba— y se registraria el cobro dos veces. El indice unico
-- no se puede esquivar: la segunda insercion choca, y punto.
--
-- Un reembolso es OTRA fila (`kind = 'refund'`), no un `update` de la compra.
-- Machacar la fila del cobro borraria que la compra existio, y hace falta para
-- cuadrar cuentas y para saber por que se revoco un acceso.
create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),

  -- Nulo permitido a proposito: una regularizacion o una compra recuperada de
  -- la tienda puede llegar sin orden nuestra. Perder el cobro por no tener a
  -- que engancharlo seria peor que guardarlo suelto.
  order_id uuid references public.orders(id) on delete set null,

  provider text not null,
  environment text not null default 'production',

  -- El identificador del cobro EN LA TIENDA. Es la llave de la idempotencia.
  external_transaction_id text not null,

  kind text not null default 'purchase' check (kind in ('purchase', 'refund')),

  amount_minor integer not null default 0 check (amount_minor >= 0),
  currency text not null default 'PEN' check (char_length(currency) = 3),

  created_at timestamptz not null default now(),

  unique (provider, environment, external_transaction_id)
);

create index if not exists payment_transactions_orden_idx
  on public.payment_transactions (order_id);


-- ---------------------------------------------------------------------------
-- 5. Los avisos recibidos, en crudo
-- ---------------------------------------------------------------------------
--
-- Se guarda el aviso ANTES de interpretarlo y con su payload entero. Dos
-- razones, las dos aprendidas caras en otros sitios:
--
--   * ANTI-REPLAY: el UNIQUE (provider, external_event_id) hace que reenviar
--     un aviso capturado no vuelva a ejecutar nada. Sin el, quien intercepte
--     un webhook puede repetirlo hasta conseguir el efecto que quiera.
--   * FORENSE: cuando un cobro no cuadra, lo unico que permite saber que dijo
--     la tienda es lo que dijo la tienda. Un resumen nuestro ya es una
--     interpretacion, y la interpretacion es justo lo que se sospecha.
--
-- `processed_at` nulo = recibido pero todavia no aplicado. `error` con texto =
-- se intento y fallo; hay que mirarlo a mano. Los dos juntos permiten
-- reprocesar sin adivinar.
create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),

  provider text not null,
  external_event_id text not null,
  event_type text not null,
  environment text not null default 'production',

  payload jsonb not null default '{}'::jsonb,

  processed_at timestamptz,
  error text,

  created_at timestamptz not null default now(),

  unique (provider, external_event_id)
);

create index if not exists payment_events_sin_procesar_idx
  on public.payment_events (created_at desc)
  where processed_at is null;


-- ---------------------------------------------------------------------------
-- 6. EL DERECHO. La unica fuente de verdad del acceso.
-- ---------------------------------------------------------------------------
--
-- Todo lo anterior es contabilidad. Esta tabla es la que responde «¿puede esta
-- persona ver este curso?». Se separa del cobro para que el acceso sobreviva a
-- cambiar de pasarela, y para que un regalo, una beca o una compensacion se
-- puedan conceder sin inventarse un cobro que no existio.
--
-- `expires_at` es NULO en compra unica, que es lo unico que hay hoy. La
-- columna existe desde el principio porque el dia que haya suscripcion no se
-- puede anadir a una tabla con derechos ya concedidos sin decidir que
-- significan los antiguos, y esa decision tomada con prisa deja gente fuera.
create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.profiles(id) on delete cascade,

  commerce_product_id uuid not null
    references public.commerce_products(id) on delete restrict,

  status text not null default 'active'
    check (status in ('active', 'revoked', 'expired')),

  -- Quien lo origino: la tienda, o 'manual' cuando lo concede administracion.
  -- Sin CHECK a proposito: aqui caben origenes que no son pasarelas.
  source_provider text not null default 'manual',

  -- El cobro que lo justifica, si lo hubo. Nulo en concesiones manuales y en
  -- lo heredado de `purchases`.
  transaction_id uuid references public.payment_transactions(id) on delete set null,

  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  expires_at timestamptz
);

-- LA IDEMPOTENCIA DEL ACCESO, y es un indice parcial por una razon concreta:
-- un derecho ACTIVO solo puede haber uno por persona y producto, pero
-- revocados puede haber varios —se compro, se reembolso, se volvio a comprar—
-- y ese historial no se puede perder. Un unique total obligaria a borrar la
-- fila vieja, es decir, a borrar que aquello paso.
create unique index if not exists entitlements_activo_unico
  on public.entitlements (user_id, commerce_product_id)
  where status = 'active';

create index if not exists entitlements_usuario_idx
  on public.entitlements (user_id, status);
create index if not exists entitlements_producto_idx
  on public.entitlements (commerce_product_id, status);


-- ---------------------------------------------------------------------------
-- 7. La matricula
-- ---------------------------------------------------------------------------
--
-- Responde a una pregunta distinta de la del derecho: «¿este curso esta en mi
-- lista?». Un curso gratuito al que alguien se apunta genera matricula y NO
-- genera derecho —no hay nada que comprar—; una compra genera las dos cosas.
--
-- `source` guarda POR QUE esta ahi. Sin esa columna, el dia que se limpien
-- matriculas no habria forma de distinguir la de quien pago de la de quien
-- pulso «apuntarme» en un curso gratis, y limpiar la equivocada quita a
-- alguien de un curso por el que pago.
create table if not exists public.course_enrollments (
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,

  source text not null
    check (source in ('free', 'entitlement', 'author', 'admin', 'legacy')),

  created_at timestamptz not null default now(),

  primary key (user_id, course_id)
);

create index if not exists course_enrollments_curso_idx
  on public.course_enrollments (course_id);


-- ---------------------------------------------------------------------------
-- 8. RLS — leer lo propio, escribir NADA
-- ---------------------------------------------------------------------------
--
-- Repetido aqui porque es lo que hay que revisar si algun dia se anade una
-- politica a este fichero: **no existe ni una sola politica de INSERT, UPDATE
-- o DELETE en toda esta migracion, ni la puede haber.** Tampoco `for all`, que
-- las incluye las tres. Hay una prueba automatica que lee este fichero y falla
-- si aparece alguna.

alter table public.commerce_products enable row level security;
alter table public.provider_products enable row level security;
alter table public.orders enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.payment_events enable row level security;
alter table public.entitlements enable row level security;
alter table public.course_enrollments enable row level security;

-- Que se vende: lo activo lo puede consultar cualquiera con sesion, igual que
-- ya puede consultar el precio del curso. Esconderlo no protege nada —el
-- precio se enseña en la ficha— y sin ello la pantalla no puede distinguir
-- «no esta a la venta aqui» de «no hay producto», que es la diferencia entre
-- explicarlo y dejar un boton muerto.
drop policy if exists commerce_products_read on public.commerce_products;
create policy commerce_products_read on public.commerce_products
  for select to authenticated
  using (active or public.is_admin());

-- Los identificadores de las tiendas NO son asunto del usuario: revelan como
-- esta montada la venta y no le sirven de nada a la aplicacion, que pide el
-- producto por curso a nuestro backend.
drop policy if exists provider_products_admin_read on public.provider_products;
create policy provider_products_admin_read on public.provider_products
  for select to authenticated
  using (public.is_admin());

-- Las ordenes propias: para poder enseñar «compra en curso» o «fallo el pago»
-- sin preguntarle al backend.
drop policy if exists orders_read_own on public.orders;
create policy orders_read_own on public.orders
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Los cobros no llevan `user_id`: se cuelgan de la orden. Una transaccion sin
-- orden (regularizacion) no la ve nadie salvo administracion, y es correcto:
-- si no se sabe de quien es, no se puede decir que es tuya.
drop policy if exists payment_transactions_read_own on public.payment_transactions;
create policy payment_transactions_read_own on public.payment_transactions
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.orders o
      where o.id = payment_transactions.order_id
        and o.user_id = auth.uid()
    )
  );

-- `payment_events` NO LLEVA POLITICA. Ninguna, a proposito: con RLS activa y
-- sin politica, PostgreSQL deniega todo a `authenticated`. Solo el backend,
-- que se conecta con identidad de servicio, la ve.

drop policy if exists entitlements_read_own on public.entitlements;
create policy entitlements_read_own on public.entitlements
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists course_enrollments_read_own on public.course_enrollments;
create policy course_enrollments_read_own on public.course_enrollments
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());


-- ---------------------------------------------------------------------------
-- 9. Refrescar el cache de esquema de PostgREST
-- ---------------------------------------------------------------------------
-- Sin esto la API de Supabase sigue sirviendo el esquema viejo y responde
-- PGRST205 sobre tablas que ya existen.
notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- 10. Comprobaciones
-- ---------------------------------------------------------------------------

-- Las siete tablas. Esperado: siete filas, todas OK.
select t.nombre as comprobacion,
       case when to_regclass('public.' || t.nombre) is null then 'FALTA' else 'OK' end
         as estado
from (values
  ('commerce_products'), ('provider_products'), ('orders'),
  ('payment_transactions'), ('payment_events'), ('entitlements'),
  ('course_enrollments')
) as t(nombre);

-- RLS activa en las siete. Esperado: siete filas con rowsecurity = true.
select relname, relrowsecurity as rls_activa
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'commerce_products', 'provider_products', 'orders',
    'payment_transactions', 'payment_events', 'entitlements',
    'course_enrollments'
  )
order by relname;

-- LA COMPROBACION QUE IMPORTA: ninguna politica de escritura para usuarios.
-- Esperado: CERO filas. Si sale alguna, alguien puede concederse acceso solo.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'commerce_products', 'provider_products', 'orders',
    'payment_transactions', 'payment_events', 'entitlements',
    'course_enrollments'
  )
  and cmd <> 'SELECT'
order by tablename, policyname;

-- `payment_events` sin ninguna politica. Esperado: CERO filas.
select policyname from pg_policies
where schemaname = 'public' and tablename = 'payment_events';

-- Los indices unicos que sostienen la idempotencia. Esperado: tres filas.
select indexname from pg_indexes
where schemaname = 'public'
  and indexname in (
    'entitlements_activo_unico',
    'commerce_products_curso_unico',
    'payment_transactions_provider_environment_external_transacti_key'
  )
order by indexname;
-- Nota: el ultimo nombre lo genera PostgreSQL a partir del UNIQUE de la tabla
-- y lo recorta a 63 caracteres. Si no sale, comprobalo asi:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.payment_transactions'::regclass and contype = 'u';
