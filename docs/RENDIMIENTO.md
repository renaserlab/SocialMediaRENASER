# Rendimiento de carga — diagnóstico, arquitectura y operación

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
  ├─ warmUpApi(): GET /health despierta Render EN PARALELO (fire-and-forget)
  ├─ instantánea local del feed (AsyncStorage) → se pinta YA         [L2]
  ├─ firmas persistidas del arranque anterior → URLs idénticas       [L2]
  │    └─ expo-image cacheKey = ruta de Storage → disco, sin red     [L3]
  ├─ GET /posts (30 s + 1 reintento tras timeout)
  │    ├─ fase 1: JSON → texto + huecos exactos (width/height)
  │    └─ fase 2: firmas por lote → se funden por id
  └─ reconciliación silenciosa + instantánea actualizada

VIDEO
  poster (imagen, al instante) → tap → HLS si existe (stream_path)
                                      → si no, MP4 feed_path (720p)
                                      → si no, original (compatibilidad)
SHORTS
  páginas de 6 (cursor keyset + offset de respaldo)
  ventana de reproductores: N-1, N, N+1 (máx. 3); el resto, posters
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
2. **Desplegar el API** (merge a `main` cuando Edson apruebe → Render). Las
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

**Por infraestructura** — ejecutar la migración 0021 y el script de
reproceso (necesitan la service role key, que este entorno no tiene);
verificar el endpoint HLS con un video real transcodificado.

**Por costo (decisiones de negocio, NO tomadas aquí)** —
- Render de pago o keep-alive externo: el warm-up mitiga, pero el plan free
  seguirá durmiendo. Un plan Starter (~7 USD/mes) elimina los 23 s de raíz.
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
