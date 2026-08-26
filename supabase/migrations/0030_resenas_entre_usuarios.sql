-- ---------------------------------------------------------------------------
-- 0030 — Resenas entre personas: A resena a B, y sale en el perfil de B.
--
-- QUE ESTABA ROTO, Y NO ERA UN FALLO DE PANTALLA.
--
-- La aplicacion ya tenia un boton «Agregar resena» que escribia en
-- `testimonials`. Pero `testimonials` NO es una resena: es la galeria de fotos
-- y videos de UN autor. Sus columnas lo dicen entero:
--
--     author_id, storage_path (NOT NULL), media_type, caption
--
-- Es decir: el archivo era OBLIGATORIO y el texto opcional —justo al reves de
-- lo que es una resena—, y no existia ninguna columna que dijera SOBRE QUIEN se
-- opina. Sin ella, lo que A escribia aparecia en el perfil de A. Una resena que
-- sale en el perfil de quien la escribe no es una resena; es una publicacion.
--
-- Encima, la galeria se lista filtrando por `author_id`, asi que la seccion de
-- un perfil ensena lo que esa persona ESCRIBIO, nunca lo que le dijeron. Y como
-- la interfaz da los botones de editar y borrar a quien es dueno del perfil,
-- el dueno podia quitar lo que otro publicara ahi. Es exactamente la regla que
-- una resena no puede permitir.
--
-- La 0008 ademas exigia `public.is_admin()` para INSERT, UPDATE y DELETE: por
-- eso, en una base donde la 0017 todavia no se hubiera aplicado, pulsar
-- «publicar» no hacia nada visible —la base rechazaba la fila y la pantalla se
-- quedaba cargando—. La 0017 ya abrio esa escritura al autor; este script NO
-- depende de si esta puesta o no, porque no toca `testimonials`.
--
-- QUE SE HACE AQUI. Se anade el dominio que faltaba, y SOLO se anade:
--
--   * `profile_reviews`  — quien opina, sobre quien, que dice y en que estado.
--   * `review_media`     — las fotos o videos de una resena. Opcionales.
--
-- QUE NO SE HACE, Y ES DELIBERADO. NO se toca `testimonials`: ni sus filas, ni
-- sus politicas, ni su nombre. Ahi hay contenido real publicado por gente real
-- y sigue siendo lo que siempre fue —la galeria de un perfil—. Tampoco se
-- migran sus filas a `profile_reviews`: no se puede, porque nadie sabe sobre
-- quien opinaba cada una. Inventar ese dato seria inventar datos.
--
-- LAS REGLAS, y donde vive cada una. Todas estas estan AQUI, en la base, y
-- ademas repetidas en el backend (`app/modules/reviews/`). La interfaz no
-- decide ninguna: solo evita ensenar botones que iban a fallar.
--
--   1. A resena a B; la resena aparece en el perfil de B.        -> columnas
--   2. El TEXTO es obligatorio. La foto y el video, opcionales.  -> CHECK
--   3. NADIE se resena a si mismo.                               -> CHECK
--   4. A borra y edita SU PROPIA resena.                         -> RLS
--   5. B NO puede borrar una resena sobre B porque no le guste.  -> RLS
--      Si le parece abusiva, la reporta (`public.reports`) y modera quien
--      modera. Que el opinado pueda borrar lo que no le gusta convierte la
--      seccion entera en un escaparate y deja de significar nada.
--   6. Los bloqueos cortan en LOS DOS SENTIDOS.                  -> RLS
--
-- LA VERIFICACION NO SE INVENTA. `verified_source` solo se rellena cuando hay
-- constancia real en esta misma base de que las dos personas se cruzaron:
--
--   * 'booking' -> hay una fila en `public.bookings` entre ambas con
--                  `status = 'completed'`. La 0025 guardo `completed_at`
--                  precisamente para esto.
--   * 'course'  -> quien opina compro un curso cuyo autor es la persona
--                  opinada (`public.purchases` con `status = 'paid'`).
--
-- Sin ninguna de las dos, la columna se queda a NULL y la resena vale igual:
-- se publica, se lee y cuenta. Lo unico que no lleva es el sello. Una columna
-- booleana `verified` habria permitido que dijera «si» sin poder explicar por
-- que; guardando la FUENTE, el sello siempre se puede justificar.
--
-- UNA RESENA POR PERSONA Y PERSONA. Es lo que hace que la seccion se pueda
-- leer: sin ese limite, una sola cuenta puede llenar el perfil de otra con
-- veinte entradas y tapar todo lo demas. Cambiar de opinion sigue siendo
-- posible —se edita la que hay, o se borra y se escribe otra—, que es lo que
-- de verdad se quiere hacer cuando una opinion cambia.
--
-- El script es REPETIBLE e IDEMPOTENTE: aditivo de principio a fin.
--
-- DESPUES DE APLICARLA, REINICIA LA API. El backend comprueba UNA VEZ por
-- proceso si estas tablas existen —para poder funcionar sin ellas mientras la
-- migracion espera aprobacion— y se queda con la respuesta.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. La resena
-- ---------------------------------------------------------------------------
create table if not exists public.profile_reviews (
  id uuid primary key default gen_random_uuid(),

  -- Quien opina y sobre quien. Nombres explicitos por la misma razon que en
  -- `bookings`: con `user_a` y `user_b`, cualquier consulta futura tendria que
  -- adivinar quien escribio y quien fue resenado, y adivinar mal aqui invierte
  -- el sentido de la frase entera.
  reviewer_id      uuid not null references public.profiles(id) on delete cascade,
  reviewed_user_id uuid not null references public.profiles(id) on delete cascade,

  -- EL TEXTO ES OBLIGATORIO, y esta es la diferencia de fondo con
  -- `testimonials`: alli el archivo era obligatorio y el texto opcional. Una
  -- resena sin palabras es una foto; lo que aporta valor es lo que se dice.
  --
  -- 2000 caracteres: espacio de sobra para contar una experiencia completa, y
  -- un tope que impide pegar un articulo entero en el perfil de alguien.
  body text not null check (char_length(btrim(body)) between 1 and 2000),

  -- `published` | `hidden` | `removed`. Texto con CHECK y no un enum nuevo:
  -- ampliar un CHECK es una linea, ampliar un enum arrastra su migracion.
  --
  --   published -> se ve.
  --   hidden    -> la escondio la moderacion. La sigue viendo quien la
  --                escribio, para que no le desaparezca sin explicacion.
  --   removed   -> retirada. Se conserva la fila para poder justificar la
  --                decision; borrarla dejaria a la moderacion sin registro.
  status text not null default 'published'
    check (status in ('published', 'hidden', 'removed')),

  -- De donde sale el sello de «interaccion verificada», o NULL si no hay
  -- ninguna constancia. Ver la nota de la cabecera: NO se rellena a mano.
  verified_source text check (verified_source in ('booking', 'course')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- NADIE SE RESENA A SI MISMO. Es un CHECK y no una validacion de formulario
  -- porque la aplicacion movil escribe contra PostgREST: una comprobacion que
  -- solo viva en la pantalla se salta con una peticion a mano.
  constraint profile_reviews_sin_autoresena
    check (reviewer_id <> reviewed_user_id)
);

comment on table public.profile_reviews is
  'Resena de una persona sobre otra. Aparece en el perfil de reviewed_user_id, no en el de quien la escribe.';
comment on column public.profile_reviews.verified_source is
  'De donde sale el sello de interaccion verificada (booking|course). NULL = no hay constancia; la resena vale igual.';

-- UNA por pareja. Indice unico y no `constraint unique` para poder crearlo con
-- `if not exists` y que el script siga siendo repetible.
create unique index if not exists profile_reviews_una_por_pareja
  on public.profile_reviews (reviewer_id, reviewed_user_id);

-- La consulta de la seccion es siempre «las resenas de ESTE perfil, las mas
-- recientes primero». Sin este indice recorreria la tabla entera cada vez.
create index if not exists profile_reviews_recibidas_idx
  on public.profile_reviews (reviewed_user_id, created_at desc);

-- Y la contraria: «las que YO he escrito», que es como se encuentra la propia
-- para editarla o borrarla desde el perfil de otra persona.
create index if not exists profile_reviews_escritas_idx
  on public.profile_reviews (reviewer_id, created_at desc);

drop trigger if exists profile_reviews_set_updated_at on public.profile_reviews;
create trigger profile_reviews_set_updated_at
  before update on public.profile_reviews
  for each row execute function public.set_updated_at();

alter table public.profile_reviews enable row level security;

-- LECTURA. Lo publicado lo ve cualquiera con sesion, MENOS si hay bloqueo por
-- cualquiera de los dos lados. Lo escondido o retirado lo sigue viendo quien lo
-- escribio —para que no le desaparezca sin explicacion— y la moderacion.
--
-- El corte por bloqueo es SIMETRICO, igual que en el resto de Z: cortar un solo
-- sentido dejaria que a quien te bloqueo le siguieran apareciendo tus resenas.
drop policy if exists profile_reviews_read on public.profile_reviews;
create policy profile_reviews_read on public.profile_reviews
  for select to authenticated using (
    (
      status = 'published'
      or reviewer_id = auth.uid()
      or public.is_admin()
    )
    and not exists (
      select 1 from public.user_blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = profile_reviews.reviewer_id)
         or (b.blocker_id = profile_reviews.reviewer_id and b.blocked_id = auth.uid())
         or (b.blocker_id = auth.uid() and b.blocked_id = profile_reviews.reviewed_user_id)
         or (b.blocker_id = profile_reviews.reviewed_user_id and b.blocked_id = auth.uid())
    )
  );

