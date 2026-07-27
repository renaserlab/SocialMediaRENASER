-- ---------------------------------------------------------------------------
-- 0020 — Tokens de dispositivo para notificaciones push
--
-- Hasta ahora las notificaciones solo existian DENTRO de la app: habia que
-- abrirla y entrar a su pestana para enterarse de un comentario. En una app
-- destinada al movil eso no basta, asi que hace falta avisar al telefono.
--
-- Cada dispositivo donde alguien inicia sesion registra aqui su token de Expo.
-- El envio lo hace la API desde `add_notification()`, que es el unico punto por
-- el que ya pasan los me gusta, los comentarios y los seguidores nuevos.
--
-- El token identifica al DISPOSITIVO, no a la persona: el mismo telefono puede
-- cambiar de cuenta, y la misma cuenta puede tener varios telefonos. Por eso la
-- clave es el token y se reasigna al usuario que inicia sesion, en vez de
-- acumular filas muertas que enviarian avisos a quien ya no usa ese aparato.
-- ---------------------------------------------------------------------------

create table if not exists public.device_tokens (
  -- El token de Expo es unico por dispositivo e instalacion.
  token text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  -- Sirve para purgar dispositivos que llevan meses sin aparecer.
  last_seen_at timestamptz not null default now()
);

-- Para buscar "todos los dispositivos de este usuario" al enviar un aviso.
create index if not exists device_tokens_user_idx on public.device_tokens (user_id);

alter table public.device_tokens enable row level security;

-- Cada quien gestiona SOLO sus dispositivos. El envio lo hace la API con la
-- clave de servicio, que no pasa por estas politicas.
drop policy if exists device_tokens_own on public.device_tokens;
create policy device_tokens_own on public.device_tokens
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

notify pgrst, 'reload schema';

-- Comprobacion. Deben salir 2 filas, ambas en OK.
select
  'tabla device_tokens' as comprobacion,
  case when exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'device_tokens'
  ) then 'OK' else 'FALTA' end as estado
union all
select
  'politica device_tokens_own',
  case when exists (
    select 1 from pg_policies
    where tablename = 'device_tokens' and policyname = 'device_tokens_own'
  ) then 'OK' else 'FALTA' end;
