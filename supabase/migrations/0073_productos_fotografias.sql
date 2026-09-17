-- 0073 · Fotografías de producto: depósito privado y aprobación de la imagen.
--
-- AL APLICARLA, REINICIAR LA API. La puerta de esquema cachea tambien el «no»
-- en la memoria del proceso: sin reiniciar, las rutas siguen contestando 503
-- aunque las tablas ya esten.
--
-- SIN APLICAR. Requiere la 0070.
--
-- QUÉ CIERRA. Hasta hoy `product_media` guardaba una ruta que escribía a mano
-- quien vende, y no existía ningún depósito donde esa ruta apuntara: el
-- catálogo se recorría entero y las imágenes salían como marcador. Esta
-- migración crea el depósito, y convierte la galería en algo que se puede
-- enseñar sin mentir.
--
-- POR QUÉ EL DEPÓSITO NO TIENE NINGUNA POLÍTICA DE ALMACENAMIENTO. Al revés que
-- `message-media` (0033), donde la aplicación sube directamente y las políticas
-- deciden quién puede, aquí NO SE SUBE DESDE EL MÓVIL. El archivo viaja a la
-- API, que comprueba la propiedad del borrador, mira los bytes de verdad,
-- genera el nombre y solo entonces escribe con la clave de servicio. Sin
-- políticas, `anon` y `authenticated` no pueden ni leer ni escribir ni listar:
-- la única puerta es la API, y la API sabe qué fotos están aprobadas.
--
-- Y POR ESO LAS URL SON FIRMADAS Y CADUCAN. El depósito es privado; el catálogo
-- entrega enlaces de vida corta emitidos en el momento. Guardar una URL en la
-- base haría que la galería dejara de cargar sin que nadie tocara nada, y por
-- eso `storage_path` sigue siendo una RUTA y hay un CHECK que rechaza `://`.
--
-- UNA FOTOGRAFÍA RECHAZADA NO SE ENSEÑA. `status` nace `pending`: subir no es
-- publicar. Quien evalúa aprueba o rechaza con motivo, y el catálogo solo firma
-- las aprobadas. Sin este estado, aprobar un producto aprobaría también
-- cualquier foto que le añadieran después.
--
-- LO QUE NO TRAE, Y ES DELIBERADO:
--
--   * NINGÚN TOPE DE CANTIDAD EN LA BASE. Cuántas fotos admite una versión es
--     una regla de producto y se cuenta en el servidor; un CHECK no cuenta
--     filas y un disparador que lo hiciera bloquearía la tabla en cada inserción
--     para defender un número que la empresa todavía puede cambiar.
--   * NINGUNA MINIATURA NI DERIVADO. El pipeline de derivados de la 0021 es de
--     contenido social y tiene otro ciclo; traerlo aquí sería copiarlo antes de
--     saber si hace falta.
--
-- ROLLBACK: `alter table public.product_media drop column ...` para las nueve
-- columnas, y `delete from storage.buckets where id = 'product-media'` cuando el
-- depósito esté vacío. No toca ninguna fila existente.

-- ------------------------------------------------------------------------- --
-- 1. El depósito privado
-- ------------------------------------------------------------------------- --
insert into storage.buckets (id, name, public)
values ('product-media', 'product-media', false)
on conflict (id) do nothing;

update storage.buckets
set
  -- 10 MB. Una fotografía de producto que pese más que esto no es una
  -- fotografía de producto: es un original sin tocar, y el catálogo la va a
  -- pintar en una tarjeta de dos columnas.
  file_size_limit = 10::bigint * 1024 * 1024,
  -- LISTA EXPLÍCITA Y CERRADA, nunca `null` —que admite cualquier cosa,
  -- ejecutables incluidos— y nunca `image/*`, que deja pasar SVG: un SVG es un
  -- documento con scripts, y esto es una galería de fotos.
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'product-media';

-- SIN POLÍTICAS A PROPÓSITO. Ver la cabecera: la única puerta es la API.
-- Se borran por si una ejecución anterior las dejó puestas.
drop policy if exists product_media_read on storage.objects;
drop policy if exists product_media_write on storage.objects;

-- ------------------------------------------------------------------------- --
-- 2. La galería: qué archivo hay detrás y quién lo aprobó
-- ------------------------------------------------------------------------- --
alter table public.product_media
  -- SUBIR NO ES PUBLICAR. Nace pendiente.
  add column if not exists status text not null default 'pending',
  -- LO QUE DE VERDAD SE GUARDÓ, medido por el servidor al recibir los bytes.
  -- No es lo que declaró el cliente: un `Content-Type` lo escribe quien sube.
  add column if not exists content_type text,
  add column if not exists byte_size bigint,
  add column if not exists width integer,
  add column if not exists height integer,
  -- LA HUELLA DEL ARCHIVO. Sirve para no volver a subir el mismo byte a byte
  -- cuando una versión nueva copia la galería de la anterior.
  add column if not exists checksum_sha256 text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists rejection_reason text;