-- PUBLICAR. Siempre EN NOMBRE PROPIO (`reviewer_id = auth.uid()`): sin esa
-- condicion, cualquiera podria firmar una opinion con el nombre de otra
-- persona, que en una seccion de resenas no es una travesura.
--
-- Y nunca sobre uno mismo ni cruzando un bloqueo. La autoresena la corta
-- ademas el CHECK de la tabla; aqui se repite para que el motivo del rechazo
-- sea el permiso y no una violacion de restriccion.
drop policy if exists profile_reviews_insert on public.profile_reviews;
create policy profile_reviews_insert on public.profile_reviews
  for insert to authenticated with check (
    reviewer_id = auth.uid()
    and reviewed_user_id <> auth.uid()
    -- El estado inicial no lo elige quien publica: nacer en `hidden` seria
    -- publicar algo que nadie lee, y nacer en `removed` no significa nada.
    and status = 'published'
    and not exists (
      select 1 from public.user_blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = profile_reviews.reviewed_user_id)
         or (b.blocker_id = profile_reviews.reviewed_user_id and b.blocked_id = auth.uid())
    )
  );

-- EDITAR. Solo quien la escribio, y solo el texto: `reviewer_id`,
-- `reviewed_user_id` y `verified_source` no se pueden cambiar desde aqui.
--
-- La moderacion tambien puede, porque esconder es un UPDATE de `status`.
--
-- LA PERSONA RESENADA NO APARECE EN ESTA POLITICA, y esa ausencia es la regla
-- entera: no puede editar lo que se dice de ella.
drop policy if exists profile_reviews_update on public.profile_reviews;
create policy profile_reviews_update on public.profile_reviews
  for update to authenticated
  using (reviewer_id = auth.uid() or public.is_admin())
  with check (reviewer_id = auth.uid() or public.is_admin());

