-- 0112 · Comunidades en el perfil: cómo se entra a cada una y en el perfil de quién sale
--
-- QUÉ RESUELVE (decidido el 29 y el 30/10/2026,
-- `docs/CONTRATOS_COMUNIDADES_EN_EL_PERFIL.md`). Lo que la aplicación llamaba
-- «grupo» (el chat padre) pasa a llamarse COMUNIDAD, y se piden dos cosas:
--
--   1. Que quien la administra elija CÓMO SE ENTRA: «abierta», de un toque
--      desde su perfil o desde el enlace, o «con solicitud», como hasta hoy.
--   2. Que salir en el perfil sea algo DE CADA PERSONA y no de la comunidad.
--      Hoy solo la enseña quien la creó, pero cuando haya co-administración
--      (spec aparte) cada uno decidirá si sale en el suyo, y no hay que
--      rehacer el ajuste.
--
-- QUÉ HACE.
--
--   · `group_settings.entrada`: `open` o `request`. TODAS LAS QUE YA EXISTEN
--     QUEDAN `request`, que es exactamente como funcionan hoy (D2: «las que
--     ya existen quedan con solicitud»). Abrir una es una decisión de quien la
--     administra, nunca de una migración.
--   · `group_profile_listings`: una fila por (comunidad, persona) que la
--     enseña en su perfil. Es lo que lee `GET /conversations/groups/of/{id}`.
--   · Relleno: una fila (comunidad, quien la creó) por cada una que hoy sale
--     en el perfil (`listed_on_profile = true`). Quien la enseñaba la sigue
--     enseñando, sin tocar nada.
--
-- POR QUÉ `listed_on_profile` NO SE BORRA. La API de esta ronda la sigue
-- escribiendo a la vez que la tabla nueva. Si hay que volver a la API
-- anterior, esa columna dice lo mismo que dice hoy y no se pierde ningún
-- perfil. Se quitará cuando la tabla lleve el tiempo suficiente en uso.
--
-- POR QUÉ UNA TABLA Y NO UNA COLUMNA MÁS. Una columna `listed_on_profile` es
-- UNA por comunidad; con dos personas administrando, la segunda que la quitara
-- de su perfil la quitaría también del de la primera.
--
-- POR QUÉ `user_id` APUNTA A `profiles` y no a `auth.users`. Es lo que hacen
-- `group_join_requests` (0104) y los temas (0108): el perfil se borra con el
-- usuario (0001), así que la fila desaparece igual, y la API lee el perfil.
--
-- BORRAR LA COMUNIDAD BORRA SUS FILAS: la clave ajena es `on delete cascade`,
-- en la misma transacción que borre la conversación. Y si la persona deja de
-- administrarla, su fila se queda pero la API deja de enseñarla: lo que se lee
-- es «filas de comunidades que esa persona administra».
--
-- EL CÓDIGO FUNCIONA SIN ELLA, como con la 0104 o la 0109: la API puede
-- desplegarse antes de pegarla (lo hace la integración continua en cuanto
-- llega a `main`, y esto se pega a mano). Mientras falte, todas las
-- comunidades se leen «con solicitud», el perfil sale de `listed_on_profile`
-- como hasta hoy, y solo cambiar cómo se entra responde 503
-- `group_extras_not_available`. La API lo averigua una vez por proceso
-- (`esquema.hay_comunidades_en_el_perfil`) y, en cuanto se pega, lo ve en
-- menos de un minuto sin reiniciar. La API ANTERIOR funciona igual con ella
-- aplicada: no lee `entrada` ni la tabla nueva, y `listed_on_profile` sigue ahí.
--
-- SEGURIDAD. RLS activada y NINGUNA política en la tabla nueva, como
-- `group_settings` y `group_join_requests`: con la clave del cliente no se lee
-- ni se escribe. Quién enseña qué, y a quién, lo resuelve la API —incluidos
-- los bloqueos, que dejan la lista vacía—. Con una política de lectura,
-- cualquiera podría listar por PostgREST qué comunidades enseña cada persona.
--
-- BLOQUEOS. Añadir la columna y su `CHECK` toma un bloqueo exclusivo de
-- `group_settings` hasta el final de la transacción: con una tabla tan pequeña
-- son milisegundos, pero si algo la está leyendo, la migración espera detrás y
-- todo lo que llega después espera detrás de la migración (el `/info` de cada
-- grupo, por ejemplo). Con `lock_timeout` se rinde a los 5 s, se revierte
-- entera y se puede volver a lanzar.
--
-- SE PEGA ENTERA, COMO UNA SOLA TRANSACCIÓN: es lo que hace el editor de
-- Supabase, y es lo que hace falta para que `set local` valga. Fuera del
-- editor: `psql -1 -f`.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
--
-- La comprobación y la vuelta atrás están al final.

set local lock_timeout = '5s';


-- -----------------------------------------------------------------------------
-- 1. Cómo se entra a cada comunidad
-- -----------------------------------------------------------------------------
-- `not null default 'request'`: en PostgreSQL 11 o posterior, añadir una
-- columna con un valor por defecto constante no reescribe la tabla, y cada fila
-- existente lee 'request'. Una fila de ajustes que se cree después sin decir
-- nada, también.
alter table public.group_settings
  add column if not exists entrada text not null default 'request';

-- El `CHECK` va con nombre y por separado, como en la 0104 y la 0109, para
-- poder volver a declararlo sin error y para que el modelo de la API
-- (`GroupSettings`) lo repita con el mismo nombre.
alter table public.group_settings
  drop constraint if exists group_settings_entrada_check;
