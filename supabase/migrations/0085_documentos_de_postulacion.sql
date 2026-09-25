-- 0085 · Un depósito para los documentos de la postulación de proveedor.
--
-- SIN APLICAR. Escrita el 24/09/2026; se aplica a mano en el editor SQL de
-- Supabase cuando se autorice.
--
-- QUÉ PASÓ. La postulación (0071) guarda documentos con una `storage_path`,
-- pero no existía ningún depósito para ellos ni forma de subirlos: la app pedía
-- ESCRIBIR la ruta a mano, y administración no podía abrir nada. En la práctica
-- solo funcionaba el campo de notas.
--
-- QUÉ HACE. Crea `seller-documents`, PRIVADO y SIN POLÍTICAS, como
-- `product-media` (0073) y `product-incidents` (0080): la única puerta es la API
-- (`POST /products/seller/application/documents`), que mira los bytes, genera
-- la ruta `<perfil>/<postulación>/<uuid>.<ext>` y sube con la clave de
-- servicio. Administración los ve con un enlace firmado de pocos minutos.
--
-- El prefijo `<perfil>/` es el de los demás depósitos de usuario: borrar la
-- cuenta los barre (`USER_BUCKETS` en `shared/storage.py`).
--
-- NO TOCA NINGUNA FILA de ninguna tabla. Es idempotente.
--
-- ROLLBACK (cuando el depósito esté vacío):
--   delete from storage.buckets where id = 'seller-documents';

insert into storage.buckets (id, name, public)
values ('seller-documents', 'seller-documents', false)
on conflict (id) do nothing;

update storage.buckets
set
  -- 10 MB: un DNI escaneado o un PDF de ficha RUC caben de sobra.
  file_size_limit = 10::bigint * 1024 * 1024,
  -- LISTA CERRADA, nunca `null` ni `image/*` (deja pasar SVG, que lleva
  -- scripts). PDF para documentos, fotos para quien fotografía el papel.
  allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
where id = 'seller-documents';

-- SIN POLÍTICAS A PROPÓSITO: se borran por si una ejecución anterior las dejó.
drop policy if exists seller_documents_read on storage.objects;
drop policy if exists seller_documents_write on storage.objects;
