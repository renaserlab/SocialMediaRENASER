-- 0109 · Las comunidades de un grupo
--
-- QUÉ RESUELVE (decidido el 26/10/2026, con Telegram de referencia). Un grupo
-- puede organizarse en COMUNIDADES: grupos hijos, cada uno con su chat, su
-- historial y sus miembros. Estar en el grupo no mete a nadie en ninguna: cada
-- persona entra en las que quiere. En la aplicación se llaman «Comunidades»; en
-- la base, `subgroups`, porque `communities` ya son los círculos de Explorar.
--
-- QUÉ HACE. Crea UNA tabla, `group_subgroups`, con una fila por comunidad:
--
--   · `conversation_id`: la comunidad, que es una fila normal de
--     `conversations` con `kind = 'group'`. Por eso todo lo que ya existe
--     —mensajes, adjuntos, tiempo real, avisos, reacciones— funciona dentro
--     sin tocarlo.
--   · `parent_id`: el grupo del que cuelga.
--   · `descripcion`, `posicion`: lo que se enseña en la lista del grupo.
--   · `entrada`: cómo se entra. `open`, de un toque; `request`, pidiéndolo, y
--     decide quien administra (con las solicitudes de la 0104).
--   · `deleted_at`: eliminar una comunidad es un borrado SUAVE. La API marca
--     esta columna y quita a todos sus miembros; los mensajes se quedan en la
--     base, inaccesibles, por si hay que responder de ellos.
--
-- POR QUÉ NO ES UNA COLUMNA DE `conversations`. Por lo mismo que la 0104 o la
-- 0107: una columna nueva en una tabla que el código ya desplegado pide entera
-- lo rompe hasta que se aplica. Con una tabla aparte, la API funciona igual con
-- ella o sin ella (sin ella, los grupos no tienen comunidades).
--
-- UN SOLO NIVEL. No hay comunidades dentro de una comunidad ni dentro del chat
-- de un tema (0108). Lo impone la API (409 `not_a_top_level_group`); aquí solo
-- se impide lo que la base puede ver sin consultar otras filas: que una
-- comunidad sea su propio padre.
--
-- QUÉ NO HACE.
--   · No toca `conversations`, `conversation_members`, `messages`,
--     `profiles` ni una sola fila existente. Los grupos que ya existen siguen
--     igual, sin comunidades hasta que quien los administra cree alguna.
--   · No entra en la publicación de tiempo real: la lista de comunidades se
--     pide a la API. Lo que se escribe DENTRO de una comunidad sí llega en
--     tiempo real, porque son mensajes normales de su conversación.
--
-- SEGURIDAD. RLS activada y NINGUNA política: con la clave del cliente no se
-- lee ni se escribe. Quién ve qué comunidad, quién entra y quién administra lo
-- resuelve la API en cada petición —incluidos los bloqueos con quien
-- administra, que dejan la comunidad «sin existir» para esa persona—. Con una
-- política de lectura, cualquiera podría listar por PostgREST las comunidades
-- de grupos en los que no está.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
-- NO SE EJECUTA CONTRA PRODUCCIÓN sin aprobación: se deja preparada.

create table if not exists public.group_subgroups (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  parent_id uuid not null references public.conversations(id) on delete cascade,
  descripcion text not null default '',
  entrada text not null default 'open',
  posicion integer not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Los `CHECK` van con nombre y por separado, como en la 0104, para poder
-- volver a declararlos sin error y para que el modelo de la API
-- (`subgrupos.GroupSubgroup`) los repita con el mismo nombre.
alter table public.group_subgroups
  drop constraint if exists group_subgroups_descripcion_check;
alter table public.group_subgroups
  add constraint group_subgroups_descripcion_check
  check (char_length(descripcion) <= 200);

alter table public.group_subgroups
  drop constraint if exists group_subgroups_entrada_check;
alter table public.group_subgroups
  add constraint group_subgroups_entrada_check
  check (entrada in ('open', 'request'));

-- Una comunidad no puede ser su propio grupo.
alter table public.group_subgroups
  drop constraint if exists group_subgroups_no_es_su_padre_check;
alter table public.group_subgroups
  add constraint group_subgroups_no_es_su_padre_check
  check (conversation_id <> parent_id);

-- La única lectura que se hace: las comunidades vivas de UN grupo (la lista
-- del grupo y la bandeja agrupada). Parcial: las eliminadas no se leen nunca.
create index if not exists group_subgroups_parent_idx
  on public.group_subgroups (parent_id)
  where deleted_at is null;

alter table public.group_subgroups enable row level security;

do $$
declare
  con_rls boolean;
  politicas integer;
begin
  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.group_subgroups'::regclass;
  if not coalesce(con_rls, false) then
    raise exception 'La 0109 no ha dejado RLS activada en group_subgroups.';
  end if;

  select count(*) into politicas
  from pg_policies
  where schemaname = 'public'
    and tablename = 'group_subgroups';
  if politicas > 0 then
    raise exception
      'group_subgroups tiene % política(s). No debe tener ninguna: estas filas '
      'solo las lee y las escribe la API.', politicas;
  end if;
end
$$;

notify pgrst, 'reload schema';

-- Comprobación: una fila, con la tabla creada, la RLS activada y sus tres
-- `CHECK` y su índice en su sitio.
select
  to_regclass('public.group_subgroups') is not null as tabla_creada,
  (select relrowsecurity
     from pg_class
    where oid = 'public.group_subgroups'::regclass) as rls_activada,
  (select count(*)
     from pg_constraint
    where conrelid = 'public.group_subgroups'::regclass
      and contype = 'c') as checks,
  (select count(*)
     from pg_indexes
    where schemaname = 'public'
      and indexname = 'group_subgroups_parent_idx') as indice_por_grupo;

-- VERIFICACIÓN, después de aplicarla (a mano, en el editor):
--
--   -- Que la API ya la ve: `GET /api/v1/conversations/availability` responde
--   -- `"subgroups": true` (en menos de un minuto: el «no» se cachea 60 s).
--
--   -- Que nadie la alcanza con la clave del cliente: ninguna política.
--   select count(*) from pg_policies
--    where schemaname = 'public' and tablename = 'group_subgroups';  -- 0
--
--   -- Que ninguna comunidad viva cuelga de otra comunidad (un solo nivel).
--   select h.conversation_id
--     from public.group_subgroups h
--     join public.group_subgroups p on p.conversation_id = h.parent_id
--    where h.deleted_at is null;                                       -- 0 filas
--
-- VUELTA ATRÁS:
--
--   drop table public.group_subgroups;
--
-- No se pierde ningún mensaje ni ningún miembro: las comunidades se quedan
-- como grupos normales (siguen en `conversations` con sus miembros) y vuelven a
-- salir sueltas en la bandeja, que es como las ven las versiones de la
-- aplicación anteriores a esto. Lo único que se pierde es de qué grupo era
-- cada una, su descripción, su orden y cómo se entraba.
