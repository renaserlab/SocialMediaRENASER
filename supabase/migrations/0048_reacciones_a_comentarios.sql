-- =============================================================================
-- 0048 — Reaccionar a un comentario («Me gusta»)
-- =============================================================================
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │  ESTA MIGRACIÓN ESTÁ PREPARADA Y **NO APLICADA**. El código funciona sin   │
-- │  ella: sin la tabla, el contador sale 0 y el corazón no aparece.           │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- =============================================================================
-- QUÉ AÑADE, Y POR QUÉ UNA TABLA NUEVA
-- =============================================================================
--
-- Hoy se puede reaccionar a una PUBLICACIÓN (`post_likes`) pero no a un
-- COMENTARIO: no hay dónde guardarlo. Esta migración crea `comment_likes`, que
-- es `post_likes` con la clave apuntando a `comments`.
--
-- NO se reutiliza `post_likes` con una columna `entity_type`. Esa tabla tiene
-- `post_id` con clave foránea a `posts`: para que sirviera para las dos cosas
-- habría que quitar esa foránea, y entonces nada impediría un «me gusta» a una
-- publicación que ya no existe. La integridad la lleva la base o no la lleva
-- nadie.
--
-- V1 A PROPÓSITO: un solo tipo de reacción, «me gusta». No hay columna de tipo
-- porque hoy no hay nada que distinguir, y añadirla luego es una migración
-- aditiva más —con `default 'like'` no se pierde ni una fila—. Lo que no se
-- puede deshacer barato es lo contrario: sacar un `type` que nadie rellena.
--
-- =============================================================================
-- IDEMPOTENCIA
-- =============================================================================
--
-- La clave primaria es `(comment_id, user_id)`: reaccionar dos veces es la
-- misma fila, no dos. El endpoint hace `on conflict do nothing`, así que pulsar
-- dos veces seguidas —o que se cuele un reintento de la red— deja el mismo
-- estado. `user_id` NUNCA llega del cliente: lo pone el servidor con la
-- identidad del token.
--
-- =============================================================================
-- LO QUE ESTA MIGRACIÓN **NO** HACE
-- =============================================================================
--
--   * NO borra ni modifica ninguna tabla, columna ni política existente.
--   * NO toca ni una fila: no hay insert, update, delete ni truncate.
--   * NO cambia nada de `post_likes`, `comments` ni `notifications`.
--
-- Es aditiva e idempotente: volver a pasarla no hace nada.
--
-- PARA DESHACERLA (se pierden las reacciones a comentarios, nada más):
--
--     drop table if exists public.comment_likes;
--
-- =============================================================================
-- DESPUÉS DE APLICARLA
-- =============================================================================
--
-- HAY QUE REINICIAR LA API. `esquema.py` cachea por proceso si la tabla existe;
-- sin reiniciar, los procesos que ya miraron seguirían respondiendo «no está» y
-- el corazón no aparecería hasta el siguiente despliegue.
-- -----------------------------------------------------------------------------

create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

-- Para contar y para saber si TÚ reaccionaste, que es lo que pide cada lista de
-- comentarios. Sin él, ambas cosas serían un recorrido de la tabla entera.
create index if not exists comment_likes_comment_idx
  on public.comment_likes (comment_id);

-- Para «lo que reaccionó esta persona», que es como se resuelve `viewer_reacted`
-- de una página entera de comentarios con UNA consulta en vez de una por fila.
create index if not exists comment_likes_user_idx
  on public.comment_likes (user_id);


-- =============================================================================
-- RLS — misma forma que `post_likes`
-- =============================================================================
--
-- Leer es público (el contador se ve sin cuenta, igual que el de la
-- publicación). Escribir y borrar, solo lo tuyo: `user_id = auth.uid()` impide
-- que nadie reaccione en nombre de otro aunque mande el id de otro.
alter table public.comment_likes enable row level security;

drop policy if exists comment_likes_read on public.comment_likes;
create policy comment_likes_read on public.comment_likes
  for select using (true);

drop policy if exists comment_likes_insert_own on public.comment_likes;
create policy comment_likes_insert_own on public.comment_likes
  for insert with check (user_id = auth.uid());

drop policy if exists comment_likes_delete_own on public.comment_likes;
create policy comment_likes_delete_own on public.comment_likes
  for delete using (user_id = auth.uid());


-- =============================================================================
-- COMPROBACIÓN AUTOMÁTICA — aborta si no quedó como debe
-- =============================================================================
--
-- Se comprueba lo que puede fallar EN SILENCIO: que la tabla quedara sin RLS.
-- Una tabla nueva sin RLS en Supabase es legible y ESCRIBIBLE por cualquiera
-- con la clave pública, y nada en la aplicación lo delataría.
do $$
begin
  if not exists (
    select 1 from pg_class
    where relname = 'comment_likes' and relnamespace = 'public'::regnamespace
  ) then
    raise exception 'La 0048 no creo public.comment_likes.';
  end if;

  if not (
    select relrowsecurity from pg_class
    where relname = 'comment_likes' and relnamespace = 'public'::regnamespace
  ) then
    raise exception
      'comment_likes quedo SIN RLS: con la clave publica cualquiera podria '
      'reaccionar en nombre de otro.';
  end if;

  if (
    select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'comment_likes'
  ) <> 3 then
    raise exception 'comment_likes no tiene las tres politicas esperadas.';
  end if;
end
$$;


-- =============================================================================
-- COMPROBACIONES A MANO (ejecutar DESPUÉS, una a una)
-- =============================================================================
--
-- 1. La tabla y sus índices.
-- \d public.comment_likes
--
-- 2. Las políticas.
-- select policyname, cmd from pg_policies
-- where schemaname = 'public' and tablename = 'comment_likes';
-- Esperado: comment_likes_read (SELECT), comment_likes_insert_own (INSERT),
--           comment_likes_delete_own (DELETE).
--
-- 3. No se ha tocado nada de lo que ya había.
-- select count(*) from public.post_likes;
-- select count(*) from public.comments;
