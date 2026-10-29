-- Datos base de la suite E2E. SOLO para el Supabase LOCAL (zeta-local).
--
-- Lo ejecuta `e2e/scripts/sembrar.sh` DESPUES de crear a Ana y Beto en Auth
-- (con estos mismos UUID) y de subir sus imagenes a Storage. Idempotente: cada
-- ejecucion devuelve a Ana y Beto al mismo punto de partida.
--
--   Ana  = e2e0a0a0-0000-4000-8000-000000000001  ana.e2e@zeta.test
--   Beto = e2e0b0b0-0000-4000-8000-000000000002  beto.e2e@zeta.test
--
-- Los modulos que necesiten mas datos van en su propio NN-<modulo>.sql y se
-- ejecutan despues de este, por orden de nombre.

begin;

-- Perfiles completos (el trigger de auth.users ya creo la fila).
--
-- SIN FOTO A PROPOSITO: la app pide los avatares por el transformador de
-- imagenes de Storage (`/render/image/...`), que el Supabase local no tiene
-- (responde 404) y `Avatar` no cae a las iniciales cuando la imagen falla:
-- saldria un circulo gris vacio. Con `avatar_path` nulo se ven las iniciales,
-- que es estable para las capturas. Las fotos SI estan subidas
-- (avatars/<uid>/e2e/avatar.jpg) por si un modulo las quiere activar.
update public.profiles set
  full_name   = 'Ana Prueba',
  username    = 'ana_e2e',
  bio         = 'Cuenta de pruebas E2E. Ceramica y diseno.',
  avatar_path = null,
  is_private  = false,
  cover_path  = null,
  role        = 'user'
where id = 'e2e0a0a0-0000-4000-8000-000000000001';

update public.profiles set
  full_name   = 'Beto Prueba',
  username    = 'beto_e2e',
  bio         = 'Cuenta de pruebas E2E. Carpinteria.',
  avatar_path = null,
  is_private  = false,
  cover_path  = null,
  role        = 'user'
where id = 'e2e0b0b0-0000-4000-8000-000000000002';

-- Cuestionario de recomendacion ya visto: sin esto cada inicio de sesion
-- manda a /onboarding en vez de a las pestanas. Version alta a proposito para
-- que subir ONBOARDING_VERSION en la API no rompa la suite.
insert into public.recommendation_preferences (user_id, onboarding_version, completed_at, skipped)
values
  ('e2e0a0a0-0000-4000-8000-000000000001', 1000, now(), true),
  ('e2e0b0b0-0000-4000-8000-000000000002', 1000, now(), true)
on conflict (user_id) do update
  set onboarding_version = excluded.onboarding_version,
      completed_at       = excluded.completed_at,
      skipped            = excluded.skipped;

-- Se siguen mutuamente.
delete from public.follows
where follower_id  in ('e2e0a0a0-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002')
   or following_id in ('e2e0a0a0-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002');
insert into public.follows (follower_id, following_id) values
  ('e2e0a0a0-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002'),
  ('e2e0b0b0-0000-4000-8000-000000000002', 'e2e0a0a0-0000-4000-8000-000000000001');

-- Publicaciones: se borra TODO lo que Ana y Beto hayan publicado (incluido lo
-- que crearon las pruebas en la ultima pasada) y se reponen las de partida.
-- El borrado arrastra media, comentarios, me gusta y guardados (on delete cascade).
delete from public.posts
where author_id in ('e2e0a0a0-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002');

insert into public.posts (id, author_id, body, status, visibility, created_at) values
  ('e2e00000-0000-4000-8000-0000000000a1', 'e2e0a0a0-0000-4000-8000-000000000001',
   'Primer lote de tazas del taller. Esmalte azul y arena.', 'published', 'public', now() - interval '2 days'),
  ('e2e00000-0000-4000-8000-0000000000a2', 'e2e0a0a0-0000-4000-8000-000000000001',
   'Probando luz natural para las fotos del catalogo.', 'published', 'public', now() - interval '1 day 20 hours'),
  ('e2e00000-0000-4000-8000-0000000000a3', 'e2e0a0a0-0000-4000-8000-000000000001',
   'Publicacion solo de texto de Ana para las pruebas E2E.', 'published', 'public', now() - interval '1 day 12 hours'),
  ('e2e00000-0000-4000-8000-0000000000b1', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Mesa de roble terminada. Tres capas de aceite y lija entre cada una.', 'published', 'public', now() - interval '1 day 6 hours'),
  ('e2e00000-0000-4000-8000-0000000000b2', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Herramienta de mano: el formon bien afilado lo es todo.', 'published', 'public', now() - interval '1 day 2 hours'),
  ('e2e00000-0000-4000-8000-0000000000b3', 'e2e0b0b0-0000-4000-8000-000000000002',
   'Publicacion solo de texto de Beto para las pruebas E2E.', 'published', 'public', now() - interval '1 day');

insert into public.post_media (post_id, storage_path, media_type, sort_order, width, height, processing_status) values
  ('e2e00000-0000-4000-8000-0000000000a1', 'e2e0a0a0-0000-4000-8000-000000000001/e2e/foto-1.jpg', 'image', 0, 1080, 1350, 'ready'),
  ('e2e00000-0000-4000-8000-0000000000a2', 'e2e0a0a0-0000-4000-8000-000000000001/e2e/foto-2.jpg', 'image', 0, 1080, 1350, 'ready'),
  ('e2e00000-0000-4000-8000-0000000000b1', 'e2e0b0b0-0000-4000-8000-000000000002/e2e/foto-3.jpg', 'image', 0, 1080, 1350, 'ready'),
  ('e2e00000-0000-4000-8000-0000000000b2', 'e2e0b0b0-0000-4000-8000-000000000002/e2e/foto-4.jpg', 'image', 0, 1080, 1350, 'ready');

commit;

-- Comprobacion (sale en la salida de psql si se ejecuta a mano).
select p.username, count(distinct po.id) as publicaciones, count(pm.id) as con_imagen
from public.profiles p
left join public.posts po on po.author_id = p.id
left join public.post_media pm on pm.post_id = po.id
where p.id in ('e2e0a0a0-0000-4000-8000-000000000001', 'e2e0b0b0-0000-4000-8000-000000000002')
group by p.username order by p.username;
