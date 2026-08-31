# Medición de Mensajes y Explorar — 31 de agosto de 2026

Documento de **medición**, no de arreglo. No se ha tocado ni una línea de código
de la aplicación para escribirlo.

Existe porque quien prueba la aplicación dice que **Mensajes** y **Explorar** «se
sienten lentos», y porque otros agentes van a cambiar esas dos pantallas justo
después. La instrucción del encargo era literal: **no supongas causa, mide.** Así
que aquí no hay ninguna causa que no venga con su número al lado, y lo que no se
pudo medir está marcado como tal.

Se apoya en los dos documentos previos y no los repite:

- [`Z_DIAGNOSTICO_DE_LENTITUD.md`](Z_DIAGNOSTICO_DE_LENTITUD.md) — 25/08/2026.
- [`Z_AUDITORIA_RENDIMIENTO_2026-08.md`](Z_AUDITORIA_RENDIMIENTO_2026-08.md) — 27/08/2026.

De lo que decían aquellos, aquí se **vuelve a comprobar** lo que afecta a estas
dos pantallas, en vez de darlo por hecho. Dos cosas han cambiado desde entonces y
están medidas más abajo (§6).

## Resumen en cinco números

| | Medido |
|---|---|
| Consultas SQL para pintar **Mensajes** | **4**, y son cuatro con 3 conversaciones y con 80 |
| Consultas SQL para pintar **Explorar** (en frío) | **41** |
| Peticiones de red para pintar **Explorar** | **hasta 16**; Mensajes hace **1** |
| Coste de **un salto secuencial** de red | **~0,42 s** (mediana de 6 muestras) |
| Medios sin derivado ligero en una página del muro | **18,72 MB**, de los cuales 17,93 MB son un solo vídeo |

**La lentitud de estas dos pantallas no está en las consultas.** Está en el
número de peticiones encadenadas (Explorar) y en el trabajo de cliente por
pulsación (Mensajes). En el servidor, Mensajes es prácticamente gratis.

---

## 1. Cómo se midió cada cosa

Cuatro métodos. Cada número de este documento lleva escrito de cuál sale.

| Método | Qué da | Qué NO da |
|---|---|---|
| **(A) Contador de consultas SQL.** Banco temporal con un escucha `before_cursor_execute` de SQLAlchemy sobre SQLite en memoria, midiendo cada endpoint con **dos o tres tamaños de conjunto**. Si el número crece con el conjunto, hay N+1. Misma técnica que `tests/test_mensajes_rendimiento.py` y `test_feed_recomendado_rendimiento.py`. | Número exacto de consultas, y si el coste es constante o crece. | Tiempo real: contra SQLite son microsegundos. |
| **(B) Tamaño de respuesta real.** `len(response.content)` del mismo banco, con datos sembrados de longitud realista, y `curl` contra producción. | Bytes de JSON por endpoint y por fila. | Compresión en tránsito, que sí aplica en producción. |
| **(C) Lectura de código, contando peticiones por pantalla.** Se sigue cada `useEffect` / `useFocusEffect` hasta el `fetch`, y se anota si va en `Promise.all` (paralelo) o encadenado (cascada). | Cuántas peticiones hace una pantalla y en qué orden. | Cuánto tarda cada una, y los renders reales. |
| **(D) Medición contra la API de producción.** Solo lecturas, con `curl`, sin sesión. | Latencia y contenido real de hoy. | Todo lo que exija sesión (devuelve 401). |

**El banco de medición era temporal y está borrado.** No queda ningún fichero
nuevo en `apps/api/tests/`; se comprobó volviendo a correr
`test_mensajes_rendimiento.py` después (12 pruebas, en verde). Lo único que queda
de este trabajo es este documento.

> **Convención.** Cada tabla dice **MEDIDO** o **ESTIMADO**. Un número estimado
> lleva siempre de dónde sale. Un número que no se pudo obtener se escribe «no
> medido» y se explica qué haría falta.

### 1.1 La unidad que hace falta para leer el resto: el salto de red — MEDIDO (D)

Seis peticiones seguidas a cada backend, desde la máquina de desarrollo:

| Destino | Muestras (s) | Mediana |
|---|---|---|
| API (CloudFront → AWS us-east-1) | 0,712 · 0,439 · 0,422 · 0,358 · 0,418 · 0,328 | **0,42 s** |
| Supabase REST (PostgREST directo) | 0,747 · 0,372 · 0,342 · 0,433 · 0,437 · 0,476 | **0,43 s** |
| `/health` (no toca la base) | 0,562 · 0,331 · 0,310 | **0,33 s** |

Tres lecturas de esto:

1. **No hay arranque en frío.** El de 21,77 s del primer documento ha
   desaparecido: la primera petición del día costó 0,56 s, no 22 s. La migración
   a AWS hizo lo que decía que iba a hacer.
2. **Los dos backends cuestan lo mismo.** 0,42 s contra la API y 0,43 s contra
   Supabase. La diferencia no está en el backend: está en el trayecto hasta esta
   máquina. Es coste de cliente, no de servidor.
