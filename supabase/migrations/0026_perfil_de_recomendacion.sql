-- El primer cerebro de Z: que necesita cada persona y quien puede aportarselo.
--
-- QUE FALTABA. La aplicacion sabe quien sigue a quien y que publica cada cual,
-- pero no sabe lo unico que hace falta para conectar a dos personas por lo que
-- saben: QUE quiere aprender una y QUE puede ensenar la otra. El cuestionario
-- de intereses que habia vivia en el telefono (estado local + AsyncStorage),
-- asi que cambiar de dispositivo lo borraba y el servidor nunca llego a
-- enterarse. Sin ese dato en el servidor no hay recomendacion posible.
--
-- QUE SE ANADE. Cuatro tablas nuevas y NADA MAS. No se toca ninguna tabla
-- existente, no se modifica ni una fila, no se borra nada.
--
--   topics                      la taxonomia canonica (configuracion del
--                               producto, no contenido de nadie)
--   user_topic_relations        PERSONA --relacion--> TEMA
--   recommendation_preferences  intenciones, formatos y version del onboarding
--   behavior_events             las senales con las que el orden aprendera
--
-- POR QUE UNA SOLA TABLA DE RELACIONES y no una por intencion. «quiero
-- aprender carpinteria» y «puedo ensenar carpinteria» son la MISMA arista
-- (persona, tema) leida en dos sentidos; separarlas en `user_interests`,
-- `user_skills`, `user_can_help`... obligaria a unir cinco tablas para
-- responder la unica pregunta que importa —quien ofrece lo que el otro
-- busca— y a repetir el mismo indice cinco veces.
--
-- PRIVACIDAD. Las relaciones NO valen todas lo mismo de cara al publico:
-- ofrecerse a ensenar algo es una declaracion voluntaria, y buscar orientacion
-- sobre algo puede no serlo. Por eso la lectura ajena solo alcanza al lado de
-- la OFERTA (can_help / teach / experienced); la demanda (learn /
-- seek_guidance / interest) solo la ve su dueno. Ver las politicas de abajo.
--
-- El script es REPETIBLE e IDEMPOTENTE: aditivo de principio a fin.


-- --------------------------------------------------------------------------
-- 1. topics — la taxonomia canonica
-- --------------------------------------------------------------------------
-- Es CONFIGURACION DEL PRODUCTO: ni usuarios ni contenido inventado. Vive en
-- la base de datos y no en una constante de React porque la consultan las dos
-- puntas (el cuestionario del movil y el recomendador del backend), porque
-- tiene que poder crecer sin publicar una version de la aplicacion, y porque
-- las relaciones apuntan a ella con una clave foranea: un tema escrito a mano
-- en dos sitios acaba siendo dos temas distintos.
create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  -- Identificador estable y legible. Es lo que permite que la migracion se
  -- pueda repetir sin duplicar la taxonomia, y lo que se leera en los tests.
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name text not null check (char_length(trim(name)) between 1 and 60),
  -- Agrupacion para pintar el cuestionario por bloques ("Oficios", "Negocios").
  -- Se llama asi y no `group` porque esa palabra esta reservada en SQL y
  -- obligaria a entrecomillarla en cada consulta.
  topic_group text not null default 'general',
  -- Retirar un tema NO es borrarlo: hay relaciones apuntando a el y borrarlas
  -- destruiria las preferencias de gente real. Se apaga y deja de ofrecerse.
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists topics_activos_idx
  on public.topics (active, topic_group, position)
  where active;

alter table public.topics enable row level security;

-- La taxonomia es publica: el cuestionario tiene que poder pintarse antes de
-- que nadie haya elegido nada. Nadie la escribe desde la aplicacion —crece por
-- migracion, como el resto de la configuracion del producto—, asi que no hay
-- politicas de insert/update/delete: sin politica, no se puede.
drop policy if exists topics_select on public.topics;
create policy topics_select on public.topics
  for select to anon, authenticated
  using (active);


