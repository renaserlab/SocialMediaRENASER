# Contratos — Audios y temas: dónde está cada archivo y su nombre

Documento de coordinación de la ronda del **30 de octubre de 2026**. Fija lo que
más de un agente podría decidir por su cuenta y decidir distinto: nombres de
columna, rutas, formas de las respuestas, códigos de error y quién toca qué.

**Nadie cambia lo que hay aquí sin avisar al coordinador.** Si algo no encaja
al implementarlo, se avisa; no se improvisa otro nombre.

Rama: `feature/audios-y-temas`, que sale de `feature/comunidades-en-el-perfil`
(`45a8bcd`) porque usa sus nombres (comunidad, grupos, temas). La spec está en
https://claude.ai/artifact/CZH85QS6tbnKYMMKYVKRbT y el lienzo aprobado en
https://claude.ai/artifact/UsHC9fL1NAqDXWKw48QgA3 (los dos son privados).

---

## 0. Qué se construye

1. **Etiqueta del tema** bajo cada mensaje de General que está en uno o más
   temas (`conversation_topic_items`). La ven todos los miembros.
2. **Agregar a un tema con ✓** donde ya está; tocar uno marcado lo quita.
3. **Contenido**: filtro por tema y «Sin tema», con cuentas, y selección de
   varios para agregarlos a un tema de una vez (solo quien administra).
4. **Nombre** (`title`, hasta 80 caracteres) en notas de voz, archivos de
   audio, documentos y videos. Lo ponen quien envió el mensaje y quien
   administra la comunidad: al agregar a un tema (si no tiene), al enviar y
   después desde el menú.
5. **La tarjeta**: con nombre, la burbuja empieza con un cuadrito de 40 px
   con el icono del tipo y el título (hasta dos líneas); debajo, el contenido
   de siempre. Sin nombre, todo se ve como hoy.
6. **Varios archivos a la vez** (hasta 10) al enviar documentos y audios, con
   un nombre por archivo. Un archivo `audio/*` elegido como archivo se envía
   como audio reproducible.

Fuera: transcripción, nombres en fotos, mover mensajes entre temas, y el
**push** (regla de privacidad de `avisos.py:15-17`: no lleva el nombre).

## 1. Migración `0113_nombres_de_adjuntos.sql`

Toma la 0113 porque esta rama se fusiona después de la 0112 de comunidades y
antes que `perf/rls-lecturas` y `perf/productos-e-indices`, que se renumeran al
rebasarlas. `test_secuencia_de_migraciones.py` exige que no haya huecos.

- `message_attachments.title text`, nulo por defecto, con
  `check (title is null or char_length(title) between 1 and 80)`.
- `message_attachments.voice_note boolean not null default false`, y relleno
  `voice_note = true` donde `kind = 'audio'`: hasta hoy todo audio era una nota
  de voz, porque un archivo de audio se mandaba como `document`. Sirve para
  elegir el icono (micrófono o nota musical).
- Sin políticas nuevas: `message_attachments` sigue sin política de UPDATE, así
  que el nombre solo se cambia por la API.
- Idempotente, `set local lock_timeout = '5s'`, `notify pgrst, 'reload
  schema'`, comprobación final con `select` y vuelta atrás comentada.

## 2. API (`apps/api/app/modules/messaging/`)

**Las versiones de la app que ya están en los teléfonos tienen que seguir
igual**, y la API nueva **no puede fallar si la 0113 aún no está pegada**:
detectarlo una vez por proceso, como hace `esquema.py` con las demás. Sin la
0113, `title` se ignora al escribir y sale `null` al leer, y `voice_note` se
deduce de `kind == "audio"`.