3. **Por eso lo que importa es el NÚMERO de saltos secuenciales.** Cada salto
   encadenado cuesta ~0,42 s aunque el servidor conteste al instante. Una cadena
   de cuatro son 1,7 s en los que no se puede pintar nada nuevo.

> **Aviso honesto sobre este número.** Está medido desde la máquina de
> desarrollo, con red fija. Un teléfono en red móvil paga más. Sirve para
> comparar cadenas entre sí y para poner un **suelo**, no para prometer tiempos
> de usuario final. Medir en un Android real sigue pendiente desde la auditoría
> de agosto y sigue sin poderse hacer desde aquí.

---

## 2. Mensajes

### 2.1 La garantía del backend SIGUE EN PIE — MEDIDO (A)

Lo primero que había que comprobar, porque estaba escrito en el documento de
agosto y no se podía dar por bueno tres rondas después.

`GET /api/v1/conversations`, contando consultas reales con tres tamaños de
bandeja sobre la misma base:

| Conversaciones en la bandeja | Consultas `SELECT` | ¿Crece? |
|---|---|---|
| 3 | **4** | — |
| 20 (una página completa) | **4** | no |
| 80 | **4** | no |

**Cuatro consultas, y son cuatro con 3 y con 80.** El coste es constante. Las
cuatro son: la página de conversaciones, los perfiles de los otros participantes
con un `IN`, los últimos mensajes con `row_number()` y los no leídos con un
`GROUP BY` (`apps/api/app/modules/messaging/lectura.py`).

La quinta y la sexta que el código admite —los resúmenes de mensajes sin texto y
la comprobación de esquema de adjuntos— **no llegaron a lanzarse**: solo se piden
si el último mensaje de alguna conversación va sin texto, que es el caso raro.

> **Conclusión: el backend de conversaciones no es el problema.** No hay N+1, no
> creció, y la prueba que lo vigila (`test_mensajes_rendimiento.py`) sigue en
> verde. **Esta garantía hay que conservarla: 4 consultas, constantes.**

### 2.2 Qué tamaño tiene la respuesta — MEDIDO (B)

Datos sembrados de longitud realista (nombre completo, ruta de avatar, último
mensaje de ~95 caracteres):

| Página | Bytes de JSON | Por fila | Consultas |
|---|---|---|---|
| `limit=10` | 4 691 B | 469 B | 4 |
| `limit=20` (por defecto) | **9 381 B** | 469 B | 4 |
| `limit=40` | 18 761 B | 469 B | 4 |
| `limit=80` | 37 521 B | 469 B | 4 |

**Una pantalla de Mensajes son 9,4 KB de JSON**, sin comprimir. No es el
problema: cabe de sobra en la primera ventana de congestión de una conexión.

Bajar el tamaño de página **no compraría nada en el servidor** —son 4 consultas
igualmente— y solo ahorraría bytes que no molestan. No hay motivo para tocarlo.

El historial de un chat, para comparar: `GET /conversations/{id}/messages?limit=30`
son **3 consultas** y **12 751 B** para 30 mensajes (425 B por mensaje).

### 2.3 Los avatares de la bandeja NO se firman — MEDIDO (C)

Ésta era una de las preguntas del encargo, y la respuesta es la buena.

`toConversation` (`apps/mobile/src/mappers/messageMapper.ts`) resuelve el avatar
con `profileImageUrl(dto.other?.avatar_path)`, y `profileImageUrl`
(`apps/mobile/src/services/storage.ts`, línea 729) hace esto:

```ts
return supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path, {
  transform: { width, height: width, resize: 'cover', quality: 75 },
}).data.publicUrl;
```

`getPublicUrl` **construye una cadena en local**. No hay petición. El bucket
`avatars` es público.

| Concepto | Peticiones en una página de 20 conversaciones |
|---|---|
| Firmas de avatar (`createSignedUrls`) | **0** |
| Firmas de adjuntos | **0** (la bandeja no pinta adjuntos) |
| **Total de peticiones de red para pintar Mensajes** | **1** |

**Cero firmas.** No se piden de una en una porque no se piden en absoluto. Y como
la URL lleva siempre los mismos parámetros de transformación, es **estable**: la
caché de disco acierta entre visitas. Se pide `width=160, quality=75` para un
círculo de 48 px, que es la corrección de la ronda anterior; aquí se confirma que
sigue aplicada a Mensajes.

> **Mensajes hace UNA petición de red para pintarse.** Es, con diferencia, la
> pantalla más barata de la aplicación. Cualquier explicación de su lentitud que
> apunte al servidor o a la red está mirando al sitio equivocado.

### 2.4 Dónde SÍ cuesta Mensajes: el cliente — ANÁLISIS DE CÓDIGO (C)

Estos números salen de leer `MessagesScreen.tsx` y aplicar las reglas de React,
**no de un perfilador**. Están marcados como tales y al final se dice qué haría
falta para medirlos de verdad.

**(a) Cada pulsación en el buscador vuelve a pintar la lista entera.**

`searchText` es estado del componente de pantalla. En cada tecla:

| Qué se recrea en cada pulsación | Consecuencia |
|---|---|
| `filteredConversations` — `.filter()` en el cuerpo del render, sin `useMemo` | `data` de `FlashList` cambia de identidad |
| `renderItem` — función flecha inline | `FlashList` no puede evitar repintar las celdas |
| `ListHeaderComponent` — elemento JSX inline | se reconstruye el buscador entero |
| `refreshControl` — elemento inline | se reconstruye |

La fila mide 48 px de avatar + 32 px de relleno + 1 px de borde = **81 px**, así
que en una pantalla de 812 px caben **7-8 filas visibles**. Escribir un nombre de
ocho letras son **8 renders completos × ~8 filas = ~64 renders de fila**, y
ninguna de las filas tiene `React.memo`.

**(b) Se recarga en CADA vuelta a la pantalla.**

```ts
useFocusEffect(useCallback(() => { void load(true); }, [load]));
```

Sin caché y sin tiempo de validez: **una petición a `/conversations` cada vez que
se enfoca Mensajes**. Salir a un chat y volver = 1 petición (4 consultas, 9,4 KB,
~0,42 s). El `silencioso = true` evita el parpadeo —eso ya está bien resuelto—
pero no evita la petición.

**(c) Los avatares usan `Image` de react-native, no `expo-image`.**

`MessagesScreen.tsx` importa `Image` de `react-native`. El resto de la aplicación
usa `expo-image` con `cachePolicy="memory-disk"`. Sin `recyclingKey`, una celda
reciclada por `FlashList` puede enseñar un instante el avatar de la fila
anterior. Es un efecto visual que se lee como lentitud aunque no lo sea.

**(d) La búsqueda filtra solo lo ya descargado.**

`conversations.filter(...)` corre sobre las 20 filas de la primera página. Buscar
a alguien de la conversación número 25 **no lo encuentra**, y además `onEndReached`
se desactiva mientras hay texto (a propósito, y bien razonado en el código). No es
un problema de rendimiento; es la razón por la que hace falta búsqueda en
servidor.

> **No medido:** el número real de renders y los milisegundos por render. Haría
> falta un perfilador de React (React DevTools Profiler o `Systrace` en un
> dispositivo). Las pruebas de móvil de este repositorio son
> `node --test` sobre `.mts`, sin renderizador, así que desde aquí no se puede.

### 2.5 Lo que costaría cada cosa nueva de la próxima ronda

El agente que toca Mensajes va a añadir cuatro cosas. Esto es lo que cuestan,
medido cuando se pudo y estimado —con la base de la estimación— cuando no.

#### Historias arriba — MEDIDO (A, B) para el servidor, ESTIMADO para el reloj

Hay **dos** implementaciones de historias y no cuestan lo mismo. Importa mucho
cuál se monte.

**Camino 1 — `StoriesRow` tal y como está hoy** (`StoryRepository.list()`, que va
**directo a Supabase**, no por la API). Leyendo el código, la secuencia es
estrictamente encadenada:

| # | Salto | ¿Puede ir en paralelo con el anterior? |
|---|---|---|
| 1 | `auth.getSession()` | local salvo que toque renovar |
| 2 | `select` sobre `stories` | — |
| 3 | `select` sobre `story_views` (las mías) | no: necesita los ids de (2) |
| 4 | `select` sobre `story_views` (contador de las propias) | **sí, y hoy no lo hace**: solo necesita (2) |
| 5 | `createSignedUrls` en lote | no: necesita las rutas de (2) |

**Cuatro saltos secuenciales.** A 0,43 s medidos por salto contra Supabase: **~1,7 s**
(estimado a partir de la latencia medida en §1.1). El salto 4 es gratis de
paralelizar y hoy espera al 3 sin necesidad.

**Camino 2 — `GET /api/v1/stories`** (el endpoint del backend, que ya agrupa por
autor y ya sabe si la has visto). Medido con el contador de consultas:

| Historias en la base | Consultas | Bytes | Por autor |
|---|---|---|---|
| 10 autores × 3 | **1** | 10 651 B | 1 065 B |
| 100 autores × 3 | **1** | 106 681 B | 1 067 B |
| 500 autores × 3 | **1** | **534 281 B** | 1 069 B |

**Una sola consulta, sin N+1** — pero **sin paginar y sin filtrar**. El coste no
está en las consultas: está en que la respuesta crece sin techo. Con 500 personas
publicando, abrir Mensajes descargaría **534 KB de historias** para enseñar las
cinco burbujas que caben en la fila. Hoy en producción `/stories` devuelve `[]`
(2 bytes), así que el problema no se ve; con la aplicación llena, sí.

> **Recomendación con número:** montar el camino 2 (**1 consulta**) y no el
> camino 1 (**4 saltos, ~1,7 s**), y añadirle `limit` antes de montarlo. A 1 067 B
> por autor, un `limit=20` deja la fila en **~21 KB** en vez de medio mega.

**Y un detalle que va a morder:** `loadStories` en `useAppStore.ts` **no tiene
guardia de petición en vuelo**, al contrario que `loadFeed` (que sí tiene
`feedInFlight`). Si `StoriesRow` se monta en Explorar y en Mensajes, y las dos
pestañas se montan, son **dos cascadas completas** en vez de una.