alter table public.group_settings
  add constraint group_settings_entrada_check
  check (entrada in ('open', 'request'));


-- -----------------------------------------------------------------------------
-- 2. En el perfil de quién sale cada comunidad
-- -----------------------------------------------------------------------------
-- La clave primaria es lo que hace idempotente «enseñarla en mi perfil» dos
-- veces: el segundo intento no escribe nada.
create table if not exists public.group_profile_listings (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- Lo que se lee: las comunidades que enseña UNA persona (su perfil). La clave
-- primaria empieza por la comunidad y no sirve para eso; y sin este índice,
-- borrar un perfil recorrería la tabla entera buscando sus filas (lo mismo
-- que `conversation_preferences_user_idx` en la 0107).
create index if not exists group_profile_listings_user_idx
  on public.group_profile_listings (user_id);

alter table public.group_profile_listings enable row level security;


-- -----------------------------------------------------------------------------
-- 3. Relleno: quien hoy enseña una comunidad, la sigue enseñando
-- -----------------------------------------------------------------------------
-- Hoy solo puede enseñarla quien la creó (`vistas.administra`), así que la
-- fila es (comunidad, created_by). `kind = 'group'` porque es lo único que
-- puede tener ajustes de grupo. `on conflict do nothing`: pegarla otra vez no
-- duplica ni falla, y una fila que la API ya escribió se queda como está.
insert into public.group_profile_listings (conversation_id, user_id)
select s.conversation_id, c.created_by
from public.group_settings s
join public.conversations c on c.id = s.conversation_id
where s.listed_on_profile
  and c.kind = 'group'
on conflict do nothing;


-- -----------------------------------------------------------------------------
-- 4. Que la tabla nueva quede cerrada: RLS activada y ninguna política
-- -----------------------------------------------------------------------------
do $$
declare
  con_rls boolean;
  politicas integer;
begin
  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.group_profile_listings'::regclass;
  if not coalesce(con_rls, false) then
    raise exception 'La 0112 no ha dejado RLS activada en group_profile_listings.';
  end if;

  select count(*) into politicas
  from pg_policies
  where schemaname = 'public'
    and tablename = 'group_profile_listings';
  if politicas > 0 then
    raise exception
      'group_profile_listings tiene % política(s). No debe tener ninguna: estas '
      'filas solo las lee y las escribe la API.', politicas;
  end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 5. Que PostgREST se entere del cambio de esquema
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';


-- -----------------------------------------------------------------------------
-- 6. Comprobación
-- -----------------------------------------------------------------------------
-- Una fila. Esperado: la columna con su valor por defecto y su `CHECK`, la
-- tabla con RLS y cero políticas, y TANTAS filas en el perfil como
-- comunidades enseñadas había (`en_perfil_antes` = `en_perfil_ahora`).
select
  (select column_default
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'group_settings'
      and column_name = 'entrada') as entrada_por_defecto,
  (select count(*)
     from pg_constraint
    where conrelid = 'public.group_settings'::regclass
      and conname = 'group_settings_entrada_check') as check_de_entrada,
  (select relrowsecurity
     from pg_class
    where oid = 'public.group_profile_listings'::regclass) as rls_activada,
  (select count(*)
     from pg_policies
    where schemaname = 'public'
      and tablename = 'group_profile_listings') as politicas,
  (select count(*)
     from public.group_settings s
     join public.conversations c on c.id = s.conversation_id
    where s.listed_on_profile
      and c.kind = 'group') as en_perfil_antes,
  (select count(*) from public.group_profile_listings) as en_perfil_ahora;


-- -----------------------------------------------------------------------------
-- VERIFICACIÓN A MANO (no se ejecuta sola)
-- -----------------------------------------------------------------------------
-- Ninguna comunidad quedó abierta por la migración (debe salir solo
-- `request`):
--
--   select entrada, count(*) from public.group_settings group by entrada;
--
-- Cada comunidad enseñada tiene su fila, y ninguna fila sobra (las dos
-- consultas deben devolver cero filas):
--
--   select s.conversation_id
--   from public.group_settings s
--   join public.conversations c on c.id = s.conversation_id
--   where s.listed_on_profile and c.kind = 'group'
--     and not exists (
--       select 1 from public.group_profile_listings l
--       where l.conversation_id = s.conversation_id and l.user_id = c.created_by
--     );
--
--   select l.conversation_id, l.user_id
--   from public.group_profile_listings l
--   join public.group_settings s on s.conversation_id = l.conversation_id
--   where not s.listed_on_profile;
--
-- -----------------------------------------------------------------------------
-- VUELTA ATRÁS (rollback)
-- -----------------------------------------------------------------------------
-- Después hay que REINICIAR LA API: `esquema.py` recuerda el «sí» para
-- siempre (una tabla no desaparece sola), y sin reiniciar seguiría pidiendo la
-- tabla y la columna. Reiniciada, lee `listed_on_profile` y trata todas las
-- comunidades como con solicitud. No se pierde ningún mensaje ni ningún
-- miembro, y ningún perfil: esa columna se ha seguido escribiendo. Lo que se
-- pierde es cuáles comunidades eran abiertas (vuelven a ser todas con
-- solicitud, como antes) y la marca por persona.
--
--   drop table if exists public.group_profile_listings;
--   alter table public.group_settings
--     drop constraint if exists group_settings_entrada_check;
--   alter table public.group_settings drop column if exists entrada;
--   notify pgrst, 'reload schema';
