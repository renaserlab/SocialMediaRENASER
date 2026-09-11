-- 0069 · La política publicada es inmutable, y la aceptación vive en el pedido.
--
-- SIN APLICAR.
--
-- POR QUÉ NO HAY TABLA NUEVA DE POLÍTICAS. `event_policies` (0064) ya tiene
-- todo lo que la decisión de la empresa pide: el evento (`scope='event'` +
-- `event_id`), el tipo, la versión, el estado borrador/publicada/superada, el
-- texto que lee quien compra (`body`), las reglas estructuradas (`params`),
-- quién la creó, quién la publicó, cuándo, y la huella `params_sha256`. Que
-- cada organizador tenga las suyas NO es un modelo nuevo: es usar el alcance de
-- evento que ya existía, con el dueño derivado de `events.organizer_id`.
--
-- EL DUEÑO NO SE DUPLICA EN UNA COLUMNA. Una política de evento pertenece a
-- quien organiza ESE evento, y eso ya lo dice `events.organizer_id`. Copiarlo
-- aquí crearía una segunda verdad que puede desincronizarse; quién la escribió
-- y quién la publicó SÍ se guardan, porque eso es historia y no pertenencia.
--
-- LO QUE DE VERDAD FALTABA SON DOS COSAS:
--
-- 1. NADA IMPEDÍA REESCRIBIR UNA POLÍTICA PUBLICADA. El estado estaba, la
--    huella estaba, y un `update` cambiaba los parámetros sin dejar rastro:
--    justo lo que la huella existe para impedir. Ahora lo impone un disparador,
--    no una convención del código.
--
-- 2. NADA ATABA UNA COMPRA A LA VERSIÓN QUE ACEPTÓ. Sin eso, «las compras
--    existentes conservan la versión aceptada» era una promesa sin respaldo:
--    publicar una versión nueva cambiaba en silencio las reglas de todo lo ya
--    vendido. `event_order_policy_acceptances` congela el identificador de la
--    política Y su huella, así que después se puede demostrar qué texto y qué
--    números aceptó esa persona.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE. Esquema antes que código: una tabla
-- vacía que nadie escribe y un disparador que solo prohíbe lo que el código ya
-- no hace. Código antes que esquema: la puerta de esquema apaga la aceptación y
-- las rutas contestan 503 con su código.
--
-- BACKFILL: NINGUNO. Las compras anteriores no tienen aceptación registrada, y
-- eso es un hecho, no un hueco que rellenar: nadie les enseñó una política
-- porque no había ninguna publicada. Inventarles una aceptación sería falsificar
-- un consentimiento.
--
-- ROLLBACK: `drop trigger` y `drop table`. Ninguna fila existente se toca.

-- ------------------------------------------------------------------------- --
-- 1. Una política publicada no se reescribe.
-- ------------------------------------------------------------------------- --
--
-- LA ÚNICA MODIFICACIÓN PERMITIDA es la que hace `publicar()` al superseder:
-- pasar de `published` a `superseded` y ponerle fecha de fin. Todo lo demás de
-- una fila publicada o superada queda cerrado, incluidos los parámetros, la
-- huella, el texto, la versión, el tipo y el evento.
--
-- Un borrador sí se edita: para eso es un borrador.
create or replace function public.event_policies_publicada_es_inmutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.status = 'draft' then
    return new;
  end if;

  -- El paso a superada: solo el estado y la fecha de fin.
  if old.status = 'published' and new.status = 'superseded' then
    if (new.policy_type, new.scope, new.event_id, new.jurisdiction, new.locale,
        new.version, new.params, new.params_sha256, new.body,
        new.effective_from, new.published_at, new.published_by,
        new.created_by) is distinct from
       (old.policy_type, old.scope, old.event_id, old.jurisdiction, old.locale,
        old.version, old.params, old.params_sha256, old.body,
        old.effective_from, old.published_at, old.published_by,
        old.created_by)
    then
      raise exception
        'Al superseder una política solo cambian su estado y su fecha de fin'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  raise exception 'Una política % no se modifica: se publica una versión nueva',
    old.status
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists event_policies_inmutable on public.event_policies;
create trigger event_policies_inmutable
  before update on public.event_policies
  for each row
  execute function public.event_policies_publicada_es_inmutable();

