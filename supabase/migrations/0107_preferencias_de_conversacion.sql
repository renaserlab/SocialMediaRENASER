-- 0107 · Silenciar una conversación y vaciarla para uno mismo
--
-- QUÉ RESUELVE (pedido del 10/10/2026, con Telegram de referencia). En el menú
-- de un chat faltaban «Silenciar» y «Vaciar chat». Las dos son decisiones que
-- cada persona toma PARA SÍ: silenciar un grupo no lo silencia a los demás, y
-- vaciar un chat no le borra nada a nadie.
--
-- QUÉ HACE. Crea una tabla, `conversation_preferences`, con una fila por
-- persona y conversación —y solo cuando esa persona ha decidido algo—:
--
--   · `muted`: no quiere avisos de esa conversación. Los mensajes le siguen
--     llegando y contando como no leídos; lo que no sale es el aviso.
--   · `cleared_at`: vació el chat en ese instante. Lo anterior deja de
--     enseñársele a ELLA; lo que llegue después se ve con normalidad.
--
-- POR QUÉ NO SON COLUMNAS DE `conversation_members`. Por lo mismo que los
-- adjuntos (0033) y las reacciones (0106): una columna nueva en una tabla que
-- el código ya desplegado pide entera lo rompe hasta que se aplica. Con una
-- tabla aparte, la API funciona igual con ella o sin ella.
--
-- VACIAR NO BORRA. Los mensajes siguen en `messages` para el resto de la
-- conversación. Aquí solo se anota desde cuándo quiere ver esa persona.
--
-- QUÉ NO HACE.
--   · No toca `conversations`, `conversation_members`, `messages` ni ninguna
--     fila existente.
--   · No entra en la publicación de tiempo real: son preferencias privadas.
--
-- SEGURIDAD. RLS activada y NINGUNA política: solo la lee y la escribe la
-- API, que comprueba en cada petición que quien pregunta es miembro de la
-- conversación y que la fila que toca es LA SUYA (la identidad sale de la
-- sesión, nunca de la petición).
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
--
-- CÓMO SE DESHACE:
--   drop table public.conversation_preferences;
-- No se pierde ningún mensaje: vuelven los avisos silenciados y vuelve a verse
-- lo que cada cual había vaciado.

create table if not exists public.conversation_preferences (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  muted boolean not null default false,
  cleared_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- Para que borrar un perfil no recorra la tabla entera buscando sus filas.
create index if not exists conversation_preferences_user_idx
  on public.conversation_preferences (user_id);

alter table public.conversation_preferences enable row level security;

do $$
declare
  con_rls boolean;
  politicas integer;
begin
  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.conversation_preferences'::regclass;
  if not coalesce(con_rls, false) then
    raise exception 'La 0107 no ha dejado RLS activada en conversation_preferences.';
  end if;

  select count(*) into politicas
  from pg_policies
  where schemaname = 'public'
    and tablename = 'conversation_preferences';
  if politicas > 0 then
    raise exception
      'conversation_preferences tiene % política(s). No debe tener ninguna: '
      'estas filas solo las lee y las escribe la API.', politicas;
  end if;
end
$$;

notify pgrst, 'reload schema';
