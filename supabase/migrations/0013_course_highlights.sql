-- "Lo que vas a desarrollar": los puntos destacados de un curso.
--
-- Estaban escritos a mano en CourseScreen, iguales para todos los cursos y sin
-- forma de cambiarlos. Se guardan en la propia fila del curso, que es donde
-- pertenecen.
--
-- No hacen falta politicas nuevas: `courses_read` y `courses_write` (0001) ya
-- cubren la columna, asi que la edita el autor del curso o la administracion.
--
-- El script es REPETIBLE y termina informando de si quedo aplicado.

alter table public.courses
  add column if not exists highlights text[] not null default '{}';

comment on column public.courses.highlights is
  'Puntos de "Lo que vas a desarrollar". Orden significativo.';

notify pgrst, 'reload schema';

select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'courses'
      and column_name = 'highlights') as columna_highlights;
-- Esperado: 1
