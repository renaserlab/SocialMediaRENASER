-- 0084 · Las categorías iniciales de Productos.
--
-- SIN APLICAR. Escrita el 24/09/2026; se aplica a mano en el editor SQL de
-- Supabase cuando se autorice.
--
-- QUÉ PASÓ. `product_categories` (0070) nació VACÍA a propósito —«las decide la
-- empresa»— y ninguna pantalla ni endpoint permite crearlas. Resultado: el
-- formulario de producto no podía ofrecer ninguna, el filtro por categoría de
-- la búsqueda no filtraba nada y quien vendía no podía clasificar lo suyo. Para
-- la versión de pruebas se pidió que quien crea un producto pueda ELEGIR.
--
-- QUÉ HACE. Siembra una lista corta y general, pensada para lo que ya se ve en
-- Z (crecimiento personal, bienestar, talleres). Es un PUNTO DE PARTIDA, no una
-- decisión cerrada: se cambian o se desactivan con SQL (`active = false`), y
-- desactivar no rompe los productos que ya la usan.
--
-- IDEMPOTENTE: `on conflict (slug) do nothing`. Volver a ejecutarla no duplica
-- ni pisa cambios hechos después a mano.
--
-- NO TOCA NINGUNA OTRA FILA.
--
-- ROLLBACK (solo si ningún producto las usa todavía):
--   delete from public.product_categories
--    where slug in ('libros-y-cuadernos', 'bienestar', 'hogar-y-cocina',
--                   'moda-y-accesorios', 'arte-y-artesania', 'tecnologia',
--                   'deporte', 'alimentos-y-bebidas', 'belleza-y-cuidado',
--                   'otros')
--      and not exists (select 1 from public.products p
--                        where p.category_id = product_categories.id);

insert into public.product_categories (slug, name, position, active)
values
  ('libros-y-cuadernos', 'Libros y cuadernos', 10, true),
  ('bienestar', 'Bienestar', 20, true),
  ('hogar-y-cocina', 'Hogar y cocina', 30, true),
  ('moda-y-accesorios', 'Moda y accesorios', 40, true),
  ('arte-y-artesania', 'Arte y artesanía', 50, true),
  ('tecnologia', 'Tecnología', 60, true),
  ('deporte', 'Deporte', 70, true),
  ('alimentos-y-bebidas', 'Alimentos y bebidas', 80, true),
  ('belleza-y-cuidado', 'Belleza y cuidado personal', 90, true),
  ('otros', 'Otros', 1000, true)
on conflict (slug) do nothing;
