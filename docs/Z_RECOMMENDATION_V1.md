# Recommendation Engine V1 — el primer cerebro de Z

Rama: `Edson`. La migración `0026` **ya está aplicada** en producción.

> **Continuación:** varias decisiones de este documento cambiaron en la V1.1
> —el emparejamiento necesidad↔oferta, los temas propios del contenido, el
> decaimiento temporal y la atribución de resultados—. Lo que cambia está en
> [Z_RECOMMENDATION_V1_1.md](Z_RECOMMENDATION_V1_1.md); el resto de este
> documento sigue vigente.

Este documento explica **qué se construyó, por qué así, y qué NO está
demostrado todavía**. Lo último importa tanto como lo primero.

---

## 1. Qué pregunta responde el sistema

```
¿QUÉ NECESITA ESTA PERSONA?      preferencias explícitas + señales de uso
        ↓
¿QUIÉN PODRÍA APORTARLE VALOR?   candidate generation
        ↓
¿QUIÉN ES MÁS RELEVANTE?         ranker configurable
        ↓
¿POR QUÉ?                        reason codes → frase en castellano
        ↓
MOSTRAR                          «Personas para ti» + «Para ti» ordenado
        ↓
OBSERVAR RESPUESTA               behavior_events
        ↓
APRENDER                         las señales entran en el score siguiente
```

No hay ML, ni embeddings, ni LLM en el camino. Todo es determinista y
explicable, y está construido para que V2 (embeddings), V3 (filtrado
colaborativo) y V4 (learning-to-rank) entren **sin tocar el móvil, las rutas ni
el dominio**: solo cambia lo que hay dentro de `ranker.py`.

---

## 2. Modelo de datos (migración `0026`, aditiva)

| Tabla | Qué guarda |
|---|---|
| `topics` | La taxonomía canónica. **Configuración del producto**, no contenido de nadie: crece por migración. |
| `user_topic_relations` | `PERSONA --relación--> TEMA`, con seis verbos. |
| `recommendation_preferences` | Intenciones, formatos, versión del cuestionario y cuándo se completó. |
| `behavior_events` | Las señales mínimas con las que el orden aprende. |

**Una sola tabla de relaciones** y no una por intención: «quiero aprender
carpintería» y «puedo enseñar carpintería» son la misma arista leída en dos
sentidos. Separarlas en cinco tablas obligaría a unirlas todas para responder la
única pregunta que importa —quién ofrece lo que el otro busca— y a repetir el
mismo índice cinco veces.

### Los seis verbos

| Lado | Relación | Significado |
|---|---|---|
| Demanda (**privado**) | `interest` | me interesa |
| | `learn` | quiero aprenderlo |
| | `seek_guidance` | busco orientación sobre esto |
| Oferta (**puede ser público**) | `can_help` | puedo ayudar con esto |
| | `teach` | lo enseño |
| | `experienced` | tengo experiencia práctica |

### Privacidad — la decisión central

Las relaciones **no valen todas lo mismo de cara al público**. Ofrecerse a
enseñar algo es una declaración hecha para que te encuentren; buscar orientación
sobre relaciones y familia no lo es.

La RLS lo aplica, no la interfaz:

- `user_topic_relations`: dos políticas de `SELECT` que se suman. La propia
  (todo lo tuyo) y la ajena (**solo** `can_help` / `teach` / `experienced`).
- `recommendation_preferences`: solo su dueño.
- `behavior_events`: se insertan y se leen solo en nombre propio. **Nadie**
  puede actualizarlas ni borrarlas.
- `topics`: lectura pública (hace falta para pintar el cuestionario). Sin
  políticas de escritura: sin política, no se puede.

Consecuencia en el algoritmo: un *reason code* puede nombrar un tema **solo si
sale del lado público del candidato**. Por eso `SIMILAR_INTERESTS` nunca lleva
temas dentro — nombrarlos revelaría lo que la otra persona busca.

