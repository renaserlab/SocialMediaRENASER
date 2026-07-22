-- Categoria tematica de una publicacion.
--
-- Nace para los filtros del podcast (Mente y Emociones / Cuerpo / Dinero),
-- pero se guarda en `posts` y no en una tabla aparte porque es una etiqueta
-- del contenido, util para cualquier publicacion mas adelante.
--
-- Sin CHECK a proposito: las categorias son una decision de producto que va a
-- cambiar, y una restriccion aqui obligaria a una migracion cada vez. La lista
-- valida se valida en el API (EventCreate/PostCreate) y se define en un unico
-- sitio del movil.

alter table public.posts
  add column if not exists category text;

-- Los filtros consultan por categoria dentro de lo publicado.
create index if not exists posts_category_idx
  on public.posts (category)
  where category is not null;
