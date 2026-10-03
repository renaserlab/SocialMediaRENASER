-- 0091 · Z Servicios, Incremento 3: los servicios guardados.
--
-- SIN APLICAR. Escrita el 29/09/2026 y probada solo contra PostgreSQL local:
-- desde cero (0001–0091), sobre una base con la 0090 y datos, reejecutada y con
-- un fallo a mitad (`tests/test_servicios_migracion_0091.py`). Requiere la
-- 0086–0090, aplicadas en Supabase. NO LAS TOCA.
-- Al aplicarla, REINICIAR LA API: la puerta de los guardados recuerda el «no».
--
-- ES LO ÚNICO QUE EL DESCUBRIMIENTO NECESITA ESCRIBIR. El catálogo público, la
-- búsqueda, los filtros, la ficha, el perfil del prestador y las sugerencias
-- solo LEEN las tablas de la 0086–0090. Buscar no necesita esquema: reutiliza
-- la normalización de la búsqueda global (`LIKE` con las tildes toleradas),
-- sin `unaccent` ni un índice nuevo.
--
-- QUÉ AÑADE, Y NADA MÁS: `saved_services`, la lista de una persona.
--
--   * GUARDAR DOS VECES ES GUARDAR UNA: lo impone la clave primaria.
--   * NO ES UNA RESERVA NI UN CARRITO: sin cantidad, sin fecha de atención,
--     sin aviso al prestador.
--   * NO HAY CONTADOR: cuántas personas guardaron un servicio no se escribe en
--     ninguna parte ni se enseña (no es un indicador de popularidad).
--   * Borrar la cuenta de quien guarda se lleva su lista; borrar la del
--     prestador se lleva sus servicios y, con ellos, las filas que los nombran.
--   * Un servicio que deja de estar publicado conserva la fila: la app lo
--     enseña como «ya no está disponible», con el título que tenía AL
--     GUARDARSE (`title_at_save`), sin contenido ni forma de contratar.
--   * RLS activa y ningún permiso para `anon` ni `authenticated`: solo la API.
--
-- UNA ÚNICA TRANSACCIÓN, que primero comprueba la 0086–0090 y al final
-- verifica lo que dejó. REEJECUTABLE: `if not exists`.
--
-- ROLLBACK: `drop table public.saved_services;` (la lista de cada persona se
-- pierde; nada más depende de ella) y REINICIAR LA API, que recuerda el «sí».

begin;

-- ------------------------------------------------------------------------- --
-- 1. Lo que tiene que haber.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
begin
  if to_regclass('public.services') is null
     or to_regclass('public.service_versions') is null
     or to_regclass('public.service_events') is null
     or to_regprocedure('public.servicios_catalogo_coherente()') is null
     or to_regprocedure('public.es_anonimizacion_por_baja(jsonb, jsonb, text[])') is null then
    raise exception 'La 0091 requiere la 0086–0090 aplicadas';
  end if;

  select string_agg(format('%s.%s', e.tabla, e.columna), ', ') into faltan
    from (values
      ('services', 'id'), ('services', 'status'), ('profiles', 'id')
    ) as e(tabla, columna)
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = e.tabla and c.column_name = e.columna
   );
  if faltan is not null then
    raise exception 'La 0091 no encontró las columnas %', faltan;
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. La lista de guardados.
-- ------------------------------------------------------------------------- --
create table if not exists public.saved_services (
  profile_id uuid not null
    references public.profiles(id) on delete cascade,
  service_id uuid not null
    references public.services(id) on delete cascade,
  -- EL TÍTULO QUE ERA PÚBLICO AL GUARDAR. Si el servicio deja de estar
  -- disponible, la lista enseña ESTE, para poder reconocerlo y quitarlo:
  -- nunca el título vivo, que puede ser el de una versión que no llegó a
  -- verse (publicada durante una suspensión) o posterior a un bloqueo.
  title_at_save text not null
    constraint saved_services_titulo
    check (length(trim(title_at_save)) between 1 and 300),
  created_at timestamptz not null default now(),

  constraint saved_services_pkey primary key (profile_id, service_id)
);

-- LO MÍO, LO MÁS RECIENTE PRIMERO: la única lectura de la pantalla, con el
-- desempate por servicio para que el cursor no repita ni se salte filas.
create index if not exists saved_services_mios
  on public.saved_services (profile_id, created_at desc, service_id desc);

-- Borrar un servicio (en cascada con la cuenta de su prestador) no recorre
-- la tabla entera.
create index if not exists saved_services_del_servicio
  on public.saved_services (service_id);

alter table public.saved_services enable row level security;
revoke all on public.saved_services from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 3. Lo que tiene que quedar, o nada.
-- ------------------------------------------------------------------------- --
do $$
begin
  if to_regclass('public.saved_services') is null then
    raise exception 'La 0091 no dejó saved_services';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_index i
     where i.indexrelid = to_regclass('public.saved_services_pkey')
       and i.indisprimary and i.indisunique
       and i.indnatts = 2
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality k(attnum, ord)
              join pg_catalog.pg_attribute a
                on a.attrelid = i.indrelid and a.attnum = k.attnum) = array['profile_id', 'service_id']
  ) then
    raise exception 'La 0091 no dejó la clave (profile_id, service_id)';
  end if;

  if (select count(distinct c.confrelid) from pg_catalog.pg_constraint c
       where c.conrelid = 'public.saved_services'::regclass
         and c.contype = 'f' and c.confdeltype = 'c'
         and c.confrelid in ('public.profiles'::regclass, 'public.services'::regclass)) <> 2 then
    raise exception 'La 0091 no dejó las dos claves ajenas en cascada';
  end if;

  if to_regclass('public.saved_services_mios') is null
     or to_regclass('public.saved_services_del_servicio') is null then
    raise exception 'La 0091 no dejó sus índices';
  end if;

  if not (select relrowsecurity from pg_catalog.pg_class
           where oid = 'public.saved_services'::regclass) then
    raise exception 'saved_services sin RLS';
  end if;

  if exists (select 1 from pg_catalog.pg_policy
              where polrelid = 'public.saved_services'::regclass) then
    raise exception 'saved_services tiene políticas';
  end if;

  if exists (
    select 1 from information_schema.table_privileges
     where table_schema = 'public' and table_name = 'saved_services'
       and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'saved_services tiene permisos sueltos';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
