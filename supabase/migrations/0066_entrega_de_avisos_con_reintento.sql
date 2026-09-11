-- 0066 · La entrega de un aviso, con reintento y en el idioma de quien lee.
--
-- SIN APLICAR.
--
-- QUÉ CIERRA. El módulo de avisos tenía dos huecos que había que tapar antes de
-- que la posventa dependiera de él:
--
--   1. Las plantillas estaban solo en español, escritas en el código.
--   2. Un envío que fallaba se registraba y se perdía. No había cola, ni
--      reintento, ni forma de saber después qué no llegó.
--
-- EL IDIOMA VIVE EN EL DISPOSITIVO. No hay ninguna columna de idioma en el
-- perfil, y añadirla obligaría a inventar una preferencia que nadie ha
-- elegido. El teléfono sí sabe en qué idioma está, y ya registra su token: se
-- guarda ahí. Nulo significa «no lo dijo», y entonces manda el idioma por
-- defecto del servidor.
--
-- LA COLA ES UNA TABLA, NO UN SISTEMA. Una fila por entrega, con su estado, sus
-- intentos y cuándo toca el siguiente. Quien la vacía es un endpoint
-- administrativo idempotente que invoca un planificador EXTERNO; dentro de la
-- API no hay ningún temporizador, porque hay varias réplicas y cada una
-- dispararía el suyo.
--
-- UNA ENTREGA POR SUCESO DE NEGOCIO. `dedupe_key` con índice único parcial: el
-- webhook de la pasarela se reintenta, y tres reintentos del mismo reembolso no
-- pueden ser tres veces que suena el teléfono.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE. Esquema antes que código: una tabla
-- vacía y una columna nula que nadie lee. Código antes que esquema: el envío
-- sigue siendo el de hoy —directo, sin cola— y la ruta de proceso responde 503.
--
-- BACKFILL: NINGUNO. No hay entregas anteriores que traer: hasta ahora no se
-- guardaban.
--
-- ROLLBACK: `drop table public.notification_deliveries` y
-- `alter table public.device_tokens drop column locale`. No se toca ninguna
-- fila existente, así que revertir no le quita nada a lo anterior.

-- ------------------------------------------------------------------------- --
-- 1. El idioma del dispositivo.
-- ------------------------------------------------------------------------- --
alter table public.device_tokens
  add column if not exists locale text;

do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'device_tokens'
      and c.conname = 'device_tokens_idioma'
  ) then
    alter table public.device_tokens
      add constraint device_tokens_idioma
      check (locale is null or locale in ('es', 'en', 'pt'));
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. La cola de entregas.
-- ------------------------------------------------------------------------- --
create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),

  -- El aviso in-app al que acompaña, si lo hay. `on delete cascade`: si el
  -- aviso desaparece, su entrega no tiene sentido.
  notification_id uuid references public.notifications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,

  type text not null
    constraint notification_deliveries_tipo
    check (length(trim(type)) between 1 and 64),

  -- El idioma con el que se compuso. Se guarda para poder explicar después por
  -- qué un aviso salió en un idioma y no en otro.
  locale text not null default 'es'
    constraint notification_deliveries_idioma check (locale in ('es', 'en', 'pt')),

  status text not null default 'pending'
    constraint notification_deliveries_estado
    check (status in ('pending', 'sent', 'failed')),

  attempts integer not null default 0
    constraint notification_deliveries_intentos check (attempts >= 0),
  max_attempts integer not null default 5
    constraint notification_deliveries_tope check (max_attempts between 1 and 20),
  next_attempt_at timestamptz,

  -- El último error, SANEADO y acotado. Ni cuerpos de respuesta, ni tokens.
  last_error text
    constraint notification_deliveries_error
    check (last_error is null or length(last_error) <= 500),

  -- Para poder seguir un aviso desde el hecho que lo provocó.
  correlation_id text
    constraint notification_deliveries_correlacion
    check (correlation_id is null or length(correlation_id) <= 64),

  -- QUÉ SUCESO DE NEGOCIO es este. Nulo = no se deduplica.
  dedupe_key text
    constraint notification_deliveries_clave
    check (dedupe_key is null or length(dedupe_key) <= 200),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,

  -- ENVIADA ES ENVIADA. Sin fecha no se puede decir cuándo, y «enviada» sin
  -- cuándo no sirve para investigar nada.
  constraint notification_deliveries_enviada_con_fecha
    check ((status = 'sent') = (sent_at is not null)),
  -- Pendiente es lo único que tiene próximo intento.
  constraint notification_deliveries_pendiente_con_turno
    check (status <> 'pending' or next_attempt_at is not null)
);

-- UNA ENTREGA POR SUCESO. El webhook se reintenta; el teléfono no puede sonar
-- tres veces por el mismo reembolso.
create unique index if not exists notification_deliveries_suceso_unico
  on public.notification_deliveries (dedupe_key)
  where dedupe_key is not null;

-- La cola que vacía el planificador externo. Parcial: las enviadas y las
-- fallidas definitivas no se recorren nunca.
create index if not exists notification_deliveries_pendientes
  on public.notification_deliveries (next_attempt_at, id)
  where status = 'pending';

create index if not exists notification_deliveries_de_la_persona
  on public.notification_deliveries (user_id, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 3. RLS y permisos: cerrado. El móvil no lee ni escribe esta cola.
--
-- Una entrega lleva el tipo de suceso y a quién iba dirigido. El teléfono ya
-- recibe sus avisos por su canal; la cola es de operación.
-- ------------------------------------------------------------------------- --
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_deliveries from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 4. Verificación posterior.
-- ------------------------------------------------------------------------- --
do $$
declare
  cuantas bigint;
  permisos bigint;
begin
  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'device_tokens'
      and a.attname = 'locale' and a.attnum > 0 and not a.attisdropped
  ) then
    raise exception 'La 0066 no dejó device_tokens.locale';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'notification_deliveries_suceso_unico'
  ) then
    raise exception 'La 0066 no dejó el índice de suceso único';
  end if;

  -- ESTE FICHERO NO ESCRIBE NINGUNA FILA, y se comprueba leyéndolo: aquí no
  -- hay ningún `insert`. Antes esta verificación contaba las filas y abortaba
  -- si había alguna, lo cual convertía la migración en NO RE-EJECUTABLE: en
  -- cuanto existiera una entrega, volver a aplicar el fichero —cosa que hacen
  -- el editor de Supabase y cualquier runner que reaplique— fallaba con una
  -- excepción que no significaba nada malo.

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name = 'notification_deliveries'
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'La cola de avisos tiene % permisos sueltos', permisos;
  end if;
end;
$$;
