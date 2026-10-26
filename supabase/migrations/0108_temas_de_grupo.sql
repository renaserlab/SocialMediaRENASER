-- 0108 · Los temas de un grupo
--
-- QUÉ RESUELVE (pedido del 26/10/2026, con Telegram de referencia). Un grupo
-- grande mezcla en un solo chat los avisos, el material y la charla, y lo que
-- importa se pierde. Se pide que quien administra el grupo pueda ordenarlo en
-- TEMAS: «Anuncios», «Material», «Grabaciones»… Los ven todos los miembros sin
-- tener que unirse, y en cada uno hay dos cosas:
--
--   · REFERENCIAS a mensajes de General que la administración eligió. Es el
--     MISMO mensaje, no una copia: si su autor lo borra, desaparece también
--     del tema, y reaccionar en el tema es reaccionar al original.
--   · MENSAJES PROPIOS del tema, que escribe solo la administración y que no
--     salen en General.
--
-- QUÉ HACE. Crea tres tablas:
--
--   · `conversation_topics`: un tema, con su nombre, su icono, su posición
--     en la lista y su CHAT PROPIO (`chat_id`).
--   · `conversation_topic_items`: las referencias de un tema a mensajes de
--     General.
--   · `conversation_topic_views`: hasta cuándo vio cada persona las
--     referencias de cada tema, para poder contarle lo que no ha visto.
--
-- POR QUÉ CADA TEMA TIENE UN CHAT PROPIO. Lo que escribe la administración en
-- un tema se guarda en una conversación normal (`kind = 'group'`) con los
-- mismos miembros que el grupo. Así funcionan sin tocarlos los adjuntos, el
-- almacenamiento, la RLS de lectura, el tiempo real, los avisos, las lecturas
-- y las reacciones. Se descartó guardarlo en General con una marca: la
-- aplicación pinta al instante la fila que llega por tiempo real, antes de
-- preguntar a la API, así que el anuncio aparecería en General, y en las
-- versiones ya instaladas se quedaría ahí. Ver
-- `docs/CONTRATOS_TEMAS_Y_COMUNIDADES.md` § 1.
--
-- POR QUÉ NO SON COLUMNAS DE `conversations` NI DE `messages`. Por lo mismo
-- que la 0033, la 0102 o la 0107: una columna nueva en una tabla tan leída
-- rompe el código ya desplegado que la pide entera. En tablas aparte, el
-- código desplegado antes que esta migración sigue funcionando igual.
--
-- BORRAR UN TEMA ES UN BORRADO SUAVE. Se marca `deleted_at`, se borran en
-- suave los mensajes de su chat y se quitan los miembros de ese chat (lo hace
-- la API). Por eso el nombre es único SOLO entre los temas vivos: se puede
-- volver a crear «Anuncios» después de haber borrado el anterior.
--
-- QUÉ NO HACE.
--   · No toca `conversations`, `conversation_members`, `messages` ni una sola
--     fila existente. Los grupos que ya existen siguen igual, sin temas.
--   · No entra en la publicación de tiempo real: quien añade o quita una
--     referencia avisa por difusión (`chat-temas:{group_id}`) y cada
--     aplicación vuelve a preguntar a la API.
--   · No manda avisos: añadir una referencia no los manda (D9), y lo que se
--     escribe en el chat del tema los manda por el camino de siempre.
--
-- SEGURIDAD. RLS activada y NINGUNA política en las tres tablas: con la clave
-- del cliente no se leen ni se escriben. Quién es miembro del grupo, quién lo
-- administra y qué mensaje se puede referenciar lo resuelve la API en cada
-- petición.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
--
-- La verificación y la vuelta atrás están al final.


