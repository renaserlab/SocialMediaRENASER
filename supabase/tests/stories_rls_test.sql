-- Prueba de las politicas RLS de historias.
--
-- Valida el contador de vistas sin necesidad de una segunda cuenta ni de un
-- segundo dispositivo: se suplanta a otro usuario con `request.jwt.claims`,
-- que es como Supabase resuelve auth.uid() dentro de las politicas.
--
-- COMO USARLO: pegar entero en el SQL Editor de Supabase y ejecutar. Cada
-- bloque imprime una linea con el resultado esperado al lado.
--
-- Es NO destructivo salvo por la fila de story_views que inserta (se elimina
-- al final). No toca las historias.

-- Perfiles usados. Cambia los uuid si tus cuentas son otras.
--   AUTOR      d785fd12-550c-48ed-a7d9-95465c38339b  (Darren Supa)
--   ESPECTADOR 7d00ee95-f3a6-4a45-9564-0ca782cef755  (test6)
--   TERCERO    bf485dab-8640-4a3a-9495-8cb6814ded93  (test10)


-- ---------------------------------------------------------------------------
-- 1. El espectador ve las historias vigentes y registra su visita
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"7d00ee95-f3a6-4a45-9564-0ca782cef755","role":"authenticated"}';

select '1a. historias visibles para el espectador (esperado: >0)' as prueba,
       count(*) as resultado
from public.stories;

-- La politica story_views_insert_own exige viewer_id = auth.uid().
insert into public.story_views (story_id, viewer_id)
select s.id, '7d00ee95-f3a6-4a45-9564-0ca782cef755'::uuid
from public.stories s
order by s.created_at desc
limit 1
on conflict (story_id, viewer_id) do nothing;

-- Repetir no debe crear una segunda fila: asi el visor puede llamarlo en cada
-- tramo sin inflar el contador.
insert into public.story_views (story_id, viewer_id)
select s.id, '7d00ee95-f3a6-4a45-9564-0ca782cef755'::uuid
from public.stories s
order by s.created_at desc
limit 1
on conflict (story_id, viewer_id) do nothing;

select '1b. sus propias vistas tras insertar DOS veces (esperado: 1)' as prueba,
       count(*) as resultado
from public.story_views
where viewer_id = '7d00ee95-f3a6-4a45-9564-0ca782cef755';
commit;


-- ---------------------------------------------------------------------------
-- 2. El AUTOR puede leer quien vio su historia
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"d785fd12-550c-48ed-a7d9-95465c38339b","role":"authenticated"}';

select '2. vistas que ve el autor (esperado: 1)' as prueba,
       count(*) as resultado
from public.story_views;
commit;


-- ---------------------------------------------------------------------------
-- 3. Un TERCERO no puede leer esas vistas (lo importante de la RLS)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bf485dab-8640-4a3a-9495-8cb6814ded93","role":"authenticated"}';

select '3. vistas que ve un tercero (esperado: 0)' as prueba,
       count(*) as resultado
from public.story_views;
commit;


-- ---------------------------------------------------------------------------
-- 4. Un tercero no puede borrar una historia ajena
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bf485dab-8640-4a3a-9495-8cb6814ded93","role":"authenticated"}';

with intento as (
  delete from public.stories
  where id = (select id from public.stories order by created_at desc limit 1)
  returning 1
)
select '4. historias que logra borrar un tercero (esperado: 0)' as prueba,
       count(*) as resultado
from intento;
commit;


-- ---------------------------------------------------------------------------
-- 5. Limpieza: quitar la vista de prueba
-- ---------------------------------------------------------------------------
delete from public.story_views
where viewer_id = '7d00ee95-f3a6-4a45-9564-0ca782cef755';

select '5. limpieza hecha, vistas de prueba restantes (esperado: 0)' as prueba,
       count(*) as resultado
from public.story_views
where viewer_id = '7d00ee95-f3a6-4a45-9564-0ca782cef755';