#### Chips del CRM — ESTIMADO

`GET /api/v1/conversations` va a aceptar `label_id`, y las etiquetas se pintan
como chips sobre cada fila. Dos formas de resolverlo y un orden de magnitud entre
ellas:

| Forma | Peticiones extra | Consultas extra | Comentario |
|---|---|---|---|
| Devolver las etiquetas **dentro** de `ConversationRead`, con un `IN` sobre los ids de la página | **0** | **+1** (de 4 a 5) | Es exactamente el patrón que ya usan `otros_participantes` y `no_leidos` |
| Pedir las etiquetas de cada conversación por separado | **+20** por página | +20 | Es el N+1 que `lectura.py` existe para impedir |
| Una petición aparte con la lista de etiquetas del usuario, en paralelo con la bandeja | +1 (paralela, no cascada) | +1 | Aceptable si es catálogo de etiquetas, no asignaciones |

**El número que importa: +1 consulta.** Una quinta consulta con un `IN` sobre los
ids que ya se tienen no rompe la garantía de coste constante, porque no depende
del tamaño de la lista. Cualquier otra forma sí.

La barra de chips en sí (filtros `unread` / `unanswered` / `story_replies`)
**no cuesta ninguna petición** mientras el filtro se aplique en la misma consulta
del listado, con un `WHERE` más. Si se aplica en el teléfono sobre lo ya
descargado, cuesta 0 peticiones pero **miente**: el filtro solo ve las 20 filas
de la primera página, igual que le pasa hoy a la búsqueda (§2.4d).

#### Búsqueda en servidor — ESTIMADO

Hoy: 0 peticiones (filtra en local) y resultados incompletos.
Con `q` en el servidor: **1 petición por búsqueda**, ~0,42 s.

El número a vigilar es **cuántas búsquedas se lanzan por palabra escrita**. Sin
antirrebote, escribir «martinez» son **8 peticiones**. Con antirrebote son 1 o 2.
La aplicación **ya tiene resuelto esto** en `lib/busquedaProgresiva.ts`
(`ESPERA_DE_TECLEO_MS` y un sello por petición que impide que la respuesta lenta
de «mart» pise a la de «martinez»); lo usa `ExploreScreen` y lo usa
`SearchScreen`. **No hay que inventar nada: hay que reutilizarlo.**

En el servidor, buscar por nombre y usuario del otro participante es **una
condición más en la consulta que ya se hace**: 4 consultas, no 5.

#### Filtros derivados — MEDIDO (A) por analogía

`unread` y `unanswered` se pueden resolver dentro de las consultas que ya
existen: `no_leidos` ya calcula el umbral por conversación con un `JOIN`, y
`ultimos_mensajes` ya sabe quién escribió el último. **Coste esperado: 0
consultas extra.** `story_replies` necesita mirar `message_story_context`, que es
**+1 consulta** o una condición en la que ya se hace.

#### El total de Mensajes después de la ronda

| | Hoy (medido) | Con lo nuevo (estimado) |
|---|---|---|
| Peticiones de red para pintar | **1** | **2** (bandeja + historias por API) |
| Consultas SQL | **4** | **5–6** |
| Bytes | 9,4 KB | 9,4 KB + ~21 KB de historias con `limit=20` |
| Saltos secuenciales | 1 | 1, **si las dos peticiones salen a la vez** |

**Ese «a la vez» es toda la diferencia.** Si la fila de historias espera a que
llegue la bandeja, son dos saltos: ~0,84 s en vez de ~0,42 s. Nada obliga a
encadenarlas.

---

## 3. Explorar

### 3.1 Qué pide la pantalla, en qué orden — ANÁLISIS DE CÓDIGO (C) + MEDIDO (A, D)

`ExploreScreen.tsx` no hace una petición: orquesta once, repartidas en cinco
disparadores independientes. Las consultas SQL están medidas con el método A **en
frío** (caché del recomendador vacía), que es lo que paga quien abre la
aplicación.

| # | Petición | Disparador | Espera a | SQL (frío) |
|---|---|---|---|---|
| 1 | `GET /posts?limit=20&…&with_reposts=true` | `MuroDePublicaciones`, al montar | — | **8** |
| 2 | firma en lote de medios del muro | tras (1) | **(1)** ⟵ cascada | — |
| 3 | `stories` (Supabase directo) | `StoriesRow`, al montar | — | fuera de la API |
| 4 | `story_views` (mías) | tras (3) | **(3)** ⟵ cascada | fuera de la API |
| 5 | `story_views` (propias) | tras (4) | **(4)** ⟵ cascada *innecesaria* | fuera de la API |
| 6 | firma en lote de historias | tras (5) | **(5)** ⟵ cascada | — |
| 7 | `GET /notifications/unread-count` | `useFocusEffect`, **cada foco** | — | **1** |
| 8 | `GET /recommendations/courses` | `CursosParaTi`, al montar | — | **11** |
| 9 | `GET /recommendations/onboarding/catalog` | `CursosParaTi` (paralelo con 8) | — | **1** |
| 10 | firma de portadas de cursos | tras (8) | **(8)** ⟵ cascada | — |
| 11 | `GET /recommendations/people` | `PersonasParaTi`, al montar | — | **15** |
| 12 | `GET /catalog/courses` | `cargarDestacados`, **+600 ms** | temporizador | **2** |
| 13 | `GET /catalog/events?limit=50` | `cargarDestacados` (paralelo) | temporizador | **1** |
| 14 | `GET /circles` | `cargarDestacados` (paralelo) | temporizador | **1** |
| 15 | `GET /profiles/featured` | `cargarDestacados` (paralelo) | temporizador | **1** |
| 16 | firma de portadas del catálogo | tras (12) | **(12)** ⟵ cascada | — |
| | | | **Total** | **41** |

