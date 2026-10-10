-- 0106 · Reaccionar a un mensaje y responder a uno concreto
--
-- QUÉ RESUELVE (pedido del 10/10/2026, visto en teléfono). En un chat no se
-- podía reaccionar a un mensaje ni responder a uno en particular. En un grupo,
-- donde varias conversaciones se cruzan, sin eso no se sabe a qué contesta
-- cada cual.
--
-- QUÉ HACE. Crea dos tablas:
--
--   · `message_reactions`: la reacción de UNA persona a UN mensaje. Una por
--     persona y mensaje (es la clave primaria): reaccionar otra vez la cambia,
--     no añade otra.
--   · `message_replies`: a qué mensaje responde un mensaje. Uno responde a
--     otro o a ninguno (la clave primaria es el propio mensaje).
--
-- POR QUÉ NO SON COLUMNAS DE `messages`. Por lo mismo que los adjuntos (0033)
-- y el contexto de historia (0044): `messages` es la tabla más leída, y una
-- columna nueva rompe el código ya desplegado que la pide entera.
--
-- SI SE BORRA EL MENSAJE AL QUE SE RESPONDÍA. Los mensajes se borran marcando
-- la fila, no quitándola, así que la respuesta sigue apuntando a él y la
-- aplicación enseña «Mensaje eliminado» en la cita. Si la fila llegara a
-- quitarse de verdad, `on delete set null` deja la respuesta en pie sin cita.
--
-- `conversation_id` VA REPETIDO en las reacciones, igual que en los adjuntos:
-- permite acotar las consultas a una conversación sin pasar por `messages`.
--
-- QUÉ NO HACE.
--   · No toca `messages`, `message_attachments` ni ninguna fila existente.
--   · No entra en la publicación de tiempo real: quien reacciona avisa a los
--     demás por difusión, sin contenido, y cada uno le pregunta a la API.
--
-- SEGURIDAD. RLS activada y NINGUNA política en las dos tablas: solo las lee
-- y las escribe la API, que comprueba en cada petición que quien reacciona o
-- responde es miembro de la conversación y que el mensaje es de ESA
-- conversación.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
--
-- CÓMO SE DESHACE:
--   drop table public.message_reactions;
--   drop table public.message_replies;
-- No se pierde ningún mensaje: solo las reacciones y a qué respondía cada uno.

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.message_reactions
  drop constraint if exists message_reactions_emoji_check;
alter table public.message_reactions
  add constraint message_reactions_emoji_check
  check (char_length(emoji) between 1 and 16);

create index if not exists message_reactions_conversation_idx
  on public.message_reactions (conversation_id);

create table if not exists public.message_replies (
  message_id uuid primary key references public.messages(id) on delete cascade,
  reply_to_id uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists message_replies_reply_to_idx
  on public.message_replies (reply_to_id)
  where reply_to_id is not null;

alter table public.message_reactions enable row level security;
alter table public.message_replies enable row level security;

do $$
declare
  tabla text;
  con_rls boolean;
  politicas integer;
begin
  foreach tabla in array array['message_reactions', 'message_replies'] loop
    select relrowsecurity into con_rls
    from pg_class
    where oid = ('public.' || tabla)::regclass;
    if not coalesce(con_rls, false) then
      raise exception 'La 0106 no ha dejado RLS activada en %.', tabla;
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

notify pgrst, 'reload schema';
