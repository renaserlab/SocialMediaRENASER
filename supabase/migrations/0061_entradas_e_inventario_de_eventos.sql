-- 0061 · Tipos de entrada, inventario y reserva temporal.
--
-- SIN APLICAR. Y además detrás de una bandera: `FEATURE_EVENT_TICKETING` nace
-- apagada. Con la migración puesta y la bandera apagada los datos existen y el
-- flujo comercial no se ofrece; con la migración sin poner, las rutas nuevas
-- responden 503 `event_ticketing_not_available` y todo lo demás —catálogo,
-- ficha, reserva gratuita— funciona exactamente igual.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE. Código antes que esquema: las rutas
-- nuevas contestan 503 y ninguna consulta existente cambia. Esquema antes que
-- código: cuatro tablas que nadie lee todavía, sin una sola fila, y ni `events`
-- ni `event_registrations` ni `event_operations` se tocan.
--
-- AQUÍ NO SE COBRA NADA. No hay orden, ni pago, ni entrada emitida, ni QR, ni
-- liquidación. Lo que se guarda es una RESERVA TEMPORAL: cuántas entradas de
-- qué tipo aparta alguien durante diez minutos. Nada de esto es una compra, y
-- el contrato lo dice: `event_ticket_holds.status` admite `CONSUMED`, pero
-- ningún camino de este incremento lo escribe porque no existe la orden que lo
-- justificaría.
--
-- LO QUE LA BASE SOSTIENE, y no un `if` de Python:
--
--   * Una sola moneda por evento. Clave ajena COMPUESTA `(event_id, currency)`
--     de los tipos contra la configuración: un tipo en dólares dentro de un
--     evento en soles no entra.
--   * Un tipo de entrada de OTRO evento no puede estar en una reserva. Otra
--     clave ajena compuesta, la misma idea que usa `quiz_answers` en la 0058.
--   * `subtotal = cantidad × precio unitario`, en cada línea.
--   * La suma de las líneas cuadra con la cabecera. Es una restricción entre
--     filas, así que la sostiene un disparador DIFERIDO: se comprueba al
--     confirmar, cuando ya están todas las líneas escritas.
--   * Un solo hold ACTIVO por persona y evento (índice parcial).
--   * Una clave de idempotencia no se repite para la misma persona y evento.
--   * Cantidades y precios enteros y no negativos. Nunca un flotante: en dinero
--     un flotante es un descuadre con fecha.
--
-- BACKFILL: NINGUNO, y se declara.
--
-- No se escribe una fila de configuración por evento. La ausencia de fila
-- SIGNIFICA `FREE_RSVP`, que es lo que son todos los eventos de hoy: ocho, con
-- tres reservas gratuitas entre todos. Escribirles una fila que dijera
-- exactamente lo que ya se sabe por su ausencia sería ruido, y además haría
-- creer que alguien decidió algo sobre ellos.
--
-- ROLLBACK REALISTA:
--   drop trigger if exists event_ticket_hold_items_cuadran on public.event_ticket_hold_items;
--   drop function if exists public.exigir_que_el_hold_cuadre();
--   drop table if exists public.event_ticket_hold_items;
--   drop table if exists public.event_ticket_holds;
--   drop table if exists public.event_ticket_types;
--   drop table if exists public.event_ticketing_settings;
-- Ninguna toca nada anterior, así que deshacerla devuelve la base al estado de
-- la 0060 sin perder un evento, una reserva ni una decisión de admisión.

