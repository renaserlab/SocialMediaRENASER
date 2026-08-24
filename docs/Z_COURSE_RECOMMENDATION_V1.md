# Plataforma de cursos — estado técnico

Rama: `Edson`. Continúa [Z_RECOMMENDATION_V1_1.md](Z_RECOMMENDATION_V1_1.md).

**Estado.** La plataforma de cursos y el **CourseRanker `course-v1`** están
implementados. El ranker se construyó *después* de arreglar el dominio, a
propósito: poner un ranker encima de un sitio donde crear un curso lo publicaba
vacío y donde un curso de pago se regalaba habría sido ordenar cosas rotas.

Migraciones `0026`, `0027` y `0028`: **aplicadas** (24/08/2026).

---

## 1. Los cuatro problemas que había

| Qué pasaba | Consecuencia real |
|---|---|
| `POST /catalog/courses` escribía `status='published'` | Rellenar el título publicaba en el catálogo un curso sin un solo módulo |
| `/enroll` creaba `Purchase(status='paid', amount_minor=0)` sin mirar el precio | **Un curso de pago se conseguía gratis.** Y lo llamaba el botón «Empezar curso» |
| `CourseScreen`/`LessonScreen` daban la gestión por `isAdmin` | Quien creaba un curso no podía tocarlo. El detalle ni siquiera devolvía `author_id` |
| La escritura en `course-media` estaba reservada a administración | Un autor podía crear módulos y lecciones y no subir un solo vídeo |

Y dos más que aparecieron auditando:

- `progress_seconds` existía desde la migración `0001` y **nadie lo escribía**.
  `LearningRepository.completeLesson()` no se llamaba desde ninguna pantalla.
  Un curso se podía ver entero y seguir marcando 0 %.
- `LessonDetailRead` no devolvía `body`, así que la descripción de una lección
  se guardaba correctamente y **desaparecía al recargar**.

---

## 2. Ciclo de vida del curso

```
CREAR ──► draft ──► [módulos · lecciones · recursos · temas · precio] ──► PUBLISH
                                                                            │
                                                    validación EN EL SERVIDOR
                                                                            │
                                                                     published
                                                                            │
                                                          UNPUBLISH ──► hidden
```

Se reutiliza el enum `content_status` que ya existía. Nada de un enum nuevo.

- **`draft`** — nunca ha estado publicado. Solo lo ve su autor
  (`courses_read`, migración `0001`, ya lo permitía).
- **`hidden`** — estuvo publicado y se retiró. Se conserva la diferencia con
  `draft` porque es la única pista de que alguien ya lo vio.
- **`coming_soon`** es una columna aparte (`0014`), no un estado: significa
  «visible pero sin contenido», que no es lo mismo que «no visible».

### Qué valida `POST /catalog/courses/{id}/publish`

Título, descripción de 30 caracteres o más, ≥1 módulo, ≥1 lección, y ≥1 tema
**solo si la `0028` está aplicada** (exigir algo imposible de guardar
congelaría el catálogo).

Devuelve `published: false` con la lista completa de lo que falta, no un 4xx:
el motivo es lo único útil, y decirlos de uno en uno es la forma más rápida de
que alguien abandone a medias.

---

## 3. Autoría y permisos

El permiso funcional es **`author_id == uid` OR admin**, y está en tres capas
que dicen lo mismo:

| Capa | Qué protege |
|---|---|
| RLS (`courses_write`, `course_modules_write`, `course_lessons_write`, `course_lesson_resources_write`, `course_topics_write`) | Manda de verdad. El contenido se escribe por PostgREST |
| `require_owner_or_admin` en los endpoints | Las escrituras que pasan por la API |
| `can_manage` en la respuesta | **Solo la interfaz.** Para no enseñar botones que van a dar 403 |

`can_manage` viaja en `CourseDetailRead` y en `LessonDetailRead`. La pantalla
de lección se abre por su id sin conocer el curso, así que sin ese campo
tendría que pedir el curso entero solo para decidir si pinta un lápiz.

---

## 4. Temas del curso

`course_topics` (migración `0028`) sobre la **misma** taxonomía `topics` de la
`0026`. Tabla propia y no `post_topics` reutilizada: compartir la fila
obligaría a que su clave apuntase a dos tablas según el caso, que es como se
pierde la clave foránea.

