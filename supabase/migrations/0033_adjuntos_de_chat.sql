-- ---------------------------------------------------------------------------
-- 0033 — Adjuntos de chat: fotos, vídeos y documentos dentro de un mensaje.
--
-- QUE HABIA ANTES. El botón «+» de la pantalla de chat no hacía nada: existía
-- el icono y no había nada detrás. La tabla `messages` tenía una columna
-- `attachment_path` de la migración 0001 que NUNCA se ha usado, y que además no
-- vale para lo que hace falta: es UNA ruta, sin tipo, sin nombre de fichero y
-- sin tamaño. Con ella no se puede saber si lo que hay al otro lado es una foto
-- que se pinta, un vídeo que se reproduce o un PDF que se descarga, ni se puede
-- mandar más de un archivo. La columna se deja donde está —quitarla sería una
-- vuelta atrás destructiva, y la regla del proyecto lo prohíbe— pero lo nuevo
-- vive en su propia tabla.
--
-- LO IMPORTANTE DE ESTA MIGRACION ES LA PRIVACIDAD, NO LA TABLA.
--
-- Lo que se manda por un chat privado es privado. El bucket `post-media` NO
-- sirve: su política deja leer a CUALQUIER cuenta autenticada (y desde la 0018,
-- las imágenes y vídeos incluso sin cuenta). Una foto enviada a una sola
-- persona acabaría siendo legible por todo el que tenga la aplicación
-- instalada. Por eso se crea un bucket aparte, `message-media`, donde la
-- política de lectura no pregunta «¿tienes cuenta?» sino «¿eres miembro de ESA
-- conversación?».
--
-- COMO SE CONSIGUE ESO, que es la única decisión de diseño no obvia. Storage
-- solo sabe del NOMBRE del objeto: no puede consultar la tabla de adjuntos para
-- decidir. Así que la pertenencia va escrita en la propia ruta:
--
--     message-media/<id de conversacion>/<id de quien sube>/<fichero>
--
-- La política lee la primera carpeta, comprueba que quien pregunta es miembro
-- de esa conversación, y ya está. La segunda carpeta obliga a que cada persona
-- escriba solo bajo su propio identificador, igual que en los demás buckets.
-- El backend valida la MISMA forma antes de guardar la fila, para que nadie
-- pueda registrar en su conversación un adjunto que apunta a la de otro.
--
-- QUE NO HACE ESTA MIGRACION. No borra nada. No toca `post_media` ni ninguna
-- otra tabla salvo para RELAJAR una restricción (ver el punto 2). No añade
-- ninguna columna a `messages`, a propósito: el backend hace `select` de
-- columnas concretas, pero cualquier `select(Entidad)` de SQLAlchemy pide TODAS
-- las columnas mapeadas, y una columna nueva en una tabla tan usada es la forma
-- más rápida de romper producción mientras la migración espera aprobación.
--
-- El script es REPETIBLE e IDEMPOTENTE: aditivo de principio a fin.
--
-- DESPUES DE APLICARLA, REINICIA LA API. El backend comprueba UNA VEZ por
-- proceso si la tabla `message_attachments` existe —para poder funcionar sin
-- ella mientras esto espera aprobación— y se queda con la respuesta.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. La tabla
-- ---------------------------------------------------------------------------
create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  -- Denormalizado A PROPOSITO. La política RLS de abajo tiene que decidir si
  -- quien pregunta es miembro, y hacerlo desde aquí es una comprobación
  -- directa; a través de `messages` sería un JOIN dentro de una política, que
  -- se evalúa por fila. Además es lo que permite comprobar que la ruta del
  -- fichero y la conversación del mensaje son la MISMA, que es la defensa
  -- contra registrar en un chat un archivo que vive en otro.
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- Ruta dentro del bucket `message-media`, sin el nombre del bucket.
  storage_path text not null,
  -- Tres tipos y no una lista abierta: son los tres que la interfaz sabe
  -- pintar. Un tipo que nadie sabe mostrar es una fila que miente.
  kind text not null check (kind in ('image', 'video', 'document')),
  mime_type text,
  -- El nombre original. Para un documento es lo ÚNICO que lo identifica: la
  -- ruta lleva un nombre aleatorio para que dos personas no se pisen.
  file_name text,
  bytes bigint,
  -- Medidas y duración: con ellas la burbuja reserva su hueco antes de que
  -- llegue la imagen, en vez de dar un salto cuando carga.
  width integer,
  height integer,
  duration_s double precision,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists message_attachments_message_idx
  on public.message_attachments (message_id);

