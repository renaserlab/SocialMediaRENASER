-- ---------------------------------------------------------------------------
-- 0029 — Transmisiones en vivo: la sala, el chat y las reacciones.
--
-- QUE ES ESTO Y QUE NO ES. Esto NO trae video en directo. El video en directo
-- exige un proveedor externo (LiveKit, Mux, Cloudflare Stream, IVS o similar)
-- con su cuenta, sus claves y su coste, y esa es una decision de negocio
-- exactamente igual que la pasarela de pago. Lo que hay aqui es TODO lo demas,
-- que es la mayor parte y ademas la parte que no se puede comprar hecha:
--
--   * La SALA: quien emite, desde cuando, en que estado, quien puede verla.
--   * El CHAT en vivo, con moderacion y RLS de verdad.
--   * Las REACCIONES, con una arquitectura que aguanta rafagas.
--
-- El dia que se elija proveedor, lo unico que se rellena son dos columnas
-- (`provider`, `provider_room_id`) y se implementa una clase en el backend.
-- Ni el chat, ni las reacciones, ni los permisos, ni la interfaz cambian.
--
-- POR QUE UNA TABLA PROPIA Y NO REUTILIZAR `events`. Un evento de `events` es
-- una entrada de calendario con una fecha y un enlace de WhatsApp: no tiene
-- estado que cambie solo, ni espectadores, ni chat, ni sala. Que `events`
-- admita `event_type = 'live'` es una ETIQUETA para anunciar «esto sera en
-- directo», no una emision. Mezclarlos obligaria a que la mitad de las
-- columnas fueran nulas segun el caso, que es como una tabla deja de decir la
-- verdad sobre lo que contiene.
--
-- LAS DOS DECISIONES DE RENDIMIENTO, que son el motivo de que esto tenga la
-- forma que tiene:
--
-- 1. EL CHAT SE GUARDA. Cada mensaje es una fila y viaja por Realtime igual
--    que la mensajeria privada (migracion 0002). Se guarda porque hace falta:
--    quien entra a mitad de emision tiene que ver lo anterior, y moderar exige
--    poder esconder un mensaje concreto. A ritmo de chat humano —unos pocos
--    mensajes por segundo— una fila por mensaje no es ningun problema.
--
-- 2. LAS REACCIONES NO SE GUARDAN UNA A UNA. Un corazon no es un mensaje: en
--    una emision animada se pulsan cientos por segundo, y una fila por pulsion
--    convertiria la base de datos en el cuello de botella de la fiesta. Los
--    corazones que flotan por la pantalla viajan por Realtime BROADCAST, que
--    no toca la base. Lo unico que se guarda es el TOTAL, y el cliente lo
--    manda acumulado cada pocos segundos. Se pierde saber quien pulso que y
--    cuando, y esa perdida es deliberada: nadie necesita esa informacion, y
--    guardarla costaria mas que todo lo demas junto.
--
-- QUE NO HACE ESTA MIGRACION. No toca ninguna tabla existente. No crea
-- ninguna fila. No enciende nada: `FEATURE_LIVE` sigue en false hasta que
-- exista proveedor.
--
-- El script es REPETIBLE e IDEMPOTENTE: aditivo de principio a fin.
--
-- DESPUES DE APLICARLA, REINICIA LA API. El backend comprueba UNA VEZ por
-- proceso si estas tablas existen —para poder funcionar sin ellas mientras la
-- migracion espera aprobacion— y se queda con la respuesta.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. La sala
-- ---------------------------------------------------------------------------
create table if not exists public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null default '',

  -- El ciclo de vida. `text` con CHECK y no un enum nuevo: ampliar un CHECK es
  -- una linea y ampliar un enum de Postgres arrastra su propia migracion.
  --
  --   scheduled -> anunciada, todavia no empieza. Se ve, no se entra.
  --   live      -> emitiendo AHORA.
  --   ended     -> termino. Se conserva para poder ver el chat y la grabacion.
  --   cancelled -> se anuncio y no llego a ocurrir. NO es lo mismo que `ended`:
  --                perder esa diferencia haria parecer que hubo una emision.
  status text not null default 'scheduled'
    check (status in ('scheduled', 'live', 'ended', 'cancelled')),

  scheduled_for timestamptz,
  started_at timestamptz,
  ended_at timestamptz,

  -- Que proveedor sirve el video y con que identificador de sala. 'none'
  -- mientras no haya ninguno: la sala existe, el chat funciona, y lo unico que
  -- falta es la imagen.
  provider text not null default 'none',
  provider_room_id text,

  -- La grabacion, cuando el proveedor la entregue. Ruta en Storage, no URL:
  -- las firmas caducan y la ruta no.
  recording_path text,

  -- El maximo de gente a la vez. Se guarda el PICO y no el instantaneo porque
  -- el instantaneo ya no significa nada cuando la emision termino, y porque
  -- escribir cada entrada y salida seria otra vez una fila por evento.
  viewer_peak integer not null default 0 check (viewer_peak >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Una emision no puede haber terminado antes de empezar.
  constraint live_sessions_orden_temporal
    check (ended_at is null or started_at is null or ended_at >= started_at)
);