alter table public.product_media
  drop constraint if exists product_media_estado;
alter table public.product_media
  add constraint product_media_estado
  check (status in ('pending', 'approved', 'rejected'));

-- UNA DECISIÓN DEJA FECHA. Sin esto, «rechazada» sería un estado sin cuándo, y
-- no se podría contestar a quien vende por qué su foto lleva una semana fuera.
alter table public.product_media
  drop constraint if exists product_media_decidida_con_fecha;
alter table public.product_media
  add constraint product_media_decidida_con_fecha
  check (status = 'pending' or reviewed_at is not null);

-- UN RECHAZO SIN MOTIVO NO SE PUEDE CORREGIR.
alter table public.product_media
  drop constraint if exists product_media_rechazo_con_motivo;
alter table public.product_media
  add constraint product_media_rechazo_con_motivo
  check (
    status <> 'rejected'
    or (rejection_reason is not null and length(trim(rejection_reason)) >= 3)
  );

-- UNA FOTO APROBADA TIENE UN ARCHIVO DETRÁS. Aprobar una fila sin bytes dejaría
-- el catálogo firmando una ruta que no existe, y la tarjeta saldría rota sin que
-- nada hubiera fallado.
alter table public.product_media
  drop constraint if exists product_media_aprobada_con_archivo;
alter table public.product_media
  add constraint product_media_aprobada_con_archivo
  check (
    status <> 'approved'
    or (content_type is not null and byte_size is not null and byte_size > 0)
  );

-- LOS TIPOS QUE EL DEPÓSITO ADMITE, otra vez aquí: el depósito defiende el
-- archivo y esto defiende la fila. Sin lo segundo, un `insert` por otra vía
-- dejaría una galería que dice contener algo que el depósito nunca aceptó.
alter table public.product_media
  drop constraint if exists product_media_tipo_de_archivo;
alter table public.product_media
  add constraint product_media_tipo_de_archivo
  check (
    content_type is null
    or content_type in ('image/jpeg', 'image/png', 'image/webp')
  );

alter table public.product_media
  drop constraint if exists product_media_medidas;
alter table public.product_media
  add constraint product_media_medidas
  check (
    (width is null or width > 0)
    and (height is null or height > 0)
    and (byte_size is null or byte_size > 0)
  );

alter table public.product_media
  drop constraint if exists product_media_huella;
alter table public.product_media
  add constraint product_media_huella
  check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$');

-- LA RUTA ES UNA RUTA. Ya lo decía `product_media_ruta` por longitud; esto lo
-- dice por forma, que es lo que de verdad se coló alguna vez: una URL firmada
-- pegada donde iba la ruta.
alter table public.product_media
  drop constraint if exists product_media_ruta_no_es_url;
alter table public.product_media
  add constraint product_media_ruta_no_es_url
  check (storage_path not like '%://%' and storage_path not like '/%');

-- LO QUE PINTA EL CATÁLOGO: las aprobadas de una versión, en su orden.
create index if not exists product_media_aprobadas
  on public.product_media (version_id, position, id)
  where status = 'approved';

-- LA BANDEJA DE QUIEN REVISA: lo pendiente, lo más viejo primero, que es el que
-- lleva más tiempo esperando.
create index if not exists product_media_pendientes
  on public.product_media (created_at, id)
  where status = 'pending';

-- EL MISMO ARCHIVO EN VARIAS VERSIONES. Una versión nueva copia la fila con la
-- misma ruta; este índice es el que permite preguntar «¿queda alguien
-- apuntando a este archivo?» antes de borrarlo del depósito.
create index if not exists product_media_por_ruta
  on public.product_media (storage_path);

-- ------------------------------------------------------------------------- --
-- 3. Verificación
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  publico boolean;
  tipos text[];
  politicas bigint;
begin
  select string_agg(c, ', ') into faltan
    from unnest(array[
      'status', 'content_type', 'byte_size', 'width', 'height',
      'checksum_sha256', 'reviewed_at', 'reviewed_by', 'rejection_reason'
    ]) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_media'
        and column_name = c
   );
  if faltan is not null then
    raise exception 'La 0073 no dejó estas columnas en product_media: %', faltan;
  end if;

  select public, allowed_mime_types into publico, tipos
    from storage.buckets where id = 'product-media';
  if publico is null then
    raise exception 'La 0073 no dejó el depósito product-media';
  end if;
  if publico then
    raise exception 'El depósito product-media es PÚBLICO y no debe serlo';
  end if;
  if tipos is null or array_length(tipos, 1) is null then
    raise exception 'El depósito product-media admite cualquier tipo de archivo';
  end if;

  select count(*) into politicas
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and qual like '%product-media%';
  if politicas > 0 then
    raise exception
      'El depósito product-media tiene % políticas; solo entra por la API',
      politicas;
  end if;
end;
$$;

notify pgrst, 'reload schema';
