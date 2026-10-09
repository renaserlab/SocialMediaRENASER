-- 0103 · Las conversaciones y sus miembros solo se crean por la API
--
-- EL HUECO QUE CIERRA. Desde la 0001 hay dos políticas que dejan INSERTAR con
-- la clave del cliente, sin pasar por la API:
--
--   · `conversations_insert`: cualquiera crea una conversación a su nombre;
--   · `conversation_members_insert`: cualquiera se añade A SÍ MISMO a
--     CUALQUIER conversación cuyo identificador conozca (`user_id = auth.uid()`
--     es la primera mitad de la condición), y quien creó una conversación
--     añade a quien quiera.
--
-- Con chats de dos personas el daño estaba acotado: el identificador de una
-- conversación no se adivina y solo lo conocen sus dos miembros. Con los
-- GRUPOS (09/10/2026) deja de estarlo, porque todo lo que la API exige al
-- crear un grupo o al cambiar sus miembros se puede saltar escribiendo
-- directamente en la tabla:
--
--   · alguien a quien se sacó de un grupo conoce su identificador y puede
--     volver a meterse solo;
--   · se puede añadir a quien te bloqueó, que es justo lo que la API impide;
--   · no hay tope de miembros ni de grupos por hora.
--
-- QUÉ HACE. Quita esas dos políticas. Sin política de INSERT y con RLS
-- activada, la clave del cliente deja de poder escribir en las dos tablas. La
-- API no usa esa clave: se conecta con el rol del servidor, al que RLS no se
-- le aplica, igual que para todas las tablas «solo por la API» (0098–0102).
--
-- QUÉ NO HACE.
--   · No toca las políticas de LECTURA (`conversations_read`,
--     `conversation_members_read`, `messages_read`): son las que deciden qué
--     recibe cada teléfono por tiempo real, y siguen igual.
--   · No toca `messages` ni ninguna fila. No borra nada.
--   · No cambia nada para la aplicación: nunca ha escrito en estas dos tablas
--     con la clave del cliente; siempre lo ha hecho por la API.
--
-- EL ORDEN NO IMPORTA. Se puede aplicar antes o después de desplegar el
-- código de los grupos: el código no depende de ella. Mientras no esté, los
-- grupos funcionan pero sus reglas se pueden saltar como se explica arriba.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error.
--
-- CÓMO SE DESHACE (no debería hacer falta):
--   create policy conversations_insert on public.conversations
--     for insert with check (created_by = auth.uid());
--   create policy conversation_members_insert on public.conversation_members
--     for insert with check (
--       user_id = auth.uid() or exists (
--         select 1 from public.conversations c
--         where c.id = conversation_id and c.created_by = auth.uid()
--       )
--     );

drop policy if exists conversations_insert on public.conversations;
drop policy if exists conversation_members_insert on public.conversation_members;

do $$
declare
  tabla text;
  con_rls boolean;
  de_escritura integer;
  de_lectura integer;
begin
  foreach tabla in array array['conversations', 'conversation_members'] loop
    select relrowsecurity into con_rls
    from pg_class
    where oid = ('public.' || tabla)::regclass;
    if not coalesce(con_rls, false) then
      raise exception
        '% no tiene RLS activada: sin ella, quitar la política de INSERT '
        'deja la tabla abierta en vez de cerrada.', tabla;
    end if;

    select count(*) into de_escritura
    from pg_policies
    where schemaname = 'public'
      and tablename = tabla
      and cmd in ('INSERT', 'ALL');
    if de_escritura > 0 then
      raise exception
        '% sigue teniendo % política(s) que dejan insertar con la clave del '
        'cliente.', tabla, de_escritura;
    end if;

    -- La lectura tiene que seguir: de ella depende lo que llega por tiempo real.
    select count(*) into de_lectura
    from pg_policies
    where schemaname = 'public'
      and tablename = tabla
      and cmd = 'SELECT';
    if de_lectura = 0 then
      raise exception
        '% se ha quedado sin política de lectura. Esta migración no debía '
        'tocarla.', tabla;
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';
