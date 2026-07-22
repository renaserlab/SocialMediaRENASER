-- Prueba de las politicas RLS de testimonios.
--
-- Comprueba lo que de verdad importa: que SOLO la administracion pueda
-- publicar y borrar, y que una cuenta normal pueda ver pero no escribir.
-- Se suplanta a cada usuario con `request.jwt.claims`, que es como Supabase
-- resuelve auth.uid() dentro de las politicas.
--
-- COMO USARLO: pegar entero en el SQL Editor y ejecutar. Devuelve UNA tabla
-- con las comprobaciones y su veredicto.
--
-- Es NO destructivo: la fila que inserta se borra dentro del mismo bloque.

--   ADMIN   d785fd12-550c-48ed-a7d9-95465c38339b  (Darren Supa)
--   NORMAL  7d00ee95-f3a6-4a45-9564-0ca782cef755  (test6)

drop table if exists _res;
create temp table _res (n int, prueba text, esperado text, obtenido text, ok boolean);

do $$
declare
  admin_id  uuid := 'd785fd12-550c-48ed-a7d9-95465c38339b';
  normal_id uuid := '7d00ee95-f3a6-4a45-9564-0ca782cef755';
  creado    uuid;
  v         bigint;
  fallo     text;
begin
  -- --- 1. El ADMIN puede publicar --------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.testimonials (author_id, storage_path, media_type, caption)
    values (admin_id, 'prueba/rls-test.jpg', 'image', 'Testimonio de prueba')
    returning id into creado;
    execute 'reset role';
    insert into _res values (1, 'El ADMIN puede publicar', 'si', 'si', true);
  exception when others then
    execute 'reset role';
    insert into _res values (1, 'El ADMIN puede publicar', 'si', 'NO: ' || sqlerrm, false);
  end;

  -- --- 2. Una cuenta NORMAL puede ver ----------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', normal_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v from public.testimonials;
  execute 'reset role';
  insert into _res values (2, 'Una cuenta NORMAL ve la galeria', '> 0', v::text, v > 0);

  -- --- 3. Una cuenta NORMAL NO puede publicar --------------------------
  execute 'set local role authenticated';
  begin
    insert into public.testimonials (author_id, storage_path, media_type, caption)
    values (normal_id, 'prueba/intruso.jpg', 'image', 'No deberia entrar');
    execute 'reset role';
    insert into _res values (3, 'Una cuenta NORMAL no puede publicar', 'rechazado', 'SE INSERTO', false);
  exception when others then
    execute 'reset role';
    insert into _res values (3, 'Una cuenta NORMAL no puede publicar', 'rechazado', 'rechazado', true);
  end;

  -- --- 4. Una cuenta NORMAL NO puede borrar ----------------------------
  execute 'set local role authenticated';
  with intento as (delete from public.testimonials where id = creado returning 1)
  select count(*) into v from intento;
  execute 'reset role';
  insert into _res values (4, 'Una cuenta NORMAL no puede borrar', '0 filas', v::text, v = 0);

  -- --- 5. El ADMIN si puede borrar (y limpia la prueba) ----------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  with intento as (delete from public.testimonials where id = creado returning 1)
  select count(*) into v from intento;
  execute 'reset role';
  insert into _res values (5, 'El ADMIN si puede borrar', '1 fila', v::text, v = 1);

  -- Por si el paso 5 no llego a borrar, no dejar basura.
  delete from public.testimonials where storage_path like 'prueba/%';
end $$;

select n as "#",
       prueba,
       esperado,
       obtenido,
       case when ok then 'OK' else 'FALLO' end as veredicto
from _res
order by n;
