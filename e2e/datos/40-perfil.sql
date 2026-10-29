-- Datos del modulo «perfil-ajustes» (agente 4). SOLO para el Supabase LOCAL.
--
-- Corre DESPUES de 00-base.sql (orden de nombre). Idempotente: cada pasada
-- deja el mismo punto de partida, aunque una prueba anterior se cortara a
-- mitad (seguir, bloquear o editar el perfil a medias).
--
-- POR QUE UNA TERCERA PERSONA Y NO BETO. 00-base deja a Ana y Beto
-- siguiendose (lo necesitan Inicio › Siguiendo y Mensajes). Para probar
-- «Seguir» → «Siguiendo» hace falta alguien a quien Ana NO siga y cuyas cifras
-- no toque nadie mas, asi que se crea a Delia, que nunca inicia sesion:
--
--   Delia = e2e0d0d0-0000-4000-8000-000000000040  delia.e2e@zeta.test
--
-- Punto de partida de Delia: 0 seguidores, 0 siguiendo, 0 me gusta y una
-- publicacion SOLO DE TEXTO y antigua (60 dias), para que no suba al principio
-- del muro de nadie ni se cruce con las pruebas de otros modulos.

begin;

-- Delia en Auth. Solo lo minimo para que exista el perfil: no se le da
-- identidad porque no entra nunca. Los *_token van a '' y no a NULL: GoTrue
-- falla al listar usuarios si encuentra NULL en ellos.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', 'e2e0d0d0-0000-4000-8000-000000000040',
  'authenticated', 'authenticated', 'delia.e2e@zeta.test',
  extensions.crypt('Zeta-e2e-2026', extensions.gen_salt('bf')), now(),
  '', '', '', '',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Delia Prueba","username":"delia_e2e"}',
  now(), now()
)
on conflict (id) do nothing;

-- El trigger `handle_new_user` crea la fila del perfil; se completa siempre
-- (por si ya existia de otra pasada con otros valores).
insert into public.profiles (id, email, full_name, username)
values ('e2e0d0d0-0000-4000-8000-000000000040', 'delia.e2e@zeta.test', 'Delia Prueba', 'delia_e2e')
on conflict (id) do nothing;

update public.profiles set
  full_name   = 'Delia Prueba',
  username    = 'delia_e2e',
  bio         = 'Perfil de pruebas E2E para seguir y bloquear',
  avatar_path = null,
  is_private  = false,
  role        = 'user'
where id = 'e2e0d0d0-0000-4000-8000-000000000040';

-- Nadie sigue a Delia ni Delia sigue a nadie: «Seguidores» arranca en 0.
delete from public.follows
where follower_id  = 'e2e0d0d0-0000-4000-8000-000000000040'
   or following_id = 'e2e0d0d0-0000-4000-8000-000000000040';

-- Ningun bloqueo entre Ana y Delia (la prueba de bloquear lo deshace al
-- final, pero si se corta a mitad lo repone esta linea).
delete from public.user_blocks
where (blocker_id = 'e2e0a0a0-0000-4000-8000-000000000001' and blocked_id = 'e2e0d0d0-0000-4000-8000-000000000040')
   or (blocker_id = 'e2e0d0d0-0000-4000-8000-000000000040' and blocked_id = 'e2e0a0a0-0000-4000-8000-000000000001');

-- Una publicacion de texto, antigua. Se repone entera (y sin me gusta).
delete from public.posts where author_id = 'e2e0d0d0-0000-4000-8000-000000000040';
insert into public.posts (id, author_id, body, status, visibility, created_at, updated_at) values
  ('e2e40000-0000-4000-8000-0000000000d1', 'e2e0d0d0-0000-4000-8000-000000000040',
   'Publicacion solo de texto de Delia para las pruebas E2E.', 'published', 'public',
   now() - interval '60 days', now() - interval '60 days');

-- Ana vuelve a su nombre y descripcion de partida (los de 00-base), por si la
-- prueba de editar el perfil se corto antes de restaurarlos.
update public.profiles set
  full_name = 'Ana Prueba',
  bio       = 'Cuenta de pruebas E2E. Ceramica y diseno.'
where id = 'e2e0a0a0-0000-4000-8000-000000000001';

commit;

-- Comprobacion.
select p.full_name,
       (select count(*) from public.follows f where f.following_id = p.id) as seguidores,
       (select count(*) from public.follows f where f.follower_id  = p.id) as siguiendo,
       (select count(*) from public.posts po where po.author_id = p.id)    as publicaciones
from public.profiles p
where p.id = 'e2e0d0d0-0000-4000-8000-000000000040';
