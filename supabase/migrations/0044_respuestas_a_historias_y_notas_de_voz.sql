-- ---------------------------------------------------------------------------
-- 0044 — Responder una historia desde el visor, y notas de voz en el chat.
--
-- ESTA MIGRACIÓN ESTÁ APLICADA en producción (31 de agosto de 2026, confirmado
-- por quien la ejecutó). Y como el bloque `do $$` del final comprueba contra
-- `pg_constraint` que no quede ninguna restricción de `kind` que rechace los
-- audios, que haya terminado sin error demuestra por sí solo que el `CHECK` se
-- reemplazó por el bueno: era el único fallo que podía pasar en silencio.
--
-- DOS COSAS Y NADA MÁS. Una tabla nueva (`message_story_context`) y UNA
-- restricción relajada (`message_attachments.kind` pasa a admitir `'audio'`).
-- No se crean columnas en `messages`, no se borra nada, no se modifica ninguna
-- fila existente. El script es REPETIBLE e IDEMPOTENTE de principio a fin.
--
-- ===========================================================================
-- PARTE 1 — POR QUÉ EL CONTEXTO DE LA HISTORIA VIVE EN SU PROPIA TABLA
-- ===========================================================================
--
-- Responder una historia produce un mensaje NORMAL: viaja por Realtime, cuenta
-- como no leído, se puede borrar y se pagina igual que los demás. Lo único que
-- lo distingue es que sabe a qué historia contestaba. Ese dato NO puede ser una
-- columna de `messages`:
--
--   - `select(Entidad)` de SQLAlchemy pide TODAS las columnas mapeadas. Una
--     columna nueva en la tabla más consultada de la aplicación rompe
--     producción en el instante en que el modelo se despliega antes que la
--     migración. Es exactamente lo que ya obligó a sacar los adjuntos a
--     `message_attachments` (0033) y la pareja directa a
--     `direct_conversation_pairs` (0039).
--   - Una tabla aparte solo se consulta cuando existe, y quien lo comprueba es
--     `messaging/esquema.py`. Sin esta migración, el chat funciona hoy igual
--     que ayer.
--
-- Y POR QUÉ NO SE GUARDA LA URL DE LA HISTORIA DENTRO DEL TEXTO. Porque el
-- texto es de quien escribe. Metiendo ahí un enlace se pierde poder distinguir
-- una respuesta de verdad de alguien que pegó un enlace a mano, la bandeja no
-- puede filtrar «Respuestas a historias» sin buscar cadenas dentro de los
-- mensajes de todo el mundo, y el día que la historia caduque el mensaje se
-- queda con un enlace muerto en medio de la frase. El contexto es estructura,
-- no decoración del cuerpo.
--
-- LO MÁS IMPORTANTE DE ESTA TABLA: `story_id` ES ANULABLE Y VA CON
-- `ON DELETE SET NULL`.
--
-- Una historia dura un día. El mensaje que la responde dura para siempre. Si la
-- clave ajena fuera `on delete cascade`, borrar una historia —o el barrido de
-- las caducadas— se llevaría por delante el contexto, y con `not null` ni
-- siquiera se podría guardar la fila sin la historia. Con `set null` el mensaje
-- sobrevive intacto y la burbuja pinta un contexto degradado: «Historia no
-- disponible». Que el chat no se rompa cuando la historia desaparece no es un
-- detalle de presentación, es el caso NORMAL: al día siguiente, todas.
--
-- Y por eso `story_owner_id` es `not null` y se conserva aunque `story_id` se
-- quede en nulo: sin él, una vez caducada la historia, el mensaje no podría ni
-- decir de quién era. «Respondiste a la historia de Ana» se sigue pudiendo
-- escribir; «respondiste a una historia» a secas, no.
--
-- ===========================================================================
-- PARTE 2 — EL PUNTO DELICADO: EL `CHECK` DE `message_attachments.kind`
-- ===========================================================================
--
-- Hoy la restricción admite ('image', 'video', 'document') y tiene que admitir
-- además 'audio'. Guardar una nota de voz como `document` para no tocar el
-- `CHECK` sería el parche que este trabajo prohíbe expresamente: la interfaz no
-- sabría que eso se reproduce, `duration_s` no significaría nada, y el día que
-- alguien quisiera contarlas no habría forma de distinguirlas de un PDF.
--
-- EL NOMBRE DE LA RESTRICCIÓN NO SE INVENTA: ES `message_attachments_kind_check`.
--
-- De dónde sale. En la 0033 el `check` se declaró DENTRO de la columna:
--
--     kind text not null check (kind in ('image', 'video', 'document')),
--
-- Una restricción de columna sin nombre explícito la bautiza PostgreSQL como
-- `<tabla>_<columna>_check`. Es la misma deducción que ya se aplicó en la 0033
-- con `messages_body_check` (declarado igual en la 0001) y en la 0042 con
-- `stories_duration_ms_check`, y en las dos ocasiones fue la correcta.
--
-- POR QUÉ IMPORTA TANTO ACERTAR. `drop constraint if exists` con el nombre
-- equivocado NO FALLA: el `if exists` se lo traga en silencio y la restricción
-- vieja se queda puesta. A partir de ahí pasa una de dos, y las dos son malas:
-- o el `add constraint` choca contra el nombre que ya existe y la migración
-- revienta, o —peor— el nombre nuevo es distinto, el `add` funciona, y la
-- restricción VIEJA sigue ahí rechazando cada nota de voz. Eso último no da la
-- cara al aplicar la migración: da la cara semanas después, en producción, como
-- un 500 al enviar un audio que en el navegador aparece disfrazado de error de
-- CORS.
--
-- Por eso, después del `add`, este fichero COMPRUEBA con `pg_constraint` que no
-- ha quedado ninguna restricción sobre `kind` que rechace los audios, y aborta
-- si la hay. Es una comprobación activa, no un comentario: la única forma de
-- que el fallo silencioso no pueda ocurrir es que la migración se niegue a
-- terminar cuando ocurre.
--
-- REVALIDACIÓN. Al reponer la restricción, PostgreSQL revalida la tabla entera.
-- Es seguro —los valores existentes son los tres de siempre, y siguen dentro de
-- la lista nueva, que solo AÑADE— pero conviene saberlo: en una tabla grande el
-- `alter` no es instantáneo.
--
-- EL BUCKET NO SE TOCA. `message-media` ya admite 'audio/*' en sus
-- `allowed_mime_types` desde la 0033, y sus políticas de lectura y escritura
-- son por pertenencia a la conversación, que es lo mismo que necesita una nota
-- de voz. No hay nada que cambiar ahí, y no cambiarlo es lo correcto: cada
-- política que se reescribe es una oportunidad de abrir un bucket privado.
--
-- LA DURACIÓN YA TIENE COLUMNA. `message_attachments.duration_s` existe desde
-- la 0033. Una nota de voz la usa igual que un vídeo; no hace falta ninguna
-- columna nueva.
--
-- ===========================================================================
-- DESPUÉS DE APLICARLA, REINICIA LA API.
-- ===========================================================================
--
-- `messaging/esquema.py` comprueba UNA VEZ POR PROCESO qué tablas existen y se
-- queda con la respuesta —preguntarlo en cada petición costaría un viaje a la
-- base por mensaje—. Mientras el proceso siga vivo con el «no» de antes, el
-- botón de grabar seguirá sin ofrecerse y responder una historia seguirá
-- guardando el mensaje sin su contexto.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. El contexto de historia de un mensaje
-- ---------------------------------------------------------------------------
create table if not exists public.message_story_context (
  -- Clave primaria Y clave ajena a la vez: un mensaje responde a UNA historia,
  -- o a ninguna. No hace falta un identificador propio, y sin él es imposible
  -- que existan dos contextos contradictorios para el mismo mensaje.
  message_id uuid primary key references public.messages(id) on delete cascade,
  -- ANULABLE Y `SET NULL` A PROPÓSITO. Ver la cabecera: la historia dura un
  -- día, el mensaje dura para siempre. Cuando la historia desaparece esto se
  -- queda en nulo y la burbuja enseña «Historia no disponible».
  story_id uuid references public.stories(id) on delete set null,
  -- `NOT NULL` justo por lo anterior: es lo único que sigue sabiendo de quién
  -- era la historia una vez que ya no existe.
  story_owner_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Todas las respuestas a UNA historia. Lo pide el autor al ver su historia y lo
-- necesita el `on delete set null`: sin este índice, borrar una historia
-- obligaría a recorrer la tabla entera para poner los nulos.
create index if not exists message_story_context_story_idx
  on public.message_story_context (story_id);

-- Por dueño de la historia. Es lo que hace barato el `cascade` al borrar una
-- cuenta, y lo que permite contar cuántas respuestas ha recibido alguien sin
-- pasar por `stories` —que para entonces puede estar ya vacía—.
create index if not exists message_story_context_owner_idx
  on public.message_story_context (story_owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. RLS del contexto
--
-- POR QUÉ AQUÍ SÍ HAY UN `exists` CONTRA `messages` DENTRO DE LA POLÍTICA,
-- cuando la 0033 evitó justamente eso denormalizando `conversation_id` en
-- `message_attachments`. Porque la forma de esta tabla está fijada por el
-- contrato de la ronda y no lleva `conversation_id`, y porque el coste no es
-- comparable: los adjuntos se leen en lote para toda una página de historial
-- —una política por fila, decenas por pantalla—, mientras que el contexto es
-- como mucho UNA fila por mensaje y solo lo consulta el backend, que lee con
-- identidad de servicio. La política es la red de seguridad para cualquier
-- cliente que entre por PostgREST, no el camino habitual.
-- ---------------------------------------------------------------------------
alter table public.message_story_context enable row level security;

drop policy if exists message_story_context_read on public.message_story_context;
create policy message_story_context_read on public.message_story_context
  for select using (
    exists (
      select 1 from public.messages m
      where m.id = message_id
        and public.is_conversation_member(m.conversation_id)
    )
  );

-- Escribir SOLO colgando de un mensaje propio. Sin la segunda condición, un
-- miembro de la conversación podría atribuirle a un mensaje ajeno una respuesta
-- a una historia que su autor nunca vio.
drop policy if exists message_story_context_insert on public.message_story_context;
create policy message_story_context_insert on public.message_story_context
  for insert with check (
    exists (
      select 1 from public.messages m
      where m.id = message_id and m.sender_id = auth.uid()
    )
  );

-- No hay política de UPDATE, y es deliberado: a qué historia respondía un
-- mensaje es un hecho del pasado. Lo único que puede cambiar es que la historia
-- deje de existir, y de eso se encarga el `on delete set null`, que corre por
-- debajo de la RLS.
drop policy if exists message_story_context_delete on public.message_story_context;
create policy message_story_context_delete on public.message_story_context
  for delete using (
    exists (
      select 1 from public.messages m
      where m.id = message_id and m.sender_id = auth.uid()
    )
    or public.is_admin()
  );

-- ---------------------------------------------------------------------------
-- 3. `message_attachments.kind` admite 'audio'
--
-- El nombre —`message_attachments_kind_check`— es el que PostgreSQL le pone a
-- un `check` declarado en la columna: `<tabla>_<columna>_check`. Ver la
-- cabecera para el porqué de que acertarlo sea crítico.
--
-- El orden importa: primero `drop ... if exists` (para poder ejecutar esto dos
-- veces sin que el `add` choque con el nombre) y después `add`. La lista nueva
-- solo AÑADE: los tres valores de siempre siguen dentro, así que la
-- revalidación de la tabla no puede fallar por una fila existente.
-- ---------------------------------------------------------------------------
alter table public.message_attachments
  drop constraint if exists message_attachments_kind_check;

alter table public.message_attachments
  add constraint message_attachments_kind_check
  check (kind in ('image', 'video', 'document', 'audio'));

-- ---------------------------------------------------------------------------
-- 4. LA COMPROBACIÓN QUE IMPIDE EL FALLO SILENCIOSO
--
-- Si el nombre deducido arriba fuera el equivocado, el `drop` de antes no
-- habría quitado nada —`if exists` no protesta— y la restricción VIEJA seguiría
-- en la tabla rechazando cada 'audio'. La migración habría terminado «bien» y
-- el fallo aparecería semanas después, en producción, al enviar la primera nota
-- de voz.
--
-- Así que se comprueba de verdad, contra `pg_constraint`, y se ABORTA si algo
-- no cuadra. Abortar deshace la transacción entera: es preferible una migración
-- que se niega a terminar y dice por qué, a una base que acepta la migración y
-- rechaza los audios en silencio.
--
-- Se buscan DOS cosas distintas:
--   a) que exista una restricción sobre `kind` que admita 'audio';
--   b) que NO quede ninguna otra sobre `kind` que no lo admita — que es la
--      forma exacta que tendría el fallo del nombre equivocado.
-- ---------------------------------------------------------------------------
do $$
declare
  admite_audio integer;
  sobrantes text;
