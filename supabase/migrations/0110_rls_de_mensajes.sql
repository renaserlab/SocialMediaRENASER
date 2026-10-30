-- 0110 · La RLS de los mensajes, una vez por consulta y no una vez por fila
--
-- QUÉ RESUELVE (auditoría de rendimiento del 28/10/2026, punto 17, §5.2 y
-- §5.8). Dos cosas distintas en las mismas tablas:
--
--   1. LENTITUD. `messages_read`, `conversation_members_read`,
--      `conversations_read` y `message_attachments_read` llaman a
--      `is_conversation_member(conversation_id)` POR CADA FILA. Es `security
--      definer`, así que PostgreSQL no puede meterla dentro de la consulta:
--      la ejecuta 200 000 veces para contar 200 000 mensajes. Medido en un
--      chat de 200 000 mensajes: 23,6 ms como `postgres` y 1966 ms como
--      `authenticated`. Es lo que paga el tiempo real (cada cambio se
--      comprueba contra esta RLS) y cualquier lectura por PostgREST.
--      `story_views_read` hace lo mismo con un EXISTS y con `is_admin()` por
--      fila, y esa tabla la lee el móvil directamente.
--
--   2. UN CANDADO QUE CIERRA POR ACCIDENTE (§5.8). La `messages_insert` de la
--      0108 consulta `conversation_topics` desde la propia política, es decir,
--      con los permisos de quien inserta. Esa tabla nació después de la 0053
--      (sin permisos para `authenticated`), con RLS y sin políticas. Resultado:
--      CUALQUIER inserción directa en `messages` con la clave del cliente
--      falla con «permission denied for table conversation_topics», también
--      en un chat de dos personas. Hoy no se nota porque los mensajes los
--      escribe la API. Pero el candado cierra por accidente: el día que
--      alguien conceda ese SELECT, la subconsulta verá cero filas (RLS sin
--      políticas), cualquier miembro podrá insertar con la clave del cliente y
--      la regla «en el chat de un tema solo escribe quien lo administra»
--      dejará de cumplirse sin que falle nada.
--
-- QUÉ HACE.
--
--   · `mis_conversaciones()`: la lista de conversaciones de quien pregunta, en
--     UNA consulta. Es exactamente la de `is_conversation_member` (misma
--     tabla, misma condición, mismo `security definer`), solo que en vez de
--     preguntar «¿soy miembro de ESTA?» fila a fila, devuelve todas de golpe.
--     Las cuatro políticas pasan a ser `conversation_id = any (esa lista)`, y
--     con el `(select …)` alrededor PostgreSQL la calcula una vez por
--     consulta. Además, como es una comparación contra una lista, el índice
--     `messages_conversation_created_idx` la puede usar.
--   · `story_views_read`: la misma condición, escrita para que se resuelva una
--     vez: las historias propias se buscan una sola vez (por el índice de
--     autor) y `auth.uid()` e `is_admin()` van dentro de `(select …)`.
--   · `messages_insert`: SE QUITA, sin sustituirla. Sin política de INSERT y
--     con RLS activada, la clave del cliente no puede insertar en `messages`:
--     los mensajes solo los escribe la API, que se conecta con el rol del
--     servidor y no pasa por la RLS. Es lo mismo que hizo la 0103 con
--     `conversations_insert` y `conversation_members_insert`.
--
-- POR QUÉ QUITARLA Y NO ARREGLARLA. Arreglarla (mover su condición a una
-- función `security definer`) la habría hecho funcionar POR PRIMERA VEZ desde
-- la 0108: un miembro volvería a poder insertar directamente en cualquier
-- conversación que no sea el chat de un tema, saltándose lo que solo hace la
-- API (rechazar un mensaje vacío, actualizar `updated_at`, mandar los
-- avisos). Hoy eso no lo puede hacer nadie: toda inserción directa falla. La
-- regla de esta migración es que nadie pueda hacer ni más ni menos que hoy, y
-- quitarla deja exactamente eso, ahora a propósito y no por un permiso que
-- falta. Y el candado deja de depender de que nadie conceda SELECT sobre
-- `conversation_topics`: ya no hay ninguna política que la lea. Lo único que
-- cambia es el texto del error: «new row violates row-level security policy»
-- en vez de «permission denied for table conversation_topics» (los dos son
-- el código 42501).
--
-- POR QUÉ UNA FUNCIÓN Y NO LA SUBCONSULTA QUE PROBÓ LA AUDITORÍA
-- (`conversation_id in (select conversation_id from conversation_members
-- where user_id = (select auth.uid()))`):
--
--   · En `conversation_members_read` es imposible: la política de una tabla no
--     puede consultar la misma tabla sin recursión infinita (lo mismo que
--     explica la 0045 para usar `is_conversation_member`).
--   · En las otras tres, la subconsulta correría con la RLS y los permisos de
--     quien pregunta, y `is_conversation_member` no: es `security definer`.
--     Hoy da lo mismo, pero dependería de que `conversation_members` siga
--     concedida a `anon` y `authenticated`. Si un día se retira ese permiso,
--     leer `messages` pasaría de «cero filas» a un error; es justo el tipo de
--     dependencia que rompió la 0108. Con la función, el contexto es idéntico
--     al de hoy.
--   · Medido en la base desechable (200 000 mensajes en un chat): contar los
--     mensajes del chat cuesta 3945 ms con la política actual, ~60 ms con la
--     subconsulta y ~27 ms con la lista (23 ms como `postgres`).
--
-- POR QUÉ ES LA MISMA SEMÁNTICA, CASO POR CASO.
--
--   · Pertenecer es TENER UNA FILA en `conversation_members`. No hay columnas
--     de baja ni de expulsión: salir de un grupo, que te saquen o borrar un
--     tema borra la fila (lo hace la API). `is_conversation_member` no mira
--     nada más y `mis_conversaciones()` tampoco.
--   · Los chats de tema (0108) y las comunidades (0109) son conversaciones
--     normales con sus propios miembros: ser del grupo no da acceso a una
--     comunidad, ni antes ni ahora.
--   · `auth.uid()` nulo (`anon`, o la clave de servicio): antes `exists(…
--     user_id = null)` era falso; ahora la lista sale vacía y `= any('{}')`
--     es falso. `created_by = null` sigue siendo nulo, que la RLS trata como
--     falso, igual que antes.
--   · `(select auth.uid())` y `(select is_admin())` dan el mismo valor que sin
--     el `select`: son `stable`, y dentro de una consulta PostgreSQL ya las
--     evaluaba con la misma instantánea en cada fila.
--   · En `story_views_read`, el EXISTS y el `in` preguntan lo mismo («¿hay una
--     historia mía con este id?») contra la misma tabla y con la misma RLS de
--     `stories` aplicada. Las historias propias siempre pasan esa RLS
--     (`author_id = auth.uid()`), caducadas o no.
--   · Insertar en `messages` con la clave del cliente: antes fallaba
--     siempre (por permisos) y ahora falla siempre (por RLS), para todo el
--     mundo y en cualquier conversación. La API, que es quien escribe, no
--     pasa por la RLS y sigue igual.
--
-- QUÉ NO HACE.
--   · No toca `is_conversation_member`: la siguen usando la inserción de
--     adjuntos, las etiquetas (0045), Storage (0033) y las sesiones (0097).
--   · No toca las otras políticas del proyecto que llaman a `auth.uid()` sin
--     `(select …)`. Esta migración se limita a las cinco de lectura de la
--     auditoría y a quitar la inserción de mensajes.
--   · No toca `message_attachments_insert`: sigue exigiendo que el mensaje
--     sea de quien adjunta, y esos mensajes solo los crea la API.
--   · No toca ninguna fila.
--
-- BLOQUEOS. `drop policy` y `create policy` toman un bloqueo exclusivo de
-- cada tabla hasta el final de la transacción. Son milisegundos, pero si una
-- consulta larga está leyendo `messages`, la migración espera detrás de ella y
-- todo lo que llega después espera detrás de la migración: el chat se
-- congelaría. Con `lock_timeout` se rinde a los 5 s, se revierte entera y se
-- puede volver a lanzar.
--
-- SE PEGA ENTERA, COMO UNA SOLA TRANSACCIÓN: es lo que hace el editor de
-- Supabase, y es lo que hace falta para que `set local` valga y para que un
-- fallo no deje unas políticas cambiadas y otras no. Fuera del editor:
-- `psql -1 -f`.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
--
-- La comprobación y la vuelta atrás están al final.