**Hasta 16 peticiones de red y 41 consultas SQL para pintar una pantalla.**
Mensajes hace 1 petición y 4 consultas.

Hoy en producción `/stories` devuelve `[]`, así que los pasos 4, 5 y 6 no llegan
a lanzarse y son 12 peticiones. En cuanto haya historias, son 16.

### 3.2 Dónde está la cascada — ANÁLISIS DE CÓDIGO (C), coste ESTIMADO desde §1.1

Cuatro cadenas. Ninguna de las cuatro espera a otra —eso está bien—, pero dentro
de cada una hay saltos que sí se esperan entre sí.

| Cadena | Saltos | Coste estimado (0,42 s/salto) | ¿Es evitable? |
|---|---|---|---|
| Muro: `/posts` → firma en lote | 2 | ~0,84 s | **No del todo.** Es deliberado y está bien: la primera fase pinta el texto (`withMediaUrls: false`) y la segunda rellena las fotos. El texto no espera a Storage. |
| Historias: `stories` → `story_views` → `story_views` → firma | **4** | **~1,7 s** | **Parcialmente.** Los dos `story_views` son independientes entre sí y hoy uno espera al otro sin necesidad: **3 saltos en vez de 4** con un `Promise.all`. |
| Cursos para ti: `/recommendations/courses` → firma | 2 | ~0,84 s | No: la firma necesita las rutas. |
| Catálogo: **espera de 600 ms** → `/catalog/courses` → firma | 2 + espera | **~1,44 s** | Sí, la espera. |

**La espera de 600 ms merece párrafo aparte.** Está escrita a propósito y el
comentario del código la razona bien: el catálogo es contenido secundario y no
debe competir con el muro por la conexión. Pero el razonamiento era de cuando el
servidor tardaba en despertar. Hoy:

- `/catalog/events` responde en **0,392 s** (medido contra producción).
- La tarjeta de programa, la lista de eventos y la del círculo enseñan texto de
  relleno («Muy pronto habrá contenido disponible») durante **600 ms + 0,39 s ≈ 1,0 s
  como mínimo**, y luego cambian de golpe.

Un segundo de texto de relleno que se sustituye solo es exactamente lo que se
siente como una pantalla lenta, aunque el servidor haya contestado en 0,39 s.

### 3.3 Catálogos completos para pintar dos filas — MEDIDO (B, D)

Contra producción, hoy:

| Petición | Trae | La pantalla usa | Se descarta |
|---|---|---|---|
| `GET /catalog/events?limit=50` | 8 eventos, **5 511 B** | `nextEvents.slice(0, 2)` → **2** | 6 de 8 |
| `GET /catalog/courses` | 4 cursos, **2 319 B** | `cursos.value[0]` → **1** | 3 de 4 |
| `GET /circles` | **0 círculos**, 2 B | `circulos.value[0]` | — |
| `GET /profiles/featured` | 1 perfil, 258 B | solo `id` (para saber quién es el admin) | 257 de 258 B |

Y el techo, medido en el banco con 60 eventos sembrados:

> `GET /catalog/events?limit=50` devuelve **39 081 B** — para pintar **dos filas**.

El `limit=50` está escrito en `CatalogRepository.listEvents()` y lo comparten
`EventsScreen` (que sí los usa todos) y `ExploreScreen` (que usa dos). Hoy cuesta
4,1 KB de más; con la agenda llena costará 37 KB de más.

**Un hallazgo que no es de rendimiento pero sale de la misma medición:**
`/circles` devuelve lista vacía en producción, así que la tarjeta «Tu círculo» de
Explorar **nunca se rellena**: siempre dice «únete a la comunidad» y su `onPress`
está deshabilitado. Se pagan una petición y una consulta por una tarjeta que hoy
no puede funcionar.

### 3.4 Lo que de verdad cuesta en el servidor: el recomendador — MEDIDO (A)

De las 41 consultas de Explorar, **26 son de dos endpoints**. Y hay una diferencia
enorme entre la primera petición y las siguientes, porque el ranking se cachea:

| Endpoint | 1ª petición (caché vacía) | 2ª petición (caché caliente) |
|---|---|---|
| `GET /recommendations/people` | **15 consultas** | **0** |
| `GET /recommendations/courses` | **11 consultas** | 8 |
| `GET /recommendations/content` | 25 consultas | 5 |

`people` + `courses` = **26 de las 41 consultas de la pantalla (63 %)**, y las dos
alimentan carruseles secundarios que además **desaparecen si vienen vacíos**
(`if (estado === 'listo' && visibles.length === 0) return null`).

