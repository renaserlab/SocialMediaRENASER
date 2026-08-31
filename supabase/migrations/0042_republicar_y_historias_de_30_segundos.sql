-- =============================================================================
-- 0042 — Republicar (repost) y historias de hasta 30 segundos
-- =============================================================================
--
-- ESTA MIGRACIÓN ESTÁ APLICADA en producción (confirmado por quien la ejecutó,
-- 31 de agosto de 2026), y se ha vuelto a ejecutar sin consecuencias: todas sus
-- sentencias son idempotentes —`if not exists`, `drop policy if exists` antes de
-- crearla— y NINGUNA toca una sola fila. No hay `insert`, ni `update`, ni
-- `delete`, ni `truncate`, ni `drop table`. Volver a pasarla es un no-op.
--
-- Al volver a ejecutarla, el `check` de la duración de las historias se quita y
-- se pone otra vez, y al ponerlo Postgres revalida la tabla entera. Que no haya
-- fallado demuestra que ninguna historia guardada se sale de los 1000–30000 ms.
--
-- Trae dos cosas que no tienen nada que ver entre sí. Van juntas porque el
-- encargo asignó UN número a este bloque de trabajo, no porque estén
-- relacionadas: cada apartado es independiente y se puede leer solo.
--
-- =============================================================================
-- APARTADO 1 — REPUBLICAR
-- =============================================================================
--
-- QUÉ ES. Que alguien vuelva a compartir la publicación de otra persona dentro
-- de la aplicación, sin copiar nada. Hoy lo único que hay es el botón de
-- compartir del sistema operativo, que saca un enlace hacia FUERA.
--
-- -----------------------------------------------------------------------------
-- POR QUÉ UNA TABLA APARTE Y NO UNA COLUMNA EN `posts`
-- -----------------------------------------------------------------------------
-- Tres razones, en orden de peso:
--
-- 1. NO SE PUEDE REPUBLICAR UNA REPUBLICACIÓN. Con una columna
--    `posts.repost_of` una republicación SERÍA una publicación, así que
--    republicarla crearía una cadena: A republica a B, C republica a la
--    republicación de A... y para deshacerlo haría falta un disparador que
--    persiguiera la cadena hasta el original. Con una tabla aparte la cadena no
--    se puede ni escribir: `post_reposts.post_id` apunta SIEMPRE a una fila de
--    `posts`, y una republicación no es una fila de `posts`. La recursión no se
--    prohíbe con una comprobación: no se puede expresar.
--
-- 2. Cualquier `select(Entidad)` de SQLAlchemy pide TODAS las columnas
--    mapeadas. Una columna nueva en `posts` —la tabla más consultada de todas—
--    rompe producción en cuanto el modelo se adelanta a la migración. Una tabla
--    aparte solo se consulta cuando existe. Es el mismo razonamiento que ya se
--    escribió en la 0039.
--
-- 3. EL ARCHIVO NO SE DUPLICA. La republicación no tiene medios propios: sus
--    imágenes y vídeos son los de `post_media` del post original, que ya se
--    firman por RUTA (`resolveMediaUrls` en el móvil) y no por identidad de
--    publicación. Copiar el archivo habría significado, además, subirlo a la
--    carpeta de quien republica: la política de escritura de Storage
--    (`post_media_owner_write`) ata cada objeto a la carpeta de su dueño.
--
-- -----------------------------------------------------------------------------
-- QUÉ HACE Y QUÉ NO HACE
-- -----------------------------------------------------------------------------
-- Crea UNA tabla, sus dos índices y sus tres políticas. Nada más.
--
-- NO borra nada. NO modifica ni una fila existente. NO añade columnas a `posts`
-- ni a `post_media`. NO copia archivos.
--
-- LOS BLOQUEOS NO SE RESUELVEN AQUÍ, y es deliberado: la política `posts_read`
-- tampoco los mira. El corte en los dos sentidos vive en la API
-- (`blocked_either_way`), y para una republicación hay que aplicarlo DOS veces
-- —a quien republica y al autor original—, porque si no, bloquear a alguien
-- dejaría de servir de nada en cuanto un tercero le republicara. Eso está en
-- `app/modules/content/reposts.py` y probado en `tests/test_reposts.py`.