set local lock_timeout = '5s';


-- -----------------------------------------------------------------------------
-- 1. Las conversaciones de quien pregunta, de una vez
-- -----------------------------------------------------------------------------
-- Una LISTA y no un conjunto de filas: comparada con `= any (…)` dentro de un
-- `(select …)`, PostgreSQL la calcula una vez y la puede usar como condición
-- de índice. Con un conjunto (`in (select …)`) la calcula una vez igual, pero
-- la aplica fila a fila después de leerlas.
--
-- `coalesce(…, '{}')`: sin conversaciones, `array_agg` devuelve nulo; con la
-- lista vacía el resultado es «falso» en vez de «nulo», que para la RLS es lo
-- mismo pero se lee mejor.
--
-- Llamarla a mano por PostgREST (`rpc/mis_conversaciones`) no enseña nada
-- nuevo: devuelve las conversaciones propias, que ya se leen en
-- `conversation_members`.
create or replace function public.mis_conversaciones()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(conversation_id), '{}'::uuid[])
  from public.conversation_members
  where user_id = auth.uid();
$$;


-- -----------------------------------------------------------------------------
-- 2. Las cuatro lecturas del chat
-- -----------------------------------------------------------------------------
-- EL `::uuid[]` NO SOBRA. Sin él, `= any ((select …))` se lee como
-- `= ANY (subconsulta)` y PostgreSQL compara un uuid con una lista entera.
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select using (
  conversation_id = any ((select public.mis_conversaciones())::uuid[])
);