Es decir: se pueden pagar 26 consultas para no pintar nada. No se pudo comprobar
si en producción vienen vacíos, porque los dos endpoints exigen sesión y devuelven
401 sin token. **No medido**; haría falta un token de una cuenta de prueba.

### 3.5 Los esqueletos y el salto de maquetación — ANÁLISIS DE CÓDIGO (C)

| Sección | Mientras carga | Si viene vacía |
|---|---|---|
| Muro | 2 tarjetas de esqueleto, y **solo si no hay nada guardado** (`feedStatus === 'loading' && posts.length === 0`) | mensaje de vacío |
| `CursosParaTi` | carrusel de esqueletos | **desaparece entera** |
| `PersonasParaTi` | carrusel de esqueletos | **desaparece entera** |
| Catálogo (programa, eventos, círculo) | **texto de relleno**, no esqueleto | se queda el texto de relleno |

**Lo que está bien y conviene no romper:** la estructura principal **no espera a
nada**. La cabecera (historias, pestañas, compositor, tarjetas rápidas) y el pie
se pintan de inmediato; el esqueleto del muro va en `ListEmptyComponent`, así que
ocupa el hueco de la lista y no tapa el resto. Además `hydrateFeedFromCache`
pinta la instantánea guardada del arranque anterior antes de que llegue la red.
**El muro no es un esqueleto que se quede puesto: es contenido viejo que se
sustituye.** Eso es lo correcto.

**Lo que sí cuesta:** los dos carruseles «para ti» reservan alto, enseñan
esqueletos y luego **se van**. La página se encoge debajo del dedo. Un esqueleto
que se convierte en nada es peor que no haber puesto esqueleto: promete contenido
que no llega y mueve todo lo que hay debajo.

> **No medido:** cuántos milisegundos duran esos esqueletos en un teléfono real, y
> cuántos píxeles salta la maquetación. Haría falta grabar la pantalla en un
> dispositivo o instrumentar `onLayout`.

### 3.6 Los medios del muro: lo que queda del problema de agosto — MEDIDO (D)

La auditoría de agosto dejó como pendiente número uno «rellenar los derivados de
los 16 medios publicados». **Se comprobó, y está hecho en su mayor parte.**
Leyendo la primera página del muro en producción (18 publicaciones, 16 medios):

| | Agosto | Hoy |
|---|---|---|
| Medios con `width` / `height` / `bytes` | 0 de 16 | **16 de 16** |
| Medios con `feed_path` (derivado ligero) | 0 de 16 | **11 de 16** |
| Vídeos con `poster_path` | 0 de 3 | **5 de 5** |
| Vídeos con `stream_path` (HLS) | 0 de 3 | 3 de 5 |

Lo que queda, con los bytes del original de cada uno:

| Tipo | Tamaño original | `feed_path` | `stream_path` |
|---|---|---|---|
| vídeo 1920×1080 | 160,99 MB | sí | sí |
| vídeo 1920×1080 | 100,60 MB | sí | sí |
| vídeo 1920×1080 | 96,39 MB | sí | sí |
| **vídeo 720×1280** | **17,93 MB** | **NO** | **NO** |
| imagen 3060×4080 | 6,01 MB | sí | — |
| imagen 4032×3024 | 2,96 MB | sí | — |
| ... (7 imágenes más con derivado) | | sí | — |
| **vídeo 720×1280** | **0,61 MB** | **NO** | — |
| **3 imágenes pequeñas** | **0,18 MB** | **NO** | — |
| **Total sin derivado** | **18,72 MB** | | |

El mapeador elige `first.feed_path ?? first.storage_path`
(`apps/mobile/src/mappers/postMapper.ts:181`): **sin derivado se sirve el
original**. Y el muro reproduce los vídeos solos al aparecer en pantalla, así que
ese vídeo de **17,93 MB** se descarga al desplazarse hasta él, no solo si alguien
lo toca.

Los 395 MB de originales de la página **no se descargan**: los tres vídeos
grandes tienen HLS y derivado, y ahí el sistema funciona. El problema es el 5 % que
se quedó fuera.

> **En una frase:** de las tres causas de agosto, la de las imágenes está
> resuelta en un 69 % de los medios (11 de 16) y lo que queda son **cinco
> medios, 18,72 MB, y uno solo se lleva 17,93 de esos MB.**

---

## 4. Lo que de verdad cuesta, ordenado

Separado por dónde está el coste, porque cada sitio se arregla de una manera
distinta y no compiten por el mismo tiempo.

### Cliente y red (donde está casi todo)

| # | Coste | Número | Pantalla |
|---|---|---|---|
| 1 | **Saltos de red encadenados** | 4 cadenas; la peor son 4 saltos ≈ **1,7 s** | Explorar |
| 2 | **Espera deliberada de 600 ms** + 1 salto antes de pintar el catálogo | **~1,0 s** de texto de relleno | Explorar |
| 3 | **Un vídeo sin derivado ni HLS** que se reproduce solo al aparecer | **17,93 MB** | Explorar (muro) |
| 4 | **Catálogos completos para dos filas** | 5,5 KB hoy, **39 KB** con la agenda llena | Explorar |
| 5 | **Repintado de la lista en cada pulsación** | ~8 filas × cada tecla, sin `memo` ni `useMemo` | Mensajes |
| 6 | **Recarga en cada foco** | 1 petición (~0,42 s) por vuelta a la pantalla | Mensajes |

