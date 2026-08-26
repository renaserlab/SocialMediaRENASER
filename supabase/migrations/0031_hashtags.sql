-- Etiquetas sociales: las que escribe la gente dentro de su propio texto.
--
-- QUE NO ES ESTO, Y ES LO PRIMERO QUE HAY QUE ENTENDER. No sustituye a
-- `post_topics` (migracion 0027) ni se parece. Son dos cosas distintas que
-- conviven a proposito:
--
--   `topics`   = la taxonomia del PRODUCTO. 25 temas sembrados, cerrada,
--                elegida de una lista, y es lo que cruza el recomendador con
--                lo que cada persona dijo que busca. Nadie inventa un tema.
--   `hashtags` = vocabulario de la GENTE. Abierto, se crea al escribirlo, no
--                lo valida nadie, y sirve para descubrir y para buscar.
--
-- «#carpinteria» puede coincidir con el tema «Carpinteria» y no significa lo
-- mismo: uno lo decidio el producto, el otro lo escribio alguien. Mezclarlos
-- habria convertido una taxonomia curada en un campo de texto libre, que es
-- exactamente como mueren las taxonomias.
--
--
-- POR QUE DOS TABLAS Y NO UNA COLUMNA DE TEXTO EN `posts`.
--
-- Guardar «#ia #python» en una columna parece mas simple hasta la primera
-- pregunta real: «¿cuantas publicaciones tiene #python?». Con texto eso es un
-- LIKE sobre la tabla entera, que no usa indice y que ademas encuentra
-- «#pythonista». Con `post_hashtags` es un COUNT sobre un indice.
--
-- Y hay una segunda razon que solo se ve mas tarde: una etiqueta con IDENTIDAD
-- propia puede tener cosas colgando —seguirla, silenciarla, fusionarla con
-- otra, marcarla como prohibida—. Una cadena de texto repetida en 4.000 filas
-- no puede tener nada de eso sin reescribir esas 4.000 filas.
--
--
-- LA FORMA NORMALIZADA, QUE ES EL CORAZON DE TODO ESTO.
--
-- #IA, #ia y #Ia son LA MISMA etiqueta. Si no lo fueran, la etiqueta se parte
-- en tres y ninguna de las tres tiene publicaciones suficientes para servir de
-- nada. Por eso hay DOS columnas y no una:
--
--   `tag`         forma normalizada. Es la UNICA, la que lleva el indice unico
--                 y por la que se busca y se cuenta.
--   `display_tag` como la escribio quien la uso PRIMERO. Solo para pintar, para
--                 que «#MiNegocio» no se muestre como «#minegocio».
--
-- La normalizacion la hace el backend (app/modules/content/hashtags.py) y no
-- la base: es la misma funcion que extrae las etiquetas del texto, y tenerla
-- en dos sitios es garantizar que un dia dejen de coincidir.
--
--
-- QUIEN EXTRAE LAS ETIQUETAS. El servidor, del cuerpo de la publicacion. NO se
-- confia en una lista que mande el cliente: si se confiara, cualquiera podria
-- colgar su publicacion de #python sin que la palabra aparezca por ningun
-- lado, que es la definicion de spam de etiquetas.
--
--
-- QUE NO HACE ESTA MIGRACION. No toca ninguna fila existente y no extrae
-- etiquetas de las publicaciones que ya hay. Las 26 publicaciones actuales se
-- quedan sin etiquetar hasta que alguien las edite: reprocesarlas seria
-- escribir por ellas algo que nadie ha pedido, y ademas es reversible en
-- cualquier momento (basta con editar). El script es REPETIBLE e IDEMPOTENTE:
-- aditivo de principio a fin.
--
-- DESPUES DE APLICARLA, REINICIA LA API. El backend comprueba UNA VEZ por
-- proceso si estas tablas existen —para poder funcionar sin ellas mientras la
-- migracion espera aprobacion— y se queda con la respuesta. Si el servidor
-- llevaba levantado desde antes, seguira creyendo que no estan y las
-- publicaciones se guardaran sin etiquetas. No es un fallo: es el precio de
-- que la aplicacion no se caiga cuando la migracion todavia no esta puesta.
-- Ver `app/modules/recommendations/esquema.py`.


