-- Dos huecos que la 0026 dejo abiertos a proposito, y que ahora estorban.
--
-- 1. UNA PUBLICACION NO DICE DE QUE TRATA.
--
--    El recomendador de contenido hereda el tema del AUTOR, porque no habia
--    otra cosa. Eso convierte a un carpintero en «carpinteria» tambien cuando
--    publica una receta de cocina o como monto su negocio. Con un catalogo
--    pequeno se nota poco; con uno real, el feed empieza a mentir.
--
--    `post_topics` es la arista que faltaba: POST --tema--> TOPIC. Se apoya en
--    la MISMA taxonomia que ya usan las personas (`topics`), asi que
--    «carpinteria» significa exactamente lo mismo en los dos lados y se pueden
--    cruzar sin traducir nada.
--
-- 2. NO SE SABE SI UNA RECOMENDACION SIRVIO PARA ALGO.
--
--    `behavior_events` guarda que alguien abrio un perfil, pero no si ese
--    perfil venia de una recomendacion, de que algoritmo, en que superficie ni
--    en que posicion. Sin eso no se puede responder a la unica pregunta que
--    importa —«¿lo que mostre produjo algo?»— y ajustar los pesos seria
--    opinion.
--
--    Se anaden TRES columnas a la tabla que ya existe. No se crea una tabla de
--    analitica aparte: seria el mismo hecho contado dos veces, y cruzar dos
--    tablas para reconstruir un embudo que cabe en una es trabajo inventado.
--
-- QUE NO HACE ESTA MIGRACION. No toca ninguna fila existente. No clasifica
-- automaticamente las 26 publicaciones que ya hay: nadie ha dicho de que
-- tratan, y escribirlo por ellas seria inventar datos. El recomendador sigue
-- funcionando con esas publicaciones mediante el respaldo del autor.
--
-- El script es REPETIBLE e IDEMPOTENTE: aditivo de principio a fin.
--
-- DESPUES DE APLICARLA, REINICIA LA API. El backend comprueba UNA VEZ por
-- proceso que partes de esta migracion existen —para poder funcionar sin ella
-- mientras espera aprobacion— y se queda con la respuesta. Si el servidor
-- llevaba levantado desde antes, seguira creyendo que estas tablas no estan y
-- se comportara como si nada hubiera cambiado. No es un fallo: es el precio de
-- que la aplicacion no se caiga cuando la migracion todavia no esta puesta.
-- Ver `app/modules/recommendations/esquema.py`.


