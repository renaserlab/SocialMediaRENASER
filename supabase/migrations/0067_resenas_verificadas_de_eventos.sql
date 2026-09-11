-- 0067 · Reseñas de evento con asistencia verificada, y la respuesta del
--        organizador.
--
-- SIN APLICAR.
--
-- EL SELLO NO ES UNA COLUMNA QUE ALGUIEN PUEDA ESCRIBIR. «Asistencia
-- verificada» se DERIVA de un check-in correcto, y la clave ajena a
-- `event_checkins` es lo que lo impone: una reseña existe porque hay una fila
-- de acceso que dice que esa persona entró. No hay ningún booleano editable.
--
-- Lo que sí se guarda es el identificador de ESE check-in, para poder
-- reconstruir después por qué una reseña lleva el sello. Y como el índice único
-- parcial de la 0062 garantiza un solo check-in correcto por entrada, ese
-- identificador no se puede reutilizar para colar una segunda reseña.
--
-- CINCO EJES, ENTEROS DE 1 A 5. Son los del blueprint: contenido,
-- organización, recinto, seguridad y valor. Y una puntuación general aparte,
-- que responde a otra pregunta —«¿entregó lo que anunció?»— y por eso no es su
-- media: calcularla obligaría a decidir cuánto pesa cada eje, y eso no lo ha
-- decidido nadie.
--
-- UNA RESEÑA POR PERSONA Y EVENTO. Restricción única, no un `if`.
--
-- MODERAR ES ESCONDER, NO BORRAR. `status` pasa a `hidden` y la fila se queda:
-- borrarla dejaría a la persona sin saber qué pasó con lo que escribió, y al
-- histórico sin poder explicarse.
--
-- LA RESPUESTA DEL ORGANIZADOR NACE APAGADA. La tabla existe; publicarla exige
-- una política `organizer_reply` que nadie ha aprobado, y sin ella el servicio
-- se niega. Una sola respuesta VISIBLE por reseña, por índice parcial: varias
-- serían una forma de hostigar a quien opinó.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE. Esquema antes que código: dos tablas
-- vacías que nadie lee. Código antes que esquema: las rutas responden 503
-- `event_reviews_not_available` y la ficha del evento no enseña ninguna sección
-- de reseñas.
--
-- BACKFILL: NINGUNO, y se comprueba. No hay reseñas de evento anteriores: no
-- existía dónde guardarlas.
--
-- ROLLBACK: `drop table` de las dos, en orden inverso. No se toca ninguna tabla
-- existente.

