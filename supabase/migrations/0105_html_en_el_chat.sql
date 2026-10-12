-- 0105 · El chat admite adjuntar páginas HTML
--
-- QUÉ RESUELVE (pedido del 10/10/2026). Adjuntar un archivo `.html` en un chat
-- fallaba: el almacén `message-media` solo admite la lista de tipos que fijó
-- la 0033, y `text/html` no estaba en ella.
--
-- QUÉ HACE. Añade `text/html` a los tipos admitidos de ese almacén, y nada
-- más. Es la misma lista de la 0033 con un tipo añadido.
--
-- LO QUE NO CAMBIA.
--   · El almacén sigue siendo PRIVADO: un archivo solo se lee con una
--     dirección firmada, y solo la obtienen los miembros de la conversación.
--   · Las políticas de lectura y escritura no se tocan.
--   · El tope de 100 MB por archivo no se toca.
--   · No se admite «cualquier tipo»: la lista sigue siendo explícita.
--
-- POR QUÉ ES ASUMIBLE ADMITIR HTML. Una página puede llevar código, así que
-- la aplicación NO la abre como página: la descarga como archivo (añade
-- `download` a la dirección firmada). Quien la recibe decide si la abre, igual
-- que con cualquier archivo que le manden.
--
-- LOS AUDIOS NO NECESITAN ESTA MIGRACIÓN. El almacén ya admite `audio/*`. Lo
-- que fallaba era que algunos teléfonos entregan el audio sin decir su tipo;
-- eso se corrige en la aplicación, que ahora lo deduce de la extensión.
--
-- ES REPETIBLE: se puede ejecutar dos veces y el resultado es el mismo.
--
-- CÓMO SE DESHACE: volver a ejecutar el `update` sin la línea de `text/html`.
-- Los HTML ya subidos siguen en el almacén; solo deja de poderse subir más.

update storage.buckets
set allowed_mime_types = array[
    'image/*',
    'video/*',
    'audio/*',
    'text/plain',
    'text/csv',
    'text/html',
    'application/pdf',
    'application/zip',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
where id = 'message-media';

do $$
declare
  admitidos text[];
  es_publico boolean;
begin
  select allowed_mime_types, public into admitidos, es_publico
  from storage.buckets
  where id = 'message-media';

  if admitidos is null then
    raise exception
      'El almacén message-media no existe o admite cualquier tipo. La 0105 '
      'solo añade text/html a una lista explícita.';
  end if;
  if not ('text/html' = any(admitidos)) then
    raise exception 'La 0105 no ha dejado text/html entre los tipos admitidos.';
  end if;
  if not ('audio/*' = any(admitidos) and 'image/*' = any(admitidos)) then
    raise exception 'La 0105 ha perdido tipos que ya estaban admitidos.';
  end if;
  if coalesce(es_publico, true) then
    raise exception 'El almacén message-media ha dejado de ser privado.';
  end if;
end
$$;
