-- 0115 · Cuánto tardan los videos de Inicio en los teléfonos de verdad
--
-- QUÉ RESUELVE. La línea base de velocidad de Inicio (primer video 3,1 s con
-- wifi y 6,6 s con 4G; pasar al siguiente 0,9 s y 13,5 s) se midió en la WEB.
-- Del iPhone y del Android no hay ni un número. La app manda ahora, una vez por
-- arranque, un lote pequeño con lo que tardó cada paso
-- (`apps/mobile/src/lib/medicionDeVideo.ts`), y la API lo guarda aquí
-- (`POST /api/v1/telemetria/video`, `apps/api/app/modules/telemetria`).
--
-- QUÉ HACE.
--   · Crea `metricas_de_video`: UNA FILA POR MEDICIÓN (un hito de la carga o
--     un tramo de un video), para que medianas y percentiles salgan de un
--     `group by` directo. Sin ninguna columna de persona: ni usuario, ni
--     publicación, ni IP. `sesion` es un número al azar por arranque.
--   · Índices por fecha y por (plataforma, tramo, fecha), que es como se lee.
--   · RLS ACTIVADA Y SIN POLÍTICAS, más `revoke all` a `anon` y
--     `authenticated`: por PostgREST no se lee ni se escribe. Solo la API, que
--     se conecta con el rol del servidor, escribe y lee.
--   · La vista `metricas_de_video_resumen` (últimos 7 días, mediana, p75 y
--     p90 por plataforma y tramo) para consultarla desde el editor SQL. Es
--     `security_invoker` y tampoco se sirve por PostgREST.
--   · La función `purgar_metricas_de_video(dias)` que borra lo anterior a
--     90 días (por defecto). Ver RETENCIÓN.
--
-- QUÉ NO HACE. No toca `behavior_events` (alimenta al recomendador; esto es
-- otra cosa y no debe mezclarse) ni `audit_events` (solo se añade a ella). No
-- toca ninguna fila existente.
--
-- RETENCIÓN. Noventa días: de sobra para comparar antes y después de una
-- optimización, y lo bastante corto para que la tabla no crezca sin fin. Con
-- `pg_cron` disponible (en Supabase: Database → Extensions), se programa así:
--   select cron.schedule('purgar-metricas-de-video', '30 4 * * *',
--     $$select public.purgar_metricas_de_video(90)$$);
-- Sin `pg_cron`, ejecutar a mano `select public.purgar_metricas_de_video();`
-- una vez al mes. Con el volumen de hoy (un lote de 5-35 filas por arranque)
-- no corre ninguna prisa.
--
-- SE PUEDE DESPLEGAR EL CÓDIGO ANTES O DESPUÉS. Sin esta tabla, la API sigue
-- contestando 202 al teléfono y descarta el lote (lo registra como aviso): el
-- teléfono no nota nada. El informe de administración daría 500 hasta aplicarla.
--
-- IDEMPOTENTE: se puede ejecutar dos veces.
--
-- VUELTA ATRÁS (se pierden las mediciones, que no son datos de nadie):
--   drop view if exists public.metricas_de_video_resumen;
--   drop function if exists public.purgar_metricas_de_video(integer);
--   drop table if exists public.metricas_de_video;

create table if not exists public.metricas_de_video (
  id bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  sesion text not null,
  plataforma text not null,
  version_app text,
  build text,
  modelo text,
  sistema text,
  red text,
  tramo text not null,
  ms integer,
  fotograma_ms integer,
  esperas smallint,
  espera_ms integer,
  formato text,
  bytes bigint,
  error boolean,
  constraint metricas_de_video_sesion check (sesion ~ '^[0-9a-f]{16}$'),
  constraint metricas_de_video_plataforma check (plataforma in ('ios', 'android', 'web')),
  constraint metricas_de_video_tramo check (tramo in (
    'feed_pedido', 'feed_respuesta', 'urls_firmadas', 'primer_fotograma',
    'primera_reproduccion', 'primer_video', 'deslizamiento', 'otro'
  )),
  constraint metricas_de_video_ms check (ms is null or ms between 0 and 120000),
  constraint metricas_de_video_fotograma check (fotograma_ms is null or fotograma_ms between 0 and 120000),
  constraint metricas_de_video_esperas check (esperas is null or esperas between 0 and 1000),
  constraint metricas_de_video_espera check (espera_ms is null or espera_ms between 0 and 120000),
  constraint metricas_de_video_formato check (formato is null or formato in ('hls', 'mp4')),
  constraint metricas_de_video_bytes check (bytes is null or bytes >= 0),
  constraint metricas_de_video_textos check (
    coalesce(length(version_app), 0) <= 32 and coalesce(length(build), 0) <= 32
    and coalesce(length(modelo), 0) <= 64 and coalesce(length(sistema), 0) <= 32
    and coalesce(length(red), 0) <= 16
  )
);

comment on table public.metricas_de_video is
  'Velocidad de los videos de Inicio medida en los teléfonos (0115). Sin datos de persona. Retención: 90 días (purgar_metricas_de_video).';

create index if not exists metricas_de_video_creado_en
  on public.metricas_de_video (creado_en);
create index if not exists metricas_de_video_plataforma_tramo
  on public.metricas_de_video (plataforma, tramo, creado_en);

alter table public.metricas_de_video enable row level security;
revoke all on public.metricas_de_video from anon, authenticated;

-- Resumen para el editor SQL. Sin `security_invoker`, una vista corre con los
-- permisos de su dueño y saltaría la RLS de la tabla; con él, quien no puede
-- leer la tabla tampoco puede leer la vista.
create or replace view public.metricas_de_video_resumen
  with (security_invoker = true) as
select
  plataforma,
  tramo,
  count(*) as n,
  count(*) filter (where ms is null) as sin_reproducir,
  round(percentile_cont(0.5) within group (order by ms))::integer as mediana_ms,
  round(percentile_cont(0.75) within group (order by ms))::integer as p75_ms,
  round(percentile_cont(0.9) within group (order by ms))::integer as p90_ms,
  round(avg(case when esperas > 0 then 1.0 else 0.0 end), 3) as con_esperas
from public.metricas_de_video
where creado_en >= now() - interval '7 days'
group by plataforma, tramo
order by plataforma, tramo;

revoke all on public.metricas_de_video_resumen from anon, authenticated;

create or replace function public.purgar_metricas_de_video(dias integer default 90)
returns integer
language plpgsql
set search_path = public
as $$
declare
  borradas integer;
begin
  if dias is null or dias < 7 then
    raise exception 'purgar_metricas_de_video: como mínimo 7 días (recibido %)', dias;
  end if;
  delete from public.metricas_de_video where creado_en < now() - make_interval(days => dias);
  get diagnostics borradas = row_count;
  return borradas;
end;
$$;

-- Las funciones nacen ejecutables por PUBLIC: se cierra, para que nadie la
-- llame por PostgREST (`/rpc/purgar_metricas_de_video`).
revoke all on function public.purgar_metricas_de_video(integer) from public, anon, authenticated;

notify pgrst, 'reload schema';

select
  to_regclass('public.metricas_de_video') is not null as tabla,
  (select relrowsecurity from pg_class where oid = 'public.metricas_de_video'::regclass) as rls,
  to_regclass('public.metricas_de_video_resumen') is not null as vista;
