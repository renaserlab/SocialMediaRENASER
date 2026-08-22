-- Una publicacion puede no llevar texto si lleva un medio.
--
-- El CHECK original exigia entre 1 y 3000 caracteres en `body`. Eso obligaba a
-- escribir algo para poder compartir una foto o un reel, que es un requisito
-- nuestro y no de quien publica: en el nuevo Crear, un reel se explica solo y
-- la descripcion es opcional. Sin este cambio, publicar un reel sin texto
-- fallaba en la base de datos con un error que ademas no se podia explicar
-- bien en pantalla.
--
-- Se AMPLIA la condicion, no se quita: el tope de 3000 sigue vigente. Ampliar
-- un CHECK nunca puede invalidar filas existentes —todas cumplian ya la
-- condicion mas estricta—, asi que el cambio es no destructivo por
-- construccion.
--
-- Que al menos haya texto O medio se comprueba en el backend (`PostCreate`),
-- que es quien ve las dos cosas a la vez; un CHECK de tabla no puede mirar
-- `post_media`, que es otra tabla y se inserta despues.
--
-- El script es REPETIBLE.

alter table public.posts
  drop constraint if exists posts_body_check;

alter table public.posts
  add constraint posts_body_check
  check (char_length(body) between 0 and 3000);

comment on column public.posts.body is
  'Texto de la publicacion. Puede ir vacio si la publicacion lleva un medio.';

notify pgrst, 'reload schema';

-- Comprobacion final.
select
  (select count(*) from public.posts) as publicaciones_conservadas,
  (select count(*) from pg_constraint
     where conname = 'posts_body_check') as check_presente;
-- Esperado: las publicaciones que ya hubiera, y check_presente = 1.