begin
  select count(*) into admite_audio
  from pg_constraint
  where conrelid = 'public.message_attachments'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%kind%'
    and pg_get_constraintdef(oid) like '%audio%';

  if admite_audio = 0 then
    raise exception
      'La 0044 no ha dejado ninguna restriccion de `kind` que admita audio en '
      'message_attachments. Reviselo antes de continuar: sin ella las notas de '
      'voz se rechazarian con un error de integridad (un 500 en la aplicacion).';
  end if;

  select string_agg(conname || ' => ' || pg_get_constraintdef(oid), chr(10))
  into sobrantes
  from pg_constraint
  where conrelid = 'public.message_attachments'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%kind%'
    and pg_get_constraintdef(oid) not like '%audio%';

  if sobrantes is not null then
    raise exception
      'Queda una restriccion antigua sobre `kind` que NO admite audio, asi que '
      'el nombre que usa el `drop constraint` de esta migracion no es el que '
      'tiene puesto la tabla. Restriccion(es) sobrante(s): %. '
      'Corrija el nombre en la 0044 y vuelva a ejecutarla.', sobrantes;
  end if;
end
$$;

-- =============================================================================
-- Que PostgREST se entere del esquema nuevo sin reiniciar nada.
-- =============================================================================
notify pgrst, 'reload schema';