-- ------------------------------------------------------------------------- --
-- 1. Configuración de venta. Una fila por evento, o ninguna.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_ticketing_settings (
  event_id uuid primary key references public.events(id) on delete cascade,

  -- SIN FILA SIGNIFICA `FREE_RSVP`. El valor por omisión existe para quien
  -- inserte sin decirlo, no para poblar la tabla.
  --
  -- `INVITATION_ONLY` está en el contrato y NO tiene flujo: se acepta en la
  -- columna para no necesitar otra migración cuando lo tenga, y el servicio se
  -- niega a ofrecerlo. Un modo que la base admite y la aplicación no enseña es
  -- honesto; uno que la aplicación enseña sin flujo detrás, no.
  access_mode text not null default 'FREE_RSVP'
    constraint event_ticketing_settings_modo
    check (access_mode in ('FREE_RSVP', 'TICKETED', 'INVITATION_ONLY')),

  -- ISO 4217. Una sola por evento: los tipos la heredan por clave ajena.
  currency char(3) not null default 'PEN'
    constraint event_ticketing_settings_moneda check (currency ~ '^[A-Z]{3}$'),

  -- Tope por operación, para toda la reserva. `null` = sin tope propio; manda
  -- entonces el de cada tipo.
  max_per_order integer
    constraint event_ticketing_settings_tope
    check (max_per_order is null or max_per_order > 0),

  sales_open_at timestamptz,
  sales_close_at timestamptz
    constraint event_ticketing_settings_ventana
    check (
      sales_open_at is null
      or sales_close_at is null
      or sales_close_at > sales_open_at
    ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- La pareja que los tipos referencian para heredar la moneda.
  constraint event_ticketing_settings_evento_moneda unique (event_id, currency)
);

-- ------------------------------------------------------------------------- --
-- 2. Tipos de entrada.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  name text not null
    constraint event_ticket_types_nombre check (length(trim(name)) between 1 and 80),
  description text not null default ''
    constraint event_ticket_types_descripcion check (length(description) <= 500),

  -- EN UNIDAD MENOR Y ENTERO. 4900 son S/ 49.00. Cero es válido: una entrada
  -- gratuita dentro de un evento con entradas es un caso real —una cortesía—,
  -- y no es lo mismo que un evento `FREE_RSVP`.
  price_minor integer not null
    constraint event_ticket_types_precio check (price_minor >= 0),
  currency char(3) not null
    constraint event_ticket_types_moneda check (currency ~ '^[A-Z]{3}$'),

  quota integer not null
    constraint event_ticket_types_cupo check (quota > 0),

  min_per_order integer not null default 1
    constraint event_ticket_types_minimo check (min_per_order > 0),
  max_per_order integer not null default 10
    constraint event_ticket_types_maximo check (max_per_order > 0),
  constraint event_ticket_types_rango check (max_per_order >= min_per_order),

  inclusions text[] not null default '{}',
  restrictions text[] not null default '{}',

  -- `retired` no borra: una reserva puede estar apuntando a este tipo y su
  -- resumen tiene que seguir contando lo mismo.
  status text not null default 'draft'
    constraint event_ticket_types_estado
    check (status in ('draft', 'on_sale', 'paused', 'retired')),

  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- UNA SOLA MONEDA POR EVENTO. La clave ajena compuesta contra la
  -- configuración: para meter un tipo en dólares habría que cambiar la moneda
  -- del evento entero, que es justo la decisión que se quiere que sea explícita.
  constraint event_ticket_types_moneda_del_evento
    foreign key (event_id, currency)
    references public.event_ticketing_settings (event_id, currency)
    on delete cascade,

  -- La pareja que las líneas de reserva referencian: un tipo de OTRO evento no
  -- puede colarse en una reserva.
  constraint event_ticket_types_de_su_evento unique (event_id, id)
);

-- ORDEN ESTABLE. `sort_order` puede empatar —el organizador arrastra dos al
-- mismo sitio—, y sin el desempate la lista cambia de orden entre dos cargas.
create index if not exists event_ticket_types_en_orden
  on public.event_ticket_types (event_id, sort_order, created_at, id);

-- ------------------------------------------------------------------------- --
-- 3. Reservas temporales (holds). NO son compras.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_ticket_holds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- La clave que manda el cliente. Un reintento con la misma clave devuelve la
  -- MISMA reserva en vez de apartar otras tantas entradas.
  idempotency_key text not null
    constraint event_ticket_holds_clave check (length(trim(idempotency_key)) between 1 and 200),

  -- Huella de lo pedido. Sirve para distinguir «el mismo intento otra vez» de
  -- «otra cosa con la misma clave», que es un error del cliente y merece un
  -- conflicto en vez de devolverle una reserva que no pidió.
  request_fingerprint text not null,

  status text not null default 'ACTIVE'
    constraint event_ticket_holds_estado
    check (status in ('ACTIVE', 'EXPIRED', 'RELEASED', 'CONSUMED')),

  currency char(3) not null
    constraint event_ticket_holds_moneda check (currency ~ '^[A-Z]{3}$'),

  -- Suma de las líneas. El disparador de más abajo lo comprueba.
  subtotal_minor integer not null
    constraint event_ticket_holds_subtotal check (subtotal_minor >= 0),

  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_ticket_holds_clave_unica unique (event_id, user_id, idempotency_key),
  constraint event_ticket_holds_de_su_evento unique (id, event_id)
);