-- ------------------------------------------------------------------------- --
-- 1. La reseña.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_reviews (
  id uuid primary key default gen_random_uuid(),

  event_id uuid not null references public.events(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,

  -- LA PRUEBA DE QUE ENTRÓ. Sin esta fila no hay reseña: el sello se deriva de
  -- aquí y no de un campo que alguien pueda escribir.
  checkin_id uuid not null references public.event_checkins(id) on delete restrict,
  ticket_id uuid not null references public.event_tickets(id) on delete restrict,

  -- «¿El evento entregó lo que anunció?». NO es la media de los ejes: es otra
  -- pregunta, y promediarlos exigiría decidir cuánto pesa cada uno.
  overall smallint not null
    constraint event_reviews_general check (overall between 1 and 5),

  -- Los cinco ejes del blueprint. Opcionales: quien solo quiera responder la
  -- pregunta general no se queda sin poder opinar.
  content smallint
    constraint event_reviews_contenido check (content is null or content between 1 and 5),
  organization smallint
    constraint event_reviews_organizacion
    check (organization is null or organization between 1 and 5),
  venue smallint
    constraint event_reviews_recinto check (venue is null or venue between 1 and 5),
  safety smallint
    constraint event_reviews_seguridad check (safety is null or safety between 1 and 5),
  value smallint
    constraint event_reviews_valor check (value is null or value between 1 and 5),

  -- «¿Lo recomendarías?». Nulo = no contestó. No se deduce de la puntuación.
  recommends boolean,

  comment text
    constraint event_reviews_comentario
    check (comment is null or length(comment) <= 1000),

  status text not null default 'visible'
    constraint event_reviews_estado check (status in ('visible', 'hidden')),
  -- Por qué se escondió. Interno: no sale en ninguna respuesta pública.
  moderation_reason text
    constraint event_reviews_motivo_moderacion
    check (moderation_reason is null or length(moderation_reason) <= 500),
  moderated_by uuid references public.profiles(id) on delete set null,
  moderated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- UNA POR PERSONA Y EVENTO.
  constraint event_reviews_una_por_persona unique (event_id, author_id),
  -- Y UNA POR CHECK-IN: el identificador del acceso no se reutiliza para colar
  -- una segunda reseña.
  constraint event_reviews_un_acceso unique (checkin_id),

  constraint event_reviews_escondida_con_fecha
    check ((status = 'hidden') = (moderated_at is not null))
);

create index if not exists event_reviews_del_evento
  on public.event_reviews (event_id, created_at desc, id desc)
  where status = 'visible';

create index if not exists event_reviews_de_la_persona
  on public.event_reviews (author_id, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 2. La respuesta del organizador. NACE APAGADA.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_review_replies (
  id uuid primary key default gen_random_uuid(),

  review_id uuid not null references public.event_reviews(id) on delete cascade,
  -- Quién respondió. Se comprueba contra el organizador del evento en el
  -- servicio; aquí queda constancia de quién escribió.
  author_id uuid not null references public.profiles(id) on delete cascade,

  body text not null
    constraint event_review_replies_texto
    check (length(trim(body)) between 1 and 1000),

  status text not null default 'draft'
    constraint event_review_replies_estado
    check (status in ('draft', 'visible', 'hidden')),

  moderation_reason text
    constraint event_review_replies_motivo
    check (moderation_reason is null or length(moderation_reason) <= 500),
  moderated_by uuid references public.profiles(id) on delete set null,
  moderated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- UNA RESPUESTA VISIBLE POR RESEÑA. Varias serían una forma de hostigar a quien
-- opinó; los borradores y las escondidas conviven en el histórico.
create unique index if not exists event_review_replies_una_visible
  on public.event_review_replies (review_id)
  where status = 'visible';

create index if not exists event_review_replies_de_la_resena
  on public.event_review_replies (review_id, created_at desc, id desc);

-- ------------------------------------------------------------------------- --
-- 3. El historial de moderación. SOLO AÑADIR.
-- ------------------------------------------------------------------------- --
create table if not exists public.event_review_moderation (
  id uuid primary key default gen_random_uuid(),
  review_id uuid references public.event_reviews(id) on delete cascade,
  reply_id uuid references public.event_review_replies(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  from_status text,
  to_status text not null,
  reason text
    constraint event_review_moderation_motivo
    check (reason is null or length(reason) <= 500),
  created_at timestamptz not null default now(),

  -- Una fila habla de una reseña O de una respuesta, nunca de las dos ni de
  -- ninguna: si no, no se sabe qué se moderó.
  constraint event_review_moderation_de_algo
    check ((review_id is null) <> (reply_id is null))
);

create index if not exists event_review_moderation_de_la_resena
  on public.event_review_moderation (review_id, created_at);

create or replace function public.event_review_moderation_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'El historial de moderación no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists event_review_moderation_inmutable
  on public.event_review_moderation;
create trigger event_review_moderation_inmutable
before update or delete on public.event_review_moderation
for each row execute function public.event_review_moderation_solo_anadir();

-- ------------------------------------------------------------------------- --
-- 4. RLS y permisos: cerrado. El móvil pregunta por la API.
--
-- Una reseña es pública, pero quién la escribió y con qué entrada no lo es.
-- Una política `for select` sobre esta tabla pondría `ticket_id` y `checkin_id`
-- —que atan a una persona con un acceso concreto— a un `select` de distancia
-- desde el teléfono.
-- ------------------------------------------------------------------------- --
alter table public.event_reviews enable row level security;
alter table public.event_review_replies enable row level security;
alter table public.event_review_moderation enable row level security;

revoke all on public.event_reviews from anon, authenticated;
revoke all on public.event_review_replies from anon, authenticated;
revoke all on public.event_review_moderation from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 5. Verificación posterior.
-- ------------------------------------------------------------------------- --
do $$
declare
  cuantas bigint;
  permisos bigint;
begin
  select
      (select count(*) from public.event_reviews)
    + (select count(*) from public.event_review_replies)
    + (select count(*) from public.event_review_moderation)
  into cuantas;
  if cuantas > 0 then
    raise exception 'La 0067 no escribe ninguna fila y hay %', cuantas;
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'event_reviews'
      and c.conname = 'event_reviews_una_por_persona'
  ) then
    raise exception 'La 0067 no dejó la restricción de una reseña por persona';
  end if;

  -- EL SELLO SE DERIVA. Si esta clave ajena no está, «asistencia verificada»
  -- vuelve a ser algo que alguien puede escribir a mano.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_class d on d.oid = c.confrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'event_reviews'
      and d.relname = 'event_checkins' and c.contype = 'f'
  ) then
    raise exception 'La 0067 no ató la reseña a su check-in';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'event_review_replies_una_visible'
  ) then
    raise exception 'La 0067 no dejó el índice de una respuesta visible';
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in (
       'event_reviews', 'event_review_replies', 'event_review_moderation'
     )
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Las reseñas tienen % permisos sueltos', permisos;
  end if;
end;
$$;