-- Por conversación: es como los busca el listado del historial y como los
-- barrería un borrado de cuenta.
create index if not exists message_attachments_conversation_idx
  on public.message_attachments (conversation_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Un mensaje puede ser SOLO un archivo
--
-- `messages.body` nació con `check (char_length(body) between 1 and 5000)`, así
-- que mandar una foto sin escribir nada era imposible: la fila no entraba. Se
-- relaja el mínimo a cero.
--
-- POR QUE LA REGLA «o texto o archivo» NO ES UNA RESTRICCION DE LA TABLA. Una
-- restricción de columna no puede mirar otra tabla, y el adjunto se inserta
-- DESPUES del mensaje dentro de la misma transacción: en el instante en que se
-- escribe la fila del mensaje todavía no hay adjunto que enseñar. Hacerlo con
-- un trigger diferido complicaría el esquema para volver a comprobar lo que el
-- API ya comprueba y rechaza con un 422 legible. Lo que sí impide la base es lo
-- único que de verdad no puede pasar: un mensaje sin conversación o sin autor.
-- ---------------------------------------------------------------------------
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages
  add constraint messages_body_check check (char_length(body) between 0 and 5000);

-- ---------------------------------------------------------------------------
-- 3. RLS de la tabla
-- ---------------------------------------------------------------------------
alter table public.message_attachments enable row level security;

drop policy if exists message_attachments_read on public.message_attachments;
create policy message_attachments_read on public.message_attachments
  for select using (public.is_conversation_member(conversation_id));

-- Escribir solo en la propia conversación y solo colgando de un mensaje PROPIO:
-- sin la segunda mitad, un miembro podría colgarle un archivo a un mensaje que
-- escribió otra persona.
drop policy if exists message_attachments_insert on public.message_attachments;
create policy message_attachments_insert on public.message_attachments
  for insert with check (
    public.is_conversation_member(conversation_id)
    and exists (
      select 1 from public.messages m
      where m.id = message_id and m.sender_id = auth.uid()
    )
  );

drop policy if exists message_attachments_delete on public.message_attachments;
create policy message_attachments_delete on public.message_attachments
  for delete using (
    exists (
      select 1 from public.messages m
      where m.id = message_id and m.sender_id = auth.uid()
    )
    or public.is_admin()
  );

-- ---------------------------------------------------------------------------
-- 4. El bucket privado
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('message-media', 'message-media', false)
on conflict (id) do nothing;

update storage.buckets
set
  -- 100 MB. Un chat no es el sitio de un vídeo de curso de 2 GB, y un tope
  -- alto en un bucket que nadie modera es una factura esperando a ocurrir.
  file_size_limit = 100::bigint * 1024 * 1024,
  -- Lista explícita y no `null`. `null` admite CUALQUIER tipo, incluidos
  -- ejecutables; esta lista cubre lo que la gente manda de verdad por un chat
  -- —fotos, vídeos, notas de voz, PDF, ofimática, comprimidos— y deja fuera lo
  -- que no tiene ningún motivo para viajar por aquí.
  allowed_mime_types = array[
    'image/*',
    'video/*',
    'audio/*',
    'text/plain',
    'text/csv',
    'application/pdf',
    'application/zip',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
where id = 'message-media';

-- ---------------------------------------------------------------------------
-- 5. Quién puede leer un archivo del bucket
--
-- La comprobación va en una función y no dentro de la política por un motivo
-- concreto: `(storage.foldername(name))[1]::uuid` LANZA si la carpeta no es un
-- uuid válido, y una política que lanza no deniega el acceso, revienta la
-- consulta entera. Bastaría con que alguien subiera `basura/x.jpg` para que
-- listar el bucket dejara de funcionar. Aquí se comprueba la forma primero y se
-- devuelve `false` —que es «no», no un error— cuando no encaja.
-- ---------------------------------------------------------------------------
create or replace function public.es_miembro_de_la_ruta(ruta text)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
declare
  carpeta text := (storage.foldername(ruta))[1];
begin
  if carpeta is null or carpeta !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  return public.is_conversation_member(carpeta::uuid);
end;
$$;

-- Leer: solo los miembros de la conversación que nombra la primera carpeta.
-- `to authenticated` y no `to public`: sin cuenta no hay `auth.uid()`, así que
-- nunca se es miembro de nada. Esto es lo contrario de la 0018, y a propósito.
drop policy if exists message_media_member_read on storage.objects;
create policy message_media_member_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'message-media'
    and public.es_miembro_de_la_ruta(name)
  );

-- Escribir: miembro de la conversación Y bajo la propia carpeta. Sin lo
-- segundo, un miembro podría subir haciéndose pasar por otro.
drop policy if exists message_media_member_write on storage.objects;
create policy message_media_member_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'message-media'
    and public.es_miembro_de_la_ruta(name)
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- Borrar solo lo propio. No hay `update`: un adjunto no se edita, se manda otro.
drop policy if exists message_media_owner_delete on storage.objects;
create policy message_media_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'message-media'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Comprobaciones
-- ---------------------------------------------------------------------------

-- El bucket existe y NO es público.
select id, public, file_size_limit / 1024 / 1024 as limite_mb
from storage.buckets
where id = 'message-media';
-- Esperado: message-media | false | 100

-- Las tres políticas del bucket.
select policyname, cmd
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'message_media%'
order by policyname;
-- Esperado: message_media_member_read (SELECT), message_media_member_write
--           (INSERT), message_media_owner_delete (DELETE)

-- Un mensaje sin texto ya cabe.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.messages'::regclass and conname = 'messages_body_check';
-- Esperado: check ((char_length(body) >= 0) AND (char_length(body) <= 5000))
