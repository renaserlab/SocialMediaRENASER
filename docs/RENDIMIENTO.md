# Rendimiento de carga — diagnóstico, arquitectura y operación
>
> **Actualizado el 27 de agosto de 2026.** Varias afirmaciones de este
> documento dejaron de ser ciertas al migrar el backend a AWS. Lo medido y
> corregido está en [`Z_AUDITORIA_RENDIMIENTO_2026-08.md`](Z_AUDITORIA_RENDIMIENTO_2026-08.md).


Trabajo realizado en la rama `Edson` (agosto 2026). Objetivo: que abrir la
aplicación y recorrer muro, imágenes, videos y shorts se sienta inmediato,
aplicando los principios de las redes de video (caché local → metadata →
poster → prefetch → video optimizado → HLS), sin sobreingeniería para el
volumen actual.

## 1. Diagnóstico (medido contra producción, 2026-08-20)

| Cuello de botella | Medida |
| --- | ---: |
| Render (plan free) dormido: `GET /health` frío | **22.8 s** |
| `GET /health` caliente | ~0.25 s |
| `GET /api/v1/posts` caliente (TTFB) | 0.64–2.2 s |
| Timeout del móvil (20 s) vs arranque frío (23 s) | **el primer feed del día fallaba** |
| Media del feed actual (11 posts) | **372.9 MB** |
| Videos existentes (3) | 96 / 161 / 101 MB — 1080p H.264 a 10–12.5 Mbps |
| Fotos originales servidas al muro | hasta 6.1 MB (3060×4080) |
| Firmas de Storage | cada arranque refirmaba TODO → URL nueva → la caché de disco de expo-image no reconocía nada y se re-descargaba el muro entero |
| CDN (Cloudflare de Supabase) | `cache-control: no-cache`, `MISS/REVALIDATED`; el TTFB de Storage es 0.4–1.8 s por objeto |
| Transformaciones de imagen de Supabase | **NO disponibles en este proyecto** (el `transform` se ignora y sirve el original; verificado) |
| Feed | bloqueaba el render esperando TODAS las firmas; sin caché local: pantalla de esqueletos hasta que el servidor respondiera |
| Videos del muro | un reproductor por video visible, descargando buffer sin que nadie pulsara play; sin posters (rectángulos negros) |
| Shorts | 30 videos + firmas para mostrar uno; sin paginación; sin posters |
| SQL del feed | 4 subconsultas correlacionadas por fila (2 de ellas COUNT donde bastaba EXISTS); paginación por OFFSET |

## 2. Arquitectura de carga tras el cambio

```text
ABRIR LA APP
  │  (ya NO hay warmUpApi: existia para despertar Render, y AWS no duerme)
  ├─ instantánea local del feed (AsyncStorage) → se pinta YA         [L2]
  ├─ firmas persistidas del arranque anterior → URLs idénticas       [L2]
  │    └─ expo-image cacheKey = ruta de Storage → disco, sin red     [L3]
  ├─ GET /posts (espera estandar + 1 reintento tras timeout)
  │    ├─ fase 1: JSON → texto + huecos exactos (width/height)
  │    └─ fase 2: firmas por lote → se funden por id
  └─ reconciliación silenciosa + instantánea actualizada

VIDEO
  poster (imagen, al instante) → tap → HLS si existe (stream_path)
                                      → si no, MP4 feed_path (720p)
                                      → si no, original (compatibilidad)
SHORTS
  páginas de 6 (cursor keyset + offset de respaldo)
  ventana de reproductores: N-1, N, N+1, N+2 (máx. 4; web N-1..N+1); el resto, posters
  buffer: activo 15 s / 12 MB; vecinos 2 s / 1,5 MB; mínimo 0,5 s / 1 MB al arrastrar
  o con el activo justo de buffer (lib/precargaDeVideos.ts)
  expo-video useCaching para MP4 (segundo visionado sin red)
```

Capas de caché: L1 estado en memoria (zustand) · L2 metadata + firmas en
AsyncStorage · L3 disco expo-image (cacheKey estable) · L4 disco expo-video
(useCaching) · L5 CDN de Supabase · L6 Storage.

## 3. Cambios principales por área