| Qué | Contrato |
|---|---|
| `AttachmentCreate` | `title: str \| None` (recortado; vacío → `None`; más de 80 → 422 `attachment_title_too_long`; en `image` se ignora). `voice_note: bool \| None`: si no viene, vale `kind == "audio"` (así las apps antiguas siguen mandando notas de voz). |
| `AttachmentRead` | `title: str \| None`, `voice_note: bool`. |
| `MessageRead` | `topics: list[{id: str, name: str}]`, vacío por defecto. Solo se rellena en General de una comunidad con temas. Se carga de una vez por página, junto a adjuntos y reacciones (`router.py:927-948`), y también en Contenido (`vistas.py`) y en los mensajes de un tema (`temas.py`). |
| `PATCH /conversations/{id}/messages/{message_id}/attachments/{attachment_id}` (nuevo) | Cuerpo `{"title": "…" \| null}` (`null` o vacío lo borra). 200 con el `AttachmentRead`. Pueden quien envió el mensaje y quien administra la conversación (misma regla que borrar, `router.py:1256-1264`). Errores: 403 `attachment_title_forbidden`, 404 `attachment_not_found`, 422 `attachment_title_too_long`, 422 `attachment_title_invalid` (caracteres de control, categoría Unicode `Cc`: `\n`, `\r`, `\t`, `\u0000`…, mirados después de recortar los extremos; también al enviar), 422 `attachment_title_not_allowed` (si es `image`), 503 `attachment_titles_not_available` (sin la 0113). |
| `PUT /conversations/{group_id}/topics/{topic_id}/items` (nuevo, por lotes) | Cuerpo `{"message_ids": [...]}`, de 1 a 50, sin repetidos. Mismas comprobaciones que el de uno (`temas.py:1518-1570`). Todo o nada: si alguno no vale, 404 `message_not_in_group` y no se agrega ninguno. 200 `{"added": n, "already": m}`. |
| `GET /conversations/{group_id}/topics/of-messages?ids=a,b,c` (nuevo) | Para refrescar etiquetas: `{"<message_id>": [{id, name}], …}`, hasta 100 ids, solo de General de esa comunidad. Lo pueden llamar los miembros. |
| `GET /{id}/views/messages` | Parámetros nuevos `topic_id` o `sin_tema=true` (422 `views_topic_conflict` si vienen los dos), combinables con `category`; `q` busca también en `title`. Los ítems llevan `topics` y los adjuntos `title`. |
| `GET /{id}/views/topics?category=<cat>` (nuevo) | `{"sin_tema": int, "topics": [{"id", "name", "count"}]}` para la fila de filtros, respetando el chat vaciado como `_cuentas`. Solo temas vivos con algo de esa categoría. |
| Archivos de audio | `POST /conversations/{id}/messages` acepta un adjunto `kind: "audio"` con `voice_note: false` y un tipo `audio/*` (mp3, m4a, aac, wav; la app manda ogg/opus como `document` porque iOS no los reproduce), con `duration_s` opcional. Revisar la validación de audio que hoy existe para notas de voz. |
| Vistas previas | La bandeja (`lectura.py:60-64`) añade `audio` → «Nota de voz» (hoy sale «Archivo»). Con `title`, la vista previa del último mensaje es el título, en la bandeja, en la lista de la comunidad (`subgrupos.py:120-125`) y en los temas (`temas.py:790-880`). |
| Push | Sin cambios. |
| `GET /conversations/availability` | Campo nuevo `attachment_titles: bool`, junto a `subgroups`. Vale `true` solo si la 0113 está aplicada. La app esconde «Ponerle nombre» y los campos de nombre cuando es `false`. |
| `voice_note` en las citas y en la lista de temas | `reply_to` y el `last` de la lista de temas ganan `voice_note: bool`. Con `kind: "audio"` y `excerpt` vacío, la app escribe «Nota de voz» si es `true` y «Audio» si es `false`. `excerpt` lleva el nombre cuando lo hay. |

## 3. App (`apps/mobile/`)

- Tipos y mapeo: `title` y `voiceNote` en los adjuntos, `temas` en los
  mensajes (`messageMapper.ts`, `MessageRepository.ts`); `TemasRepository`
  gana `agregarVarios` y `temasDeMensajes`.
- **La tarjeta** en `BurbujaDeNotaDeVoz`, `ArchivoDeChat` y `MedioDeChat`
  (video): cuadrito 40×40 con radio de las tarjetas pequeñas, icono Feather
  `mic` (nota de voz), `music` (archivo de audio), `video` (video) o la sigla
  del documento; título 14/700, dos líneas como máximo. En el documento con
  nombre, debajo va una línea fina con el nombre real del archivo, el peso y
  la descarga. Sin nombre, todo como hoy. Solo tokens del tema.
- **Etiqueta** bajo la burbuja (fuera de ella, del mismo lado): una píldora
  gris con `#` + nombre, o capas + «En N temas» (abre una hoja con la lista).
  `ChatScreen` escucha el aviso `chat-temas:{grupoId}` (`realtime.ts`) y
  refresca las etiquetas de lo cargado con `temasDeMensajes`.
- **Hoja «Agregar a un tema»** (`HojaDeTemas.tsx`): ✓ desde
  `GET …/topics?message_id=` (`contains`), «Ya está aquí · toca para quitarlo»,
  y el campo «Nombre (opcional)» arriba si el adjunto no tiene nombre (se
  guarda con «Listo», vía el PATCH).
- **Menú del mensaje** (`ChatScreen.tsx:2589-2668`): «Ponerle nombre» /
  «Cambiar el nombre» para quien envió y quien administra; «Ir al tema
  «X»» / «Ver en qué temas está» para todos. Las hojas se abren con
  `afterSheetClose`.
- **Nota de voz**: el campo «Ponle nombre (opcional)» en la fase `lista` de
  `useGrabadoraDeVoz` / `BotonDeNotaDeVoz`; viaja en `attachments[].title`.
- **Archivos**: `elegirArchivo` deja elegir hasta 10; un `audio/*` va como
  `kind: "audio"`, `voice_note: false`. Hoja «Enviar N archivos» con un campo
  por archivo, rellenado con el nombre del archivo sin extensión y con `-`/`_`
  como espacios, salvo los de cámara (`IMG_`, `VID_`, `PXL_`, `WhatsApp Audio`)
  que quedan vacíos. Un mensaje por archivo. El selector se abre tras
  `afterSheetClose` (hoy `elegirCon` no lo hace, `ChatScreen.tsx:1184-1199`).
- **Contenido** (`PestanasDeContenido`, `vistasDeChat.ts`): fila «Tema» con
  «Todos · N», «Sin tema · N» y un filtro por tema; selección con pulsación
  larga (solo quien administra), cabecera «N seleccionados» y botón «Agregar N
  a un tema», que llama al PUT por lotes y manda el aviso `chat-temas`.
- No se toca nada de `apps/mobile/app/` (rutas).

## 4. Quién toca qué

| Parte | Ficheros |
|---|---|
| Backend | `supabase/migrations/0113_*.sql`, `apps/api/**` (código y pruebas) |
| App | `apps/mobile/**` salvo `apps/mobile/app/` |
| Coordinador | este documento, los commits y la integración |

Nadie hace commit, push, stash ni `git add -A`: el coordinador hace los commits.