**No se guardan** diagnósticos, atributos sensibles inferidos, texto íntimo,
mensajes ni términos de búsqueda. El cuestionario pregunta por ámbitos
generales y opcionales («Relaciones y familia», «Bienestar personal»), nunca por
un problema concreto.

---

## 3. El cuestionario

Cinco preguntas, menos de dos minutos, progreso visible, retroceso que no pierde
nada y **saltar disponible desde la primera**. Solo la de temas es obligatoria:
sin al menos un tema no hay nada que recomendar.

| # | Pregunta | Se guarda en |
|---|---|---|
| 1 | ¿Qué te gustaría encontrar en Z? | `goals` |
| 2 | ¿En qué temas quieres crecer o aprender? | relaciones `learn` + `interest` |
| 3 | ¿Qué tipo de conexión te sería más útil? | `preferred_connection_types` |
| 4 | ¿Cómo prefieres aprender o conectar? | `preferred_content_formats` |
| 5 | ¿Tú también puedes ayudar? ¿En qué temas? | `offer_modes` + relaciones de oferta |

**El móvil manda las RESPUESTAS, no las relaciones.** La traducción de «quiero
aprender esto» a `learn` + `interest` (+ `seek_guidance` si además pidió
orientación) vive en el servidor: es una regla de producto, y una regla repartida
entre dos clientes acaba significando dos cosas distintas. Los temas y las
opciones también los sirve el backend, así que añadir «Panadería» es **una fila
en la base de datos**, no una versión esperando aprobación en dos tiendas.

### Cuándo se enseña

```
login/registro → sesión válida → ¿pasó por esta versión del cuestionario?
                                    ├── NO → cuestionario  (una vez)
                                    └── SÍ → flujo habitual
```

Lo decide **el servidor** (`GET /recommendations/onboarding/status`). Si lo
decidiera el teléfono, cambiar de dispositivo volvería a preguntarlo todo.

Cubre a los usuarios que ya existían: no tienen fila, así que se les pregunta una
vez. Saltar **también** cuenta como «ya pasó por aquí» — no se persigue a nadie
en cada arranque. Se puede reconfigurar en **Ajustes → Tus intereses**.

`PASSWORD_RECOVERY` sigue mandando sobre todo lo demás. La precedencia vive en
`src/lib/rutaDeArranque.ts`, **probada**, precisamente para que nadie cuele
mañana una condición por delante sin enterarse de lo que rompe: una sesión
temporal abierta por el enlace del correo existe para cambiar la contraseña, no
para contestar preguntas.

---

## 4. El algoritmo (`people-v1`)

```
CandidateGenerator  → ¿quiénes podrían servir?
FeatureBuilder      → ¿qué sabemos de cada uno?
Ranker              → ¿en qué orden?
ReRanker            → diversidad y exploración
Service             → orquesta
```

### Generación de candidatos — cuatro vías

1. **Oferta** — quien ofrece los temas que la persona busca. *La vía principal.*
2. **Interés común** — solo si pidió «personas con intereses parecidos».
3. **Actividad** — quien ha publicado últimamente. Ordenado por **última
   publicación, no por seguidores**: ordenar por seguidores convertiría esto en
   un ranking de popularidad.
4. **Destacados** — último recurso, para que una cuenta nueva no vea una
   pantalla vacía.

Si nadie entró por la vía 1, la respuesta lo **dice** (`strategy: "cold_start"`)
y la interfaz lo dice también. Presentar un respaldo como si fuera una
coincidencia sería mentir sobre lo que Z sabe.

### Exclusiones obligatorias

Uno mismo · quien bloqueó o fue bloqueado (**simétrico**) · cuentas privadas ·
quien ya se sigue (salvo `include_following=true`) · a quien se marcó «no me
interesa».

### Pesos (`config.py`, versionados)

| Componente | Peso | Qué mide |
|---|---:|---|
| `tema` | 0.34 | cuánto de lo que busca cubre el candidato |
| `intencion` | 0.18 | si ofrece lo pedido **sobre los temas que importan** |
| `formato` | 0.08 | si publica donde la persona prefiere |
| `actividad` | 0.12 | que exista de verdad: publica, atiende |
| `comportamiento` | 0.18 | lo que el propio usuario ya hizo |
| `reputacion` | **0.00** | *neutral a propósito — ver abajo* |
| `exploracion` | 0.10 | sitio para quien aún no tiene señales |

