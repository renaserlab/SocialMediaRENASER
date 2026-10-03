-- 0096 · Z Servicios: rutas opacas para las imágenes del catálogo (P29).
--
-- SIN APLICAR. Escrita el 02/10/2026 y probada solo contra PostgreSQL local:
-- desde cero (0001–0096), sobre una base con la 0095 vacía y con imágenes de
-- ruta anterior, reejecutada, con un fallo a mitad y sin cada una de sus
-- dependencias (`tests/test_servicios_migracion_0096.py`). Requiere la
-- 0086–0095, ya aplicadas en Supabase. Al aplicarla, REINICIAR LA API: la
-- puerta del catálogo recuerda el «no».
--
-- EL ORDEN: PRIMERO ESTA MIGRACIÓN, DESPUÉS EL CÓDIGO. Un servidor con el
-- código nuevo y sin la 0096 contesta 503 en todo el catálogo de Servicios
-- (la puerta mira el cuerpo de esta función). Un servidor ANTERIOR con la
-- 0096 ya aplicada no podría subir una imagen (arma la ruta de la 0090, que
-- desde aquí no se registra): hoy no existe ninguno, el código de Servicios
-- no está desplegado y sus banderas están apagadas.
--
-- POR QUÉ. La 0090 exige que la ruta de una imagen empiece por el
-- identificador del PERFIL del prestador (`<perfil>/<servicio>/<versión>/…`).
-- Esa ruta viaja dentro de la URL firmada de cada tarjeta del catálogo, que
-- se ve sin sesión: delata el perfil de quien presta. La política P29
-- (02/10/2026) pide rutas opacas.
--
-- QUÉ CAMBIA, y nada más: EL CUERPO DE UNA FUNCIÓN,
-- `service_version_images_solo_en_borrador()` (la de la 0090; aquella
-- migración no se edita). Ni tablas, ni columnas, ni índices, ni permisos, ni
-- políticas, ni el depósito, ni ningún archivo.
--
--   * LA RUTA NUEVA es `<servicio>/<32 hexadecimales>.<jpg|png|webp>`. La pone
--     el servidor, al azar; el identificador del servicio delante es el mismo
--     que lleva la dirección de su ficha, y deja que la base compruebe que la
--     ruta es de ESE servicio y que la baja de una cuenta barra su carpeta.
--   * UNA RUTA ANTERIOR (la de la 0090) YA NO SE REGISTRA. Solo entra COPIADA:
--     si otra fila del mismo servicio ya la nombra. Es lo que hace la API al
--     abrir una versión nueva, que copia las filas de la publicada con su
--     misma ruta; sin esto, un servicio con imágenes anteriores no se podría
--     volver a editar.
--   * Lo demás del disparador queda igual: las imágenes solo cambian en un
--     borrador, y fuera de él solo se van en cascada.
--
-- LO QUE YA EXISTA SE QUEDA COMO ESTÁ. Las filas con ruta anterior no se
-- tocan ni se renombran, y sus archivos siguen donde están: se firman, se
-- copian y se borran igual, y la baja de la cuenta los sigue barriendo por
-- la carpeta del perfil. Esta migración NO mueve ningún objeto de Storage.
-- El 29/09/2026 el depósito `service-media` tenía 0 objetos y la tabla 0
-- filas, y el procedimiento de aplicación lo vuelve a mirar antes
-- (`docs/Z_SERVICIOS_ARQUITECTURA.md`, §124); pero la migración no depende de
-- ello: dice cuántas filas anteriores hay y sigue.
--
-- NO TRAE DINERO, pasarela, permisos ni políticas. `service_version_images`
-- sigue con RLS activa, cero políticas y cero privilegios para `anon` y
-- `authenticated`, y el depósito sigue privado: solo la API.
--
-- UNA ÚNICA TRANSACCIÓN, que primero comprueba lo anterior y al final
-- verifica lo que dejó. REEJECUTABLE.
--
-- NO SE DESHACE EN PRODUCCIÓN. Si algo falla después de aplicarla, se apaga
-- `FEATURE_SERVICES` y se corrige hacia delante, con otra migración
-- (`docs/Z_SERVICIOS_ARQUITECTURA.md`, §104).