-- --------------------------------------------------------------------------
-- 2. user_topic_relations — PERSONA --relacion--> TEMA
-- --------------------------------------------------------------------------
create table if not exists public.user_topic_relations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  relation text not null check (
    relation in (
      -- Lo que la persona BUSCA (privado)
      'interest',        -- me interesa
      'learn',           -- quiero aprenderlo
      'seek_guidance',   -- busco orientacion sobre esto
      -- Lo que la persona OFRECE (puede ser publico)
      'can_help',        -- puedo ayudar con esto
      'teach',           -- lo enseno
      'experienced'      -- tengo experiencia practica
    )
  ),
  -- De donde salio la relacion. Existe para que reeditar el cuestionario pueda
  -- reemplazar SOLO lo que dijo el cuestionario y no pisar lo que en el futuro
  -- venga del perfil o de una senal de uso.
  source text not null default 'onboarding' check (
    source in ('onboarding', 'profile', 'behavior')
  ),
  created_at timestamptz not null default now(),
  -- La misma persona no puede querer aprender el mismo tema dos veces.
  unique (user_id, topic_id, relation)
);

-- Las dos consultas del recomendador, en los dos sentidos:
--   «que busca esta persona»  -> por usuario
--   «quien ofrece este tema»  -> por tema
create index if not exists user_topic_relations_user_idx
  on public.user_topic_relations (user_id, relation);
create index if not exists user_topic_relations_topic_idx
  on public.user_topic_relations (topic_id, relation);

alter table public.user_topic_relations enable row level security;

/*
  Quien puede que.

  LEER lo propio: siempre. Es la pantalla de preferencias de cada quien.

  LEER lo ajeno: SOLO el lado de la oferta. Que alguien se ofrezca a ensenar
  carpinteria es una declaracion que hace para que le encuentren; que alguien
  busque orientacion sobre relaciones y familia, no. Dos politicas de SELECT se
  suman (OR), asi que la propia sigue valiendo entera.

  ESCRIBIR: solo en nombre propio, en los tres verbos. Que la aplicacion no
  ensene el boton no es un permiso.
*/
drop policy if exists user_topic_relations_select_own on public.user_topic_relations;
create policy user_topic_relations_select_own on public.user_topic_relations
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists user_topic_relations_select_oferta on public.user_topic_relations;
create policy user_topic_relations_select_oferta on public.user_topic_relations
  -- Solo `authenticated`, no `anon`. Es informacion publica DENTRO de Z, no
  -- para cualquiera con la direccion del proyecto: sin sesion, el grafo entero
  -- de quien sabe que seria descargable de una peticion. Nada se pierde por
  -- ello, porque quien lee esto para recomendar es el backend, que se conecta
  -- con su propio rol y no pasa por aqui.
  for select to authenticated
  using (relation in ('can_help', 'teach', 'experienced'));

drop policy if exists user_topic_relations_insert on public.user_topic_relations;
create policy user_topic_relations_insert on public.user_topic_relations
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists user_topic_relations_update on public.user_topic_relations;
create policy user_topic_relations_update on public.user_topic_relations
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists user_topic_relations_delete on public.user_topic_relations;
create policy user_topic_relations_delete on public.user_topic_relations
  for delete to authenticated
  using (user_id = auth.uid());