- Máximo **5** por curso (`MAX_TEMAS_POR_CURSO`), frente a 3 por publicación:
  un curso dura semanas y toca varias cosas de verdad.
- `source` solo vale `'manual'` hoy. `'auto'` está reservado para cuando exista
  un clasificador real; escribirlo antes sería firmar como automático algo que
  no lo es.
- **Los cursos existentes no se clasifican.** Deducir el tema del título sería
  convertir una suposición en un dato declarado.

---

## 5. Acceso: gratis, de pago, y el agujero que había

La verdad vive en `public.has_course_access()` (migración `0016`), que protege
los **archivos** aunque alguien llame al almacenamiento saltándose la app.
Cuatro vías: gratuito, autor, administración, compra `paid`.

`pending` **no** da acceso: un cobro iniciado y no completado no es un cobro.

### El agujero

`POST /learning/courses/{id}/enroll` creaba la fila de acceso para cualquier
curso sin mirar `price_minor`. El muro de pago de la `0016` estaba bien hecho;
esta puerta lo rodeaba por dentro. Ahora:

```
price_minor == 0  →  entitlement gratuito permitido
price_minor  > 0  →  403 course_requires_purchase
```

La fila sigue siendo un `Purchase` porque es lo que ya consulta
`has_course_access()`. Representa un **derecho de acceso gratuito**, no un
cobro: `provider='manual'`, `amount_minor=0`. Ni un céntimo cambió de manos.

Cuando exista pasarela, el camino de un curso de pago será
`/payments/checkout` y su webhook. Nunca `/enroll`.

---

## 6. Precio

`price_minor` (centavos) + `currency`, de extremo a extremo.

El contrato anterior recibía `price` entero en unidad mayor y multiplicaba por
100, así que **49.90 no se podía expresar**: llegaba 49 y se guardaba 4900. Y
en el móvil `Math.round(price_minor / 100)` convertía 4990 en 50.

`lib/dinero.ts` concentra el cálculo y **compone con enteros**: `Number('49.90')
* 100` da `4989.999999999999`, y truncar eso pierde un céntimo por curso
siempre en la misma dirección.

`price` se sigue aceptando en la API para los clientes ya instalados; si vienen
los dos, manda `price_minor`.

---

## 7. Pagos — el bloqueo, dicho claro

| Pieza | Estado |
|---|---|
| 1. Modelo de precio | **HECHO** — `price_minor` + `currency`, unidad menor |
| 2. Muro de pago | **HECHO** — `has_course_access()` en la base, migración `0016` |
| 3. Dominio de compras | **HECHO** — `purchases` con estados y `ON DELETE RESTRICT` |
| 4. `PaymentProvider` | **PARCIAL** — el contrato existe; el registrado es `NotConfiguredProvider` |
| 5. Checkout | **BLOQUEADO** — sin pasarela |
| 6. Webhook | **BLOQUEADO** — sin pasarela que firme |
| 7. Facturación nativa | **NO IMPLEMENTADO** |

**Qué falta y no es código:** elegir pasarela, abrir cuenta, credenciales,
comisiones, países, y decidir el canal (cobrar contenido digital dentro de la
app obliga a la facturación de Google Play / App Store). Es una decisión de
negocio, no una tarea.

Mientras tanto: `payments_enabled = false`, `FEATURE_PURCHASES = false`, y
**ningún botón de comprar**. Un curso de pago sin acceso dice lo que es y nada
más.

> **Configurar un precio y cobrarlo son dos cosas distintas.** El creador puede
> declarar que su curso vale S/ 49.90 aunque las ventas estén apagadas: eso es
> un dato del curso. Lo que no se hace es ofrecer a nadie un checkout que no
> lleva a ninguna parte.

Se quitó **«Incluido en tu membresía»** de `CourseScreen`. No existe ninguna
membresía en el backend: ni tabla, ni suscripción, ni derecho de acceso que se
llame así.

---

## 8. Progreso

`lesson_progress` (ya existía). Se reutiliza; no hay tabla nueva.

**Las reglas viven en `app/modules/learning/progreso.py`**, en un sitio:

- `UMBRAL_DE_COMPLETADO = 0.92`. Ni 100 % —los créditos no hacen falta— ni
  80 %, que se alcanza dejándolo de fondo.