**Móvil** — instantánea SWR del feed (`useAppStore.hydrateFeedFromCache`),
caché de firmas persistente (`services/storage.ts`), carga en dos fases y
deduplicación (`loadFeed`), `cacheKey` estable en imágenes/posters, video del
muro poster-first (el reproductor nace al pulsar play), shorts paginados con
ventana de 3 reproductores, `bestVideoSource` (HLS → MP4 optimizado →
original), metadata y poster generados en el dispositivo al subir
(react-native-compressor: `getVideoMetaData` + `createVideoThumbnail`),
compresión de video subida a 720p/2.5 Mbps explícitos, instrumentación con
`EXPO_PUBLIC_PERFORMANCE_DEBUG=1` (`src/lib/perf.ts`).

**Backend** — migración `0021_media_metadata.sql` (medidas, duración, bytes,
poster_path, feed_path, stream_path, processing_status en `post_media` +
índice parcial del muro), API que acepta/devuelve esa metadata, derivados en
segundo plano al publicar (WebP 1080 de imágenes con Pillow; poster de video
con ffmpeg leyendo por rangos), endpoint `/media/{id}/hls/{playlist}` que
firma los segmentos por lote (el bucket sigue privado), EXISTS en liked/saved
y cursor keyset en `/posts` (offset se mantiene por compatibilidad).

**Scripts** — `scripts/procesar_media.py` (con `--dry-run`): reprocesa lo
existente donde hay CPU: posters, WebP de imágenes, MP4 720p ~2.4 Mbps con
faststart y escalera HLS 360/540/720 (segmentos .ts de 4 s, disposición
plana). Valida la duración del transcode antes de tocar la base de datos y
NUNCA sobreescribe originales (todo va a `<uid>/derived/<media_id>/…`).

**UI** — `FloatingGlassTabBar`: cápsula flotante acrílica (blur real en
iOS/web; en Android superficie translúcida sin blur a propósito:
rendimiento > adorno), tokens `glass*` en claro/oscuro, píldora activa
animada 180 ms con native driver, globo de mensajes, zona segura respetada.
Rutas intactas.

## 4. Resultados medidos

| Métrica | Antes | Después |
| --- | ---: | ---: |
| Fotos reales del muro (7) | 15.0 MB | **0.7 MB** (WebP 1080, mismas fotos, −95 %) |
| Foto de 6.1 MB (3060×4080) | 6.1 MB | 24 KB |
| Primer feed del día (Render dormido) | error a los 20 s | contenido cacheado al instante; red al despertar (warm-up + reintento) |
| Firmas al reabrir (<1 h) | 1 petición + re-descarga total | 0 peticiones, disco |
| Reproductores de video en el muro | 1 por video visible (con buffer) | 0 hasta pulsar play |
| Shorts: primera pantalla | 30 videos + firmas | 6 posts, posters primero |
| Reproductores vivos en shorts | según distancia de dibujo | máx. 3 (N−1, N, N+1) |
| Pipeline HLS | no existía | validado offline: escalera 360/540/720 correcta (vertical incluida) |

Proyección para los videos existentes al ejecutar el script (bitrate medido
10–12.5 Mbps → 2.4 Mbps a 720p): 161 MB → ~31 MB, 96 MB → ~19 MB. Con HLS, el
arranque solo necesita el primer segmento de 4 s de la calidad elegida
(~0.4–1.2 MB) en lugar de bufferizar un MP4 gigante.

No medible desde este entorno (documentado como pendiente): RAM/FPS en build
release de Android, EXPLAIN ANALYZE contra el Postgres real y los tiempos del
API con el código nuevo desplegado.

## 5. Operación — qué ejecutar y en qué orden

1. **Migración**: pegar `supabase/migrations/0021_media_metadata.sql` en el
   SQL Editor de Supabase (repetible; termina con su comprobación).
2. **Desplegar el API** (merge a `main` cuando Edson apruebe). El despliegue
   lo hace `.github/workflows/desplegar-aws.yml`, contra AWS, no Render. Las
   publicaciones nuevas generan derivados solas a partir de aquí.
3. **Reprocesar lo existente** (cualquier máquina con ffmpeg). El script lee
   la dirección del proyecto de `apps/mobile/.env` y pide la **service role
   key por teclado, oculta**: no va en ningún archivo del repositorio ni en la
   línea de comandos, donde quedaría en el historial de la consola.
   ```bash
   python scripts/procesar_media.py --dry-run
   python scripts/procesar_media.py --images
   python scripts/procesar_media.py --videos --hls
   ```