Poner un peso a `0` **apaga** el componente sin borrar código ni pruebas.

Un rasgo puede valer `None` = **no aplica**, que no es cero: si alguien no dijo
qué formatos prefiere, ese peso sale del reparto en vez de dar un cero a todo el
mundo. Así el score sigue siendo comparable entre personas con respuestas
distintas.

### Reputación: hoy vale cero, y es deliberado

**No hay reseñas verificadas.** Los `testimonials` que existen no lo son. Usar
`testimonial_count`, seguidores o «me gusta» como prueba de experiencia sería
fabricar una confianza que nadie ha ganado. El hueco está hecho
(`Rasgos.reputacion`) para que enchufar el sistema real no toque nada más.

Hay una prueba que lo fija: `test_hoy_no_se_fabrica_reputacion`.

### Popularidad ≠ experiencia

Las reacciones recibidas pesan un 10 % del componente de actividad y saturan a
las 50. Hay una prueba con una cuenta de 5 000 reacciones que **pierde** contra
alguien de 1 publicación que sí enseña el tema buscado.

### Exploración determinista

`blake2b(usuario | candidato | día)`. No es azar: con azar, la lista se
reordenaría al desplazarse y ningún test podría comprobar nada. La semilla es el
día, así que rota cada 24 h y la paginación es estable dentro de una sesión.

> No se usa `hash()` de Python: lleva una sal distinta por proceso, así que el
> mismo usuario vería otro orden en cada reinicio del servidor.

### Explicabilidad

Cada recomendación produce *reason codes* (`TOPIC_MATCH`, `TEACHES`, `CAN_HELP`,
`EXPERIENCED`, `INTENT_MATCH`, `PREFERRED_1_TO_1`, `PREFERRED_FORMAT`,
`YOU_ENGAGED_BEFORE`, `SIMILAR_INTERESTS`, `ACTIVE_CREATOR`, `NEW_VOICE`), y la
interfaz los convierte en una frase:

> «Te recomendamos a Carlos porque enseña Carpintería.»

**El score nunca sale a pantalla.** `0.8734261` no significa nada para quien lo
lee y aparenta una precisión que no existe. El desglose numérico existe y se
consulta con `?debug=1`, **solo fuera de producción**.

---

## 5. El feed «Para ti» (`content-v1`)

Entra por la abstracción que ya existía, `src/feed/fuenteDeVideos.ts`: la
pantalla sigue pidiendo un lote y pintando lo que le den.

```
Inicio → FuenteDeVideos → RecommendationService → posts ordenados
                        ↘ (si falla) → orden cronológico de siempre
```

**Honestidad sobre lo que se puede hacer hoy:** una publicación no declara de
qué trata —no hay temas en `posts` ni embeddings—, así que la afinidad temática
se **hereda del autor**. Si a alguien le encaja mucho un carpintero, es correcto
que sus vídeos suban. No se inventa contenido: si hay tres vídeos, se ordenan
tres vídeos.

### El respaldo es una condición de aceptación

`decisionDeFuente.ts` decide, y está probado caso a caso:

| Situación | Primera página | Páginas siguientes |
|---|---|---|
| llega contenido | usar | usar |
| no llega nada | **respaldo cronológico** | fin (no reinicia desde arriba) |
| llega pero nada reproducible | **respaldo cronológico** | usar (el cursor avanza) |
| la petición falla | **respaldo cronológico** | respaldo |

Una vez que cae, se queda caído durante esa sesión de la fuente: mezclar dos
ordenaciones distintas repetiría y saltaría vídeos.

Resultado: si `RecommendationService` muere, **Inicio sigue cargando**. Ni
pantalla negra, ni 500, ni spinner eterno.

---

## 6. Señales