### Servidor

| # | Coste | Número | Pantalla |
|---|---|---|---|
| 7 | **Recomendador en frío** | **26 consultas** de las 41 (63 %) | Explorar |
| 8 | El resto de Explorar | 15 consultas | Explorar |
| 9 | Toda la bandeja de Mensajes | **4 consultas** | Mensajes |

**El orden importa.** Los seis primeros son de cliente y de red, y suman
segundos. Los tres últimos son de servidor, y contra una base que responde bien
son décimas. **Optimizar el SQL de estas dos pantallas no arreglaría nada
perceptible.**

---

## 5. Lo que NO explica la lentitud

Igual de importante que lo anterior, para que nadie cierre la investigación antes
de tiempo persiguiendo lo que ya se descartó **con números**.

### «Hay un N+1 en algún sitio» — FALSO, MEDIDO (A)

Ocho endpoints, cada uno con dos tamaños de conjunto (6 y 60 elementos). **Ni uno
creció.**

| Endpoint | Con 6 | Con 60 | ¿Crece? |
|---|---|---|---|
| `/conversations` | 4 | 4 | no |
| `/catalog/courses` | 2 | 2 | no |
| `/catalog/events?limit=50` | 1 | 1 | no |
| `/circles` | 1 | 1 | no |
| `/profiles/featured` | 1 | 1 | no |
| `/posts` con la URL exacta de la aplicación | 8 | 8 | no |
| `/search?q=…` | 9 | 9 | no |
| `/recommendations/people` (caché vacía) | 15 | 15 | no |
| `/recommendations/courses` (caché vacía) | 11 | 11 | no |

Y `/stories`, medido aparte con 10, 100 y 500 autores: **1 consulta en los tres
casos**. No crece en consultas —solo en bytes, que es otro problema y está en
§2.5.

Los listados están bien construidos. **Buscar un N+1 en el backend es perder el
tiempo.**

### «Es el arranque en frío de Render» — YA NO, MEDIDO (D)

`/health` en la primera petición del día: **0,562 s**. Los 21,77 s de agosto han
desaparecido. La migración a AWS funcionó.

### «Es que la base está lejos» — YA NO, MEDIDO (D)

`/health` (que no toca la base) 0,33 s y `/circles` (que sí) 0,42 s: **~0,09 s de
diferencia**, no los 0,35 s que costaba cruzar el país en agosto.

### «Las respuestas son enormes» — FALSO, MEDIDO (B, D)

| Respuesta | Bytes |
|---|---|
| Bandeja de 20 conversaciones | 9 381 B |
| 30 mensajes de un chat | 12 751 B |
| Muro de 20 publicaciones | 16 588 B |
| Catálogo de cursos entero | 2 319 B |
| Los 8 eventos | 5 511 B |

**Todo por debajo de 17 KB.** El JSON no es el problema en ninguna de las dos
pantallas. (La excepción futura es `/stories` sin paginar: 534 KB con 500
autores. Hoy son 2 bytes.)

### «Los avatares se firman uno a uno» — FALSO, MEDIDO (C)

Cero firmas en Mensajes. El bucket `avatars` es público y la URL se construye en
local. Ver §2.3.

### «Las imágenes se sirven a tamaño original» — YA CASI NO, MEDIDO (D)

11 de 16 medios del muro tienen derivado ligero, los 16 tienen dimensiones y
peso, y los 5 vídeos tienen póster. Queda un 31 % sin derivado, casi todo el peso
concentrado en **un** vídeo. Ver §3.6.

### «Es que se pide demasiadas veces lo mismo» — FALSO PARA ESTAS DOS PANTALLAS

Las deduplicaciones de la ronda anterior siguen puestas y se comprobaron leyendo
el código: `signMediaUrls` tiene mapa de firmas en vuelo y caché persistente,
`pedirDestacados` tiene caché de 10 minutos compartida por cinco pantallas, y
`loadFeed` tiene guardia `feedInFlight`. **La única excepción encontrada es
`loadStories`, que no tiene guardia** (§2.5).

---

## 6. Recomendaciones

Cada una con el número que la justifica. Sin número no es una recomendación: es
una opinión, y no se escribe aquí.

### Para quien toca Mensajes