-- UN SOLO HOLD ACTIVO POR PERSONA Y EVENTO. Índice parcial: los vencidos,
-- liberados y consumidos no estorban.
--
-- No dice «y no vencido» porque `now()` no es inmutable y un índice no puede
-- llamarlo. Lo resuelve el servicio: antes de crear uno, marca como `EXPIRED`
-- los de esa persona que ya pasaron de hora. Así el índice sostiene la
-- invariante y el reloj no entra en él.
create unique index if not exists event_ticket_holds_uno_activo
  on public.event_ticket_holds (event_id, user_id)
  where status = 'ACTIVE';

-- Buscar los activos de un evento es la consulta del cálculo de disponibilidad.
create index if not exists event_ticket_holds_activos_por_evento
  on public.event_ticket_holds (event_id, status, expires_at);

-- Y la limpieza recorre por vencimiento.
create index if not exists event_ticket_holds_por_vencer
  on public.event_ticket_holds (expires_at)
  where status = 'ACTIVE';

-- ------------------------------------------------------------------------- --
-- 4. Líneas de la reserva.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_ticket_hold_items (
  id uuid primary key default gen_random_uuid(),
  hold_id uuid not null,
  -- Se repite el evento para poder exigir con claves ajenas COMPUESTAS que la
  -- línea, su reserva y su tipo hablen del mismo evento. Es la misma forma que
  -- usa `quiz_answers` en la 0058.
  event_id uuid not null,
  ticket_type_id uuid not null,

  quantity integer not null
    constraint event_ticket_hold_items_cantidad check (quantity > 0),

  -- EL PRECIO CONGELADO. Se copia del tipo al crear la reserva: si el
  -- organizador lo cambia después, el resumen sigue diciendo lo que se apartó.
  unit_price_minor integer not null
    constraint event_ticket_hold_items_precio check (unit_price_minor >= 0),
  subtotal_minor integer not null
    constraint event_ticket_hold_items_subtotal
    check (subtotal_minor = quantity * unit_price_minor),

  -- Y el nombre, también congelado, por lo mismo.
  ticket_type_name_snapshot text not null
    constraint event_ticket_hold_items_nombre check (length(trim(ticket_type_name_snapshot)) >= 1),

  created_at timestamptz not null default now(),

  constraint event_ticket_hold_items_de_su_hold
    foreign key (hold_id, event_id)
    references public.event_ticket_holds (id, event_id) on delete cascade,
  constraint event_ticket_hold_items_de_su_evento
    foreign key (event_id, ticket_type_id)
    references public.event_ticket_types (event_id, id) on delete restrict,

  -- UNA LÍNEA POR TIPO DENTRO DE UNA RESERVA. Dos líneas del mismo tipo son dos
  -- formas de decir lo mismo, y la segunda se olvida al sumar.
  constraint event_ticket_hold_items_un_tipo unique (hold_id, ticket_type_id)
);

create index if not exists event_ticket_hold_items_por_tipo
  on public.event_ticket_hold_items (ticket_type_id);

-- ------------------------------------------------------------------------- --
-- 5. La suma de las líneas cuadra con la cabecera.
-- ------------------------------------------------------------------------- --
--
-- Es una restricción ENTRE FILAS, así que no cabe en un CHECK. Va en un
-- disparador de restricción DIFERIDO: se comprueba al CONFIRMAR, cuando la
-- cabecera y todas sus líneas ya están escritas. Sin diferirlo, insertar la
-- cabecera con su subtotal antes que las líneas fallaría siempre.
create or replace function public.exigir_que_el_hold_cuadre()
returns trigger
language plpgsql
as $$
declare
  objetivo uuid := coalesce(new.hold_id, old.hold_id);
  suma integer;
  cabecera integer;
begin
  select coalesce(sum(subtotal_minor), 0) into suma
  from public.event_ticket_hold_items where hold_id = objetivo;

  select subtotal_minor into cabecera
  from public.event_ticket_holds where id = objetivo;

  -- La cabecera puede haberse borrado en la misma transacción (cascada).
  if cabecera is null then
    return null;
  end if;

  if suma <> cabecera then
    raise exception
      'El subtotal de la reserva (%) no cuadra con sus lineas (%)', cabecera, suma
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists event_ticket_hold_items_cuadran on public.event_ticket_hold_items;
create constraint trigger event_ticket_hold_items_cuadran
after insert or update or delete on public.event_ticket_hold_items
deferrable initially deferred
for each row execute function public.exigir_que_el_hold_cuadre();