- Los segundos se **acotan a la duración real**. Sin ese tope, mandar 999999
  marcaba cualquier curso como terminado y envenenaba justo lo que se quiere
  medir.
- Una lección sin duración declarada no se completa sola: no hay contra qué
  comparar.
- El porcentaje no miente en los extremos: empezado no es 0 %, y al 99 % no es
  100 %.

`PUT /learning/lessons/{id}/progress` es **idempotente** y exige acceso al
curso. Se guarda el **máximo**, no el último: rebobinar para repasar no es
perder lo avanzado.

### Ritmo (móvil)

`lib/ritmoDeProgreso.ts`: cada **15 segundos de vídeo** —no de reloj, así un
vídeo pausado no genera peticiones— más pausa, cambio de lección, salida,
segundo plano y final. El reproductor avisa 4 veces por segundo; una petición
por aviso serían catorce mil en una lección de una hora.

### Curso completado

Lo afirma **el servidor**, al completarse la última lección: se deduce de que
no queda ninguna pendiente. Una sola señal, no una por reintento. Misma
filosofía que seguir a alguien o cerrar una reserva.

---

## 9. Biblioteca

`GET /learning/me/courses`. Antes salía de `purchasedCourseIds`, una lista en
el teléfono: se vaciaba al reinstalar, no se compartía entre dispositivos y
podía enseñar un curso al que ya no se tiene acceso.

Tres estados que **no se mezclan** —`not_started`, `in_progress`,
`completed`— porque piden cosas opuestas de quien mira. Número de consultas
constante, no una por curso.

---

## 10. Señales y atribución

`behavior_events.entity_type` ya admitía `course`. No hay tabla nueva.

| Qué pasó | `event_type` | `source` |
|---|---|---|
| Curso mostrado | `content_impression` + `surface=courses_for_you` | client |
| Curso abierto | `content_engaged` | client |
| Curso completado | `content_completed` | **server** |
| No me interesa | `not_interested` | client |

`courses_for_you` se añade al CHECK de `surface` en la `0028`. **Hasta
entonces la base rechaza esa cadena**, así que el endpoint de eventos guarda la
señal *sin contexto* en vez de tumbar la petición.

---

## 11. La aplicación funciona con la `0028` y sin ella

Es la lección de la `0027`, y costó cara: se desplegó código que exigía una
migración no aplicada, cada petición reventaba con un 500, y el navegador lo
reportaba como **error de CORS** porque Starlette no añade cabeceras CORS a una
excepción sin capturar.

`esquema.py` comprueba una vez por proceso qué hay. Sin la `0028`:

| Con la 0028 | Sin ella |
|---|---|
| Un curso lleva temas | Se crea y edita igual; los temas salen vacíos |
| Publicar exige ≥1 tema | No lo exige |
| «Cursos para ti» se puede medir | La impresión se guarda sin superficie |
| El autor sube el vídeo de su curso | Solo administración (como hoy) |

`tests/test_sin_migracion_0028.py` crea el esquema y después **deshace** la
`0028`. Si algo vuelve a depender de ella a la fuerza, se cae.

> **Al aplicar la `0028` hay que reiniciar la API.** La comprobación se cachea
> por proceso: un servidor levantado desde antes seguirá creyendo que
> `course_topics` no está.

---

## 12. Almacenamiento

El bucket `course-media` **sigue siendo privado**. La lectura la sigue
decidiendo `has_course_access()`.

La `0028` abre la **escritura** al autor, con propiedad demostrable en la
propia ruta:

```
<author_id>/<course_id>/<archivo>
```

La política comprueba la segunda carpeta **contra la tabla `courses`**: da
igual lo que mande el cliente, si ese curso no es suyo la base lo rechaza. No
se hace `using (true)`.

**Los archivos ya subidos no se tocan.** Viven en `<uid>/<archivo>` y se siguen
leyendo exactamente igual; no se mueve ni se renombra nada.

---

## 13. CourseRanker `course-v1`

`GET /api/v1/recommendations/courses` → `{ algorithm_version, strategy,
with_topics, items }`. Estrategia: `personalized` | `cold_start` | `disabled`.

**No es un sistema paralelo.** Reutiliza el mismo Recommendation Profile que
alimenta personas y contenido: la demanda declarada, la taxonomía `topics`, las
señales con decaimiento, la memoria corta, la exploración determinista y la
atribución.