-- BORRAR. Quien la escribio, o la moderacion. NADIE MAS.
--
-- Aqui esta la regla que da sentido a toda la seccion: B NO puede borrar una
-- resena sobre B. Si le parece abusiva la reporta y decide quien modera. Sin
-- esto, en el perfil de cualquiera solo quedaria lo que a esa persona le gusta,
-- y leerlas no serviria para nada.
drop policy if exists profile_reviews_delete on public.profile_reviews;
create policy profile_reviews_delete on public.profile_reviews
  for delete to authenticated
  using (reviewer_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- 2. Las fotos y los videos de la resena
-- ---------------------------------------------------------------------------
-- Tabla aparte y no dos columnas nullables en `profile_reviews` por dos
-- razones: una resena puede llevar VARIOS archivos, y la inmensa mayoria no
-- lleva ninguno. Con columnas dentro, la tabla estaria casi entera vacia y
-- ademas solo admitiria un archivo para siempre.
--
-- Los ficheros van al bucket privado `post-media`, que ya existe desde la 0001
-- y cuya politica de escritura EXIGE que la ruta empiece por la carpeta de quien
-- sube (`<uid>/...`). Por eso aqui NO se crea ninguna politica de Storage: la
-- que hay ya es la correcta, y anadir otra solo abriria camino a rutas ajenas.
create table if not exists public.review_media (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.profile_reviews(id) on delete cascade,

  -- La RUTA dentro del bucket, no la URL: las firmas caducan y la ruta no.
  storage_path text not null check (char_length(btrim(storage_path)) between 1 and 500),
  media_type text not null check (media_type in ('image', 'video')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.review_media is
  'Fotos y videos OPCIONALES de una resena. El texto es lo obligatorio; esto acompana.';

create index if not exists review_media_resena_idx
  on public.review_media (review_id, sort_order);

alter table public.review_media enable row level security;

-- Los archivos siguen a su resena: si se puede leer la resena, se pueden ver
-- sus fotos. Repetir aqui las condiciones de visibilidad las dejaria libres de
-- desincronizarse con las de arriba en el proximo cambio.
drop policy if exists review_media_read on public.review_media;
create policy review_media_read on public.review_media
  for select to authenticated using (
    exists (
      select 1 from public.profile_reviews r
      where r.id = review_media.review_id
    )
  );

-- Escribir: solo quien escribio la resena, y solo sobre la suya. La moderacion
-- para poder retirar un archivo concreto sin borrar el texto.
drop policy if exists review_media_write on public.review_media;
create policy review_media_write on public.review_media
  for all to authenticated
  using (
    exists (
      select 1 from public.profile_reviews r
      where r.id = review_media.review_id
        and (r.reviewer_id = auth.uid() or public.is_admin())
    )
  )
  with check (
    exists (
      select 1 from public.profile_reviews r
      where r.id = review_media.review_id
        and (r.reviewer_id = auth.uid() or public.is_admin())
    )
  );

-- PostgREST cachea el esquema: sin esto, las tablas recien creadas pueden
-- seguir dando 404 ("could not find the table ... in the schema cache") un rato.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Comprobacion final. Las dos tablas nuevas salen a 0 —nadie ha resenado a
-- nadie todavia— y TODO lo anterior queda INTACTO, `testimonials` incluida.
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.profile_reviews)                        as resenas,
  (select count(*) from public.review_media)                           as medios_de_resena,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'profile_reviews')     as politicas_resenas,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'review_media')        as politicas_medios,
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname = 'profile_reviews_una_por_pareja')                as indice_unico,
  -- Lo que NO se ha tocado. `testimonials` conserva sus filas y sus politicas.
  (select count(*) from public.testimonials)                           as testimonios_intactos,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'testimonials')        as politicas_testimonios,
  (select count(*) from public.profiles)                               as perfiles_intactos,
  (select count(*) from public.bookings)                               as reservas_intactas,
  (select count(*) from public.posts)                                  as publicaciones_intactas;
-- Esperado: 0, 0, 4, 2, 1, y el resto exactamente igual que antes de ejecutar.