### Las escribe el servidor cuando puede

`follow`, `message_started`, `booking_requested`, `booking_completed`. Son las
que más pesan y las que un cliente podría falsificar. El backend **sabe** que
ocurrieron porque acaban de pasar dentro de una de sus operaciones, y se anotan
en el mismo commit: no puede quedar una señal de algo que no se guardó. El
esquema de entrada del móvil ni siquiera las admite (responde 422).

`booking_completed` se anota **para las dos partes**: cada una aprendió algo de
la otra.

### Las del cliente van por lotes

`content_impression`, `content_engaged`, `content_completed`, `profile_view`,
`search_result_opened`, `not_interested`.

Se acumulan y se envían de golpe (25 eventos, u 8 s, o al pasar la app a segundo
plano). Una petición por impresión convertiría bajar el feed en una tormenta de
red compitiendo con el propio contenido — y el contenido es lo que la persona
vino a ver. Cada evento lleva `event_key` para que reintentar un lote no
duplique nada; hay un índice único que lo garantiza también en la base.

### Peso de cada señal

```
content_impression 0.05 · content_engaged 0.6 · content_completed 1.0
profile_view 0.8 · search_result_opened 0.9
follow 2.5 · message_started 3.0 · booking_requested 4.0 · booking_completed 5.0
not_interested → EXCLUYE (no resta: elimina)
```

### El bucle de aprendizaje, sin entrenar nada

Alguien empieza interesado en negocios, visita perfiles de programación, sigue a
un desarrollador, abre contenido de React → la afinidad por tema sube y los
candidatos de tecnología suben con ella. Probado en
`test_el_interes_se_mueve_con_el_uso_aunque_no_se_toquen_las_preferencias`.

### Lo que NO se hace

Abrir un perfil se registra internamente **pero no se le cuenta a su dueño**. No
existe «alguien buscó tu perfil»: convertir mirar en una acción pública exige una
decisión de privacidad y de producto que nadie ha tomado.

---

## 7. Rendimiento

Medido sobre SQLite en memoria, 60 personas y 120 publicaciones. No es
producción, pero el **número de consultas** sí es representativo:

| Endpoint | Antes de la memoria corta | Después |
|---|---:|---:|
| `/posts` (cronológico, referencia) | 2 | 2 |
| `/recommendations/content` 1.ª página | 21 | 21 |
| `/recommendations/content` páginas siguientes | 21 | **5** |
| `/recommendations/people` | 17 | **1** |

Ninguna consulta es un N+1: su número **no crece** con los candidatos. Cada
lectura del repositorio está escrita para responder de una sola consulta sobre
todos los candidatos a la vez.

La memoria corta es un diccionario en el proceso (60 s, techo de 500 entradas).
**No hay Redis** ni servicios nuevos. Se invalida a mano cuando cambia algo que
altera lo que hay que recomendar: guardar preferencias, seguir, agendar, «no me
interesa». Sin eso, quien acaba de contestar el cuestionario vería un minuto las
recomendaciones de **antes** de contestarlo.

Índices creados según los accesos reales:
`user_topic_relations(user_id, relation)`, `(topic_id, relation)`,
`behavior_events(user_id, created_at desc)`, `(entity_type, entity_id, created_at desc)`,
`topics(active, topic_group, position)` y el único de idempotencia.

---

## 8. Interruptor y vuelta atrás

```
FEATURE_RECOMMENDATIONS_V1=false
```

Apaga el cuestionario, «Personas para ti» y el orden personalizado. **No falla:
responde vacío y en silencio**, y el móvil cae a su comportamiento anterior.
Devolver 503 convertiría un apagado controlado en una pantalla rota.

Las tablas nuevas se quedan donde están, quietas. **El rollback no necesita
borrar información de nadie.**

---

## 9. Qué está demostrado y qué no

**Demostrado:**

