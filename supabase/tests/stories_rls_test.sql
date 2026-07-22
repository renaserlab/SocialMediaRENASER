-- Prueba de las politicas RLS de historias.
--
-- Valida el contador de vistas sin necesidad de una segunda cuenta ni de un
-- segundo dispositivo: se suplanta a otro usuario con `request.jwt.claims`,
-- que es como Supabase resuelve auth.uid() dentro de las politicas.
--
-- COMO USARLO: pegar entero en el SQL Editor de Supabase y ejecutar. Devuelve
-- UNA sola tabla con las cinco comprobaciones y su veredicto.
--
-- (El editor solo muestra el resultado de la ultima sentencia, por eso todo se
-- acumula en una tabla temporal y se imprime de golpe al final.)
--
-- Es NO destructivo: la unica fila que inserta se borra dentro del mismo
-- bloque. Las historias no se tocan.

-- Perfiles usados. Cambia los uuid si tus cuentas son otras.
--   AUTOR      d785fd12-550c-48ed-a7d9-95465c38339b  (Darren Supa)
--   ESPECTADOR 7d00ee95-f3a6-4a45-9564-0ca782cef755  (test6)
--   TERCERO    bf485dab-8640-4a3a-9495-8cb6814ded93  (test10)

drop table if exists _res;
create temp table _res (n int, prueba text, esperado text, obtenido bigint, ok boolean);

do $$
declare
  autor      uuid := 'd785fd12-550c-48ed-a7d9-95465c38339b';
  espectador uuid := '7d00ee95-f3a6-4a45-9564-0ca782cef755';
  tercero    uuid := 'bf485dab-8640-4a3a-9495-8cb6814ded93';
  ultima     uuid;
  v          bigint;
  borradas   bigint;
begin
  -- Se elige la historia mas reciente. Aqui todavia mandamos como superusuario,
  -- asi que la RLS no filtra nada.
  select id into ultima from public.stories order by created_at desc limit 1;
  if ultima is null then
    insert into _res values (0, 'No hay historias vigentes: sube una y repite', '-', 0, false);
    return;
  end if;

  -- --- 1. El espectador ve las historias vigentes -------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', espectador, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v from public.stories;
  execute 'reset role';
  insert into _res values (1, 'El espectador ve las historias vigentes', '> 0', v, v > 0);

  -- --- 2. Registrar la vista es idempotente -------------------------------
  -- Se inserta DOS veces a proposito: el visor lo llama en cada tramo y no debe
  -- inflar el contador.
  execute 'set local role authenticated';
  insert into public.story_views (story_id, viewer_id) values (ultima, espectador)
    on conflict (story_id, viewer_id) do nothing;
  insert into public.story_views (story_id, viewer_id) values (ultima, espectador)
    on conflict (story_id, viewer_id) do nothing;
  select count(*) into v from public.story_views
    where story_id = ultima and viewer_id = espectador;
  execute 'reset role';
  insert into _res values (2, 'Insertar la vista dos veces deja UNA fila', '1', v, v = 1);

  -- --- 3. El autor ve quien miro su historia ------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', autor, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v from public.story_views where story_id = ultima;
  execute 'reset role';
  insert into _res values (3, 'El AUTOR ve quien miro su historia', '1', v, v = 1);

  -- --- 4. Un tercero NO ve esas vistas ------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', tercero, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v from public.story_views where story_id = ultima;
  execute 'reset role';
  insert into _res values (4, 'Un TERCERO no ve esas vistas', '0', v, v = 0);

  -- --- 5. Un tercero NO puede borrar una historia ajena --------------------
  execute 'set local role authenticated';
  with intento as (delete from public.stories where id = ultima returning 1)
  select count(*) into borradas from intento;
  execute 'reset role';
  insert into _res values (5, 'Un TERCERO no puede borrar tu historia', '0', borradas, borradas = 0);

  -- --- Limpieza ------------------------------------------------------------
  delete from public.story_views where story_id = ultima and viewer_id = espectador;
end $$;

select n as "#",
       prueba,
       esperado,
       obtenido,
       case when ok then 'OK' else 'FALLO' end as veredicto
from _res
order by n;