-- =============================================================================
-- COMPROBACIONES (ejecutar a mano DESPUÉS, una a una)
-- =============================================================================
--
-- 1. La tabla existe con sus columnas y `story_id` es ANULABLE.
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'message_story_context'
-- order by ordinal_position;
-- Esperado: message_id (uuid, NO), story_id (uuid, YES  <-- lo importante),
--           story_owner_id (uuid, NO), created_at (timestamptz, NO, now()).
--
-- 2. LAS CLAVES AJENAS, Y SOBRE TODO SU `ON DELETE`. Es lo que decide si un
--    mensaje sobrevive a la caducidad de la historia que respondía. Si
--    `story_id` saliera con CASCADE en vez de SET NULL, PARAR: borrar una
--    historia se llevaría el contexto de todos los mensajes que la respondían.
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.message_story_context'::regclass
-- order by conname;
-- Esperado: PRIMARY KEY (message_id);
--           FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
--           FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE SET NULL;
--           FOREIGN KEY (story_owner_id) REFERENCES profiles(id) ON DELETE CASCADE.
--
-- 3. EL `CHECK` DE `kind`. Esta es la comprobación que más importa de todo el
--    fichero: tiene que salir UNA sola fila, y su definición tiene que incluir
--    'audio'. Si salieran DOS, la vieja sigue puesta y las notas de voz se
--    rechazarán en silencio.
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.message_attachments'::regclass
--   and contype = 'c'
--   and pg_get_constraintdef(oid) like '%kind%';
-- Esperado: exactamente una fila, `message_attachments_kind_check`, con
--           CHECK (kind = ANY (ARRAY['image','video','document','audio'])).
--
-- 4. Los índices del contexto.
-- select indexname, indexdef from pg_indexes
-- where schemaname = 'public' and tablename = 'message_story_context'
-- order by indexname;
-- Esperado: la clave primaria, message_story_context_story_idx y
--           message_story_context_owner_idx.
--
-- 5. LA RLS ESTÁ ACTIVADA. Si devuelve `false`, la tabla es legible por
--    cualquier cuenta autenticada: parar y arreglarlo antes de seguir.
-- select relname, relrowsecurity from pg_class
-- where oid = 'public.message_story_context'::regclass;
-- Esperado: t.
--
-- 6. Las políticas están puestas y no hay ninguna de UPDATE.
-- select policyname, cmd from pg_policies
-- where schemaname = 'public' and tablename = 'message_story_context'
-- order by policyname;
-- Esperado: message_story_context_delete (DELETE),
--           message_story_context_insert (INSERT),
--           message_story_context_read (SELECT). Ninguna más.
--
-- 7. EL BUCKET SIGUE SIENDO EL DE ANTES. Esta migración no lo toca; se mira
--    para confirmar que sigue privado y que ya aceptaba audio desde la 0033.
-- select id, public, 'audio/*' = any(allowed_mime_types) as admite_audio
-- from storage.buckets where id = 'message-media';
-- Esperado: message-media | false | true
--
-- 8. NADA se ha tocado de lo que ya había. Los mensajes y los adjuntos de antes
--    siguen exactamente donde estaban.
-- select
--   (select count(*) from public.messages)               as mensajes,
--   (select count(*) from public.message_attachments)    as adjuntos,
--   (select count(*) from public.message_story_context)  as contextos;
-- Esperado: los dos primeros, los mismos números que antes de ejecutar esto;
--           el tercero, 0.
