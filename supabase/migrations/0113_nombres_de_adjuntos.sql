-- 0113 · Nombres de adjuntos: el nombre de cada audio, documento o video, y si un audio es nota de voz
--
-- QUÉ RESUELVE (decidido el 30/10/2026, `docs/CONTRATOS_AUDIOS_Y_TEMAS.md`
-- § 1). Cuando se mandan veinte audios a General, no se sabe cuál es cuál ni
-- cuáles faltan por ordenar en un tema. Se piden dos cosas de la tabla de
-- adjuntos:
--
--   1. Un NOMBRE que pone una persona («Clase 3 — Respiración 4-7-8») a una
--      nota de voz, a un archivo de audio, a un documento o a un video. Las
--      fotos no lo llevan: ya tienen el texto del mensaje.
--   2. Distinguir una NOTA DE VOZ (grabada en el chat) de un ARCHIVO DE AUDIO
--      elegido del teléfono. Hasta hoy un mp3 se mandaba como `document` y no
--      se podía escuchar en el chat; desde esta ronda viaja como `audio`, y la
--      aplicación necesita saber cuál de los dos es para el icono (micrófono o
--      nota musical) y la API para no exigirle a un mp3 lo que a una nota de
--      voz (duración obligatoria, cinco minutos como mucho).
--
-- QUÉ HACE.
--
--   · `message_attachments.title text`, nulo por defecto: nulo es «sin
--     nombre». Su `CHECK` impide la cadena vacía —«sin nombre» ya tiene su
--     forma, y dos formas de decir lo mismo acaban en dos pantallas que no se
--     ponen de acuerdo— y más de 80 caracteres, que es lo que caben en dos
--     líneas de la tarjeta.
--   · `message_attachments.voice_note boolean not null default false`.
--   · Relleno: `voice_note = true` en todo `kind = 'audio'` que ya exista.
--     Hasta hoy TODO audio era una nota de voz (un archivo de audio se
--     mandaba como `document`), así que es la verdad, no una suposición.
--
-- POR QUÉ EL RELLENO SOLO CORRE CUANDO LA COLUMNA SE CREA. Una vez pegada, la
-- API escribe `voice_note = false` en los archivos de audio. Si pegar la
-- migración otra vez volviera a rellenar «todo audio es nota de voz»,
-- convertiría esos mp3 en notas de voz sin que nadie lo pidiera. Por eso la
-- columna y su relleno van juntos dentro de un `do` que solo hace algo si la
-- columna aún no existe: la segunda vez no toca ni una fila.
--
-- POR QUÉ NO HAY POLÍTICA NUEVA. `message_attachments` no tiene política de
-- UPDATE desde la 0033, y así se queda: con la clave del cliente nadie puede
-- cambiar un nombre por PostgREST. Quién puede ponerlo (quien envió el
-- mensaje y quien administra la comunidad) lo decide la API, en
-- `PATCH /conversations/{id}/messages/{mid}/attachments/{aid}`. La política de
-- lectura de siempre ya deja ver las dos columnas a los miembros, igual que
-- el resto de la fila.
--
-- EL CÓDIGO FUNCIONA SIN ELLA, como con la 0112: la API puede desplegarse
-- antes de pegarla (lo hace la integración continua en cuanto llega a `main`,
-- y esto se pega a mano). Mientras falte, el nombre que mande la aplicación se
-- ignora, sale `title: null`, y `voice_note` se deduce de `kind = 'audio'`;
-- ponerle nombre después responde 503 `attachment_titles_not_available`. La
-- API lo averigua una vez por proceso (`esquema.hay_nombres_de_adjuntos`) y,
-- en cuanto se pega, lo ve en menos de un minuto sin reiniciar. La API
-- ANTERIOR funciona igual con ella aplicada: no nombra estas columnas, y lo
-- que inserta sin ellas recibe nulo y `false`.
--
-- BLOQUEOS. Añadir las columnas y el `CHECK` toma un bloqueo exclusivo de
-- `message_attachments` hasta el final de la transacción. Las columnas no
-- reescriben la tabla (PostgreSQL 11 o posterior guarda el valor por defecto
-- constante aparte), pero el `CHECK` la lee entera para validarla, y el
-- relleno escribe las filas de audio: con los adjuntos de hoy son
-- milisegundos. Si algo la está leyendo, la migración espera detrás, y todo lo
-- que llega después —abrir cualquier chat con adjuntos— espera detrás de la
-- migración. Con `lock_timeout` se rinde a los 5 s, se revierte entera y se
-- puede volver a lanzar.
--
-- SE PEGA ENTERA, COMO UNA SOLA TRANSACCIÓN: es lo que hace el editor de
-- Supabase, y es lo que hace falta para que `set local` valga y para que la
-- columna y su relleno no se puedan separar. Fuera del editor: `psql -1 -f`.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
--
-- La comprobación y la vuelta atrás están al final.

set local lock_timeout = '5s';


-- -----------------------------------------------------------------------------
-- 1. El nombre
-- -----------------------------------------------------------------------------
alter table public.message_attachments
  add column if not exists title text;