| # | Recomendación | El número que la justifica |
|---|---|---|
| M1 | **Conservar las 4 consultas.** Las etiquetas del CRM se resuelven con **una** consulta más y un `IN` sobre los ids de la página, como ya hacen `otros_participantes` y `no_leidos`. Nunca una consulta por conversación. | 4 constantes con 3 y con 80. Una por conversación serían **24 con 20 filas**. |
| M2 | **La fila de historias, por `GET /api/v1/stories` y no por `StoryRepository`.** | 1 consulta y 1 salto, contra **4 saltos ≈ 1,7 s** del camino actual. |
| M3 | **Antes de montarla, poner `limit` a `/stories`.** | **534 281 B** con 500 autores. Con `limit=20`, ~21 KB. |
| M4 | **Lanzar bandeja e historias a la vez**, nunca encadenadas. | 1 salto (~0,42 s) contra 2 (~0,84 s). |
| M5 | **Añadir guardia de petición en vuelo a `loadStories`**, como la que tiene `loadFeed`. | Sin ella, dos pantallas con `StoriesRow` montado son **2 cascadas** en vez de 1. |
| M6 | **`useMemo` para la lista filtrada, `useCallback` para `renderItem`, y `React.memo` en la fila.** | ~8 filas repintadas **por pulsación**; ocho letras son ~64 renders de fila. |
| M7 | **Sacar el buscador a su propio componente** para que su estado no repinte la lista. | Mismo número que M6, y es la forma barata de conseguirlo. |
| M8 | **Reutilizar `lib/busquedaProgresiva.ts`** para la búsqueda en servidor. | Sin antirrebote, «martinez» son **8 peticiones**; con él, 1 o 2. Ya está escrito y probado. |
| M9 | **Los filtros (`unread`, `unanswered`), dentro de la consulta que ya se hace.** | **+0 consultas**: `no_leidos` ya calcula el umbral y `ultimos_mensajes` ya sabe quién escribió el último. Filtrar en el teléfono cuesta 0 pero solo ve 20 filas. |
| M10 | **No bajar el tamaño de página.** | 4 consultas con `limit=10` y con `limit=80`. Bajarlo no compra nada y obliga a paginar antes. |
| M11 | **Poner tiempo de validez al `useFocusEffect`** (p. ej. no recargar si hace menos de 30 s). | 1 petición y ~0,42 s por cada vuelta a la pantalla, hoy sin condición. |
| M12 | **Cambiar `Image` de react-native por `expo-image` con `recyclingKey`.** | El resto de la aplicación ya lo hace; sin `recyclingKey`, `FlashList` enseña un instante el avatar de la fila anterior al reciclar. |

### Para quien toca Explorar

| # | Recomendación | El número que la justifica |
|---|---|---|
| E1 | **Quitar la espera de 600 ms de `cargarDestacados`.** | Nació cuando el servidor tardaba en despertar; hoy `/catalog/events` responde en **0,392 s** y esos 600 ms son un segundo de texto de relleno regalado. |
| E2 | **Pedir a `/catalog/events` solo lo que se pinta** (`limit=2` desde Explorar). | **39 081 B** con la agenda llena, para dos filas. Hoy 5 511 B para dos filas. |
| E3 | **Igual con `/catalog/courses`.** | 4 cursos (2 319 B) para usar `[0]`. |
| E4 | **No pedir `/circles` desde Explorar mientras devuelva vacío**, o quitar la tarjeta. | 0 círculos en producción: 1 petición y 1 consulta por una tarjeta que hoy no puede abrirse. |
| E5 | **Paralelizar los dos `story_views`** de `StoryRepository.list()` si se mantiene ese camino. | **4 saltos → 3**. Uno de los dos no depende del otro. |
| E6 | **Procesar los 5 medios sin `feed_path`**, empezando por el vídeo de 17,93 MB. | **18,72 MB** en una página del muro, de los que 17,93 MB son uno solo, y el muro lo reproduce solo al aparecer. Es `scripts/procesar_media.py` con la `service_role` key. |
| E7 | **Reservar hueco fijo a los carruseles «para ti», o no pintar esqueleto.** | Hoy reservan alto, enseñan esqueleto y **desaparecen** si vienen vacíos: la página se encoge debajo del dedo. |
| E8 | **Medir si el recomendador devuelve algo en producción antes de optimizarlo.** | **26 de 41 consultas (63 %)** en dos endpoints cuyas secciones desaparecen si vienen vacías. Si vienen vacías, es el mejor recorte disponible; si no, no se toca. |

### Lo que hay que medir y desde aquí no se pudo

1. **El recomendador en producción.** `/recommendations/people` y
   `/recommendations/courses` devuelven 401 sin sesión. Hace falta un token de una
   cuenta de prueba para saber si esas 26 consultas producen algo o no.
2. **Renders y FPS en un Android real.** Las pruebas de móvil de este repositorio
   son `node --test` sobre ficheros `.mts`, sin renderizador de React. Hace falta
   React DevTools Profiler sobre un dispositivo.
3. **El peso real de los derivados `feed_path`.** El bucket `post-media` es
   privado y firmar exige sesión; solo se pudo leer el peso de los **originales**
   (que el API sí expone en `bytes`).
4. **Latencia desde un teléfono en red móvil.** Los 0,42 s de §1.1 son desde la
   máquina de desarrollo por red fija: son un suelo, no el número del usuario.

---

## 7. Estado de las pruebas al terminar

| | Resultado |
|---|---|
| `test_mensajes_rendimiento.py` (la que vigila el coste constante) | **12 pruebas, en verde** |
| Ficheros nuevos dejados en el repositorio | **ninguno** — el banco de medición se borró |
| Código de la aplicación modificado | **ninguno** |