-- ------------------------------------------------------------------------- --
-- 6. RLS y concesiones. Nacen cerradas, como manda la 0053.
-- ------------------------------------------------------------------------- --
alter table public.event_ticketing_settings enable row level security;
alter table public.event_ticket_types enable row level security;
alter table public.event_ticket_holds enable row level security;
alter table public.event_ticket_hold_items enable row level security;

revoke all on public.event_ticketing_settings from anon, authenticated;
revoke all on public.event_ticket_types from anon, authenticated;
revoke all on public.event_ticket_holds from anon, authenticated;
revoke all on public.event_ticket_hold_items from anon, authenticated;

-- NINGUNA POLÍTICA, por la misma razón que en la 0060: una política `for
-- select` entrega la fila entera. `event_ticket_types` parece pública —el
-- precio se enseña— pero la fila lleva además el cupo, el estado y los topes de
-- compra, que son inventario. La API elige qué sale; PostgREST no.

-- ------------------------------------------------------------------------- --
-- 7. Comprobación final.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text := '';
  t text;
begin
  foreach t in array array[
    'event_ticketing_settings', 'event_ticket_types',
    'event_ticket_holds', 'event_ticket_hold_items'
  ] loop
    if to_regclass('public.' || t) is null then
      faltan := faltan || 'tabla_' || t || ' ';
    end if;
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relrowsecurity
    ) then faltan := faltan || 'rls_' || t || ' '; end if;
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t
        and grantee in ('anon', 'authenticated')
    ) then faltan := faltan || 'concesion_' || t || ' '; end if;
    if exists (
      select 1 from pg_policies where schemaname = 'public' and tablename = t
    ) then faltan := faltan || 'politica_' || t || ' '; end if;
  end loop;

  -- Por NOMBRE, no por el texto de la definición: leerlo de vuelta depende de
  -- la versión de PostgreSQL y eso ya hizo fallar la 0057.
  foreach t in array array[
    'event_ticketing_settings_modo',
    'event_ticketing_settings_moneda',
    'event_ticketing_settings_ventana',
    'event_ticketing_settings_evento_moneda',
    'event_ticket_types_nombre',
    'event_ticket_types_precio',
    'event_ticket_types_cupo',
    'event_ticket_types_rango',
    'event_ticket_types_estado',
    'event_ticket_types_moneda_del_evento',
    'event_ticket_types_de_su_evento',
    'event_ticket_holds_estado',
    'event_ticket_holds_subtotal',
    'event_ticket_holds_clave_unica',
    'event_ticket_holds_de_su_evento',
    'event_ticket_hold_items_cantidad',
    'event_ticket_hold_items_subtotal',
    'event_ticket_hold_items_de_su_hold',
    'event_ticket_hold_items_de_su_evento',
    'event_ticket_hold_items_un_tipo'
  ] loop
    if not exists (select 1 from pg_constraint where conname = t) then
      faltan := faltan || t || ' ';
    end if;
  end loop;

  foreach t in array array[
    'event_ticket_types_en_orden',
    'event_ticket_holds_uno_activo',
    'event_ticket_holds_activos_por_evento',
    'event_ticket_holds_por_vencer',
    'event_ticket_hold_items_por_tipo'
  ] loop
    if to_regclass('public.' || t) is null then
      faltan := faltan || 'indice_' || t || ' ';
    end if;
  end loop;

  if not exists (
    select 1 from pg_trigger where tgname = 'event_ticket_hold_items_cuadran'
  ) then faltan := faltan || 'disparador_de_cuadre '; end if;

  -- Y que no se haya tocado nada de antes: ningún evento cambia de modo por
  -- esta migración, porque no se escribe ninguna fila.
  if exists (select 1 from public.event_ticketing_settings) then
    faltan := faltan || 'backfill_que_no_deberia_existir ';
  end if;

  if faltan <> '' then
    raise exception '0061 incompleta, falta: %', faltan;
  end if;
end $$;

notify pgrst, 'reload schema';
