-- 0101 · La grabación de un directo (prototipo)
--
-- QUÉ RESUELVE (documento «Z bugs y nuevas funcionalidades», 07/10/2026): que
-- quien emitió pueda descargar el vídeo de su directo durante un tiempo.
--
-- QUÉ HACE. Crea `live_recordings`: una fila por emisión con lo que el
-- proveedor de vídeo avisa cuando termina de preparar la grabación —dónde
-- está y el enlace temporal para bajarla—.
--
-- ES UN PROTOTIPO. Z NO GRABA NADA POR SÍ MISMA: graba el proveedor, y solo si
-- la grabación está ENCENDIDA en su panel (hoy está apagada, y encenderla
-- tiene costo por minuto grabado). Con la grabación apagada esta tabla se
-- queda vacía y nadie ve ningún botón.
--
-- QUÉ NO HACE.
--   · No toca `live_sessions` ni ninguna otra tabla. `recording_path`, que ya
--     existía ahí, se deja como está.
--   · No guarda el vídeo: guarda el enlace que da el proveedor, que CADUCA.
--   · No deja leer ni escribir al cliente: solo la API, y la API solo se lo
--     enseña a quien gestiona la emisión.
--
-- SE PUEDE DESPLEGAR EL CÓDIGO ANTES O DESPUÉS. Sin esta tabla, el aviso de
-- grabación se ignora y la aplicación no ofrece descarga. Tras aplicarla hay
-- que REINICIAR la API.
--
-- IDEMPOTENTE: se puede ejecutar dos veces.
--
-- VUELTA ATRÁS: `drop table public.live_recordings;` y reiniciar la API.

create table if not exists public.live_recordings (
  session_id uuid primary key references public.live_sessions(id) on delete cascade,
  -- El identificador de la grabación en el proveedor, para poder investigar.
  provider_recording_id text,
  -- Dónde la dejó el proveedor (su ruta de almacenamiento). No es un enlace.
  storage_path text,
  -- El enlace temporal para bajarla, tal como lo mandó el proveedor. CADUCA.
  download_url text,
  duration_seconds integer,
  size_bytes bigint,
  -- Cuándo llegó el aviso: el enlace cuenta su caducidad desde entonces.
  received_at timestamptz not null default now()
);

alter table public.live_recordings enable row level security;

-- NINGUNA POLÍTICA. El enlace deja bajar el vídeo a quien lo tenga: solo lo
-- entrega la API, y solo a quien gestiona esa emisión.

do $$
declare
  con_rls boolean;
  politicas integer;
begin
  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.live_recordings'::regclass;
  if not coalesce(con_rls, false) then
    raise exception 'La 0101 no ha dejado RLS activada en live_recordings.';
  end if;

  select count(*) into politicas
  from pg_policies
  where schemaname = 'public'
    and tablename = 'live_recordings';
  if politicas > 0 then
    raise exception
      'live_recordings tiene % política(s). No debe tener ninguna.',
      politicas;
  end if;
end
$$;

notify pgrst, 'reload schema';