4. **App móvil**: nueva build EAS (hay dependencia nativa nueva: expo-blur) y
   publicación. La app funciona contra el API viejo y el nuevo.

## 6. Pendientes

**Por código** — nada bloqueante; ideas: reproductor de `PostDetailScreen`
con HLS explícito (hoy hereda de PostCard), prefetch de la siguiente imagen
del muro con `Image.prefetch`.

**Por infraestructura** — ejecutar el script de reproceso (necesita la service
role key); verificar el endpoint HLS con un video real transcodificado.

### Hallazgo colateral (2026-08-20): `SUPABASE_SERVICE_ROLE_KEY` faltaba en Render

Al configurarla para el procesado de media se descubrió que **nunca había
estado puesta**. Consecuencia anterior a este trabajo: `delete_user_files`
(borrado de cuenta) salía por su rama de "no configurado", registraba un aviso
en el log y **no borraba nada de Storage**. La política de privacidad promete
que esos archivos se eliminan.

Comprobación hecha comparando las carpetas de los buckets contra la tabla
`profiles`: **un único archivo huérfano**, `post-media/7d00ee95-f3a6-4a45-9564-0ca782cef755/1784580768207-e6y8ogml.jpg`
(0.16 MB, 2026-07-20). Verificado que es real y no un falso positivo por RLS:
no existe el perfil, no hay publicaciones de ese autor y ninguna fila de
`post_media` lo referencia. Los buckets `avatars` y `course-media` están
limpios.

Queda **borrarlo a mano** desde Storage en el panel de Supabase. Con la
variable ya configurada, los borrados de cuenta futuros sí limpian solos.

**Por costo (decisiones de negocio, NO tomadas aquí)** —
- ~~Render de pago o keep-alive externo~~. RESUELTO de otra forma: el backend
  vive en AWS y no duerme (0,29-0,66 s medidos). Las builds del movil apuntan
  ahi desde el 27/08/2026; Render solo sigue vivo para las que ya estan
  instaladas.
- CDN de video dedicado (Cloudflare Stream ~5 USD/1000 min, Bunny Stream,
  Mux): solo si el volumen de video crece en serio; con HLS + Supabase basta
  hoy.
- Transformaciones de imagen de Supabase (plan Pro): harían innecesario el
  derivado propio de imágenes, pero el pipeline ya lo cubre gratis.
- Bucket público para los derivados HLS: quitaría la firma por segmento y
  dejaría cachear el CDN al máximo. NO se tocó ninguna política; decidirlo
  requiere aprobación expresa.

**Por producción** — medir en un Android real la build release (RAM, FPS,
arranque frío/caliente) con `EXPO_PUBLIC_PERFORMANCE_DEBUG=1`, y correr
`EXPLAIN ANALYZE` del feed contra Postgres cuando el índice parcial exista.

## 7. Medición de los videos de Inicio en teléfonos reales (noviembre 2026)

La línea base que había se midió en la **web** (primer video 3,1 s con wifi y
6,6 s con 4G; deslizar al siguiente 0,9 s y 13,5 s). Del iPhone y del Android
no había ningún número. Desde la migración `0115` y la rama
`feature/medicion-video-en-telefono`, cada arranque de la app manda un lote
pequeño con lo que tardó cada paso. Funciona en las builds normales, no solo
con `EXPO_PUBLIC_PERFORMANCE_DEBUG=1`, que sigue igual que antes y solo escribe
en la consola.

### Qué se mide

Todo en ms y sin datos de persona: ni usuario, ni publicación, ni texto, ni IP.
`sesion` es un número al azar por arranque.

| Tramo | Qué es |
|---|---|
| `feed_pedido` | Desde que arrancó el JS hasta que Inicio pide la primera página |
| `feed_respuesta` | … hasta que responde el feed (recomendador o cronológico) |
| `urls_firmadas` | … hasta que están firmadas las URLs de esa página |
| `primer_fotograma` | … hasta el primer fotograma del primer video (`onFirstFrameRender`) |
| `primera_reproduccion` | … hasta que el primer video **reproduce de verdad** |
| `primer_video` / `deslizamiento` / `otro` | Por cada video que pasa a ser el activo: desde el gesto (`onScrollBeginDrag`) o desde que se activó hasta que reproduce; además, hasta el primer fotograma si se vio en ese momento, el número de esperas por falta de datos **después** de arrancar, cuánto sumaron, si era HLS o MP4 y el peso (solo si se reproduce el original: el derivado del feed no tiene un peso guardado) |