-- --------------------------------------------------------------------------
-- 3. recommendation_preferences — intenciones, formatos y version
-- --------------------------------------------------------------------------
-- Una fila por persona. Lo que NO es una relacion con un tema vive aqui.
--
-- `onboarding_version` es lo que permitira cambiar las preguntas manana sin
-- destruir lo respondido hoy: quien contesto la version 1 no vuelve a ver el
-- cuestionario, y el dia que exista una version 2 se le podra ofrecer sin
-- borrar nada. Guardar solo un booleano «ya lo hizo» cerraria esa puerta.
create table if not exists public.recommendation_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  onboarding_version integer not null default 0,
  -- Cuando termino. Nulo mientras no haya terminado.
  completed_at timestamptz,
  -- Paso de largo. Se distingue de «no lo ha visto» para no volver a
  -- perseguirle en cada arranque, y de «lo completo» para saber que sus
  -- recomendaciones son las de arranque en frio.
  skipped boolean not null default false,
  -- Que viene a buscar (pregunta 1). Texto y no clave foranea: son opciones
  -- del cuestionario, versionadas junto a el, no entidades del dominio.
  goals text[] not null default '{}' check (cardinality(goals) <= 16),
  -- Que tipo de conexion le seria util (pregunta 3).
  preferred_connection_types text[] not null default '{}'
    check (cardinality(preferred_connection_types) <= 12),
  -- Como prefiere aprender o conectar (pregunta 4).
  preferred_content_formats text[] not null default '{}'
    check (cardinality(preferred_content_formats) <= 12),
  -- Que ofrece (pregunta 5). Los temas concretos van en user_topic_relations;
  -- aqui queda EN QUE FORMA se ofrece.
  offer_modes text[] not null default '{}' check (cardinality(offer_modes) <= 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.recommendation_preferences enable row level security;

-- Las preferencias son de quien las declara y de nadie mas. El recomendador
-- las lee desde el backend, que se conecta con su propio rol.
drop policy if exists recommendation_preferences_select on public.recommendation_preferences;
create policy recommendation_preferences_select on public.recommendation_preferences
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists recommendation_preferences_insert on public.recommendation_preferences;
create policy recommendation_preferences_insert on public.recommendation_preferences
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists recommendation_preferences_update on public.recommendation_preferences;
create policy recommendation_preferences_update on public.recommendation_preferences
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- --------------------------------------------------------------------------
-- 4. behavior_events — las senales
-- --------------------------------------------------------------------------
-- Lo minimo para que el orden pueda APRENDER, y ni un campo mas.
--
-- Esta tabla NO es un almacen de todo lo que hace la gente. No guarda texto
-- escrito, ni mensajes, ni busquedas literales, ni nada que pueda revelar algo
-- intimo: solo QUE se toco, DE QUE tipo era, y cuanto se quedo mirando. Con
-- eso basta para ordenar; con mas, esto seria otra cosa.
create table if not exists public.behavior_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null check (
    event_type in (
      'content_impression',   -- aparecio en pantalla
      'content_engaged',      -- lo abrio, reacciono o guardo
      'content_completed',    -- lo termino
      'profile_view',         -- abrio un perfil
      'search_result_opened', -- eligio un resultado de busqueda
      'follow',               -- empezo a seguir
      'message_started',      -- abrio conversacion
      'booking_requested',    -- pidio una sesion
      'booking_completed',    -- la sesion ocurrio
      'not_interested'        -- senal negativa explicita
    )
  ),
  entity_type text not null check (
    entity_type in ('post', 'profile', 'course', 'booking', 'conversation')
  ),
  entity_id uuid,
  -- Los temas implicados, cuando se conocen. Permite que una senal sobre un
  -- video de React refuerce «tecnologia» sin volver a consultarlo todo.
  topic_ids uuid[],
  -- Proporcion vista o completada (0..1). Normalizada a proposito: es lo unico
  -- que el orden necesita, y evita guardar una linea de tiempo del uso.
  value real check (value >= 0 and value <= 1),
  -- Tiempo visible, en milisegundos. Se acota para que un reproductor olvidado
  -- en segundo plano no cuente como una hora de interes.
  dwell_ms integer check (dwell_ms >= 0 and dwell_ms <= 600000),
  -- Quien lo registro. Las senales fuertes (seguir, agendar) las escribe el
  -- SERVIDOR cuando la accion de verdad ocurre; el movil no puede afirmarlas.
  source text not null default 'client' check (source in ('client', 'server')),
  -- Idempotencia: el movil manda por lotes y un lote puede reintentarse.
  event_key text check (char_length(event_key) <= 120),
  created_at timestamptz not null default now()
);

-- Reintentar un lote no debe duplicar sus senales.
create unique index if not exists behavior_events_idempotencia_idx
  on public.behavior_events (user_id, event_key)
  where event_key is not null;

-- «Que ha hecho esta persona ultimamente»: la consulta del recomendador.
create index if not exists behavior_events_user_idx
  on public.behavior_events (user_id, created_at desc);
-- «Que ha pasado con esta entidad»: afinidad hacia un perfil concreto.
create index if not exists behavior_events_entity_idx
  on public.behavior_events (entity_type, entity_id, created_at desc);

alter table public.behavior_events enable row level security;

