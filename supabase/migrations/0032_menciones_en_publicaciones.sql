-- Etiquetar personas en una publicacion.
--
-- QUE RESUELVE. Hoy nombrar a alguien en una publicacion es escribir su nombre
-- en el texto: no le llega nada, no lleva a su perfil y no se puede consultar
-- «donde me han mencionado». Es decir, no es un enlace, es una cadena.
--
-- `post_mentions` convierte eso en una ARISTA: POST --menciona--> PERFIL. Con
-- eso ya se puede avisar a quien fue mencionado, llevar a su perfil desde el
-- texto y, el dia que haga falta, responder «que publicaciones me mencionan».
--
--
-- POR QUE LA ELIGE UNA PERSONA Y NO SE EXTRAE DEL TEXTO, al contrario que los
-- hashtags de la 0031. Porque las dos cosas fallan de forma distinta:
--
--   Una etiqueta mal extraida crea una fila de mas en una tabla. Molesta.
--   Una mencion mal extraida MANDA UNA NOTIFICACION A LA PERSONA EQUIVOCADA.
--
-- «@ana» es ambiguo: hay varias Anas, los nombres de usuario cambian, y un
-- correo dentro del texto lleva una arroba que no menciona a nadie. Con la
-- notificacion de por medio, adivinar no es aceptable: quien publica ELIGE de
-- una lista de perfiles reales y lo que viaja son identificadores, no nombres.
--
--
-- LOS BLOQUEOS MANDAN SOBRE ESTO. Una mencion es una via para hacer llegar
-- algo a alguien, asi que es exactamente lo que un bloqueo tiene que cortar.
-- La comprobacion es SIMETRICA —ni a quien bloqueaste ni a quien te bloqueo—
-- porque si solo cortara en un sentido, bastaria con no bloquear de vuelta
-- para seguir mandando avisos a alguien que ya dijo que no. Eso lo aplica el
-- backend contra `user_blocks` antes de escribir; aqui no se puede expresar
-- sin meter una subconsulta a otra tabla dentro de cada insercion.
--
--
-- QUE NO HACE ESTA MIGRACION. No toca ninguna fila existente, no busca
-- arrobas en las publicaciones que ya hay y no manda ninguna notificacion por
-- contenido antiguo. Sembrar menciones a posteriori seria avisar a gente de
-- publicaciones de hace meses. El script es REPETIBLE e IDEMPOTENTE.
--
-- DESPUES DE APLICARLA, REINICIA LA API. El backend comprueba UNA VEZ por
-- proceso si esta tabla existe —para poder funcionar sin ella mientras la
-- migracion espera aprobacion— y se queda con la respuesta. Ver
-- `app/modules/recommendations/esquema.py`.


-- --------------------------------------------------------------------------
-- 1. post_mentions — a quien etiqueta cada publicacion
-- --------------------------------------------------------------------------
create table if not exists public.post_mentions (
  post_id uuid not null references public.posts(id) on delete cascade,

  -- `on delete cascade` y no `set null`: una mencion a una cuenta borrada no
  -- es una mencion «a nadie», es una mencion que ya no existe. Dejarla con el
  -- perfil a null obligaria a filtrar por null en cada lectura para siempre.
  mentioned_user_id uuid not null references public.profiles(id) on delete cascade,

  created_at timestamptz not null default now(),

  -- La clave es el par: etiquetar dos veces a la misma persona en la misma
  -- publicacion no es etiquetarla dos veces. Y esto es lo que garantiza, a
  -- nivel de base y no de codigo, que nadie reciba dos notificaciones por una
  -- sola publicacion aunque dos peticiones simultaneas intenten escribirla.
  primary key (post_id, mentioned_user_id)
);

-- «Donde me han mencionado»: la consulta desde el lado de la persona. Va
-- ordenada por fecha dentro del indice para que paginar no ordene nada.
create index if not exists post_mentions_user_idx
  on public.post_mentions (mentioned_user_id, created_at desc);

-- «A quien menciona esta publicacion»: una consulta por pagina de feed sobre
-- el lote entero de publicaciones, no una por fila.
create index if not exists post_mentions_post_idx
  on public.post_mentions (post_id);


-- --------------------------------------------------------------------------
-- 2. RLS
-- --------------------------------------------------------------------------
alter table public.post_mentions enable row level security;

/*
  LEER: quien pueda ver la publicacion, MAS la persona mencionada.

  Ese «mas» no es un detalle. Sin el, alguien mencionado en una publicacion que
  todavia no esta publicada no podria ver que le mencionaron, aunque le haya
  llegado el aviso. El aviso y el dato tienen que contar la misma historia.

  ESCRIBIR: solo el autor de la publicacion. Sin esta politica, cualquiera
  podria etiquetar a quien quisiera en la publicacion de otra persona —y
  provocar una notificacion que parece venir de ella—. Es el mismo criterio que
  `post_topics` y `post_hashtags`: una mencion es parte de la publicacion.

  Lo que la RLS NO puede hacer es comprobar el bloqueo: exigiria una
  subconsulta a `user_blocks` en cada insercion, y ademas el resultado correcto
  cuando hay bloqueo no es «error» sino «esa mencion no se guarda». Eso vive en
  el backend (app/modules/content/menciones.py), que ya tiene que decidir a
  quien avisar.
*/
drop policy if exists post_mentions_read on public.post_mentions;
create policy post_mentions_read on public.post_mentions
  for select
  using (
    mentioned_user_id = auth.uid()
    or exists (
      select 1 from public.posts p
      where p.id = post_id and (p.status = 'published' or p.author_id = auth.uid())
    )
  );

drop policy if exists post_mentions_write on public.post_mentions;
create policy post_mentions_write on public.post_mentions
  for all
  using (
    exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
  )
  with check (
    exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
  );