«Reproduce de verdad» es el `playingChange` de expo-video, que en iOS sale de
`timeControlStatus == .playing` y en Android de `onIsPlayingChanged` de
ExoPlayer: los dos solo son ciertos cuando hay datos y el video avanza.
`readyToPlay` llega antes de que haya imagen, y el primer fotograma se puede
pintar con el video en pausa (el vecino precargado), así que ninguno de los dos
vale para esto. Una espera es `statusChange → loading` tras haber arrancado. En
la web son los eventos `playing` y `waiting` del `<video>`.

Contexto del equipo: plataforma, versión de la app, id corto de la
actualización OTA (o `embebido`), modelo (`expo-device`) y versión del sistema.
**El tipo de red queda vacío en iPhone y Android**: saberlo exige
`@react-native-community/netinfo` o `expo-network`, que son módulos nativos
que no están en el binario publicado, y añadir uno obliga a pasar por las
tiendas. En la web sale del navegador.

### Cuándo se envía y cuánto cuesta

- Todo en memoria. Ni disco, ni estado de React, ni un render por medición.
- Como mucho 30 tramos por sesión (`TOPE_DE_EVENTOS`).
- **Un solo envío por arranque**, al pasar a segundo plano o al minuto de la
  primera medición, lo que ocurra antes. `fetch` sin esperar respuesta, con
  `keepalive`, corte a los 5 s y sin reintentos: si falla, se pierde.
- Pesa unos 435 bytes con un video, ~1,8 KB con diez y ~4,7 KB lleno.
- Se apaga con `MEDICION_ENCENDIDA = false` o con `MUESTREO` (fracción de
  arranques que se miden; hoy 1 = todos) en `src/lib/medicionDeVideo.ts`.
  También se apaga sola si falta `EXPO_PUBLIC_API_URL`.
- Lo que se mide después del envío ya no se guarda. Mide el arranque y el
  primer minuto, que es justo lo que se quiere comparar con la línea base.

Código: `apps/mobile/src/lib/medicionDeVideo.ts` (lógica, sin React Native),
`medicionDeVideoEnApp.ts` (conexión con el teléfono), y los enganches en
`VideoPlayer(.web).tsx`, `FeedVerticalDeVideos.tsx`, `useFeedDeVideos.ts`,
`fuenteDeVideos.ts` y `PostRepository.listVideos`.

### Servidor

- `POST /api/v1/telemetria/video` funciona sin sesión, igual que Inicio. Valida de forma estricta
  (campos cerrados, ms entre 0 y 120 000, textos cortos, como mucho 30 tramos,
  cuerpo de 16 KB como máximo), limita a 20 lotes por IP cada 10 min (en
  memoria del proceso, como el chat en directo) y responde **202** antes de
  escribir. La escritura va en segundo plano y, si falla, solo se registra.
- Tabla `metricas_de_video` (migración `0115`): una fila por medición. Tiene RLS
  sin políticas y `revoke` a `anon`/`authenticated`, así que solo la API la
  lee y la escribe. No tiene nada que ver con `behavior_events`, que alimenta
  al recomendador.
- **Retención: 90 días** con `select public.purgar_metricas_de_video();`. Se
  puede programar con `pg_cron` (el comando está en la cabecera de la
  migración).

### Cómo consultarlo

- Admin en la API: `GET /api/v1/admin/telemetria/video?dias=7` (1 a 90 días)
  da `n`, mediana, p75 y p90 por plataforma, tramo y almacén, cuántos no
  llegaron a reproducir y qué fracción tuvo esperas.
- **Almacén.** Cada tramo de video lleva `almacen`: `supabase` (Storage, hoy)
  o `s3` (S3 + CloudFront, spec de la opción B). Mientras convivan, el resumen
  y la vista los separan, y así se compara con números si S3 carga mejor. Un
  cliente que no lo manda cuenta como `supabase`; los hitos de carga no lo llevan.
