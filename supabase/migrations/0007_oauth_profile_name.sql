-- Nombre del perfil al registrarse con un proveedor externo.
--
-- El trigger solo leia `full_name`, que es lo que envia el registro por correo
-- de esta app. Google manda el nombre en `name` (y a veces en `full_name`),
-- asi que un usuario de Google entraba con el nombre vacio y la app le
-- saludaba en generico.
--
-- No se toca `avatar_path`: esa columna guarda una RUTA dentro del bucket
-- `avatars`, no una URL externa. Meter aqui la foto de Google produciria un
-- enlace roto al resolverla contra el bucket.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, username)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data->>'full_name', ''),
      nullif(new.raw_user_meta_data->>'name', ''),
      -- Ultimo recurso: la parte local del correo, mejor que dejarlo vacio.
      split_part(coalesce(new.email, ''), '@', 1),
      ''
    ),
    nullif(new.raw_user_meta_data->>'username', '')
  );
  return new;
end;
$$;