-- --------------------------------------------------------------------------
-- 1. post_topics — de que trata cada publicacion
-- --------------------------------------------------------------------------
create table if not exists public.post_topics (
  post_id uuid not null references public.posts(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  -- De donde salio la etiqueta. Hoy solo hay una via real, pero distinguirlas
  -- desde el principio evita el dia en que haya que separar «lo dijo una
  -- persona» de «lo dedujo una maquina» sobre filas ya escritas, que no se
  -- puede hacer a posteriori.
  source text not null default 'manual' check (
    source in (
      'manual',           -- lo eligio quien publica
      'author_fallback',  -- heredado de los temas del autor
      'auto'              -- reservado: clasificacion automatica futura
    )
  ),
  created_at timestamptz not null default now(),
  -- La clave es el par. Etiquetar dos veces el mismo tema no es etiquetar dos
  -- veces: es un error de dedo, y aqui no llega.
  primary key (post_id, topic_id)
);

-- «De que trata esta publicacion»: la consulta del ranker, una por pagina de
-- feed sobre el lote entero de candidatos.
create index if not exists post_topics_post_idx on public.post_topics (post_id);
-- «Que se ha publicado sobre este tema»: la que hara falta para buscar y para
-- descubrir por tema.
create index if not exists post_topics_topic_idx on public.post_topics (topic_id, created_at desc);

alter table public.post_topics enable row level security;

/*
  Quien puede que. Las mismas reglas que `post_media`, y por el mismo motivo:
  una etiqueta es parte de la publicacion, no una entidad con vida propia.

  LEER: quien pueda ver la publicacion. Si esta publicada, cualquiera; si no,
  solo su autor.

  ESCRIBIR: solo el autor de la publicacion. Que la aplicacion no ensene el
  boton en el contenido ajeno es comodidad, no permiso: sin esta politica,
  cualquiera podria etiquetar las publicaciones de los demas y, con ello,
  decidir a quien se le recomiendan.
*/
drop policy if exists post_topics_read on public.post_topics;
create policy post_topics_read on public.post_topics
  for select
  using (
    exists (
      select 1 from public.posts p
      where p.id = post_id and (p.status = 'published' or p.author_id = auth.uid())
    )
  );

drop policy if exists post_topics_write on public.post_topics;
create policy post_topics_write on public.post_topics
  for all
  using (
    exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
  )
  with check (
    exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
  );


-- --------------------------------------------------------------------------
-- 2. behavior_events — de donde venia lo que se mostro
-- --------------------------------------------------------------------------
-- Tres columnas, todas OPCIONALES. Las senales que ya hay siguen siendo
-- validas: una senal sin superficie es una senal que ocurrio fuera de una
-- recomendacion, y eso es informacion, no un hueco.
alter table public.behavior_events
  -- Donde se mostro. Es lo que permite medir «Personas para ti» por separado
  -- del feed: son dos productos distintos con dos tasas distintas.
  add column if not exists surface text,
  -- Con que version del orden. Sin esto no se pueden comparar dos versiones y
  -- cualquier mejora seria una impresion.
  add column if not exists algorithm_version text,
  -- En que puesto de la lista. La posicion sesga el resultado —lo primero se
  -- toca mas, sea bueno o no—, asi que sin ella las tasas no se pueden leer.
  add column if not exists rank integer;

-- Valores acotados: una superficie escrita a mano en dos sitios acaba siendo
-- dos superficies, y las metricas dejan de sumar.
--
-- Se anaden dentro de un `do` porque `add constraint` no admite
-- `if not exists`, y esta migracion tiene que poder repetirse. La comprobacion
-- es inmediata: las tres columnas acaban de crearse y valen NULL en todas las
-- filas existentes, asi que no hay nada que recorrer.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'behavior_events_surface_check'
  ) then
    alter table public.behavior_events
      add constraint behavior_events_surface_check
      check (
        surface is null or surface in (
          'people_for_you',  -- la seccion de Explorar
          'for_you_feed',    -- el feed vertical de Inicio
          'following_feed',  -- la pestana Siguiendo
          'search',          -- resultados de busqueda
          'profile'          -- llegada directa a un perfil
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'behavior_events_rank_check'
  ) then
    alter table public.behavior_events
      add constraint behavior_events_rank_check
      check (rank is null or (rank between 0 and 1000));
  end if;
end
$$;

-- El embudo se lee por superficie y version: «de las impresiones de
-- people_for_you con people-v1, cuantas acabaron en follow». Sin este indice
-- esa consulta recorre la tabla entera.
create index if not exists behavior_events_atribucion_idx
  on public.behavior_events (surface, algorithm_version, event_type, created_at desc)
  where surface is not null;


comment on table public.post_topics is
  'De que trata cada publicacion. Misma taxonomia que las personas (topics), para poder cruzarlas.';
comment on column public.behavior_events.surface is
  'Donde se mostro la recomendacion. Nulo = la accion no vino de una recomendacion.';
comment on column public.behavior_events.algorithm_version is
  'Con que version del orden se genero. Permite comparar versiones.';
comment on column public.behavior_events.rank is
  'Posicion en la lista mostrada. Sin ella las tasas no se pueden leer: lo primero se toca mas.';

notify pgrst, 'reload schema';

-- Comprobacion final. `temas_de_contenido` sale 0 la primera vez (nadie ha
-- etiquetado nada todavia) y las tablas de siempre quedan INTACTAS.
select
  (select count(*) from public.post_topics)                      as temas_de_contenido,
  (select count(*) from public.topics)                           as temas,
  (select count(*) from public.behavior_events)                  as senales,
  (select count(*) from public.behavior_events where surface is not null) as senales_con_superficie,
  (select count(*) from public.profiles)                         as perfiles_intactos,
  (select count(*) from public.posts)                            as publicaciones_intactas,
  (select count(*) from public.user_topic_relations)             as relaciones_intactas,
  (select count(*) from public.recommendation_preferences)       as preferencias_intactas;