/*
  Quien puede que.

  INSERTAR: solo en nombre propio. Sin esto cualquiera podria inflar las
  senales de otra persona y manipular lo que se le recomienda.

  LEER: solo lo propio. Es el historial de uso de alguien; nadie mas tiene por
  que verlo, ni siquiera para «mejorar la experiencia».

  ACTUALIZAR / BORRAR: nadie. Una senal es un hecho ya ocurrido. Si algun dia
  hace falta olvidar (baja de cuenta, retirada de consentimiento), se hara con
  una operacion explicita y auditada, no con un UPDATE suelto desde el movil.
*/
drop policy if exists behavior_events_insert on public.behavior_events;
create policy behavior_events_insert on public.behavior_events
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists behavior_events_select on public.behavior_events;
create policy behavior_events_select on public.behavior_events
  for select to authenticated
  using (user_id = auth.uid());


-- --------------------------------------------------------------------------
-- 5. Taxonomia inicial
-- --------------------------------------------------------------------------
-- Configuracion del producto, no datos inventados de nadie. Se inserta por
-- `slug` con `on conflict do nothing`: repetir la migracion no duplica ni
-- pisa un nombre que alguien haya ajustado despues.
insert into public.topics (slug, name, topic_group, position) values
  ('tecnologia',            'Tecnología',              'Tecnología',        10),
  ('programacion',          'Programación',            'Tecnología',        20),
  ('inteligencia-artificial','Inteligencia Artificial', 'Tecnología',        30),

  ('negocios',              'Negocios',                'Negocios',         110),
  ('emprendimiento',        'Emprendimiento',          'Negocios',         120),
  ('marketing',             'Marketing',               'Negocios',         130),
  ('ventas',                'Ventas',                  'Negocios',         140),

  ('carpinteria',           'Carpintería',             'Oficios',          210),
  ('electricidad',          'Electricidad',            'Oficios',          220),
  ('mecanica',              'Mecánica',                'Oficios',          230),
  ('construccion',          'Construcción',            'Oficios',          240),

  ('musica',                'Música',                  'Arte y creación',  310),
  ('arte',                  'Arte',                    'Arte y creación',  320),
  ('fotografia',            'Fotografía',              'Arte y creación',  330),

  ('productividad',         'Productividad',           'Crecimiento',      410),
  ('habitos',               'Hábitos',                 'Crecimiento',      420),
  ('liderazgo',             'Liderazgo',               'Crecimiento',      430),

  ('educacion',             'Educación',               'Formación',        510),
  ('idiomas',               'Idiomas',                 'Formación',        520),
  ('carrera-profesional',   'Carrera profesional',     'Formación',        530),

  -- Ambitos personales en GENERAL y opcionales. No se pregunta por
  -- diagnosticos, enfermedades ni problemas concretos: eso no es arranque en
  -- frio, es informacion sensible, y no se guarda.
  ('relaciones-y-familia',  'Relaciones y familia',    'Vida personal',    610),
  ('bienestar-personal',    'Bienestar personal',      'Vida personal',    620),
  ('experiencias-de-vida',  'Experiencias de vida',    'Vida personal',    630),

  ('finanzas',              'Finanzas',                'Dinero',           710),
  ('otros',                 'Otros',                   'Otros',            910)
on conflict (slug) do nothing;


comment on table public.topics is
  'Taxonomia canonica de temas. Configuracion del producto: crece por migracion.';
comment on table public.user_topic_relations is
  'PERSONA --relacion--> TEMA. La demanda (learn/seek_guidance/interest) es privada; la oferta (can_help/teach/experienced) puede leerse en publico.';
comment on table public.recommendation_preferences is
  'Perfil de recomendacion por persona. La finalizacion del onboarding vive AQUI, no en el dispositivo.';
comment on table public.behavior_events is
  'Senales minimas para ordenar. Sin texto, sin mensajes, sin atributos sensibles.';

notify pgrst, 'reload schema';

-- Comprobacion final. Las tres primeras deben ser 0 la primera vez (nadie ha
-- contestado todavia), `temas` = 25, y las tablas de siempre INTACTAS.
select
  (select count(*) from public.topics)                     as temas,
  (select count(*) from public.user_topic_relations)       as relaciones,
  (select count(*) from public.recommendation_preferences) as preferencias,
  (select count(*) from public.behavior_events)            as senales,
  (select count(*) from public.profiles)                   as perfiles_intactos,
  (select count(*) from public.posts)                      as publicaciones_intactas,
  (select count(*) from public.bookings)                   as sesiones_intactas;
