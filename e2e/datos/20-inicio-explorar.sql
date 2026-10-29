-- Datos del modulo «Inicio + Explorar + publicaciones». SOLO Supabase LOCAL.
--
-- Lo ejecuta `e2e/scripts/sembrar.sh` despues de 00-base.sql. Idempotente:
-- 00-base.sql ya borra TODAS las publicaciones de Ana y Beto (y con ellas, en
-- cascada, comentarios, me gusta, guardados, etiquetas y menciones), asi que
-- aqui solo se reponen las de este modulo con UUID fijos. Las historias y el
-- circulo no los borra nadie: se reponen con upsert.
--
--   Ana  = e2e0a0a0-0000-4000-8000-000000000001
--   Beto = e2e0b0b0-0000-4000-8000-000000000002
--
-- Prefijo de los UUID de este modulo: e2e2....
--
-- Que necesita cada flujo (e2e/flujos/inicio-explorar/):
--   P1 (Beto, sin me gusta, sin guardar, sin comentarios) -> me gusta y guardar
--   P2 (Ana, #TallerE2E, menciona a Beto)                 -> etiqueta y mencion
--   P3 (Beto, con foto y dos comentarios)                  -> detalle y comentarios
--   P4 (Beto, sin me gusta)                                -> me gusta abriendo
--                                                             por enlace directo
--   Cuatro historias de Beto que Ana NO ha visto           -> anillo rosa
--     (cuatro de 30 s, el maximo que admite la tabla: en este emulador cada
--      paso de Maestro tarda hasta 40 s mientras la barra de progreso se anima,
--      y con dos la historia se acababa sola antes de comprobarla. El flujo
--      pausa la historia tocando el campo de respuesta y la cierra, asi que
--      quedan historias sin ver y el anillo sigue rosa en la siguiente pasada)
--   Un circulo con Ana y Beto                              -> tarjeta «Tu circulo»
--
-- Fechas relativas a now(): estas publicaciones quedan ENCIMA de las de
-- 00-base.sql en el muro, y las historias caducan 24 h despues de sembrar.

begin;

-- 1. Publicaciones ---------------------------------------------------------
-- Por si este archivo se lanza a mano sin 00-base.sql delante.
delete from public.posts
where id in ('e2e20000-0000-4000-8000-000000000001',
             'e2e20000-0000-4000-8000-000000000002',
             'e2e20000-0000-4000-8000-000000000003',
             'e2e20000-0000-4000-8000-000000000004');

insert into public.posts (id, author_id, body, status, visibility, created_at) values
  -- P1: la mas reciente, la primera del muro en «Para ti».
  ('e2e20000-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Lijado fino antes del barniz: grano 320 y sin prisa.',
   'published', 'public', now() - interval '5 minutes'),
  -- P2: etiqueta en el texto y Beto etiquetado (sale como «Con @beto_e2e»).
  ('e2e20000-0000-4000-8000-000000000002', 'e2e0a0a0-0000-4000-8000-000000000001',
   'Este sabado abrimos el taller a quien quiera venir #TallerE2E',
   'published', 'public', now() - interval '10 minutes'),
  -- P3: con foto (tocarla abre el detalle) y comentarios previos.
  ('e2e20000-0000-4000-8000-000000000003', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Acabado al aceite o al barniz? Os leo en los comentarios.',
   'published', 'public', now() - interval '15 minutes'),
  -- P4: solo para el flujo del enlace directo (no la toca nadie mas).
  ('e2e20000-0000-4000-8000-000000000004', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Enlace directo E2E: cola de milano a mano, sin plantilla.',
   'published', 'public', now() - interval '20 minutes');

-- La foto ya la sube sembrar.sh (es la misma que usa b1 en 00-base.sql).
insert into public.post_media (post_id, storage_path, media_type, sort_order, width, height, processing_status) values
  ('e2e20000-0000-4000-8000-000000000003',
   'e2e0b0b0-0000-4000-8000-000000000002/e2e/foto-3.jpg', 'image', 0, 1080, 1350, 'ready');

-- Etiqueta: la API la extrae al publicar; sembrando por SQL hay que ponerla.
insert into public.hashtags (tag, display_tag) values ('tallere2e', 'TallerE2E')
on conflict (tag) do update set display_tag = excluded.display_tag;

insert into public.post_hashtags (post_id, hashtag_id)
select 'e2e20000-0000-4000-8000-000000000002', h.id from public.hashtags h where h.tag = 'tallere2e'
on conflict do nothing;

-- Mencion: Ana etiqueta a Beto en P2.
insert into public.post_mentions (post_id, mentioned_user_id) values
  ('e2e20000-0000-4000-8000-000000000002', 'e2e0b0b0-0000-4000-8000-000000000002')
on conflict do nothing;

-- Comentarios previos de P3 (los ids fijos permiten reconocerlos).
insert into public.comments (id, post_id, author_id, body, status, created_at) values
  ('e2e2c000-0000-4000-8000-000000000001', 'e2e20000-0000-4000-8000-000000000003',
   'e2e0a0a0-0000-4000-8000-000000000001', 'Al aceite, sin duda: se nota la veta.',
   'published', now() - interval '14 minutes'),
  ('e2e2c000-0000-4000-8000-000000000002', 'e2e20000-0000-4000-8000-000000000003',
   'e2e0b0b0-0000-4000-8000-000000000002', 'Gracias, Ana. El sabado lo probamos.',
   'published', now() - interval '13 minutes');

-- 2. Historias de Beto que Ana no ha visto ---------------------------------
insert into public.stories (id, author_id, storage_path, media_type, duration_ms, caption, created_at, expires_at) values
  ('e2e25000-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002',
   'e2e0b0b0-0000-4000-8000-000000000002/e2e/foto-3.jpg', 'image', 30000,
   'Historia E2E de Beto 1: la mesa recien aceitada', now() - interval '2 hours', now() + interval '22 hours'),
  ('e2e25000-0000-4000-8000-000000000002', 'e2e0b0b0-0000-4000-8000-000000000002',
   'e2e0b0b0-0000-4000-8000-000000000002/e2e/foto-4.jpg', 'image', 30000,
   'Historia E2E de Beto 2: el canto pulido', now() - interval '1 hour 30 minutes', now() + interval '22 hours 30 minutes'),
  ('e2e25000-0000-4000-8000-000000000003', 'e2e0b0b0-0000-4000-8000-000000000002',
   'e2e0b0b0-0000-4000-8000-000000000002/e2e/foto-3.jpg', 'image', 30000,
   'Historia E2E de Beto 3: la veta de cerca', now() - interval '1 hour', now() + interval '23 hours'),
  ('e2e25000-0000-4000-8000-000000000004', 'e2e0b0b0-0000-4000-8000-000000000002',
   'e2e0b0b0-0000-4000-8000-000000000002/e2e/foto-4.jpg', 'image', 30000,
   'Historia E2E de Beto 4: lista para entregar', now() - interval '30 minutes', now() + interval '23 hours 30 minutes')
on conflict (id) do update set
  storage_path = excluded.storage_path,
  media_type   = excluded.media_type,
  duration_ms  = excluded.duration_ms,
  caption      = excluded.caption,
  created_at   = excluded.created_at,
  expires_at   = excluded.expires_at;

-- Sin ver: el anillo de Beto vuelve a rosa en cada siembra.
delete from public.story_views
where story_id in ('e2e25000-0000-4000-8000-000000000001', 'e2e25000-0000-4000-8000-000000000002',
                   'e2e25000-0000-4000-8000-000000000003', 'e2e25000-0000-4000-8000-000000000004');

-- 3. Circulo para la tarjeta «Tu circulo» -----------------------------------
insert into public.circles (id, owner_id, name, description, is_private) values
  ('e2e2c1c0-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Circulo E2E de oficios', 'Circulo de pruebas E2E: carpinteria y ceramica.', true)
on conflict (id) do update set
  owner_id = excluded.owner_id, name = excluded.name,
  description = excluded.description, is_private = excluded.is_private;

delete from public.circle_members where circle_id = 'e2e2c1c0-0000-4000-8000-000000000001';
insert into public.circle_members (circle_id, user_id, role) values
  ('e2e2c1c0-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002', 'owner'),
  ('e2e2c1c0-0000-4000-8000-000000000001', 'e2e0a0a0-0000-4000-8000-000000000001', 'member');

-- 4. Nada que esconda a Beto del muro de Ana --------------------------------
-- Un bloqueo que otra prueba dejara puesto vaciaria el muro (la API filtra los
-- bloqueos en las dos direcciones). Si un modulo posterior necesita el
-- bloqueo, su .sql (NN > 20) lo vuelve a poner.
delete from public.user_blocks
where (blocker_id = 'e2e0a0a0-0000-4000-8000-000000000001' and blocked_id = 'e2e0b0b0-0000-4000-8000-000000000002')
   or (blocker_id = 'e2e0b0b0-0000-4000-8000-000000000002' and blocked_id = 'e2e0a0a0-0000-4000-8000-000000000001');

commit;

-- Comprobacion.
select 'publicaciones' as que, count(*) from public.posts where id::text like 'e2e20000-%'
union all select 'historias sin ver', count(*) from public.stories s
  where s.id::text like 'e2e25000-%' and s.expires_at > now()
    and not exists (select 1 from public.story_views v
                    where v.story_id = s.id and v.viewer_id = 'e2e0a0a0-0000-4000-8000-000000000001')
union all select 'comentarios', count(*) from public.comments where post_id = 'e2e20000-0000-4000-8000-000000000003'
union all select 'miembros del circulo', count(*) from public.circle_members where circle_id = 'e2e2c1c0-0000-4000-8000-000000000001';