comment on table public.live_sessions is
  'Una transmision en vivo: la sala, su estado y su grabacion. El video lo sirve un proveedor externo.';

-- La consulta de la pestana Live es «que hay emitiendo ahora», y despues «que
-- hay anunciado». Sin este indice recorreria la tabla entera cada vez.
create index if not exists live_sessions_estado_idx
  on public.live_sessions (status, started_at desc nulls last);

create index if not exists live_sessions_host_idx
  on public.live_sessions (host_id, created_at desc);

drop trigger if exists live_sessions_set_updated_at on public.live_sessions;
create trigger live_sessions_set_updated_at
  before update on public.live_sessions
  for each row execute function public.set_updated_at();

alter table public.live_sessions enable row level security;

-- LECTURA: lo que esta emitiendo o ya emitio lo ve cualquiera con sesion, y
-- tambien lo anunciado —anunciar sirve justamente para que se vea antes—. Lo
-- cancelado solo lo ve quien lo creo: para el resto, esa emision nunca existio.
drop policy if exists live_sessions_read on public.live_sessions;
create policy live_sessions_read on public.live_sessions
  for select using (
    status in ('scheduled', 'live', 'ended')
    or host_id = auth.uid()
    or public.is_admin()
  );

-- ESCRITURA: quien emite, sobre lo suyo. La administracion para poder moderar,
-- que en directo significa poder cortar una emision.
drop policy if exists live_sessions_write on public.live_sessions;
create policy live_sessions_write on public.live_sessions
  for all to authenticated
  using (host_id = auth.uid() or public.is_admin())
  with check (host_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- 2. El chat
-- ---------------------------------------------------------------------------
create table if not exists public.live_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- 300 caracteres. Un chat en directo se lee de reojo mientras se mira otra
  -- cosa; un parrafo ahi no lo lee nadie y ademas empuja fuera de pantalla lo
  -- que si estaban leyendo los demas.
  body text not null check (char_length(btrim(body)) between 1 and 300),

  created_at timestamptz not null default now(),

  -- Moderacion: se ESCONDE, no se borra. Borrar deja al moderador sin poder
  -- explicar por que lo hizo, y a quien lo escribio sin saber que paso.
  hidden_at timestamptz,
  hidden_by uuid references public.profiles(id) on delete set null
);

comment on table public.live_messages is
  'Mensajes del chat de una transmision. Se esconden al moderar, nunca se borran.';

-- La consulta es siempre «los ultimos N de ESTA sala».
create index if not exists live_messages_sala_idx
  on public.live_messages (session_id, created_at desc);

alter table public.live_messages enable row level security;

-- LECTURA: si se puede ver la sala, se puede leer su chat. Lo escondido lo ve
-- quien lo escribio —para que no le desaparezca el mensaje sin mas— y quien
-- modera.
drop policy if exists live_messages_read on public.live_messages;
create policy live_messages_read on public.live_messages
  for select using (
    exists (
      select 1 from public.live_sessions s
      where s.id = session_id
        and (
          s.status in ('scheduled', 'live', 'ended')
          or s.host_id = auth.uid()
          or public.is_admin()
        )
    )
    and (
      hidden_at is null
      or user_id = auth.uid()
      or public.is_admin()
      or exists (
        select 1 from public.live_sessions s
        where s.id = session_id and s.host_id = auth.uid()
      )
    )
  );

-- ESCRITURA: solo en NOMBRE PROPIO y solo mientras se emite.
--
-- `user_id = auth.uid()` es lo que impide escribir haciendose pasar por otra
-- persona, que en un chat en directo delante de cien espectadores no es una
-- travesura. Y `status = 'live'` impide llenar de mensajes una sala que aun no
-- ha empezado o que ya termino.
drop policy if exists live_messages_write on public.live_messages;
create policy live_messages_write on public.live_messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.live_sessions s
      where s.id = session_id and s.status = 'live'
    )
    -- Nadie escribe en la sala de alguien que le bloqueo, ni en la de alguien
    -- a quien bloqueo. Es el mismo corte simetrico que en el resto de Z.
    and not exists (
      select 1
      from public.live_sessions s
      join public.user_blocks b
        on (b.blocker_id = s.host_id and b.blocked_id = auth.uid())
        or (b.blocker_id = auth.uid() and b.blocked_id = s.host_id)
      where s.id = session_id
    )
  );