begin;

-- ------------------------------------------------------------------------- --
-- 1. Lo que tiene que haber: la base, en la forma de la 0095.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  cuerpo text;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array[
      'profiles', 'service_providers', 'services', 'service_versions', 'service_version_images',
      'service_bookings'
    ]) t
   where to_regclass('public.' || t) is null;
  if faltan is not null then
    raise exception 'La 0096 requiere la 0086–0095 aplicadas: faltan %', faltan;
  end if;

  -- LA 0095: su función, su disparador activo y su fotografía.
  if to_regprocedure('public.servicios_reserva_con_politica()') is null
     or not exists (
       select 1 from pg_catalog.pg_trigger g
        where g.tgrelid = 'public.service_bookings'::regclass and g.tgname = 'service_bookings_con_politica'
          and not g.tgisinternal and g.tgenabled in ('O', 'A')
     )
     or not exists (
       select 1 from pg_catalog.pg_attribute a
        where a.attrelid = 'public.service_bookings'::regclass and a.attname = 'operating_policy'
          and not a.attisdropped
     ) then
    raise exception 'La 0096 requiere la 0095 aplicada (la política operativa de la reserva)';
  end if;

  -- EL DISPARADOR DE LAS IMÁGENES, el de la 0090: en su tabla, activo y sobre
  -- esta función.
  if to_regprocedure('public.service_version_images_solo_en_borrador()') is null
     or not exists (
       select 1 from pg_catalog.pg_trigger g
        where g.tgrelid = 'public.service_version_images'::regclass
          and g.tgname = 'service_version_images_solo_en_borrador'
          and not g.tgisinternal and g.tgenabled in ('O', 'A') and g.tgtype = 31
          and g.tgfoid = to_regprocedure('public.service_version_images_solo_en_borrador()')
     ) then
    raise exception 'La 0096 requiere el disparador service_version_images_solo_en_borrador de la 0090, activo';
  end if;

  -- SU CUERPO ES EL DE LA 0090 o, si esto es una reejecución, el de esta. Uno
  -- que nadie conoce no se sustituye a ciegas.
  select md5(replace(p.prosrc, E'\r', '')) into cuerpo
    from pg_catalog.pg_proc p
   where p.oid = to_regprocedure('public.service_version_images_solo_en_borrador()');
  if cuerpo not in ('b8aa892aaaf500ceaf19e4ae52a457af', '222bdbbd898701ecf458747cd45f6ef9') then
    raise exception 'La 0096 requiere service_version_images_solo_en_borrador() con el cuerpo de la 0090';
  end if;

  -- El depósito, privado.
  if to_regclass('storage.buckets') is null
     or not exists (select 1 from storage.buckets b where b.id = 'service-media' and not b.public) then
    raise exception 'La 0096 requiere el depósito privado service-media de la 0090';
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. La ruta de una imagen: opaca. La misma función, con el mismo nombre, la
--    misma firma y el mismo disparador; cambia lo que admite como ruta.
-- ------------------------------------------------------------------------- --
create or replace function public.service_version_images_solo_en_borrador()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  estado text;
  perfil uuid;