- Desde el editor SQL de Supabase: `select * from metricas_de_video_resumen;`
  (últimos 7 días). Para cruzar por modelo o versión:
  ```sql
  select modelo, formato, count(*),
         percentile_cont(0.5) within group (order by ms) as mediana
  from metricas_de_video
  where tramo = 'deslizamiento' and plataforma = 'android'
    and creado_en > now() - interval '7 days'
  group by 1, 2 order by 3 desc;
  ```

**Cómo leerlo frente a la línea base.** La línea base del «primer video» (3,1 s
y 6,6 s) equivale a `primera_reproduccion`, que cuenta desde el arranque del
JS. «Deslizar al siguiente» (0,9 s y 13,5 s) equivale a la mediana y al p90 de
`deslizamiento.ms`. Como hoy no hay tipo de red en nativo, comparar con la
cifra de wifi o de 4G de la web se hace por percentiles (la mediana se parece
más a wifi y el p90 a una red mala), no fila a fila.

### Qué hace falta para que llegue a los teléfonos

1. **API y migración**: aplicar `0115` en Supabase y desplegar la API. El
   orden da igual: sin tabla, la API responde 202 y descarta el lote.
2. **App por EAS Update, sin pasar por las tiendas.** El cambio es solo de JS:
   `expo-device`, `expo-constants` y `expo-updates` ya iban en el binario (los
   avisos push usan `expo-device` desde julio y `expo-updates` está desde
   septiembre). `runtimeVersion` usa la política `appVersion` (hoy `1.2.4`),
   así que una actualización publicada desde este código llega a las builds
   1.2.4 de cada canal: `eas update --channel production` (tiendas) o
   `--channel preview` (APK repartido). **Cuidado:** `eas update` no lee el
   `env` de los perfiles de `eas.json`, sino el `.env` local o las variables
   del entorno de EAS. Si `EXPO_PUBLIC_API_URL` y las de Supabase no están
   ahí, la actualización sale en modo demo. Hay que comprobarlo antes de
   publicar. Las builds con otra versión (1.2.3 o anteriores) no la reciben:
   necesitan una build nueva.

## Precarga estilo TikTok y portadas sin negro (noviembre 2026)

**App (solo JS, llega por EAS Update).** `src/lib/precargaDeVideos.ts` decide
la ventana y el buffer de cada reproductor del muro de Inicio:

- Ventana N-1..N+2 en teléfonos (máximo 4 reproductores vivos); la web sigue
  con N-1..N+1 y sin perfiles de buffer.
- El activo pide 15 s / 12 MB (como antes). Los vecinos 2 s / 1,5 MB: primer
  fotograma listo, nada más. Al volverse activo, el mismo reproductor sube en
  caliente (`player.bufferOptions`), sin recrearse.
- Mientras el dedo arrastra (o la lista sigue por inercia), todos los vecinos
  menos el siguiente bajan a 0,5 s / 1 MB. Mientras el activo tiene menos de
  2 s por delante (se suelta al pasar de 5 s, o si ya está descargado entero),
  todos los vecinos bajan a ese mínimo.

La telemetría `metricas_de_video` no cambia (mismo `inicioDeGesto` al empezar
el arrastre y mismos tramos), así que antes/después se compara con las
consultas de arriba (`primer_fotograma`, `deslizamiento`).

**API.** El poster de los videos nuevos (Supabase y S3) es el primer fotograma
no negro de los primeros 3 s (`blackframe` + `metadata`, un solo ffmpeg que se
corta en cuanto encuentra uno). Si todo es negro, respaldo en 1 s, luego 0,1 s
y luego el principio (clips de menos de 0,1 s). Código en
`comandos_de_poster` de `apps/api/app/modules/content/media_processing.py`; la
misma regla está copiada en `extrae_poster` de `scripts/procesar_media.py`.
Si el teléfono ya subió su propio poster junto al video, se respeta ese
(el servidor solo genera el que falta).

### Regenerar las portadas YA publicadas

Guion: `apps/api/scripts/regenerar_portadas.py`. Llama a las mismas funciones
de la API (`_extraer_poster`, `comandos_de_poster`, `rutas_de_derivados`,
`POSTER_MAX_NEGRO`), no a una copia, y sirve para Supabase y para S3.

Por qué no vale «borrar `poster_path` y reprocesar»:

1. La app cachea la portada por su RUTA (`cacheKey = poster_path`). Reescribir
   el mismo archivo no se vería en los teléfonos que ya la tienen en disco: la
   portada nueva tiene que ir a una ruta nueva.