-- Y TAMPOCO SE BORRA. Borrar una política publicada deja expedientes apuntando
-- a una decisión que ya nadie puede leer.
create or replace function public.event_policies_publicada_no_se_borra()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.status = 'draft' then
    return old;
  end if;
  raise exception 'Una política % no se borra', old.status
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists event_policies_no_se_borra on public.event_policies;
create trigger event_policies_no_se_borra
  before delete on public.event_policies
  for each row
  execute function public.event_policies_publicada_no_se_borra();

-- UN BORRADOR POR EVENTO Y TIPO. Dos `PUT` simultáneos creaban dos filas
-- `draft`; el servicio lee una con `scalar()` —la primera que devuelva la base—
-- y la otra quedaba huérfana y visible en el historial. Esto no lo puede
-- resolver una comprobación en Python: entre mirar y escribir cabe la otra
-- petición.
create unique index if not exists event_policies_un_borrador_de_evento
  on public.event_policies (policy_type, event_id, jurisdiction, locale)
  where status = 'draft' and scope = 'event';

-- ------------------------------------------------------------------------- --
-- 2. Qué aceptó cada compra.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_order_policy_acceptances (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.event_orders(id) on delete cascade,
  policy_id uuid not null
    references public.event_policies(id) on delete restrict,

  -- CONGELADOS AL ACEPTAR. El identificador basta para leer la política, pero
  -- el tipo, la versión y la huella se copian para que la prueba siga en pie
  -- aunque mañana alguien mire mal la fila de al lado.
  policy_type text not null
    constraint event_order_policy_acceptances_tipo
    check (length(trim(policy_type)) between 1 and 64),
  policy_version text not null
    constraint event_order_policy_acceptances_version
    check (length(trim(policy_version)) between 1 and 32),
  params_sha256 text not null
    constraint event_order_policy_acceptances_huella
    check (params_sha256 ~ '^[0-9a-f]{64}$'),

  accepted_at timestamptz not null default now(),
  -- Quién aceptó. Es el comprador del pedido; se guarda porque un pedido puede
  -- cambiar de dueño y el consentimiento no.
  accepted_by uuid references public.profiles(id) on delete set null,

  -- UNA ACEPTACIÓN POR PEDIDO Y TIPO. Aceptar dos versiones del mismo tipo en
  -- la misma compra sería no saber cuál rige.
  constraint event_order_policy_acceptances_unica
    unique (order_id, policy_type)
);

create index if not exists event_order_policy_acceptances_del_pedido
  on public.event_order_policy_acceptances (order_id, policy_type);

create index if not exists event_order_policy_acceptances_de_la_politica
  on public.event_order_policy_acceptances (policy_id);

-- UNA ACEPTACIÓN NO SE REESCRIBE NI SE BORRA. Es un consentimiento: cambiarlo
-- después es falsificarlo. El pedido sí se puede borrar, y entonces cae con él.
create or replace function public.event_order_policy_acceptances_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'Una aceptación de política no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists event_order_policy_acceptances_inmutable
  on public.event_order_policy_acceptances;
create trigger event_order_policy_acceptances_inmutable
  before update or delete on public.event_order_policy_acceptances
  for each row
  execute function public.event_order_policy_acceptances_solo_anadir();

-- ------------------------------------------------------------------------- --
-- 3. RLS y permisos.
-- ------------------------------------------------------------------------- --
-- Igual que el resto de lo posventa: la aplicación no habla con esta tabla, y
-- por eso no hay ninguna política de acceso. Se entra por la API.
alter table public.event_order_policy_acceptances enable row level security;
revoke all on public.event_order_policy_acceptances from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 4. Verificación.
-- ------------------------------------------------------------------------- --
-- Este fichero NO escribe ninguna fila, y se comprueba leyéndolo: aquí no hay
-- ningún `insert`. Contarlas y abortar haría que la migración dejara de ser
-- re-ejecutable en cuanto existiera una aceptación.
do $$
declare
  permisos bigint;
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.event_policies'::regclass
      and tgname = 'event_policies_inmutable'
  ) then
    raise exception 'La 0069 no dejó el disparador de inmutabilidad';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.event_order_policy_acceptances'::regclass
      and tgname = 'event_order_policy_acceptances_inmutable'
  ) then
    raise exception 'La 0069 no dejó el disparador de la aceptación';
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_order_policy_acceptances'
      and c.conname = 'event_order_policy_acceptances_unica'
  ) then
    raise exception 'La 0069 no dejó la unicidad por pedido y tipo';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name = 'event_order_policy_acceptances'
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'La aceptación de políticas tiene % permisos sueltos', permisos;
  end if;
end;
$$;