drop policy if exists conversation_members_read on public.conversation_members;
create policy conversation_members_read on public.conversation_members for select using (
  conversation_id = any ((select public.mis_conversaciones())::uuid[])
);

drop policy if exists conversations_read on public.conversations;
create policy conversations_read on public.conversations for select using (
  id = any ((select public.mis_conversaciones())::uuid[])
  or created_by = (select auth.uid())
);

-- Mira la conversación DEL ADJUNTO, como la 0033, no la de su mensaje.
drop policy if exists message_attachments_read on public.message_attachments;
create policy message_attachments_read on public.message_attachments for select using (
  conversation_id = any ((select public.mis_conversaciones())::uuid[])
);


-- -----------------------------------------------------------------------------
-- 3. Quién vio una historia
-- -----------------------------------------------------------------------------
-- Las mismas tres vías de la 0003: la vista es mía, la historia es mía, o soy
-- de la administración. La segunda se sigue preguntando a `stories` con su
-- propia RLS puesta, como el EXISTS de antes.
drop policy if exists story_views_read on public.story_views;
create policy story_views_read on public.story_views for select using (
  viewer_id = (select auth.uid())
  or story_id in (
    select s.id from public.stories s where s.author_id = (select auth.uid())
  )
  or (select public.is_admin())
);


-- -----------------------------------------------------------------------------
-- 4. Insertar un mensaje: solo la API (§5.8)
-- -----------------------------------------------------------------------------
-- Sin política de INSERT, la RLS lo niega a `anon` y a `authenticated`.
drop policy if exists messages_insert on public.messages;


-- -----------------------------------------------------------------------------
-- 5. Que no quede a medias
-- -----------------------------------------------------------------------------
do $$
declare
  politica record;
  definicion text;
begin
  for politica in
    select * from (values
      ('messages', 'messages_read'),
      ('conversation_members', 'conversation_members_read'),
      ('conversations', 'conversations_read'),
      ('message_attachments', 'message_attachments_read'),
      ('story_views', 'story_views_read')
    ) as v(tabla, nombre)
  loop
    select p.qual into definicion
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = politica.tabla
      and p.policyname = politica.nombre
      and p.cmd = 'SELECT';
    if definicion is null then
      raise exception 'La 0110 ha dejado % sin su política de lectura %.',
        politica.tabla, politica.nombre;
    end if;
    -- Ninguna de las cinco puede seguir preguntando fila a fila.
    if definicion like '%is_conversation_member%' then
      raise exception '% sigue llamando a is_conversation_member por fila.', politica.nombre;
    end if;
  end loop;

  -- `messages` sin ninguna puerta de escritura para la clave del cliente, y
  -- con la RLS puesta: sin ella, no tener política la dejaría ABIERTA.
  if not (select relrowsecurity from pg_class where oid = 'public.messages'::regclass) then
    raise exception 'messages no tiene RLS activada: sin política de INSERT quedaría abierta.';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'messages' and cmd in ('INSERT', 'ALL')
  ) then
    raise exception 'messages sigue teniendo una política que deja insertar con la clave del cliente.';
  end if;

  -- La lista de conversaciones, con el contexto del que depende su
  -- significado: el mismo que `is_conversation_member`.
  if not exists (
    select 1
    from pg_proc f
    where f.oid = to_regprocedure('public.mis_conversaciones()')
      and f.prosecdef
      and f.provolatile = 's'
      and coalesce(f.proconfig, '{}') @> array['search_path=public, pg_temp']
  ) then
    raise exception
      'mis_conversaciones() tiene que existir, ser security definer y stable, '
      'y fijar el search_path.';
  end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 6. Que PostgREST se entere del cambio de esquema
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';


