-- Datos del modulo «mensajes» (agente 3): chat, grupos, temas, comunidades y
-- notificaciones. SOLO para el Supabase LOCAL (zeta-local).
--
-- Corre DESPUES de 00-base.sql (orden de nombre), que deja a Ana y Beto con
-- sus UUID fijos y siguiendose. Idempotente: cada pasada BORRA lo que las
-- pruebas escribieron en estas conversaciones (mensajes enviados, temas
-- creados) y repone el punto de partida.
--
--   Ana  = e2e0a0a0-0000-4000-8000-000000000001
--   Beto = e2e0b0b0-0000-4000-8000-000000000002
--
-- QUE DEJA
--   · Chat Ana–Beto (e2e30000-…-000000000001): 21 mensajes, 16 de AYER y 5 de
--     HOY (hay separador de dia y sitio para subir y ver «Ir al último
--     mensaje»). Uno lleva un enlace. Beto ya leyo lo ultimo de Ana (doble
--     marca de «leído») y los DOS ultimos de Beto estan SIN LEER para Ana:
--     globo «2» en la fila y en la pestaña Mensajes.
--   · «Taller E2E» (e2e30000-…-000000000010): grupo que ADMINISTRA ANA, con el
--     tema «Avisos» y la comunidad abierta «Esmaltes». Uno sin leer en General.
--   · «Carpinteria E2E» (e2e30000-…-000000000020): grupo que administra BETO;
--     Ana es miembro normal. Tema «Planos» (1 sin ver para Ana) y comunidad
--     abierta «Torno» en la que Ana NO esta (sale «Unirme»).
--   · 5 notificaciones para Ana: 2 sin leer y 3 leidas, de tipos con iconos
--     distintos.
--
-- FECHAS: todo relativo a now(), para que «ayer», «hoy» y «Hace 15 min» sean
-- ciertos el dia que se siembra. Las conversaciones se crean hace 30 dias: el
-- tope de 10 grupos por hora cuenta los recientes, y asi crear una comunidad
-- desde una prueba no choca con lo sembrado.

begin;

-- ---------------------------------------------------------------------------
-- 0. Limpieza: lo de estas conversaciones y cualquier chat directo suelto
--    entre Ana y Beto (lo crearia «Mensaje» desde un perfil si faltara el par).
-- ---------------------------------------------------------------------------

-- Temas que las pruebas hayan creado en los grupos sembrados: se borran con su
-- chat (el borrado de la conversacion arrastra la fila del tema y sus mensajes).
delete from public.conversations c
using public.conversation_topics t
where t.chat_id = c.id
  and t.conversation_id in ('e2e30000-0000-4000-8000-000000000010',
                            'e2e30000-0000-4000-8000-000000000020')
  and t.id not in ('e2e30000-0000-4000-8000-000000000011',
                   'e2e30000-0000-4000-8000-000000000021');

-- Comunidades que las pruebas hayan creado en los grupos sembrados.
delete from public.conversations c
using public.group_subgroups s
where s.conversation_id = c.id
  and s.parent_id in ('e2e30000-0000-4000-8000-000000000010',
                      'e2e30000-0000-4000-8000-000000000020')
  and s.conversation_id not in ('e2e30000-0000-4000-8000-000000000013',
                                'e2e30000-0000-4000-8000-000000000023');

-- Chats directos Ana–Beto que no sean el sembrado.
delete from public.conversations c
where c.kind = 'direct'
  and c.id <> 'e2e30000-0000-4000-8000-000000000001'
  and exists (select 1 from public.conversation_members m
              where m.conversation_id = c.id and m.user_id = 'e2e0a0a0-0000-4000-8000-000000000001')
  and exists (select 1 from public.conversation_members m
              where m.conversation_id = c.id and m.user_id = 'e2e0b0b0-0000-4000-8000-000000000002');

-- Grupos que las pruebas hayan creado con Ana o Beto como creador (p. ej. el
-- flujo de «Crear un grupo»), salvo los sembrados y sus temas/comunidades.
delete from public.conversations c
where c.kind = 'group'
  and c.created_by in ('e2e0a0a0-0000-4000-8000-000000000001',
                       'e2e0b0b0-0000-4000-8000-000000000002')
  and c.id::text not like 'e2e30000-%';