-- --------------------------------------------------------------------------
-- 1. hashtags — la etiqueta como entidad, una fila por etiqueta
-- --------------------------------------------------------------------------
create table if not exists public.hashtags (
  id uuid primary key default gen_random_uuid(),

  -- La forma normalizada, SIN la almohadilla: minusculas, sin tildes (la ñ se
  -- respeta, que es una letra y no una vocal acentuada), letras/digitos/guion
  -- bajo y nada mas. `unique` es lo que hace que #IA y #ia sean una sola:
  -- no es una optimizacion, es la regla de negocio escrita donde no se puede
  -- saltar, ni siquiera por una condicion de carrera entre dos publicaciones
  -- simultaneas que estrenen la misma etiqueta.
  tag text not null unique check (
    length(tag) between 1 and 50 and tag = lower(tag)
  ),

  -- Como se escribio la primera vez. Solo se pinta; nunca se busca por aqui.
  -- No se actualiza despues: la primera persona que uso la etiqueta le dio su
  -- forma, y reescribirla con cada uso haria que la etiqueta cambiara de
  -- aspecto sola en la pantalla de todo el mundo.
  display_tag text not null check (length(display_tag) between 1 and 50),

  created_at timestamptz not null default now()
);

-- Buscar etiquetas escribiendo: «pyt» -> «#python». `text_pattern_ops` es lo
-- que permite que un LIKE anclado por delante ('pyt%') use el indice; con el
-- operador por defecto y una base con collation no-C, no lo usaria.
create index if not exists hashtags_tag_prefix_idx
  on public.hashtags (tag text_pattern_ops);


-- --------------------------------------------------------------------------
-- 2. post_hashtags — que publicacion lleva que etiqueta
-- --------------------------------------------------------------------------
create table if not exists public.post_hashtags (
  post_id uuid not null references public.posts(id) on delete cascade,
  hashtag_id uuid not null references public.hashtags(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- La clave es el par. Escribir «#ia» dos veces en el mismo texto no es
  -- etiquetar dos veces: es enfasis, y aqui no llega. Sin esta clave, la
  -- cuenta de publicaciones de una etiqueta mentiria a favor de quien la
  -- repite, que es justo el incentivo que no se quiere crear.
  primary key (post_id, hashtag_id)
);

-- «Que se ha publicado con esta etiqueta», ordenado por fecha: la consulta de
-- la pantalla /hashtag/[name] y de su paginacion. El orden va DENTRO del
-- indice para que paginar no tenga que ordenar nada.
create index if not exists post_hashtags_hashtag_idx
  on public.post_hashtags (hashtag_id, created_at desc);

-- «Que etiquetas lleva esta publicacion»: una consulta por pagina de feed
-- sobre el lote entero, no una por publicacion.
create index if not exists post_hashtags_post_idx
  on public.post_hashtags (post_id);


-- --------------------------------------------------------------------------
-- 3. RLS
-- --------------------------------------------------------------------------
alter table public.hashtags enable row level security;
alter table public.post_hashtags enable row level security;

/*
  `hashtags` es un DICCIONARIO PUBLICO. Que «#python» existe no es informacion
  de nadie: es el vocabulario compartido de la aplicacion, y la pantalla de
  buscar tiene que poder leerlo sin sesion, igual que el muro ya se ve sin
  cuenta desde la migracion 0018.

  Escribir, en cambio, solo con sesion: una etiqueta nace cuando alguien
  publica usandola, nunca por si sola. Y no se BORRAN ni se ACTUALIZAN filas
  —no hay politica para eso— porque una etiqueta sin publicaciones no estorba
  y borrarla dejaria huerfanas las que se escriban un segundo despues.
*/
drop policy if exists hashtags_read on public.hashtags;
create policy hashtags_read on public.hashtags
  for select
  using (true);

drop policy if exists hashtags_insert on public.hashtags;
create policy hashtags_insert on public.hashtags
  for insert
  with check (auth.uid() is not null);

/*
  `post_hashtags` sigue a la publicacion, no a la etiqueta: son las MISMAS
  reglas que `post_topics` y `post_media`, y por el mismo motivo —una etiqueta
  es parte de la publicacion, no una entidad con vida propia—.

  LEER: quien pueda ver la publicacion. Si esta publicada, cualquiera; si no,
  solo su autor. Sin esto, contar publicaciones de una etiqueta filtraria la
  existencia de borradores ajenos.

  ESCRIBIR: solo el autor de la publicacion. Que la aplicacion no ensene el
  boton en el contenido ajeno es comodidad, no permiso: sin esta politica,
  cualquiera podria colgar la publicacion de otra persona de la etiqueta que
  le conviniera.
*/
drop policy if exists post_hashtags_read on public.post_hashtags;
create policy post_hashtags_read on public.post_hashtags
  for select
  using (
    exists (
      select 1 from public.posts p
      where p.id = post_id and (p.status = 'published' or p.author_id = auth.uid())
    )
  );

drop policy if exists post_hashtags_write on public.post_hashtags;
create policy post_hashtags_write on public.post_hashtags
  for all
  using (
    exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
  )
  with check (
    exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
  );