- La arquitectura completa (candidatos → rasgos → orden → diversidad → motivos).
- El ranking determinista, con 29 pruebas puras sobre escenarios del producto.
- El flujo real de extremo a extremo, con 39 pruebas sobre base de datos.
- Que el resultado **depende de quién pregunta**.
- Que las exclusiones de privacidad funcionan.
- Que el fallo del recomendador no tumba Inicio.

**NO demostrado — y no se va a afirmar lo contrario:**

- **La calidad estadística del recomendador de contenido.** Con el catálogo
  actual no se puede medir. Decir «validado a escala» sería falso.
- El comportamiento con miles de usuarios y decenas de miles de publicaciones.
- Los pesos. Son un punto de partida razonado, **no un resultado**. Se ajustarán
  cuando haya datos reales de uso.

---

## 10. Datos falsos en producción: cero

Ninguna prueba toca Supabase. Todo corre sobre SQLite en memoria o sobre objetos
en memoria; las personas de los escenarios (Ana, Carlos, Lucía, Andrés) viven
los milisegundos que dura cada prueba.

La única inserción de la migración es la **taxonomía de temas**, que es
configuración del producto —no usuarios, no perfiles, no publicaciones— y se
inserta con `on conflict (slug) do nothing`.

---

## 11. Mapa del código

**Backend** — `apps/api/app/modules/recommendations/`

| Fichero | Responsabilidad |
|---|---|
| `config.py` | Preguntas, opciones, pesos y versiones. Lo único que se ajusta. |
| `models.py` | ORM de las cuatro tablas. |
| `schemas.py` | Contratos. Ninguno acepta `user_id` del cliente. |
| `repository.py` | Solo lecturas. Ninguna decide nada. |
| `candidate_generator.py` | Quiénes podrían servir. |
| `features.py` | Qué sabemos de cada uno, en 0..1. Funciones puras. |
| `ranker.py` | El orden y los motivos. Función pura. |
| `reranker.py` | Diversidad y exploración. Determinista. |
| `service.py` | Orquesta. El único sitio con el proceso entero. |
| `cache.py` | Memoria corta del ranking. |
| `signals.py` | Señales de servidor, para otros módulos. |
| `router.py` | Solo HTTP. |

**Móvil** — `apps/mobile/src/`

| Fichero | Responsabilidad |
|---|---|
| `repositories/RecommendationRepository.ts` | Acceso a la API. |
| `store/usePreferenciasStore.ts` | Caché del estado del cuestionario, con reloj. |
| `lib/rutaDeArranque.ts` | La precedencia del arranque. Probada. |
| `screens/OnboardingScreen.tsx` | Las cinco preguntas. |
| `components/PersonasParaTi.tsx` | La sección, dentro de Explorar. |
| `lib/motivoDeRecomendacion.ts` | Código de motivo → frase. Probado. |
| `feed/fuenteDeVideos.ts` | Fuente recomendada con respaldo. |
| `feed/decisionDeFuente.ts` | Cuándo se cae al orden cronológico. Probado. |
| `services/senales.ts` | Envío por lotes. |

---

## 12. Endpoints

```
GET  /api/v1/recommendations/onboarding/status     ¿toca el cuestionario?
GET  /api/v1/recommendations/onboarding/catalog    preguntas + temas
GET  /api/v1/recommendations/preferences           las propias
PUT  /api/v1/recommendations/preferences           guardar (reemplaza)
GET  /api/v1/recommendations/people                personas para ti
GET  /api/v1/recommendations/content               «Para ti» ordenado
POST /api/v1/recommendations/events                señales, en lote
GET  /api/v1/recommendations/version               qué versión sirve el servidor
```

---

## 13. Pendiente (fuera de esta fase)

- **Reseñas verificadas** → alimentarán `Rasgos.reputacion`, que ya existe
  vacío. `bookings.completed_at` ya guarda la prueba de que la sesión ocurrió.
- **Búsqueda semántica / pgvector** → cuando los pasos anteriores estén
  asentados. Meterlo ahora sería marcar una casilla.
- **Temas propios del contenido** → hoy se heredan del autor.
- **Ajuste de pesos con datos reales** → lo único que convierte un punto de
  partida en un resultado.