```
                   Recommendation Profile
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
         PERSONAS       CURSOS        POSTS
      people-v1.1     course-v1    content-v1.1
```

### Reparto de pesos

| Componente | Peso | Por qué |
|---|---|---|
| Tema | **0.45** | Es LA pregunta: qué quiere aprender esta persona |
| Autor | 0.15 | Ayuda, no manda: un creador popular no hace mejor curso |
| Objetivo declarado | 0.12 | Empuja, no filtra |
| Comportamiento reciente | 0.10 | El bucle de aprendizaje, con decaimiento |
| Formato preferido | 0.08 | |
| Exploración | 0.06 | Determinista (`blake2b`), no azar |
| Popularidad | **0.04** | Más alumnos no hace un curso más útil para TI |
| Precio | **—** | No es un rasgo. Ni caro ni gratis significan mejor |
| Reputación | **—** | No hay reseñas verificadas. No se inventan estrellas |

`None` no es cero: lo que no aplica sale del **denominador**. Un curso con
menos de 5 accesos no arrastra una popularidad de cero — sería castigarlo por
ser nuevo.

### Un curso sin temas NO hereda los de su autor

Al contrario que una publicación. Un curso es una obra deliberada y quien lo
publica elige sus temas al publicarlo; suponerlos pondría cursos de cocina
delante de quien pidió carpintería solo porque los firma la misma persona.

### Qué queda fuera del descubrimiento

Lo empezado (su sitio es «Continúa aprendiendo»), lo terminado, lo descartado,
los propios, los de gente bloqueada en cualquier sentido, y los `coming_soon`
— mandar a alguien a una puerta cerrada no es recomendar.

Tener acceso **no** excluye: inscribirse no es empezar.

### Explicabilidad

`COURSE_TOPIC_MATCH` · `LEARNING_GOAL_MATCH` · `PREFERRED_COURSE_FORMAT` ·
`CREATOR_AFFINITY` · `RECENT_INTEREST` · `NEW_COURSE` · `WORTH_A_LOOK`.

El score **no sale a pantalla**: «0.8734261» no significa nada para quien lo
lee y aparenta una precisión que no existe. Sin nada que contar se dice la
verdad (`WORTH_A_LOOK`) en vez de inventar una coincidencia.
`?debug=1` devuelve el desglose, y solo fuera de producción.

### Interruptor propio

`FEATURE_COURSE_RECOMMENDATIONS_V1`. Apagar los cursos no puede llevarse por
delante las personas y el feed, que llevan funcionando desde antes. Apagado,
Explorar vuelve al catálogo público sin borrar una fila.

---

## 14. Lo que NO está hecho

Dicho para que nadie lo dé por supuesto:

- **Un paso «empezó el curso» en el embudo.** Ningún evento existente significa
  eso —`content_engaged` es abrir la tarjeta— y añadir un tipo nuevo solo para
  poder enseñar una fila sería inventar una señal.
- **Conversión de compra.** Sin pasarela no hay nada que medir.
- **Checkout real.** Bloqueado por decisión de negocio, no por código.
- **Reseñas verificadas.** No existen; los `testimonials` no lo son. Ninguna
  puntuación de curso puede salir de ahí.
- **Clasificación automática de temas.** Los 25 temas se eligen a mano.
- **QA en dispositivo.** Verificado: 414 pruebas de API, 118 de móvil,
  `tsc --noEmit` limpio y `expo export --platform web` correcto. **No** se ha
  probado en un teléfono real ni con datos de producción.

---

## 15. Decisión de producto que conviene revisar

La duración de una lección estaba limitada a **15–20 minutos exactos**, y una
lección de catorce minutos y medio no se podía guardar. No se encontró ninguna
regla del producto que lo respalde, y **solo existía en el cliente**: el
esquema `LessonCreate` del backend repetía la validación pero no lo usa ningún
endpoint —el contenido se escribe contra Supabase directamente— así que en el
servidor no se aplicó nunca.

Se sustituye por un límite de cordura (30 segundos a 4 horas) en
`CourseContentEditor.tsx`, en dos constantes. Si el producto sí quiere una
duración pedagógica concreta, se cambian esas dos líneas y vuelve — pero como
decisión tomada, no heredada.
