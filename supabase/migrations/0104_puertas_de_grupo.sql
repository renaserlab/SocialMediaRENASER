-- 0104 · Las puertas de un grupo: su foto, su enlace y las solicitudes para entrar
--
-- QUÉ RESUELVE (pedido del 10/10/2026). Hasta ahora a un grupo solo se entraba
-- porque quien lo administra te añadía. Se pide:
--
--   · que el grupo tenga FOTO;
--   · que quien lo administra pueda compartir un ENLACE del grupo;
--   · que en su perfil pueda aparecer «Únete a mi grupo»;
--   · y que quien quiera entrar lo PIDA, y a quien administra le llegue el
--     aviso y decida.
--
-- QUÉ HACE. Crea dos tablas:
--
--   · `group_settings`: UNA fila por grupo, con su foto, si se enseña en el
--     perfil de quien lo administra, y su enlace (un código y si está activo).
--   · `group_join_requests`: una fila por solicitud, con su estado.
--
-- POR QUÉ NO SON COLUMNAS DE `conversations`. Por lo mismo que la 0033, la
-- 0098 o la 0102: una columna nueva en una tabla tan leída rompe el código ya
-- desplegado que la pide entera. En una tabla aparte, el código desplegado
-- antes que esta migración sigue leyendo las conversaciones sin enterarse.
--
-- ENTRAR SIEMPRE PASA POR QUIEN ADMINISTRA. Ni el enlace ni el perfil meten a
-- nadie en el grupo: crean una solicitud. Un enlace que metiera directamente
-- sería una puerta abierta para cualquiera a quien se lo reenvíen.
--
-- UNA SOLA SOLICITUD VIVA POR PERSONA Y GRUPO. Lo impone un índice único
-- parcial: pulsar «Pedir unirme» diez veces, o dos peticiones a la vez, dejan
-- una fila. Las ya resueltas se conservan: son el historial.
--
-- EL CÓDIGO DEL ENLACE ES ÚNICO Y SE PUEDE CAMBIAR. Cambiarlo deja sin efecto
-- el enlace anterior, que es la forma de «retirarlo» si se difundió de más.
--
-- QUÉ NO HACE.
--   · No toca `conversations`, `conversation_members`, `messages` ni una sola
--     fila existente. Los grupos que ya existen siguen igual: sin foto, sin
--     enlace y sin aparecer en ningún perfil hasta que quien los administra
--     lo decida.
--   · No guarda la foto: guarda su RUTA en el almacenamiento, igual que la
--     foto de un perfil.
--   · No entra en la publicación de tiempo real.
--
-- SEGURIDAD. RLS activada y NINGUNA política en las dos tablas: con la clave
-- del cliente no se leen ni se escriben. Quién puede ver la tarjeta de un
-- grupo, quién puede pedir entrar y quién decide lo resuelve la API en cada
-- petición. Con una política de lectura, cualquiera podría listar por
-- PostgREST los códigos de los enlaces de todos los grupos.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
--
-- CÓMO SE DESHACE:
--   drop table public.group_join_requests;
--   drop table public.group_settings;
-- No se pierde ningún mensaje ni ningún miembro: solo fotos, enlaces y
-- solicitudes.

create table if not exists public.group_settings (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  avatar_path text,
  listed_on_profile boolean not null default false,
  invite_code text,
  invite_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.group_settings
  drop constraint if exists group_settings_avatar_path_check;
alter table public.group_settings
  add constraint group_settings_avatar_path_check
  check (avatar_path is null or char_length(avatar_path) between 1 and 512);

alter table public.group_settings
  drop constraint if exists group_settings_invite_code_check;
alter table public.group_settings
  add constraint group_settings_invite_code_check
  check (invite_code is null or invite_code ~ '^[A-Za-z0-9_-]{16,64}$');

-- Un enlace activo necesita su código.
alter table public.group_settings
  drop constraint if exists group_settings_invite_enabled_check;
alter table public.group_settings
  add constraint group_settings_invite_enabled_check
  check (not invite_enabled or invite_code is not null);

-- Dos grupos no pueden compartir enlace.
create unique index if not exists group_settings_invite_code_uidx
  on public.group_settings (invite_code)
  where invite_code is not null;

create table if not exists public.group_join_requests (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
  source text not null default 'profile',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null
);

alter table public.group_join_requests
  drop constraint if exists group_join_requests_status_check;
alter table public.group_join_requests
  add constraint group_join_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'cancelled'));

alter table public.group_join_requests
  drop constraint if exists group_join_requests_source_check;
alter table public.group_join_requests
  add constraint group_join_requests_source_check
  check (source in ('profile', 'link'));

-- Una sola solicitud viva por persona y grupo.
create unique index if not exists group_join_requests_pending_uidx
  on public.group_join_requests (conversation_id, user_id)
  where status = 'pending';

-- Lo que lee quien administra: las pendientes de SU grupo, por orden de llegada.
create index if not exists group_join_requests_conversation_idx
  on public.group_join_requests (conversation_id, status, created_at);

-- Lo que se cuenta para el tope por persona.
create index if not exists group_join_requests_user_idx
  on public.group_join_requests (user_id, created_at);

alter table public.group_settings enable row level security;
alter table public.group_join_requests enable row level security;

do $$
declare
  tabla text;
  con_rls boolean;
  politicas integer;
begin
  foreach tabla in array array['group_settings', 'group_join_requests'] loop
    select relrowsecurity into con_rls
    from pg_class
    where oid = ('public.' || tabla)::regclass;
    if not coalesce(con_rls, false) then
      raise exception 'La 0104 no ha dejado RLS activada en %.', tabla;
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
