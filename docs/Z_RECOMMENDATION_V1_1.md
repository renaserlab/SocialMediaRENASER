# Recommendation Engine V1.1 — aprendizaje real y evidencia

Rama: `Edson`. Continúa [Z_RECOMMENDATION_V1.md](Z_RECOMMENDATION_V1.md), que
sigue siendo válido: aquí solo está **lo que cambia**.

Estado: implementado y verificado en local. La migración `0026` ya está
aplicada en producción. **La `0027` NO**: espera aprobación explícita.

---

## 1. Qué arregla esta fase

La V1 funcionaba, pero confundía cuatro cosas que no son la misma:

| Confusión | Qué producía | Qué hace ahora |
|---|---|---|
| Interés ≠ experiencia | A quien le *gusta* la carpintería contaba casi como quien *sabe* enseñarla | Matriz explícita necesidad↔oferta; el interés ajeno sale de ella |
| Autor ≠ tema | Un carpintero que publica una receta puntuaba como carpintería | `post_topics`: cada publicación dice de qué trata |
| Todo el pasado pesa igual | Lo de hace 40 días mandaba tanto como lo de ayer | Decaimiento exponencial, media vida de 30 días |
| Rechazar contenido ≠ rechazar persona | No existía el rechazo de contenido | «No me interesa» sobre un vídeo, sin tocar a su autor |

Y una que faltaba entera: **no se sabía si una recomendación producía algo**.

---

## 2. Migración `0027` (aditiva, pendiente de aprobación)

Dos cosas, y ninguna toca datos existentes:

- **`post_topics`** — `POST --tema--> TOPIC`, con la MISMA taxonomía que las
  personas. Clave primaria `(post_id, topic_id)`; cascada a `posts` y a
  `topics`; `source` distingue `manual` / `author_fallback` / `auto` para el
  día en que exista clasificación automática.
- **Tres columnas en `behavior_events`**: `surface`, `algorithm_version`,
  `rank`. Todas opcionales.

### RLS de `post_topics`

Las mismas reglas que `post_media`, y por el mismo motivo: una etiqueta es
parte de la publicación, no una entidad con vida propia.

- **Leer**: quien pueda ver la publicación.
- **Escribir**: solo su autor. Etiquetar decide a quién se le recomienda algo;
  no es cosmético.

### La aplicación funciona con y sin ella

Se escribió el código de esta fase contra un esquema que todavía no estaba
aplicado, y eso dejó la rama sin funcionar contra la base real: cada petición
que tocaba `post_topics` o `behavior_events.surface` devolvía 500. El navegador
lo reportaba como error de **CORS**, porque Starlette no añade esas cabeceras a
una respuesta que sale de una excepción sin capturar — un fallo de esquema
disfrazado de fallo de red.

Dos causas concretas, las dos mecánicas y las dos fáciles de repetir:

| Patrón | Por qué rompe |
|---|---|
| `select(BehaviorEvent)` | Trae la entidad **entera**: pide `surface` aunque nadie la use |
| `db.add(BehaviorEvent(...))` | Escribe **todas** las columnas del modelo aunque no se toquen |

Ahora ambos nombran columnas explícitamente, y `esquema.py` comprueba una vez
por proceso qué hay disponible. Sin la 0027: se publica igual (sin temas), se
ordena por el respaldo del autor, las señales se guardan sin contexto y las
métricas responden vacío. El selector de temas de Crear **se esconde**, porque
ofrecer «elige hasta 3 temas» y descartarlos en silencio sería prometer algo
que no se cumple.

`tests/test_sin_migracion_0027.py` crea el esquema y después **deshace** la
0027. Si algo vuelve a depender de ella a la fuerza, se cae.

> **Al aplicar la 0027, reinicia la API.** La comprobación se cachea por
> proceso: un servidor levantado desde antes seguirá creyendo que las tablas no
> están. Es el precio de que la aplicación no se caiga mientras la migración
> espera aprobación.

### Por qué NO una tabla de analítica aparte

Sería el mismo hecho contado dos veces, y reconstruir un embudo que cabe en una
tabla cruzando dos es trabajo inventado.

---

## 3. Interés no es experiencia

### La matriz

`config.COMPATIBILIDAD` — cuánto resuelve cada oferta cada necesidad, sobre el
mismo tema:

| Necesidad | `teach` | `can_help` | `experienced` |
|---|---:|---:|---:|
| `learn` (quiero aprender) | **1.00** | 0.75 | 0.60 |
| `seek_guidance` (busco orientación) | 0.70 | 0.90 | **1.00** |
| `interest` (me interesa) | 0.55 | 0.50 | 0.50 |

Y `INTENSIDAD_DE_DEMANDA` multiplica: `learn` y `seek_guidance` valen 1.00
(son peticiones), `interest` vale 0.60 (es una pista).

Consecuencia comprobada en tests: **el mismo par de personas se ordena distinto
según la necesidad**. Para aprender gana quien enseña; para orientarse, quien ya
lo vivió.

### El interés del candidato NO está en la matriz

Que a alguien le interese la carpintería no le convierte en quien puede
enseñarla. Se mide aparte, como afinidad social, y su motivo dice otra cosa
(`SIMILAR_INTERESTS`, que además nunca nombra el tema — sería filtrar lo que la
otra persona busca).

### Los motivos salen de la coincidencia real

Antes se derivaban de lo que el usuario *pidió*; ahora, de lo que el candidato
*declaró* y coincidió. A quien solo marcó `experienced` no se le puede presentar
como profesor. Hay un test que lo fija.

---

## 4. Cada publicación dice de qué trata

### Prioridad del ranking de contenido

```
1. temas PROPIOS de la publicación   → lo único que dice de qué trata
2. temas del AUTOR, con descuento ×0.6 → pista razonable, no un hecho
3. nada                              → 0. No se inventa afinidad.
```

El paso 2 es lo que hace que **las 26 publicaciones que ya existen sigan
puntuando** el día que se aplique la migración. No se les escribe ningún tema:
nadie ha dicho de qué tratan, y escribirlo por ellas sería inventar datos.

### Pesos de contenido

| Componente | V1 | V1.1 |
|---|---:|---:|
| tema propio | — | **0.40** |
| autor | 0.55 | 0.30 |
| recencia | 0.25 | 0.18 |
| interacción | 0.10 | 0.06 |
| exploración | 0.10 | 0.06 |

### Dónde se elige

En el Crear que ya existe, no en un formulario nuevo: hasta 3 temas, en el paso
donde se escribe la descripción. Es opcional — obligarlo convertiría publicar en
un trámite, que es justo de lo que se venía.

La validación (existe, activo, sin repetir, máximo 3) está en el **servidor**:
quien publica no manda un formulario, manda una petición.

---

## 5. Lo reciente manda

`repository.peso_por_antiguedad` — decaimiento exponencial:

```
hoy      1.000
30 días  0.500
60 días  0.250
90 días  0.125
∞        0.100   ← suelo
```

Media vida: 30 días (`MEDIA_VIDA_DE_SENAL_DIAS`). Elegida contra la ventana de
comportamiento (45 días): mucho más corta y casi toda la ventana valdría cero;
mucho más larga y el decaimiento no cambiaría nada.

El **suelo** existe porque una señal antigua pierde fuerza pero no se convierte
en mentira; sin él habría un salto brusco entre «cuenta un poco» y «no existe».

### Lo que NO decae

**Lo que la persona dijo.** El cuestionario, los temas que declara poder
enseñar, los que dice haber vivido. Que alguien no entre en dos meses no le
quita la carpintería que sabe. El decaimiento se aplica **solo** a
`behavior_events`, y hay un test que comprueba que `PerfilDeDemanda` no tiene
ninguna fecha por donde pudiera envejecer una preferencia explícita.

---

## 6. «No me interesa» sobre contenido

Tres efectos, y conviene no mezclarlos:

1. **La publicación exacta** desaparece del feed, ahora y después.
2. **Sus temas** se enfrían: `PENALIZACION_POR_RECHAZO = 0.15` por rechazo,
   con techo en `0.60`.
3. **Su autor no sufre nada.** Rechazar un vídeo no es rechazar a una persona:
   puede que el vídeo no gustara, que ya se hubiera visto o que llegara en mal
   momento. Hay un test que comprueba que el resto del contenido de esa persona
   sigue apareciendo y que ella sigue siendo recomendable.

El techo importa: un tema no puede desaparecer para siempre por una mala racha.
La persona cambia, y un sistema que no le deja volver deja de servirle.

---

## 7. Cerrar el bucle: ¿sirvió de algo?

### Qué es una impresión

