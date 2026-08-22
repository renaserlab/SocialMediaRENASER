# Z Excelencia — estado de la implementación

Documento de estado. Cada requisito de `cambio de vistas y backend z excelencia.docx`
(prioritario) y del `Informe_Plan_Maestro_Z_10_Dias.pdf` (visión) con una de estas
cuatro etiquetas:

- **HECHO** — funciona de extremo a extremo (interfaz + lógica + backend cuando aplica).
- **PARCIAL** — funciona lo esencial; queda algo acotado y explicado aquí.
- **PENDIENTE** — no corresponde a esta iteración.
- **BLOQUEADO** — no se puede hacer sin algo externo. Se dice qué falta.

Rama: `Edson`. Última actualización: 22 de agosto de 2026.

---

## INICIO

| Requisito | Estado |
|---|---|
| El feed vertical de vídeo es la pantalla de Inicio | HECHO |
| La barra de navegación nunca desaparece | HECHO |
| Cabecera `[+] · Para ti · Siguiendo · Live` | HECHO |
| El botón `+` lleva a crear contenido | HECHO |
| «Para ti» con el contenido real; lo nuevo entra en la cola | HECHO |
| «Siguiendo»: con contenido | HECHO |
| «Siguiendo»: no sigue a nadie → mensaje + descubrir personas | HECHO |
| «Siguiendo»: sin sesión → registrarse / iniciar sesión | HECHO |
| «Siguiendo»: sigue a gente pero sin contenido reciente → sugerencias etiquetadas | HECHO |
| «Live» | BLOQUEADO |
| Arquitectura preparada para el recomendador | HECHO |
| Ventana de reproductores, precarga, poster, cero reproductores abandonados | HECHO |
| Resiliencia sin conexión | PARCIAL |

**Live — qué falta exactamente.** No hay infraestructura de directo en el
proyecto. Lo que existe es HLS de vídeo **ya grabado** (el backend empaqueta lo
subido y firma su playlist en `/media/{id}/hls/…`), que no sirve para emitir. La
pantalla `/live/[id]` que había reproducía un vídeo de ejemplo con un chat en
memoria: eso es una maqueta y el documento prohíbe presentarla como un directo.

Para encenderlo hace falta, por este orden:

1. Proveedor de directo (LiveKit, Mux, Cloudflare Stream…) con cuenta, claves y
   coste asumido.
2. Entidad `live_sessions` (emisor, estado, inicio/fin, grabación) con RLS.
3. Emisión de tokens de publicación/visionado desde el backend.
4. Moderación en directo y límites anti-abuso.

El contrato de datos ya está escrito en `src/feed/transmisiones.ts` y el
interruptor en `FEATURE_LIVE` (`src/config/features.ts`). Cuando exista
proveedor se implementa una sola función y se enciende el flag; la pantalla no
cambia.

**Resiliencia sin conexión — qué cubre y qué no.** `src/feed/cacheDeVideos.ts`
guarda una instantánea de «Para ti» (12 elementos, 3 días). Si la petición
falla, se ven portadas, autores y textos en lugar de una pantalla negra, y la
pantalla **dice** «Sin conexión · contenido guardado». Los vídeos no se
reproducen sin red: sus direcciones van firmadas y caducan, y los bytes no
están descargados.

Lo que **no** cubre: si el navegador no llega a descargar la aplicación
—el caso del dinosaurio de Chrome en el despliegue web—, no hay JavaScript
ejecutándose y ninguna caché de la aplicación puede ayudar. Eso necesita un
*service worker*, que Expo no genera por defecto. Queda anotado como siguiente
paso, no hecho.

## EXPLORAR

| Requisito | Estado |
|---|---|
| Recibe todo el contenido del Inicio anterior | HECHO |
| Buscador de personas | HECHO |
| «Tu siguiente paso» | HECHO |
| «Próximos eventos» | HECHO |
| «Comunidades» | HECHO |
| Fuera «Shorts de la comunidad» | HECHO |
| Sin duplicar el muro | HECHO |

El muro vive en **un solo** componente (`MuroDePublicaciones`), con su lista
virtualizada, su ventana de reproductores y su paginación. El buscador quedó
fijo fuera de la lista: dentro obligaba a subir hasta arriba para buscar.

## CREAR

| Requisito | Estado |
|---|---|
| Publicación / Historia / Reel / Vivo | HECHO (Vivo, BLOQUEADO) |
| Cambiar de tipo arrastrando el dedo | HECHO |
| El gesto no cambia de sección | HECHO |
| Permisos *just in time* | HECHO |
| Los cuatro estados de permiso | HECHO |
| Selector multimedia | HECHO |
| Subidas con progreso, reintento y cancelación | HECHO |
| Sin publicaciones duplicadas | HECHO |
| Reutiliza el pipeline de publicaciones | HECHO |
| Reutiliza el sistema de Stories | HECHO |

Lo que se mueve al arrastrar es la fila de nombres, no las cuatro pantallas: dos
de ellas llevan una cámara viva y no se pueden tener dos abiertas a la vez.

Un **reel es una publicación con vídeo**, no una entidad nueva: sale en el muro,
se comenta, se guarda y alimenta el Inicio. La migración `0022` amplía el CHECK
de `posts.body` para admitirlo sin pie de texto.