begin
  if tg_op = 'DELETE' then
    select v.status into estado from public.service_versions v where v.id = old.version_id;
    -- La versión ya no está: es la cascada del servicio o de la cuenta.
    if estado is null or estado = 'draft' then
      return old;
    end if;
    raise exception 'Una imagen de una versión % no se quita', estado
      using errcode = 'restrict_violation';
  end if;

  select v.status into estado from public.service_versions v where v.id = new.version_id;
  if estado is distinct from 'draft' then
    raise exception 'Las imágenes solo cambian en un borrador (versión %)', coalesce(estado, '?')
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'INSERT' or new.storage_path is distinct from old.storage_path then
    -- LA RUTA NUEVA (P29): `<servicio>/<32 hexadecimales>.<ext>`. Sin el
    -- perfil del prestador, y de ESTE servicio.
    if new.storage_path ~ ('^' || new.service_id::text || '/[0-9a-f]{32}[.](jpg|png|webp)$') then
      return new;
    end if;

    -- UNA RUTA ANTERIOR (0090) solo entra COPIADA: tiene la forma de la 0090 y
    -- otra fila de este mismo servicio ya la nombra. Así una versión nueva
    -- hereda las imágenes de la publicada, y nadie registra una ruta con el
    -- perfil dentro que no existiera ya.
    select p.profile_id into perfil
      from public.services s join public.service_providers p on p.id = s.provider_id
     where s.id = new.service_id;
    if perfil is null
       or new.storage_path not like (perfil::text || '/' || new.service_id::text || '/%')
       or not exists (
         select 1 from public.service_version_images i
          where i.service_id = new.service_id
            and i.storage_path = new.storage_path
            and i.id is distinct from new.id
       ) then
      raise exception 'La ruta de una imagen la pone el servidor y es de su servicio'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 3. Cerrada: solo la API. (Sustituir el cuerpo conserva sus permisos; se
--    repite para que una reejecución no dependa de eso.)
-- ------------------------------------------------------------------------- --
revoke all on function public.service_version_images_solo_en_borrador() from public, anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 4. Lo que tiene que quedar, o nada.
-- ------------------------------------------------------------------------- --
do $$
declare
  imagenes constant regclass := 'public.service_version_images'::regclass;
  funcion constant regprocedure := 'public.service_version_images_solo_en_borrador()'::regprocedure;
  anteriores bigint;
begin
  -- El cuerpo es el de esta migración, y la función sigue siendo `security
  -- invoker` con su `search_path` fijo.
  if (select md5(replace(p.prosrc, E'\r', '')) from pg_catalog.pg_proc p where p.oid = funcion)
     is distinct from '222bdbbd898701ecf458747cd45f6ef9' then
    raise exception 'La 0096 no dejó el cuerpo esperado en service_version_images_solo_en_borrador()';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = funcion
       and (p.prosecdef or p.proconfig is distinct from array['search_path=public, pg_temp'])
  ) then
    raise exception 'service_version_images_solo_en_borrador() cambió de seguridad o de search_path';
  end if;

  -- El disparador de la 0090, intacto: en su tabla, antes de insertar, cambiar
  -- o borrar, por fila y activo.
  if not exists (
    select 1 from pg_catalog.pg_trigger g
     where g.tgrelid = imagenes and g.tgname = 'service_version_images_solo_en_borrador'
       and not g.tgisinternal and g.tgenabled in ('O', 'A') and g.tgtype = 31 and g.tgfoid = funcion
  ) then
    raise exception 'La 0096 no dejó el disparador de las imágenes como estaba';
  end if;

  if exists (
    select 1 from pg_catalog.pg_roles r
     where r.rolname in ('anon', 'authenticated')
       and pg_catalog.has_function_privilege(r.oid, funcion, 'EXECUTE')
  ) then
    raise exception 'public.service_version_images_solo_en_borrador() es ejecutable desde fuera';
  end if;

  -- Las imágenes siguen cerradas: RLS, cero políticas, nadie de fuera.
  if not (select relrowsecurity from pg_catalog.pg_class where oid = imagenes) then
    raise exception 'service_version_images sin RLS';
  end if;
  if exists (select 1 from pg_catalog.pg_policy where polrelid = imagenes) then
    raise exception 'service_version_images tiene políticas';
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles r
     where r.rolname in ('anon', 'authenticated')
       and (pg_catalog.has_table_privilege(
              r.oid, imagenes, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            or pg_catalog.has_any_column_privilege(r.oid, imagenes, 'SELECT, INSERT, UPDATE, REFERENCES'))
  ) then
    raise exception 'service_version_images tiene permisos sueltos';
  end if;
  if not exists (select 1 from storage.buckets b where b.id = 'service-media' and not b.public) then
    raise exception 'El depósito service-media dejó de ser privado';
  end if;

  -- Lo que ya había: con su ruta anterior, y dicho.
  select count(*) into anteriores
    from public.service_version_images i
   where i.storage_path !~ ('^' || i.service_id::text || '/[0-9a-f]{32}[.](jpg|png|webp)$');
  raise notice 'La 0096: % imagen(es) con ruta anterior (se conservan; se copian, no se registran nuevas)', anteriores;
end;
$$;

notify pgrst, 'reload schema';

commit;