-- MODERAR: esconder un mensaje lo puede hacer quien emite (es su sala) o la
-- administracion. Quien lo escribio NO puede editarlo: un mensaje que cambia
-- despues de leerse convierte el registro del chat en algo que no se puede
-- citar.
drop policy if exists live_messages_moderate on public.live_messages;
create policy live_messages_moderate on public.live_messages
  for update to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.live_sessions s
      where s.id = session_id and s.host_id = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.live_sessions s
      where s.id = session_id and s.host_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Las reacciones
-- ---------------------------------------------------------------------------
-- Aqui NO hay una fila por corazon. Ver la nota de la cabecera: los corazones
-- que flotan viajan por Realtime Broadcast y no tocan la base. Esta tabla
-- guarda solo el TOTAL por tipo, que es lo unico que sobrevive a la emision y
-- lo unico que alguien va a querer mirar despues.
create table if not exists public.live_reaction_totals (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  -- Cinco. Un catalogo corto es lo que hace que la fila de reacciones se lea
  -- de un vistazo; con veinte, elegir cuesta mas que reaccionar.
  kind text not null check (kind in ('corazon', 'aplauso', 'fuego', 'asombro', 'risa')),
  total bigint not null default 0 check (total >= 0),
  updated_at timestamptz not null default now(),
  primary key (session_id, kind)
);

comment on table public.live_reaction_totals is
  'Total acumulado por tipo de reaccion. Las reacciones individuales NO se guardan: viajan por Broadcast.';

alter table public.live_reaction_totals enable row level security;

-- LECTURA: la misma que la sala.
drop policy if exists live_reaction_totals_read on public.live_reaction_totals;
create policy live_reaction_totals_read on public.live_reaction_totals
  for select using (
    exists (
      select 1 from public.live_sessions s
      where s.id = session_id
        and (
          s.status in ('scheduled', 'live', 'ended')
          or s.host_id = auth.uid()
          or public.is_admin()
        )
    )
  );

-- ESCRITURA: NINGUNA por PostgREST, a proposito. No se crea politica de
-- escritura, asi que la RLS deniega por defecto.
--
-- El total lo escribe SOLO el backend, que acota cuanto puede sumar cada
-- peticion. Si el cliente pudiera escribir aqui directamente, «he pulsado el
-- corazon» y «he pulsado el corazon nueve millones de veces» serian la misma
-- peticion, y el contador dejaria de significar nada.

-- ---------------------------------------------------------------------------
-- 4. Realtime
-- ---------------------------------------------------------------------------
-- El chat y el estado de la sala se entregan en vivo, respetando RLS, igual
-- que ya hace la mensajeria privada desde la 0002.
--
-- `live_reaction_totals` NO se publica: su total cambia cada pocos segundos y
-- lo que la pantalla anima son los corazones de Broadcast, no el contador.
-- Publicarla seria una notificacion por flush para redibujar un numero.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'live_messages'
  ) then
    alter publication supabase_realtime add table public.live_messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'live_sessions'
  ) then
    alter publication supabase_realtime add table public.live_sessions;
  end if;
end
$$;

-- PostgREST cachea el esquema; sin esto los cambios tardan en verse.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Comprobacion final. Las tres tablas salen a 0 —nadie ha emitido nada
-- todavia— y TODO lo anterior queda INTACTO.
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.live_sessions)                        as emisiones,
  (select count(*) from public.live_messages)                        as mensajes_de_chat,
  (select count(*) from public.live_reaction_totals)                 as totales_de_reaccion,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'live_sessions')     as politicas_sala,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'live_messages')     as politicas_chat,
  (select count(*) from pg_publication_tables
     where pubname = 'supabase_realtime'
       and tablename in ('live_messages', 'live_sessions'))           as tablas_en_realtime,
  (select count(*) from public.profiles)                             as perfiles_intactos,
  (select count(*) from public.posts)                                as publicaciones_intactas,
  (select count(*) from public.courses)                              as cursos_intactos,
  (select count(*) from public.messages)                             as mensajes_privados_intactos;
-- Esperado: 0, 0, 0, 2, 3, 2, y el resto igual que antes de ejecutar.
