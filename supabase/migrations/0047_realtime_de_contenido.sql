-- =============================================================================
-- 0047 — Realtime para el contenido público (posts, comments, stories, courses)
-- =============================================================================
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │  ESTA MIGRACIÓN ESTÁ PREPARADA Y **NO APLICADA**, Y HOY TODAVÍA NO HACE   │
-- │  FALTA. NO LA EJECUTES SIN LEER LA SECCIÓN «CUÁNDO APLICARLA».            │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- =============================================================================
-- QUÉ PROBLEMA RESUELVE, Y CUÁL NO
-- =============================================================================
--
-- El fallo reportado —«el usuario debe estar saliendo y volviendo a entrar para
-- que recién vea lo que publicó»— es sobre el contenido PROPIO, en el MISMO
-- dispositivo. Eso NO se arregla con Realtime, y de hecho ya está arreglado sin
-- él, en `apps/mobile/src/lib/sincronizacion.ts`:
--
--   NIVEL A  la mutación inserta la fila que devolvió el servidor en el estado
--            que le toca. Inmediato, con el id de verdad.
--   NIVEL B  las superficies con lista propia (Inicio, Perfil) se enteran de
--            que su copia envejeció y la refrescan cuando se están viendo.
--
-- Esta migración es para el NIVEL C: que lo que publica OTRA PERSONA aparezca
-- en una pantalla ya abierta sin tocar nada. Es una mejora, no el fallo.
--
-- =============================================================================
-- CUÁNDO APLICARLA  (y por qué no antes)
-- =============================================================================
--
-- Añadir tablas a `supabase_realtime` hace que Postgres empiece a EMITIR los
-- cambios. Si en el cliente no hay nadie suscrito, eso es coste de replicación
-- sin ningún beneficio: nadie escucha.
--
-- APLICAR SOLO CUANDO EXISTA, EN EL CLIENTE, TODO ESTO:
--
--   1. Suscripciones por SUPERFICIE, no por tarjeta. Un canal por publicación
--      visible serían veinte canales en un muro; el límite de conexiones se
--      alcanza con dos pestañas abiertas.
--   2. Deduplicación por id al mezclar. El mismo INSERT llega dos veces —por la
--      respuesta del POST y por el evento— y sin identidad estable se pinta el
--      comentario dos veces. El patrón ya existe en `lib/mensajesEnVivo.ts`.
--   3. Baja de la suscripción al desmontar y al CAMBIAR DE CUENTA. Una
--      suscripción que sobrevive al cierre de sesión sigue recibiendo lo que ya
--      no le corresponde.
--   4. Agrupación de eventos rápidos (debounce). Sin ella, veinte «me gusta»
--      seguidos son veinte repintados.
--
-- Mientras eso no exista, el Nivel B ya cubre la consistencia: al volver a una
-- superficie se comprueba si cambió algo y se pide solo entonces.
--
-- =============================================================================
-- SEGURIDAD: QUÉ VIAJA Y QUIÉN LO RECIBE
-- =============================================================================
--
-- Las cuatro tablas tienen RLS activada, y Realtime la RESPETA en INSERT y
-- UPDATE: cada cliente solo recibe las filas que podría leer con un `select`.
-- Comprobado en las migraciones anteriores:
--
--   posts     posts_read      status = 'published' or author_id = auth.uid() or is_admin()
--   comments  comments_read   status = 'published' or author_id = auth.uid() or is_admin()
--   stories   stories_read    expires_at > now()  or author_id = auth.uid() or is_admin()
--   courses   courses_read    status = 'published' or author_id = auth.uid() or is_admin()
--
-- O sea: un borrador ajeno NO se emite a nadie más que a su autor. Es la misma
-- garantía que ya tiene el `select`, sin excepciones nuevas.
--
-- NO se añaden aquí, a propósito:
--
--   post_likes / conversation_labels / enrollments / payments — o son privadas,
--   o su volumen de escritura es alto y su valor en vivo bajo. Un contador de
--   «me gusta» que se actualiza al segundo no compensa emitir cada fila de
--   reacción a todos los clientes que miran esa publicación.
--
-- ⚠ EL DELETE ES EL CASO DELICADO. Con la identidad de réplica por defecto
-- (`DEFAULT`), el registro viejo de un DELETE solo lleva la CLAVE PRIMARIA:
-- Postgres no manda el resto de columnas, así que Realtime NO PUEDE evaluar la
-- RLS sobre esa fila y el evento se entrega SIN filtrar. Solo viaja un id, que
-- por sí mismo no revela contenido —pero sí revela que ALGO se borró.
--
-- Si algún día hace falta filtrar también los DELETE, la única forma es:
--
--     alter table public.posts replica identity full;
--
-- y NO se pone aquí porque tiene coste: con `full`, cada UPDATE y cada DELETE
-- escriben la fila ENTERA en el WAL. En una tabla que se actualiza a menudo eso
-- se nota en disco y en replicación. Para lo que necesita esta aplicación
-- —enterarse de que una publicación desapareció— basta con el id.
--
-- =============================================================================
-- LO QUE ESTA MIGRACIÓN **NO** HACE
-- =============================================================================
--
--   * NO crea ni borra tablas, columnas, políticas ni restricciones.
--   * NO toca ni una fila. No hay insert, update, delete ni truncate.
--   * NO cambia ninguna RLS. Añadir una tabla a una publicación no concede
--     acceso a nada: solo emite lo que esa RLS ya dejaba leer.
--   * NO cambia `replica identity` de ninguna tabla (ver arriba).
--
-- Es aditiva e idempotente: volver a pasarla no hace nada.
--
-- =============================================================================
-- DESPUÉS DE APLICARLA
-- =============================================================================
--
-- No hace falta reiniciar la API: esto no lo lee `esquema.py`. Lo que sí hay
-- que hacer es MEDIR el coste de replicación durante unos días — es la primera
-- vez que tablas de contenido, y no de mensajería, entran en la publicación.
--
-- PARA DESHACERLO, si el coste no compensa:
--
--     alter publication supabase_realtime drop table public.posts;
--
-- No se pierde nada: los clientes dejan de recibir eventos y el Nivel B sigue
-- manteniendo la consistencia al volver a cada superficie.
-- -----------------------------------------------------------------------------