2. En S3 la ruta lleva versión (`poster-v<n>.jpg`) y CloudFront la sirve como
   inmutable. La versión sale del `poster_path` actual; si se vacía, vuelve a
   `v1` y pisaría un archivo que CloudFront ya tiene en caché.

Qué hace con cada video:

- **Rutas nuevas.** Supabase: `<dueño>/derived/<media_id>/poster-v2.jpg` (v3,
  v4… si se repite). S3: `videos/<uid>/<media_id>/poster-v<n+1>.jpg`. El
  original solo se LEE (por URL temporal, unos cientos de KB por rangos).
- **La base** solo cambia `post_media.poster_path`, con «compara y cambia»: si
  la fila cambió entre la lectura y la escritura (se reprocesó, se editó, se
  borró) no se pisa y queda como `conflicto`.
- **Excluye** publicaciones borradas, datos E2E (ids `e2e…`, autores o textos
  que terminan en « Prueba») y filas en `pending`/`processing`
  (`process_media` reescribiría la ruta vieja al terminar).
- **No empeora**: si la portada nueva también es negra (un video oscuro de
  verdad, o un diseño de texto blanco sobre negro) y la vieja se podía leer,
  no la cambia (`saltado_nueva_tambien_negra`).
- **Respaldo en S3.** La limpieza diaria borra los `poster-v<n>` que la fila ya
  no nombra en cuanto tienen 7 días de ESCRITOS, o sea, la vieja en la primera
  pasada. Antes de cambiar la fila se copia a
  `videos/<uid>/<media_id>/respaldo-portada/`, que la limpieza no toca. En
  Supabase la vieja se queda donde estaba.
- **Registro** JSONL (por defecto
  `~/.local/share/zeta/regenerar_portadas/registro.jsonl`): una línea por paso
  con `ref_vieja`, `ref_nueva`, `respaldo` y el % de negro de cada una.
  Reanudar salta lo que el registro da por `aplicado`; cortarlo y relanzarlo
  sigue donde iba. Guardarlo: es la vuelta atrás.

Credenciales: las de la API, leídas del secreto `zexcelencia/produccion/api`
con el perfil `prod` (DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY;
nunca se imprimen). El bucket no es secreto. Se corre desde `apps/api` con su
entorno (`uv venv .venv && uv pip install -r requirements.txt`) y ffmpeg en el
PATH:

```bash
cd apps/api
P="--secreto-aws zexcelencia/produccion/api --perfil-aws prod \
   --bucket-s3 zexcelencia-medios-produccion-302277511407"
.venv/bin/python scripts/regenerar_portadas.py $P                  # simulacro (por defecto)
.venv/bin/python scripts/regenerar_portadas.py $P --guardar-muestras /tmp/portadas  # ver vieja/nueva
.venv/bin/python scripts/regenerar_portadas.py $P --aplicar --solo-negras --limite 1
.venv/bin/python scripts/regenerar_portadas.py $P --aplicar --solo-negras
.venv/bin/python scripts/regenerar_portadas.py $P --aplicar        # todas, si se quiere
```

El simulacro solo lee: baja las portadas viejas (unos KB) para medir cuáles
son negras y prueba la extracción en local en `--muestra` videos (5 por
defecto) para estimar tiempo y tráfico. `--solo-negras` toma las negras, las
que faltan y las ilegibles (en la app se ven igual). `--informe x.csv` deja el
detalle por video.

**Revertir**: `... --revertir` lista lo que haría; `... --revertir --aplicar`
devuelve cada fila a `ref_vieja` (también con «compara y cambia»: si alguien
la cambió después, no la toca) y, en S3, repone la vieja desde el respaldo si
la limpieza ya la borró. `--media-id <uuid>` limita a un medio. Los teléfonos
que ya tenían la vieja en caché la vuelven a usar sin descargar nada.

Simulacro en producción (23/11/2026): 16 videos, 5 de publicaciones borradas,
ningún E2E; 11 candidatos (5 Supabase, 6 S3). Portadas viejas negras: 3 (2 en
S3, la misma imagen de un degradado oscuro, que pasa a un fotograma gris; 1 en
Supabase que es texto blanco sobre negro y que el guardarraíl deja como está).
Estimación de `--aplicar` completo: ~10 s y ~12 MB de tráfico.