-- -----------------------------------------------------------------------------
-- 7. Comprobación
-- -----------------------------------------------------------------------------
-- Seis filas: las cinco lecturas, ninguna con `is_conversation_member`, y una
-- última que debe decir que `messages` ya no tiene política de inserción.
select tablename as tabla, policyname as politica, cmd as comando,
       qual as condicion
from pg_policies
where schemaname = 'public'
  and policyname in (
    'messages_read', 'conversation_members_read', 'conversations_read',
    'message_attachments_read', 'story_views_read'
  )
union all
select 'messages', 'messages_insert', 'INSERT',
       case when exists (
         select 1 from pg_policies
         where schemaname = 'public' and tablename = 'messages'
           and cmd in ('INSERT', 'ALL')
       ) then 'SIGUE EXISTIENDO: revisar'
       else '(ninguna: los mensajes solo los escribe la API)' end
order by 1, 2;


-- -----------------------------------------------------------------------------
-- VERIFICACIÓN A MANO (no se ejecuta sola)
-- -----------------------------------------------------------------------------
-- Como una persona concreta (cambiar el uuid por el de una cuenta de prueba),
-- dentro de una transacción que se deshace:
--
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub', '<uuid>', 'role', 'authenticated')::text, true);
--   set local role authenticated;
--   explain analyze select count(*) from public.messages
--     where conversation_id = '<uuid de un chat suyo>';
--   rollback;
--
-- El plan tiene que enseñar `InitPlan` y `conversation_id = ANY ($0)` en la
-- condición del índice, y NINGUNA llamada a `is_conversation_member`.
--
-- -----------------------------------------------------------------------------
-- VUELTA ATRÁS (rollback)
-- -----------------------------------------------------------------------------
-- Las cinco lecturas como estaban (0001, 0003 y 0033) y la inserción como la
-- dejó la 0108. OJO: esa inserción vuelve con el candado accidental de §5.8
-- (falla por permisos, y deja de proteger los temas si alguien concede
-- SELECT sobre `conversation_topics`).
--
--   drop policy if exists messages_read on public.messages;
--   create policy messages_read on public.messages for select
--     using (public.is_conversation_member(conversation_id));
--   drop policy if exists conversation_members_read on public.conversation_members;
--   create policy conversation_members_read on public.conversation_members for select
--     using (public.is_conversation_member(conversation_id));
--   drop policy if exists conversations_read on public.conversations;
--   create policy conversations_read on public.conversations for select
--     using (public.is_conversation_member(id) or created_by = auth.uid());
--   drop policy if exists message_attachments_read on public.message_attachments;
--   create policy message_attachments_read on public.message_attachments for select
--     using (public.is_conversation_member(conversation_id));
--   drop policy if exists story_views_read on public.story_views;
--   create policy story_views_read on public.story_views for select using (
--     viewer_id = auth.uid()
--     or exists (select 1 from public.stories s
--                where s.id = story_id and s.author_id = auth.uid())
--     or public.is_admin()
--   );
--   drop policy if exists messages_insert on public.messages;
--   create policy messages_insert on public.messages for insert with check (
--     sender_id = auth.uid()
--     and public.is_conversation_member(conversation_id)
--     and not exists (
--       select 1
--       from public.conversation_topics t
--       join public.conversations c on c.id = t.chat_id
--       where t.chat_id = messages.conversation_id
--         and c.created_by is distinct from auth.uid()
--     )
--   );
--
-- Y después, ya sin ninguna política que la use:
--
--   drop function if exists public.mis_conversaciones();
--
-- Para volver solo a las lecturas de antes sin reabrir el candado accidental,
-- basta con los cinco primeros pares `drop`/`create` y el `drop function`: no
-- hace falta recrear `messages_insert`, y sin ella la inserción sigue siendo
-- solo de la API.