-- -----------------------------------------------------------------------------
-- 1. Los temas
-- -----------------------------------------------------------------------------
create table if not exists public.conversation_topics (
  id uuid primary key default gen_random_uuid(),
  -- El grupo al que pertenece el tema.
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- El chat propio del tema: donde escribe la administración. UNO por tema, y
  -- nunca el del propio grupo.
  chat_id uuid not null unique references public.conversations(id) on delete cascade,
  nombre text not null,
  -- El nombre en minúsculas y sin espacios de sobra. No se pinta: existe para
  -- que «Anuncios» y « anuncios » sean el mismo tema (ver el índice único).
  nombre_normalizado text not null,
  -- Un icono de la lista cerrada de la API. Uno desconocido se guarda como
  -- `folder`, así que aquí basta con acotar el largo.
  icono text not null default 'folder',
  posicion integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.conversation_topics
  drop constraint if exists conversation_topics_nombre_check;
alter table public.conversation_topics
  add constraint conversation_topics_nombre_check
  check (char_length(nombre) between 1 and 40);

alter table public.conversation_topics
  drop constraint if exists conversation_topics_icono_check;
alter table public.conversation_topics
  add constraint conversation_topics_icono_check
  check (char_length(icono) between 1 and 32);

-- El chat del tema no puede ser el propio grupo: escribir en el tema
-- escribiría en General, que es justo lo que los temas existen para evitar.
alter table public.conversation_topics
  drop constraint if exists conversation_topics_chat_distinto_check;
alter table public.conversation_topics
  add constraint conversation_topics_chat_distinto_check
  check (chat_id <> conversation_id);

-- Dos temas vivos con el mismo nombre en un grupo no se distinguen en la
-- lista. Los borrados no cuentan: se puede volver a crear el nombre.
create unique index if not exists conversation_topics_nombre_uidx
  on public.conversation_topics (conversation_id, nombre_normalizado)
  where deleted_at is null;

-- La lectura de siempre: los temas vivos de UN grupo.
create index if not exists conversation_topics_conversation_idx
  on public.conversation_topics (conversation_id)
  where deleted_at is null;


-- -----------------------------------------------------------------------------
-- 2. Las referencias a mensajes de General
-- -----------------------------------------------------------------------------
-- La clave primaria compuesta es lo que hace idempotente añadir dos veces el
-- mismo mensaje a un tema: el segundo intento no escribe nada.
create table if not exists public.conversation_topic_items (
  topic_id uuid not null references public.conversation_topics(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  -- El grupo, repetido (también lo sabe el tema), para acotar por grupo sin
  -- pasar por `conversation_topics`.
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  added_by uuid references public.profiles(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (topic_id, message_id)
);

-- La lectura de un tema, por orden de llegada.
create index if not exists conversation_topic_items_topic_idx
  on public.conversation_topic_items (topic_id, added_at);

-- «¿En qué temas está este mensaje?» (el menú de un mensaje de General), y
-- que borrar un mensaje no recorra la tabla entera.
create index if not exists conversation_topic_items_message_idx
  on public.conversation_topic_items (message_id);


-- -----------------------------------------------------------------------------
-- 3. Hasta cuándo vio cada persona las referencias de un tema
-- -----------------------------------------------------------------------------
-- Los mensajes propios del tema no necesitan esto: su chat ya tiene
-- `conversation_members.last_read_at`. Las referencias no viven en ese chat,
-- y por eso llevan su propia marca.
create table if not exists public.conversation_topic_views (
  topic_id uuid not null references public.conversation_topics(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  visto_hasta timestamptz not null,
  primary key (topic_id, user_id)
);

-- Para que borrar un perfil no recorra la tabla entera buscando sus filas
-- (lo mismo que `conversation_preferences_user_idx` en la 0107).
create index if not exists conversation_topic_views_user_idx
  on public.conversation_topic_views (user_id);


-- -----------------------------------------------------------------------------
-- 4. Seguridad: RLS activada y ninguna política
-- -----------------------------------------------------------------------------
alter table public.conversation_topics enable row level security;
alter table public.conversation_topic_items enable row level security;
alter table public.conversation_topic_views enable row level security;

do $$
declare
  tabla text;
  con_rls boolean;
  politicas integer;
begin
  foreach tabla in array array[
    'conversation_topics', 'conversation_topic_items', 'conversation_topic_views'
  ] loop
    select relrowsecurity into con_rls
    from pg_class
    where oid = ('public.' || tabla)::regclass;
    if not coalesce(con_rls, false) then
      raise exception 'La 0108 no ha dejado RLS activada en %.', tabla;
    end if;

    select count(*) into politicas
    from pg_policies
    where schemaname = 'public'
      and tablename = tabla;
    if politicas > 0 then
      raise exception
        '% tiene % política(s). No debe tener ninguna: estas filas solo las '
        'lee y las escribe la API.', tabla, politicas;
    end if;
  end loop;
end
$$;


-- -----------------------------------------------------------------------------
-- 4 bis. En el chat de un tema solo escribe quien administra, también por RLS
-- -----------------------------------------------------------------------------
-- EL HUECO QUE CIERRA. La política `messages_insert` de la 0001 deja a
-- cualquier miembro insertar mensajes con la clave del cliente, sin pasar por la
-- API. Los miembros del chat de un tema son los del grupo, así que cualquiera
-- podría escribir en «Anuncios» saltándose el 403 `topic_admin_only` de la API.
--
-- QUÉ HACE. Rehace la política con la MISMA condición de antes y una más: si la
-- conversación es el chat de un tema, quien escribe tiene que ser quien creó
-- ese chat, que es quien administra el grupo. Para cualquier otra conversación
-- la política dice exactamente lo mismo que decía. La aplicación no inserta
-- mensajes directamente (lo hace la API, con el rol del servidor, al que RLS no
-- se le aplica); esto cierra la puerta a quien use la clave a mano.
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert with check (
  sender_id = auth.uid()
  and public.is_conversation_member(conversation_id)
  and not exists (
    select 1
    from public.conversation_topics t
    join public.conversations c on c.id = t.chat_id
    where t.chat_id = messages.conversation_id
      and c.created_by is distinct from auth.uid()
  )
);


-- -----------------------------------------------------------------------------
-- 5. Que PostgREST se entere del cambio de esquema
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';


-- -----------------------------------------------------------------------------
-- 6. Comprobación
-- -----------------------------------------------------------------------------
-- Debe devolver tres tablas, todas con RLS activada y cero políticas.
select
  c.relname as tabla,
  c.relrowsecurity as rls_activada,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as politicas
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'conversation_topics', 'conversation_topic_items', 'conversation_topic_views'
  )
order by c.relname;


-- -----------------------------------------------------------------------------
-- VERIFICACIÓN A MANO (no se ejecuta sola)
-- -----------------------------------------------------------------------------
-- Los índices (deben salir cinco, más los de las claves primarias y el único
-- de `chat_id`):
--
--   select indexname from pg_indexes
--   where schemaname = 'public'
--     and tablename in ('conversation_topics', 'conversation_topic_items',
--                       'conversation_topic_views')
--   order by indexname;
--
-- Que ningún chat de tema se haya quedado con miembros distintos de los de su
-- grupo (debe devolver cero filas):
--
--   select t.id as tema, cm.user_id
--   from public.conversation_topics t
--   join public.conversation_members cm on cm.conversation_id = t.chat_id
--   where t.deleted_at is null
--     and not exists (
--       select 1 from public.conversation_members g
--       where g.conversation_id = t.conversation_id and g.user_id = cm.user_id
--     );
--
-- -----------------------------------------------------------------------------
-- VUELTA ATRÁS
-- -----------------------------------------------------------------------------
-- OJO ANTES DE BORRAR LAS TABLAS. Los chats de los temas son filas normales de
-- `conversations`. Mientras esta tabla existe, la API los esconde de la
-- bandeja; sin ella, saldrían sueltos como grupos con el nombre del tema. Por
-- eso, primero se vacían de miembros (no se pierde ningún mensaje: siguen en
-- `messages`, inaccesibles):
--
--   delete from public.conversation_members
--   where conversation_id in (select chat_id from public.conversation_topics);
--
-- Después se devuelve `messages_insert` a como la dejó la 0001: la nueva
-- consulta `conversation_topics`, y sin esto la tabla no se podría borrar.
--
--   drop policy if exists messages_insert on public.messages;
--   create policy messages_insert on public.messages for insert with check
--     (sender_id = auth.uid() and public.is_conversation_member(conversation_id));
--
-- Y por último:
--
--   drop table public.conversation_topic_views;
--   drop table public.conversation_topic_items;
--   drop table public.conversation_topics;
--
-- General no pierde nada: las referencias nunca tocaron sus mensajes.