**No** es «el backend devolvió este candidato». Es «esto se le puso delante a
alguien». Por eso la declara el cliente cuando el elemento se hace visible de
verdad, y lleva encima:

```
surface           people_for_you | for_you_feed | following_feed | search | profile
algorithm_version people-v1.1 | content-v1.1
rank              la posición que decidió el SERVIDOR
```

La posición la pone el servidor y viaja de vuelta: dejársela calcular al móvil
funcionaría hoy, pero cualquier filtro que hiciera por su cuenta desplazaría los
números y las métricas medirían otra cosa sin que nadie se diera cuenta.

### El embudo

```
impresión → profile_view → follow → message_started
          → booking_requested → booking_completed
```

Atribución **por pareja** (quien mira, a quién) dentro de 7 días, no por id de
petición: con un id por petición la cadena se rompe en cuanto la persona cierra
la aplicación y vuelve al día siguiente, que es justo cuando ocurren las
conexiones que más importan.

Reglas del cálculo:

- Se cuenta la **primera** impresión de cada pareja: ver algo diez veces no son
  diez oportunidades distintas.
- Cada paso cuenta **una vez** por pareja: seguir a alguien dos veces no son dos
  conversiones.
- Lo que no ocurrió sale a **cero**, no ausente: un hueco se lee como «no se
  midió», que es otra cosa.

### Las acciones fuertes las sigue escribiendo el servidor

`follow`, `message_started`, `booking_requested`, `booking_completed`. Son las
que más pesan y las que un cliente podría falsificar. No se ha cambiado nada de
eso, y no debe cambiarse.

### Métricas

`GET /api/v1/recommendations/metrics?days=30` — **solo administración**.

Es un endpoint, no un panel: un panel es una pantalla que mantener; esto es una
consulta que se hace cuando hay algo que decidir. Devuelve, por superficie y
versión del algoritmo: impresiones, conversiones absolutas y tasas.

Si todo sale a cero es que todavía no ha pasado nada. **Eso es un resultado**, y
no se rellena con nada.

---

## 8. La oferta pública del perfil

`GET /api/v1/recommendations/profiles/{id}/offer` devuelve lo que esa persona
declara poder aportar. **No existe el simétrico** y no es un olvido: la demanda
es privada y no debe poder consultarse sobre otra cuenta de ninguna forma.

Tres capas dicen lo mismo a propósito:

1. La RLS de la `0026` (solo `can_help`/`teach`/`experienced` para terceros).
2. El filtro en `service.oferta_publica` — el backend se conecta con su propio
   rol y **no pasa por RLS**, así que sin esa línea la demanda saldría por aquí.
3. El esquema de salida, que no tiene ningún campo donde la demanda pudiera
   caber aunque alguien se equivocara más abajo.

### El lenguaje es parte de la garantía

| Relación | Se escribe |
|---|---|
| `can_help` | «Puede ayudar en» |
| `teach` | «Enseña» |
| `experienced` | «Experiencia declarada en» |

**Nunca** «experto», «verificado» ni «certificado». No existe verificación
todavía y afirmarla sería inventar confianza.

### Usuarios existentes

No se infiere nada de su biografía. Quien no ha declarado nada simplemente no
tiene sección; en su propio perfil ve una invitación discreta a completarla. El
cuestionario sigue siendo la puerta principal, y no se persigue a nadie.

---

## 9. Rendimiento

Medido sobre SQLite en memoria: 60 personas, 120 publicaciones, la mitad
clasificadas (el caso realista de las semanas siguientes a la migración).

| Endpoint | V1 | V1.1 |
|---|---:|---:|
| `/posts` (referencia cronológica) | 2 | 3 |
| `/recommendations/content` 1.ª página | 21 | 24 |
| `/recommendations/content` siguientes | 5 | 8 |
| `/recommendations/people` | 1 | 1 |

Ninguna consulta es N+1: su número no crece con los candidatos ni con el
catálogo.

Las tres de más en el feed son exactamente la capacidad nueva: los temas del
lote de candidatos, los temas de los autores para el respaldo, y los temas en la
respuesta. `/people` —el que sostiene Explorar— no se movió.

Durante el desarrollo la paginación llegó a subir a 11 porque la demanda se
construía **dos veces** por petición (una para ordenar el contenido por tema y
otra dentro del ranking de personas). Ahora se memoriza junto al ranking, con la
misma caducidad y la misma invalidación.

