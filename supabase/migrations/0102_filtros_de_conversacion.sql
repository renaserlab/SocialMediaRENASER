-- 0102 · Filtros personalizados de una conversación de grupo
--
-- QUÉ RESUELVE (pedido del 09/10/2026). Que quien administra un grupo pueda
-- definir VISTAS de sus mensajes —«Material de estudio», «Anuncios»— además de
-- las categorías automáticas (fotos, vídeos, archivos, audios, enlaces), que no
-- necesitan guardar nada porque salen del tipo de cada mensaje.
--
-- QUÉ HACE. Crea `conversation_filters`: una fila por filtro, con su nombre y
-- sus CRITERIOS. Un filtro es una pregunta guardada, no una lista de mensajes:
-- qué mensajes le pertenecen se calcula al consultarlo, sobre `messages` y
-- `message_attachments`, con los índices que ya existen.
--
-- POR QUÉ NO SE GUARDA QUÉ MENSAJE ESTÁ EN QUÉ FILTRO. Una tabla de
-- pertenencia habría que mantenerla al llegar cada mensaje, al borrarse y cada
-- vez que alguien cambia los criterios (que obligaría a reclasificar el
-- historial entero del grupo). Calculándolo al leer, no hay nada que pueda
-- quedarse viejo: un mensaje nuevo aparece solo, uno borrado desaparece solo,
-- y cambiar los criterios cambia el resultado en la siguiente lectura.
--
-- QUÉ NO HACE.
--   · No toca `conversations`, `conversation_members`, `messages` ni
--     `message_attachments`, ni una sola fila existente. No hay nada que
--     adaptar del historial: los mensajes de antes entran en las vistas igual
--     que los de después.
--   · No copia mensajes ni archivos. Borrar un filtro borra SOLO esta fila.
--   · No entra en la publicación de tiempo real.
--   · No deja leer ni escribir al cliente (ver más abajo).
--
-- LOS CRITERIOS VAN EN `jsonb`, y su forma la valida la API antes de guardar
-- (`messaging/vistas.py`): tipos de contenido, palabras y autores, de listas
-- cerradas y con topes. Aquí solo se exige que sea un objeto. No es texto que
-- se ejecute: la API lo traduce a condiciones con parámetros, nunca a SQL
-- concatenado.
--
-- SEGURIDAD. RLS activada y NINGUNA política: con la clave del cliente no se
-- lee ni se escribe. Quién puede ver los filtros de un grupo (sus miembros) y
-- quién puede cambiarlos (quien lo administra) lo decide la API en cada
-- petición. Una política de lectura para miembros sería fácil de escribir,
-- pero dejaría ver por PostgREST también los filtros desactivados.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
--
-- CÓMO SE DESHACE: `drop table public.conversation_filters;`. No se pierde
-- ningún mensaje: solo las definiciones de los filtros.

create table if not exists public.conversation_filters (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  name text not null,
  description text not null default '',
  icon text not null default 'filter',
  criteria jsonb not null,
  enabled boolean not null default true,
  position integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.conversation_filters
  drop constraint if exists conversation_filters_name_check;
alter table public.conversation_filters
  add constraint conversation_filters_name_check
  check (char_length(btrim(name)) between 1 and 40);

alter table public.conversation_filters
  drop constraint if exists conversation_filters_description_check;
alter table public.conversation_filters
  add constraint conversation_filters_description_check
  check (char_length(description) <= 200);

alter table public.conversation_filters
  drop constraint if exists conversation_filters_icon_check;
alter table public.conversation_filters
  add constraint conversation_filters_icon_check
  check (char_length(icon) between 1 and 32);

alter table public.conversation_filters
  drop constraint if exists conversation_filters_criteria_check;
alter table public.conversation_filters
  add constraint conversation_filters_criteria_check
  check (jsonb_typeof(criteria) = 'object');

-- Dos filtros con el mismo nombre en un grupo no se distinguen en la pantalla.
-- Sin mayúsculas ni espacios de más: «Tareas» y « tareas » son el mismo.
create unique index if not exists conversation_filters_name_uidx
  on public.conversation_filters (conversation_id, lower(btrim(name)));

-- La única lectura que se hace: los filtros de UNA conversación, en su orden.
create index if not exists conversation_filters_conversation_idx
  on public.conversation_filters (conversation_id, position, created_at);

alter table public.conversation_filters enable row level security;

do $$
declare
  con_rls boolean;
  politicas integer;
begin
  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.conversation_filters'::regclass;
  if not coalesce(con_rls, false) then
    raise exception 'La 0102 no ha dejado RLS activada en conversation_filters.';
  end if;

  select count(*) into politicas
  from pg_policies
  where schemaname = 'public'
    and tablename = 'conversation_filters';
  if politicas > 0 then
    raise exception
      'conversation_filters tiene % política(s). No debe tener ninguna: estas '
      'filas solo las lee y las escribe la API.',
      politicas;
  end if;
end
$$;

notify pgrst, 'reload schema';