-- Lo sembrado se rehace entero: borrar la conversacion arrastra miembros,
-- mensajes, temas, comunidades, preferencias y etiquetas (on delete cascade).
delete from public.conversations
where id::text like 'e2e30000-0000-4000-8000-0000000000%';

-- ---------------------------------------------------------------------------
-- 1. Conversaciones
-- ---------------------------------------------------------------------------
insert into public.conversations (id, title, kind, created_by, created_at, updated_at) values
  -- Chat de dos. Sin titulo: la bandeja enseña el nombre de la otra persona.
  ('e2e30000-0000-4000-8000-000000000001', null,               'direct', 'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '5 minutes'),
  -- Grupo de Ana + chat de su tema + su comunidad.
  ('e2e30000-0000-4000-8000-000000000010', 'Taller E2E',       'group',  'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '30 minutes'),
  ('e2e30000-0000-4000-8000-000000000012', 'Avisos',           'group',  'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '2 hours 45 minutes'),
  ('e2e30000-0000-4000-8000-000000000013', 'Esmaltes',         'group',  'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '2 hours'),
  -- Grupo de Beto + chat de su tema + su comunidad.
  ('e2e30000-0000-4000-8000-000000000020', 'Carpinteria E2E',  'group',  'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '1 day 2 hours'),
  ('e2e30000-0000-4000-8000-000000000022', 'Planos',           'group',  'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '1 day 1 hour'),
  ('e2e30000-0000-4000-8000-000000000023', 'Torno',            'group',  'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '3 days');

-- El par del chat directo (migracion 0039): con el, «Mensaje» desde el perfil
-- de Beto abre ESTA conversacion y no crea otra.
insert into public.direct_conversation_pairs (user_low, user_high, conversation_id, created_at)
values ('e2e0a0a0-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002',
        'e2e30000-0000-4000-8000-000000000001', now() - interval '30 days')
on conflict (user_low, user_high) do update set conversation_id = excluded.conversation_id;

-- ---------------------------------------------------------------------------
-- 2. Miembros y hasta donde ha leido cada uno
-- ---------------------------------------------------------------------------
insert into public.conversation_members (conversation_id, user_id, joined_at, last_read_at) values
  -- Chat: Ana leyo hasta su ultimo mensaje (-40 min) => lo de Beto de -10 y
  -- -5 min queda sin leer (2). Beto leyo hasta -38 min => lo de Ana, leido.
  ('e2e30000-0000-4000-8000-000000000001', 'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '39 minutes'),
  ('e2e30000-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '38 minutes'),
  -- Taller E2E (General): 1 sin leer para Ana (Beto, -30 min).
  ('e2e30000-0000-4000-8000-000000000010', 'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '2 hours 40 minutes'),
  ('e2e30000-0000-4000-8000-000000000010', 'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '1 minute'),
  -- Chat del tema «Avisos»: los miembros del grupo, como hace la API al crearlo.
  ('e2e30000-0000-4000-8000-000000000012', 'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '2 hours 44 minutes'),
  ('e2e30000-0000-4000-8000-000000000012', 'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '1 minute'),
  -- Comunidad «Esmaltes»: solo Ana, que la creo.
  ('e2e30000-0000-4000-8000-000000000013', 'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '1 hour 59 minutes'),
  -- Carpinteria E2E (General): Ana lo leyo todo.
  ('e2e30000-0000-4000-8000-000000000020', 'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '1 minute'),
  ('e2e30000-0000-4000-8000-000000000020', 'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '1 day'),
  -- Chat del tema «Planos»: Ana nunca lo abrio => 1 sin ver.
  ('e2e30000-0000-4000-8000-000000000022', 'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '1 minute'),
  ('e2e30000-0000-4000-8000-000000000022', 'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days', null),
  -- Comunidad «Torno»: solo Beto. Ana la ve en la lista con «Unirme».
  ('e2e30000-0000-4000-8000-000000000023', 'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days', now() - interval '1 minute');

-- ---------------------------------------------------------------------------
-- 3. Temas y comunidades (migraciones 0108 y 0109)
-- ---------------------------------------------------------------------------
insert into public.conversation_topics
  (id, conversation_id, chat_id, nombre, nombre_normalizado, icono, posicion, created_by, created_at) values
  ('e2e30000-0000-4000-8000-000000000011', 'e2e30000-0000-4000-8000-000000000010',
   'e2e30000-0000-4000-8000-000000000012', 'Avisos', 'avisos', 'bell', 0,
   'e2e0a0a0-0000-4000-8000-000000000001', now() - interval '30 days'),
  ('e2e30000-0000-4000-8000-000000000021', 'e2e30000-0000-4000-8000-000000000020',
   'e2e30000-0000-4000-8000-000000000022', 'Planos', 'planos', 'folder', 0,
   'e2e0b0b0-0000-4000-8000-000000000002', now() - interval '30 days');

insert into public.group_subgroups (conversation_id, parent_id, descripcion, entrada, posicion, created_at) values
  ('e2e30000-0000-4000-8000-000000000013', 'e2e30000-0000-4000-8000-000000000010',
   'Recetas y pruebas de esmalte', 'open', 0, now() - interval '30 days'),
  ('e2e30000-0000-4000-8000-000000000023', 'e2e30000-0000-4000-8000-000000000020',
   'Piezas torneadas', 'open', 0, now() - interval '30 days');

-- ---------------------------------------------------------------------------
-- 4. Mensajes
-- ---------------------------------------------------------------------------
-- Chat Ana–Beto. AYER: 16 mensajes alternos, de -1 dia -48 min a -1 dia -3 min.
insert into public.messages (conversation_id, sender_id, body, created_at)
select 'e2e30000-0000-4000-8000-000000000001',
       case when n % 2 = 1 then 'e2e0b0b0-0000-4000-8000-000000000002'::uuid
            else 'e2e0a0a0-0000-4000-8000-000000000001'::uuid end,
       texto,
       now() - interval '1 day' - make_interval(mins => (17 - n) * 3)
from (values
  (1,  'Hola Ana, ¿cómo va el taller?'),
  (2,  '¡Hola Beto! Bien, horneando el segundo lote.'),
  (3,  '¿Las tazas azules?'),
  (4,  'Sí, con esmalte azul y arena.'),
  (5,  'Quiero dos para la mesa nueva.'),
  (6,  'Te las aparto.'),
  (7,  '¿Cuánto tardan en estar listas?'),
  (8,  'Una semana, más o menos. Depende del horno, de la humedad del taller y de si el esmalte sale parejo en la primera cocción; si no, toca repetirla.'),
  (9,  'Perfecto, no hay apuro.'),
  (10, 'Te aviso cuando salgan del horno.'),
  (11, 'Gracias. Yo sigo con el roble.'),
  (12, '¿Le diste las tres capas de aceite?'),
  (13, 'Dos de tres, mañana la última.'),
  (14, 'Cuando esté, mándame una foto.'),
  (15, 'Hecho.'),
  (16, '¡Buenas noches!')
) as v(n, texto);

-- Chat Ana–Beto. HOY.
insert into public.messages (conversation_id, sender_id, body, created_at) values
  ('e2e30000-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Buenos días. Mira lo que encontré', now() - interval '60 minutes'),
  ('e2e30000-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002',
   'La feria de artesanos: https://example.com/feria-e2e', now() - interval '59 minutes'),
  ('e2e30000-0000-4000-8000-000000000001', 'e2e0a0a0-0000-4000-8000-000000000001',
   'Lo vi, ¡qué buena! Vamos juntos.', now() - interval '40 minutes'),
  -- Los dos SIN LEER para Ana.
  ('e2e30000-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Genial, salimos a las 10.', now() - interval '10 minutes'),
  ('e2e30000-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002',
   '¿Llevas las tazas?', now() - interval '5 minutes');

-- Taller E2E: General, el tema y la comunidad.
insert into public.messages (conversation_id, sender_id, body, created_at) values
  ('e2e30000-0000-4000-8000-000000000010', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Hola a todos, bienvenidos al grupo del taller.', now() - interval '3 hours'),
  ('e2e30000-0000-4000-8000-000000000010', 'e2e0a0a0-0000-4000-8000-000000000001',
   'Los avisos importantes van en el tema Avisos.', now() - interval '2 hours 50 minutes'),
  ('e2e30000-0000-4000-8000-000000000010', 'e2e0b0b0-0000-4000-8000-000000000002',
   '¿Mañana abrimos a las 9?', now() - interval '30 minutes'),
  ('e2e30000-0000-4000-8000-000000000012', 'e2e0a0a0-0000-4000-8000-000000000001',
   'Horario: lunes a viernes de 9 a 18.', now() - interval '2 hours 45 minutes'),
  ('e2e30000-0000-4000-8000-000000000013', 'e2e0a0a0-0000-4000-8000-000000000001',
   'Recetas de esmalte aquí.', now() - interval '2 hours');

-- Carpinteria E2E: General (de ayer), el tema y la comunidad.
insert into public.messages (conversation_id, sender_id, body, created_at) values
  ('e2e30000-0000-4000-8000-000000000020', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Grupo para compartir planos y dudas.', now() - interval '1 day 2 hours'),
  ('e2e30000-0000-4000-8000-000000000022', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Plano de la mesa de roble.', now() - interval '1 day 1 hour'),
  ('e2e30000-0000-4000-8000-000000000023', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Bienvenidos al torno.', now() - interval '3 days');

-- ---------------------------------------------------------------------------
-- 5. Notificaciones de Ana: 2 sin leer y 3 leidas, iconos distintos.
--    Por id fijo: no se tocan las que generen otros modulos.
-- ---------------------------------------------------------------------------
delete from public.notifications where id::text like 'e2e30000-0000-4000-8000-0000000003%';

insert into public.notifications (id, user_id, actor_id, type, entity_type, entity_id, payload, read_at, created_at) values
  -- Sin leer. «Nuevo seguidor» (campana) -> al tocar, perfil de Beto.
  ('e2e30000-0000-4000-8000-000000000301', 'e2e0a0a0-0000-4000-8000-000000000001',
   'e2e0b0b0-0000-4000-8000-000000000002', 'follow', 'profile', 'e2e0b0b0-0000-4000-8000-000000000002',
   '{}'::jsonb, null, now() - interval '15 minutes'),
  -- Sin leer. «Nuevo comentario» (globo) -> publicacion a1 de Ana (00-base).
  ('e2e30000-0000-4000-8000-000000000302', 'e2e0a0a0-0000-4000-8000-000000000001',
   'e2e0b0b0-0000-4000-8000-000000000002', 'comment', 'post', 'e2e00000-0000-4000-8000-0000000000a1',
   '{}'::jsonb, null, now() - interval '1 hour'),
  -- Leidas.
  ('e2e30000-0000-4000-8000-000000000303', 'e2e0a0a0-0000-4000-8000-000000000001',
   'e2e0b0b0-0000-4000-8000-000000000002', 'like', 'post', 'e2e00000-0000-4000-8000-0000000000a2',
   '{}'::jsonb, now() - interval '2 hours', now() - interval '3 hours'),
  ('e2e30000-0000-4000-8000-000000000304', 'e2e0a0a0-0000-4000-8000-000000000001',
   'e2e0b0b0-0000-4000-8000-000000000002', 'session_accepted', 'booking', null,
   '{}'::jsonb, now() - interval '20 hours', now() - interval '1 day'),
  ('e2e30000-0000-4000-8000-000000000305', 'e2e0a0a0-0000-4000-8000-000000000001',
   'e2e0b0b0-0000-4000-8000-000000000002', 'live_started', 'live', null,
   '{}'::jsonb, now() - interval '1 day', now() - interval '2 days');

commit;

-- Comprobacion (sale en la salida de psql si se ejecuta a mano).
select c.title, c.kind, count(m.id) as mensajes
from public.conversations c
left join public.messages m on m.conversation_id = c.id
where c.id::text like 'e2e30000-%'
group by c.id, c.title, c.kind
order by c.id;