do $$
declare
  tabla text;
begin
  -- `stories` va incluida aunque hoy la fila se refresque desde el almacén: si
  -- se activa el Nivel C, una historia nueva de alguien a quien sigues es
  -- justamente el caso que más se nota.
  foreach tabla in array array['posts', 'comments', 'stories', 'courses'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = tabla
    ) then
      execute format('alter publication supabase_realtime add table public.%I', tabla);
      raise notice 'anadida a supabase_realtime: %', tabla;
    else
      raise notice 'ya estaba en supabase_realtime: %', tabla;
    end if;
  end loop;
end
$$;


-- =============================================================================
-- COMPROBACIÓN AUTOMÁTICA — aborta si no quedó como debe
-- =============================================================================
--
-- Se comprueba lo que puede fallar EN SILENCIO: que una tabla no llegara a
-- entrar en la publicación. Sin esto, el cliente se suscribiría, no recibiría
-- nada y no habría forma de distinguirlo de «no ha pasado nada todavía».
do $$
declare
  faltan text;
begin
  select string_agg(t, ', ')
    into faltan
  from unnest(array['posts', 'comments', 'stories', 'courses']) as t
  where not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
  );

  if faltan is not null then
    raise exception
      'La 0047 no anadio a supabase_realtime: %. Sin ellas el cliente se '
      'suscribiria y no recibiria nada, sin ningun error que lo delate.', faltan;
  end if;
end
$$;


-- =============================================================================
-- COMPROBACIONES A MANO (ejecutar DESPUÉS, una a una)
-- =============================================================================
--
-- 1. Qué hay ahora en la publicación.
-- select tablename from pg_publication_tables
-- where pubname = 'supabase_realtime' and schemaname = 'public' order by tablename;
-- Esperado: comments, conversations, courses, live_messages, live_sessions,
--           messages, posts, stories.
--
-- 2. La RLS de las cuatro sigue activada y sin cambios.
-- select relname, relrowsecurity from pg_class
-- where relname in ('posts','comments','stories','courses');
-- Esperado: relrowsecurity = true en las cuatro.
--
-- 3. La identidad de réplica NO se ha tocado (debe seguir en 'd' = default).
-- select relname, relreplident from pg_class
-- where relname in ('posts','comments','stories','courses');
--
-- 4. No se ha tocado ninguna fila.
-- select count(*) from public.posts;
-- select count(*) from public.comments;