### Invalidación de la caché

Sigue siendo **por persona**, nunca global. Lo que la invalida: guardar
preferencias, seguir, agendar, «no me interesa», y cambiar los temas de una
publicación propia (esa última invalida la del autor, porque su contenido ya no
trata de lo mismo).

---

## 10. Qué está demostrado y qué no

**Demostrado** (247 tests de API, todos sin tocar Supabase):

- Que un interés no se trata como experiencia, y que el orden cambia según la
  necesidad.
- Que el tema propio manda sobre el del autor, y que el contenido antiguo sigue
  funcionando.
- Que la curva de decaimiento es la documentada y que las preferencias no
  decaen.
- Que rechazar un vídeo no bloquea a su autor.
- Que la demanda privada no sale por ningún endpoint.
- Que el embudo cuenta lo que pasó y no atribuye lo que ocurrió fuera de la
  ventana.

**NO demostrado, y no se va a afirmar lo contrario:**

- **Que las recomendaciones produzcan conexiones.** Es justo lo que esta fase
  permite empezar a medir. Hoy hay 0 `user_topic_relations`, 0
  `behavior_events` y 0 bookings: el embudo devolverá ceros hasta que haya uso
  real, y eso es correcto.
- **La calidad de los pesos.** Siguen siendo un punto de partida razonado. Con
  las métricas ya se pueden mover con criterio; sin datos, moverlos sería
  cambiar una opinión por otra.
- **El comportamiento a escala.** 37 perfiles y 26 publicaciones no permiten
  afirmar nada estadístico.

---

## 11. Lo que deliberadamente NO entra

pgvector, embeddings, clasificación con LLM, filtrado colaborativo,
learning-to-rank, Kafka, Redis, microservicios, feature store.

Ninguna resuelve un problema que tengamos **hoy**. Los embeddings serán una
mejora sobre datos útiles cuando existan perfiles con oferta real, contenido con
tema y comportamiento medido — no una capa sofisticada sobre un dataset vacío.

Las **reseñas verificadas** tampoco: hay 0 bookings completados. `Rasgos.reputacion`
sigue valiendo 0 y con su hueco hecho.

---

## 12. Endpoints nuevos o cambiados

```
GET  /api/v1/recommendations/profiles/{id}/offer   NUEVO   oferta pública
GET  /api/v1/recommendations/metrics               NUEVO   embudo (admin)
GET  /api/v1/recommendations/content               CAMBIA  ahora va envuelto:
                                                           { algorithm_version,
                                                             strategy,
                                                             with_own_topics,
                                                             items: PostRead[] }
POST /api/v1/recommendations/events                CAMBIA  admite surface,
                                                           algorithm_version, rank
POST /api/v1/posts                                 CAMBIA  admite topic_ids
PATCH /api/v1/posts/{id}                           CAMBIA  admite topic_ids
GET  /api/v1/posts                                 CAMBIA  devuelve topic_ids
```

La envoltura de `/content` existe para que la versión del algoritmo la diga el
servidor. Con una lista pelada, el móvil tendría que llevarla escrita en su
código, y una versión antigua de la aplicación mediría contra una etiqueta
equivocada.

---

## 13. Un hallazgo que no estaba previsto

`apps/api/.env` existe en la máquina de desarrollo con las credenciales reales.
Con ese fichero delante, `processing_configured()` devuelve `True`, así que la
primera prueba que publicara una publicación por HTTP habría encolado
`process_media`: una tarea que descarga de Supabase, genera derivados y los
**sube**, con la `service_role` key.

Nadie se había dado cuenta porque hasta ahora ninguna prueba llamaba a ese
endpoint. Se apaga en `tests/conftest.py` para **toda** la suite, no fichero a
fichero: lo que depende de que alguien se acuerde, antes o después falla.

---

## 14. Cómo se prueba esto de verdad

Con personas reales, y en este orden:

```
cuenta real → completa el cuestionario
            → declara en qué puede ayudar
            → publica contenido real CON temas
otra cuenta real → completa el cuestionario
            → PeopleRanker encuentra la compatibilidad
            → se muestra la recomendación   (impresión)
            → abre el perfil                (profile_view)
            → sigue / escribe / agenda      (conversión)
            → el embudo lo registra
```

Hasta que eso ocurra, las métricas devuelven ceros. No se rellenan.