-- El `CHECK` va con nombre y por separado, como en la 0104 y la 0112, para
-- poder volver a declararlo sin error y para que el modelo de la API
-- (`MessageAttachment`) lo repita con el mismo nombre. `char_length` cuenta
-- caracteres, no bytes: «Respiración» son 11, no 12. La API recorta los
-- espacios de los extremos y responde 422 antes de llegar aquí; esto es lo
-- que lo garantiza aunque algo se salte la API.
alter table public.message_attachments
  drop constraint if exists message_attachments_title_check;
alter table public.message_attachments
  add constraint message_attachments_title_check
  check (title is null or char_length(title) between 1 and 80);


-- -----------------------------------------------------------------------------
-- 2. Nota de voz o archivo de audio, con su relleno
-- -----------------------------------------------------------------------------
-- Dentro de un `do` para que el relleno corra SOLO la vez que se crea la
-- columna (ver la cabecera). `not null default false`: cada fila que ya existe
-- lee `false` sin reescribir la tabla, y el `update` de después solo toca las
-- de audio.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'message_attachments'
      and column_name = 'voice_note'
  ) then
    alter table public.message_attachments
      add column voice_note boolean not null default false;

    update public.message_attachments
    set voice_note = true
    where kind = 'audio';
  end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 3. Que siga sin poder cambiarse por PostgREST
-- -----------------------------------------------------------------------------
-- Si alguien hubiera creado a mano una política de UPDATE, cualquiera podría
-- renombrar los archivos de otros saltándose la API. No se borra aquí —no es
-- de esta migración—: se para, para que lo mire alguien.
do $$
declare
  escrituras integer;
begin
  select count(*) into escrituras
  from pg_policies
  where schemaname = 'public'
    and tablename = 'message_attachments'
    and cmd in ('UPDATE', 'ALL');
  if escrituras > 0 then
    raise exception
      'message_attachments tiene % política(s) de UPDATE. No debe tener ninguna: '
      'el nombre de un adjunto solo lo cambia la API.', escrituras;
  end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 4. Que PostgREST se entere del cambio de esquema
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';


-- -----------------------------------------------------------------------------
-- 5. Comprobación
-- -----------------------------------------------------------------------------
-- Una fila. Esperado: las dos columnas (`title` nula sin valor por defecto;
-- `voice_note` con `false` y no nula), el `CHECK` del nombre, ninguna política
-- de UPDATE, ningún nombre todavía, y TANTAS notas de voz como audios había
-- (`audios` = `notas_de_voz`; recién pegada, todo audio es nota de voz).
select
  (select is_nullable
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'message_attachments'
      and column_name = 'title') as title_admite_nulo,
  (select column_default
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'message_attachments'
      and column_name = 'voice_note') as voice_note_por_defecto,
  (select count(*)
     from pg_constraint
    where conrelid = 'public.message_attachments'::regclass
      and conname = 'message_attachments_title_check') as check_del_nombre,
  (select count(*)
     from pg_policies
    where schemaname = 'public'
      and tablename = 'message_attachments'
      and cmd in ('UPDATE', 'ALL')) as politicas_de_update,
  (select count(*)
     from public.message_attachments
    where title is not null) as con_nombre,
  (select count(*)
     from public.message_attachments
    where kind = 'audio') as audios,
  (select count(*)
     from public.message_attachments
    where voice_note) as notas_de_voz;


-- -----------------------------------------------------------------------------
-- VERIFICACIÓN A MANO (no se ejecuta sola)
-- -----------------------------------------------------------------------------
-- Ningún adjunto que no sea audio quedó como nota de voz (debe devolver cero
-- filas):
--
--   select id, kind from public.message_attachments
--   where voice_note and kind <> 'audio';
--
-- Cuántos de cada cosa hay (útil después, cuando ya se manden archivos de
-- audio):
--
--   select kind, voice_note, count(*), count(title) as con_nombre
--   from public.message_attachments group by 1, 2 order by 1, 2;
--
-- -----------------------------------------------------------------------------
-- VUELTA ATRÁS (rollback)
-- -----------------------------------------------------------------------------
-- Después hay que REINICIAR LA API: `esquema.py` recuerda el «sí» para
-- siempre (una columna no desaparece sola), y sin reiniciar seguiría
-- nombrándolas y cada chat con adjuntos respondería 500. Reiniciada, trata
-- todo audio como nota de voz y no enseña nombres, como antes. No se pierde
-- ningún mensaje ni ningún archivo. Lo que se pierde son los nombres puestos y
-- qué audios eran archivos: un mp3 mandado mientras tanto pasa a leerse como
-- nota de voz (se sigue reproduciendo; cambia el icono). La API ANTERIOR no
-- los conoce, así que con ella no hay nada más que hacer.
--
--   alter table public.message_attachments
--     drop constraint if exists message_attachments_title_check;
--   alter table public.message_attachments drop column if exists title;
--   alter table public.message_attachments drop column if exists voice_note;
--   notify pgrst, 'reload schema';