La cámara se desmonta en cuanto Crear deja de verse (el carrusel de secciones
mantiene montadas las vecinas).

## PERFIL

| Requisito | Estado |
|---|---|
| Foto centrada, nombre debajo | HECHO |
| Siguiendo · Seguidores · Me gusta | HECHO |
| «Me gusta» definido en backend | HECHO |
| Audio de presentación (crear, reemplazar, reproducir, pausar, eliminar) | HECHO |
| Categorías propias del podcast | HECHO |
| Cursos sin tocar | HECHO |
| «Agenda» en vez de «Agendar tu sesión» | HECHO |

**«Me gusta»** = los **recibidos** en las publicaciones del perfil, contados por
el backend (`likes_count`, solo publicaciones publicadas). No los que ha dado:
cuántos ha repartido alguien no dice nada de esa persona para quien la visita.

**Audio de presentación** (migración `0023`): se guarda la ruta en el bucket
`post-media` que ya existía, nunca el audio en Postgres ni una URL firmada. La
firma se pide al reproducir. Tope de un minuto con corte automático. El
micrófono se pide al tocar «grabar».

**Categorías** (migración `0024`): tabla `podcast_categories` con RLS. La
categoría de un episodio se sigue guardando en `posts.category`, que es texto
libre: ahí va el ID de la fila. Por eso las etiquetas antiguas
(`mente`/`cuerpo`/`dinero`) siguen siendo válidas y **nada de lo publicado
necesitó conversión**; sus audios aparecen en «Todos». Borrar una categoría no
borra sus audios.

## AGENDA

| Requisito | Estado |
|---|---|
| «Solicitudes de agenda» con aceptar/rechazar | HECHO |
| «Agenda · sesiones» (pedidas, próximas, confirmadas, histórico) | HECHO |
| Entidad persistente con estados | HECHO |
| Enum/contrato consistente | HECHO |
| Preparada para reseñas verificables | HECHO |

Migración `0025`. Estados: `pending`, `accepted`, `rejected`, `cancelled`,
`reschedule_requested`, `completed`, `expired`. Qué transición vale se declara
en una tabla (`app/modules/bookings/schemas.py::TRANSICIONES`), no en una cadena
de `if`, y está cubierta por 17 pruebas.

`completed_at` guarda que la sesión ocurrió: es lo único que hará verificable
una reseña posterior. Sin ese dato desde el principio, añadir reseñas obligaría
a reconstruir una historia que no existe.

Bloquear a alguien también corta la agenda. Dos toques en «Agendar» devuelven la
solicitud que ya existe en lugar de dejar dos idénticas en la bandeja ajena.

## NO CORRESPONDE A ESTA ITERACIÓN

| Requisito | Estado |
|---|---|
| Recommendation Engine avanzado | PENDIENTE |
| Compras, costos, monetización | PENDIENTE |
| Búsqueda semántica / pgvector | PENDIENTE |
| Reseñas y reputación | PENDIENTE (estructura preparada) |
| Rediseño de Cursos | PENDIENTE |

## MIGRACIONES APLICADAS

Las cuatro son **aditivas y repetibles**. Ninguna borra columnas ni filas.

| Migración | Qué hace | Aplicada |
|---|---|---|
| `0022_publicacion_sin_texto.sql` | Amplía el CHECK de `posts.body` a 0–3000 | Sí |
| `0023_audio_de_presentacion.sql` | 3 columnas nuevas en `profiles` | Sí |
| `0024_categorias_de_podcast.sql` | Tabla `podcast_categories` + RLS + índices | Sí |
| `0025_agenda_de_sesiones.sql` | Tabla `bookings` + RLS + índices | Sí |

Comprobado tras aplicarlas: 26 publicaciones conservadas, perfiles conservados,
avisos conservados.

## VALIDACIONES

| Comprobación | Resultado |
|---|---|
| `npx tsc --noEmit` (mobile) | 0 errores |
| `npm test` (mobile) | 61/61 |
| `pytest` (api) | 109/109 |
| `npx expo-doctor@latest` | 18/18 |
| `npm run build:web` | OK |

Antes de empezar el baseline era: tsc 0, mobile 55/55, api 44/44.

## CHECKLIST VIVO

```
INICIO
[x] Feed vertical
[x] Barra siempre visible
[x] Cabecera + / Para ti / Siguiendo / Live
[x] Para ti
[x] Siguiendo (4 casos)
[~] Live  (interfaz y contrato; sin infraestructura)
[x] Ventana de reproductores
[~] Sin conexión (contenido guardado; sin service worker en web)

EXPLORAR
[x] Buscador
[x] Contenido del Inicio anterior
[x] Tu siguiente paso
[x] Próximos eventos
[x] Comunidades
[x] Sin Shorts

CREAR
[x] Publicación
[x] Historia
[x] Reel
[~] Vivo  (sin infraestructura)
[x] Arrastre entre modos
[x] Permisos just in time (4 estados)
[x] Progreso / reintento / cancelación
[x] Sin duplicados

PERFIL
[x] Foto centrada + nombre
[x] Siguiendo / Seguidores / Me gusta
[x] Audio de presentación
[x] Categorías propias
[x] Cursos sin tocar

AGENDA
[x] Solicitudes
[x] Sesiones
[x] Estados y backend
[x] Preparada para reseñas
```