create table if not exists public.post_reposts (
  id uuid primary key default gen_random_uuid(),
  -- Quien republica. NO es el autor del contenido: eso sigue siendo
  -- `posts.author_id`, y no se toca.
  author_id uuid not null references public.profiles(id) on delete cascade,
  -- El post ORIGINAL. Al ser una clave ajena a `posts`, nunca puede apuntar a
  -- otra republicación: ahí está la garantía de que no hay cadenas.
  post_id uuid not null references public.posts(id) on delete cascade,
  -- Comentario opcional de quien republica ("cita"). Vacío es lo normal.
  comentario text not null default '' check (char_length(comentario) <= 500),
  -- La fecha de la REPUBLICACIÓN, distinta de la del post original. Las dos se
  -- enseñan: una dice cuándo se compartió y la otra cuándo se publicó.
  created_at timestamptz not null default now(),
  -- Republicar dos veces lo mismo es querer republicarlo una. Sin esto, un
  -- doble toque o el reintento de una red lenta crean dos filas.
  constraint post_reposts_unicos unique (author_id, post_id)
);

-- Las republicaciones de un perfil, de la más nueva a la más vieja: es
-- exactamente como se leen (pestaña del perfil y paginación por cursor).
create index if not exists post_reposts_autor_fecha_idx
  on public.post_reposts (author_id, created_at desc);

-- Cuántas veces se republicó un post, y por quién.
create index if not exists post_reposts_post_idx on public.post_reposts (post_id);

alter table public.post_reposts enable row level security;

-- Se lee una republicación si se podría leer el post original: mismo criterio
-- que `post_media_read`. Sin esto, una republicación de un borrador delataría
-- que existe.
drop policy if exists post_reposts_read on public.post_reposts;
create policy post_reposts_read on public.post_reposts for select using (
  exists (
    select 1 from public.posts p
    where p.id = post_id and (p.status = 'published' or p.author_id = auth.uid())
  )
);

-- Solo se republica en nombre propio.
drop policy if exists post_reposts_insert_own on public.post_reposts;
create policy post_reposts_insert_own on public.post_reposts for insert
  with check (author_id = auth.uid());

-- Deshacer es de quien republicó. El autor original NO puede borrar la
-- republicación de otra persona: para eso está bloquear o denunciar, que son
-- decisiones distintas y se toman en otro sitio.
drop policy if exists post_reposts_delete_own on public.post_reposts;
create policy post_reposts_delete_own on public.post_reposts for delete
  using (author_id = auth.uid() or public.is_admin());

-- =============================================================================
-- APARTADO 2 — HISTORIAS DE HASTA 30 SEGUNDOS
-- =============================================================================
--
-- La 0003 dejó escrito `check (duration_ms between 1000 and 15000)`. El encargo
-- pide treinta segundos, así que el tope sube. Es una RELAJACIÓN del límite: no
-- hay ninguna fila existente que deje de cumplirlo, así que no puede fallar por
-- datos.
--
-- YA APLICADO: el tope real son treinta segundos y el reintento de quince que
-- llevaba `StoryRepository.create` como red de seguridad dejó de dispararse
-- solo, sin tocar el móvil. Se mantiene por si algún despliegue viejo apunta a
-- una base sin esta migración.
--
-- El nombre de la restricción es el que le pone Postgres a un `check` declarado
-- en la columna: `<tabla>_<columna>_check`.

alter table public.stories drop constraint if exists stories_duration_ms_check;
alter table public.stories
  add constraint stories_duration_ms_check check (duration_ms between 1000 and 30000);

-- =============================================================================
-- Que PostgREST se entere del esquema nuevo sin reiniciar nada.
-- =============================================================================
notify pgrst, 'reload schema';

-- =============================================================================
-- COMPROBACIONES (ejecutar a mano DESPUÉS, una a una)
-- =============================================================================
--
-- 1. La tabla existe con sus columnas.
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'post_reposts'
-- order by ordinal_position;
-- Esperado: id, author_id, post_id, comentario, created_at.
--
-- 2. La pareja es única y las claves ajenas apuntan a donde deben.
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.post_reposts'::regclass
-- order by conname;
-- Esperado: la primaria, post_reposts_unicos UNIQUE (author_id, post_id), el
--           check del comentario y las dos claves ajenas (profiles y posts).
--
-- 3. Las tres políticas están puestas y no hay ninguna más.
-- select policyname, cmd from pg_policies
-- where schemaname = 'public' and tablename = 'post_reposts' order by policyname;
-- Esperado: post_reposts_delete_own (DELETE), post_reposts_insert_own (INSERT),
--           post_reposts_read (SELECT).
--
-- 4. El tope de las historias es el nuevo.
-- select pg_get_constraintdef(oid) from pg_constraint
-- where conrelid = 'public.stories'::regclass and conname = 'stories_duration_ms_check';
-- Esperado: CHECK ((duration_ms >= 1000) AND (duration_ms <= 30000)).
--
-- 5. Ninguna historia existente se quedó fuera del check (debe dar 0).
-- select count(*) from public.stories where duration_ms not between 1000 and 30000;
