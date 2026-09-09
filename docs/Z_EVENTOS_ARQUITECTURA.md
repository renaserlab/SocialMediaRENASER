# Eventos · Incremento 1

Arquitectura, aforo y admisión. Complementa `Z_EVENTOS_ESPECIFICACION.md`, que
describe el catálogo y la ficha pública.

La fuente funcional es el blueprint de producto de Eventos. Cuando este
documento y el blueprint digan cosas distintas, manda el blueprint.

---

## 1. Arquitectura encontrada

Eventos era **dos rutas dentro del catálogo**. `catalog/router.py` —2 141
líneas— llevaba a la vez cursos, eventos, temas, versiones y valoraciones. El
modelo `Event` tenía nueve columnas, ninguna de ellas operativa: ni estado de
admisión, ni curaduría, ni versiones, ni categoría, ni promesa, ni zona horaria.

Un evento se creaba `status = 'published'`. Eso es autopublicación: cualquier
cuenta ponía un evento en el catálogo sin que nadie lo mirara.

## 2. Arquitectura final

Monolito modular. Un dominio propio en `apps/api/app/modules/events/`:

| Fichero | Responsabilidad |
|---|---|
| `models.py` | Las cinco tablas nuevas (0060). |
| `schemas.py` | Dos familias de contratos: la del organizador y la de la revisión. |
| `states.py` | Transiciones y validaciones **puras**. No toca la base. |
| `permissions.py` | Capacidades: organizador, curaduría, administración. |
| `admission.py` | Puntaje, umbrales y fallas críticas. **Puro**. |
| `inventory.py` | Reserva gratuita y bloqueo del aforo. |
| `service.py` | Coordinación transaccional y auditoría. |
| `esquema.py` | Si la 0060 está aplicada en ESTA base. |
| `router.py` | HTTP y dependencias. |

`catalog` se queda con **la lectura pública**: `GET /catalog/events` y
`GET /catalog/events/{id}` conservan su contrato exacto y consultan al dominio
nuevo solo para saber si un evento lleva sello Z.

`Event` y `EventRegistration` siguen declarados en `catalog/models.py`. Moverlos
en este commit obligaba a tocar quince módulos sin ganar nada; el día que se
muevan, lo que hay en `events/` no cambia.

## 3. Causa raíz de la sobreventa

```
contar inscritos  ->  comparar con capacity  ->  insertar la reserva
```

Entre el conteo y la inserción no había nada. Dos peticiones simultáneas leían
el mismo conteo, las dos veían un hueco y las dos insertaban. La clave única
`(event_id, user_id)` impedía que **una persona** se duplicara, y por eso el
fallo no se veía probando a mano: hacen falta dos cuentas distintas pulsando a
la vez. El resultado eran 51 inscritos en un aforo de 50, sin un solo error en
el registro.

**Por qué no un cerrojo en memoria.** Un `asyncio.Lock` ordena las corrutinas de
un proceso. La API corre con varios trabajadores y puede correr con varias
réplicas; dos procesos no comparten ese cerrojo.

**Por qué no un índice único.** Un índice puede impedir que dos filas sean
iguales, pero no puede contar cuántas hay. «Como mucho N» no es una propiedad de
una fila: es del conjunto, y eso solo lo sostiene una transacción que serialice
a quien escribe.

## 4. Solución transaccional

En una transacción y en este orden:

1. `select ... for update` sobre la **fila del evento**
2. ¿ya está inscrita esta persona? → se le devuelve la suya
3. ¿se puede reservar? (publicado, no pasado, no suspendido)
4. contar reservas activas
5. comparar contra el aforo aprobado
6. insertar
7. confirmar

El bloqueo de la fila del evento ordena a los competidores: la segunda petición
espera en el paso 1 y no llega al paso 4 hasta que la primera ha confirmado.

`cancelar` toma **el mismo cerrojo y en el mismo orden**. Sin eso, una
cancelación podría colarse entre el conteo y la inserción y el hueco que libera
se contaría dos veces.

La colisión se recoge en un **SAVEPOINT** (`db.begin_nested()`) y no con un
`rollback` de la transacción entera, y se captura **solo** la colisión esperada.
Dicho lo cual: con el cerrojo puesto y siendo estas dos funciones las únicas que
escriben reservas, **esa rama no puede ejecutarse**, y por tanto no está
probada. Está anotada como tal en el código.

El cerrojo **se suelta en todos los caminos**, también en los de error y en el
idempotente. No hacerlo dejaba la fila bloqueada mientras FastAPI serializaba la
respuesta y mientras el router pedía el perfil del organizador: un evento
popular con gente reintentando encadenaba esperas hasta agotar el pool.

Y el conteo que se devuelve se lee **dentro** de la transacción que lo cambió.
Leerlo después del `commit` abre otra transacción y devuelve el número de los
que entraron detrás.

**En SQLite no hay `FOR UPDATE`** y SQLAlchemy lo omite al compilar. Por eso las
pruebas están partidas: las reglas se prueban en SQLite y la carrera solo
significa algo contra PostgreSQL.

## 5. Evidencia de concurrencia real

`apps/api/tests/test_aforo_concurrente_postgres.py`, 16 pruebas contra un
PostgreSQL 16 desechable, con **sesiones distintas** peleando a la vez.

La que manda es `test_mientras_una_reserva_tiene_la_fila_bloqueada_la_otra_
espera`: no depende del planificador, fija el orden a mano.

```
A  ->  bloquea la fila del evento y NO confirma
B  ->  pide el cupo: se queda esperando en el `select ... for update`
A  ->  ocupa el último sitio y confirma
B  ->  despierta, cuenta lo que hay AHORA y ve el evento lleno
```

**Comprobado quitando `with_for_update()`**: se ponen rojas esa, la de diez
peticiones por tres cupos y la del aforo aprobado. Las de una sola plaza
pasaban igual sin el cerrojo —el planificador las serializaba solo—, y por eso
la garantía es la determinista.

**El mismo cerrojo protege el ciclo del evento.** `decidir`, `publicar`,
`suspender`, `enviar` y `evaluar` leían `workflow_status`, validaban contra él y
escribían, sin nada en medio: un `reject` y un `approve` simultáneos sobre un
evento en SUBMITTED dejaban `SUBMITTED → DRAFT → APPROVED`, una transición que
la máquina no permite, con el sello puesto y dos decisiones contradictorias.
`test_dos_decisiones_a_la_vez_no_producen_una_transicion_imposible` lo prueba y
se pone roja al quitar el cerrojo.

## 6. Estados

Doce en el contrato. **Siete se guardan**; los otros cinco no son columnas
porque no son decisiones de nadie:

| Derivado | De dónde sale |
|---|---|
| `SOLD_OUT` | del aforo. Guardado, miente en cuanto alguien cancela. |
| `IN_PROGRESS`, `COMPLETED_PENDING` | de las fechas, como `time_state`. |
| `MODIFIED` | de que exista una versión posterior a la vendida. |
| `SETTLED` | de la liquidación, que este incremento no implementa. |

El CHECK de la 0060 acepta exactamente los siete guardables: nadie puede
escribir `SOLD_OUT` a mano.

**Transiciones del Incremento 1:**

```
DRAFT ──submit──► SUBMITTED ──approve──► APPROVED ──publish──► PUBLISHED
  ▲                   │                                            │
  │                   ├──approve_conditional──► CONDITIONAL        ├─suspend─► SUSPENDED
  └───request_changes─┤                              │             ◄─resume───┘
  └───reject──────────┘                              └──submit──► SUBMITTED
```

**`REJECTED` no se inventa.** El blueprint no lo tiene entre sus estados; el
rechazo vive en la decisión de admisión, con su motivo y su autor, y el evento
vuelve a borrador sin haber estado publicado nunca.

**`cancel` no existe todavía.** Cancelar abre el flujo de devoluciones y este
incremento no cobra entradas. Un `CANCELLED` sin devolución detrás prometería
una gestión que no existe. Para detener las ventas está `suspend`.

## 7. Permisos

| | Organizador | Curaduría (`moderator`) | Administración (`admin`) |
|---|:---:|:---:|:---:|
| Crear y editar su borrador | ✅ | — | — |
| Enviar a revisión | ✅ | — | — |
| Ver la cola de revisión | — | ✅ | ✅ |
| Puntuar (ocho criterios) | — | ✅ | ✅ |
| Pedir correcciones | — | ✅ | ✅ |
| Aprobar / condicionar / rechazar | — | ❌ | ✅ |
| Publicar | — | ❌ | ✅ |
| Suspender y reanudar | — | ❌ | ✅ |
| **Sobre su PROPIO evento** | — | — | ❌ |

Curaduría **puntúa**; administración **decide**. Un curador que puntúa 92 no ha
aprobado nada.

`is_admin` no se usa para admitir: incluye `moderator`, y con esa comprobación
un moderador podía aprobar y publicar. Es el mismo patrón que separó moderar
contenido de mover dinero.

**Nadie aprueba, publica ni PUNTÚA su propio evento.** Puntuarse era la puerta
de al lado de aprobarse: el puntaje es exactamente lo que habilita la aprobación
de otra persona, así que una cuenta de curaduría que organiza podía ponerse
100/100 y esperar a que alguien pulsara aprobar. Evaluar, pedir correcciones,
registrar requisitos y leer el expediente exigen que el evento sea ajeno.

**El rol se comprueba antes de buscar el evento.** Al revés, un identificador
inventado daba 404 y uno real 403, y con eso se sondea qué eventos existen. La
propiedad se comprueba después, que es lo que impide aprobarse el propio.

**El organizador no ve la evaluación interna.** No es que se filtre y se quite:
`EventoDelOrganizador` no declara los ocho puntajes. La deliberación no cabe en
su contrato, ni en el servidor ni en el repositorio del móvil.

## 8. Versionado

`event_versions` guarda una fotografía inmutable de lo comprometido: título,
promesa, categoría, descripción, fechas, zona horaria, modalidad, recinto y
aforo. **No** lleva la portada ni el enlace al grupo: cambiar una imagen no
cambia lo prometido, y obligar a una revisión por eso solo consigue que nadie
retoque nunca una foto mal recortada.

- Se congela **al enviar a revisión**.
- Correlativa por evento (1, 2, 3…), con `changed_fields` respecto de la anterior.
- **Una sola vigente**: índice parcial `where status <> 'superseded'`.
- **No se reescribe ni se borra**: disparador en PL/pgSQL, como la 0051 con las
  versiones de curso. Lo único que puede cambiar es `status`.

El disparador **deja pasar la cascada**: si el evento ya no existe, la versión
se va con él. Sin esa salida, el disparador impide borrar el evento entero y,
por la cascada de `organizer_id`, también dar de baja la cuenta de quien lo
organizó.

> **Hallazgo de línea base, no corregido.** `course_versions` (0050/0051, ya
> aplicadas) **no** tiene esa salida, y allí el problema es real: comprobado
> contra PostgreSQL, borrar un curso con una versión publicada falla con «Una
> versión de curso no se borra». Por cascada, tampoco se puede dar de baja la
> cuenta de su autor. Corregirlo toca migraciones aplicadas y el módulo de
> Cursos; queda reportado, sin tocar.

## 9. Admisión

Los ocho criterios del blueprint, con sus pesos: propuesta 20, trayectoria 15,
programa 15, recinto 15, seguridad 15, precio 10, accesibilidad 5, afinidad 5.

```
aprobado     ->  85 o más y CERO fallas críticas
condicional  ->  entre 80 y 84, y cero fallas críticas
rechazado    ->  menos de 80
```

**Una falla crítica impide aprobar aunque el puntaje sea alto.** Es la regla que
más fácil se pierde al programarla: con un `if total >= 85` delante, un evento
sin plan de emergencias y con 98 puntos entra igual.

La regla está escrita **tres veces**, y las tres hacen falta:

1. `admission.py`, para explicar el rechazo con una frase útil.
2. Un CHECK en la 0060, para que ninguna ruta —ni una futura, ni un script—
   pueda aprobar un evento de 70.
3. `admisionDeEvento.ts`, para no ofrecer un botón que va a responder 409.

**El sello «Seleccionado por Z»** solo lo concede una decisión `approved`. Un
condicional no lo lleva; rechazar lo quita. En el móvil se pinta únicamente si
el servidor lo confirma en `seleccionado_por_z`.

## 10. La migración 0060

Aditiva. **`events` no se toca: ni una columna.** No es purismo: una columna
nueva ahí rompe `select(Event)` en el catálogo, en Explorar, en la búsqueda y en
el perfil a la vez, desde que se despliega el código hasta que alguien pega el
SQL en Supabase. La regla del proyecto es que desplegar no puede exigir una
migración puesta, y hay una prueba por cada migración que lo comprueba.

Cinco tablas: `event_operations`, `event_versions`, `event_admission_reviews`,
`event_admission_decisions`, `event_documents`. RLS activa en las cinco, cero
concesiones a `anon`/`authenticated`, ninguna política de escritura.

`event_admission_reviews` **no tiene ninguna política**: una política `for
select` entrega la fila entera, y esa fila es la deliberación de curaduría.

**Backfill honesto.** Los eventos publicados se quedan publicados, con
`origin = 'legacy'` y `selection_status = 'none'`. No se les regala el sello, no
se les inventa una puntuación y no se les fabrica una versión: no pasaron por
una admisión que no existía.

### Dos agujeros que las pruebas encontraron antes de aplicarla

1. **Aprobar sin puntaje colaba.** El CHECK decía
   `decision = 'approved' and critical_failure = false and total >= 85`. Con
   `total` nulo, `total >= 85` no da FALSO: da NULL, y **un CHECK que evalúa a
   NULL se cumple**. Quedaba aprobado un evento sin ninguna puntuación. Ahora
   lleva `total is not null` delante.
2. **El disparador impedía borrar el evento.** Ver §8.

## 11. Lo que este incremento NO hace

Stripe para eventos, tipos de entrada pagados, checkout, retención de diez
minutos, QR, check-in, transferencia de entradas, reseñas de eventos,
devoluciones, liquidaciones, riesgo dinámico, modo sin conexión, mapa,
geolocalización, wallet, seguros, varios países, recomendación predictiva,
automatizaciones internas y AWS.

`EventRegistration` sigue siendo **una reserva gratuita**. No es una orden, ni
una entrada, ni un pago, ni un check-in, ni inventario comercial.

## 12. Bloqueos que dependen de negocio

Del capítulo 24 del blueprint, ninguno resuelto y ninguno inventado:

- Qué entidad figura como vendedor y *merchant of record*.
- Disponibilidad de Stripe Connect y transferencias por país.
- Tratamiento tributario y comprobantes.
- Texto jurídico final de protección y reembolso.
- Garantías, seguro y permisos por categoría y aforo.
- Porcentaje de comisión.
- SLA de soporte y fondo de reserva.
- Política de datos biométricos, si se usan.

Mientras no estén cerrados, la reserva es gratuita y no hay dinero de eventos en
ninguna tabla.

---

## 13. Lo que la revisión independiente dejó abierto

Tres agentes revisaron el diff —concurrencia, permisos y contratos— y cada
hallazgo se reprodujo antes de tocar nada. Lo corregido está en los commits;
esto es lo que se decidió **no** hacer, y por qué.

| Abierto | Por qué se deja |
|---|---|
| Los listados piden 50 y no hay «cargar más» | A partir del evento 51 el contenido es inalcanzable. El servidor ya acepta `offset`; falta la interfaz. No hay ningún organizador con 50 eventos todavía. |
| `documentos` y `bloqueos_para_publicar` llegan vacíos en `/pending` | La lista no los pinta, así que hoy no dice nada falso. El mismo tipo significa cosas distintas según la ruta, que es lo que hay que arreglar cuando se use. |
| No hay portada, enlace al grupo ni zona horaria en el editor nuevo | Los dos primeros se editan desde la hoja del perfil mientras el evento sea borrador. `timezone` queda en `null`: la columna existe y nadie la escribe. Ausente es honesto; poner la del teléfono sería inventarla. |
| Sin `lock_timeout` en la conexión | Un cerrojo pegado espera indefinidamente con un pool de diez. Ya no hay ninguno que se quede pegado, pero el parámetro protegería de los que vengan. Es una decisión de toda la API, no de Eventos. |
| La rama `IntegrityError` del aforo no está probada | Con el cerrojo puesto no puede ocurrir: no hay otro escritor. Está anotada como defensa sin verificar en el propio código. |
| La migración 0001 no es idempotente | `create type public.app_role` no tiene guarda, así que aplicar las migraciones dos veces falla ahí. Es la única prueba de PostgreSQL en rojo. Corregirlo toca una migración **aplicada** y necesita autorización expresa. |

### El hallazgo de línea base que no se toca

`course_versions` (0050/0051, aplicadas) tiene un disparador que impide borrar
una versión, **y la cascada de `courses` choca con él**. Comprobado contra
PostgreSQL: borrar un curso con una versión publicada falla con «Una version de
curso no se borra». Por la cascada de `courses.author_id`, tampoco se puede dar
de baja la cuenta de su autor.

El arreglo es el mismo que lleva la 0060: dejar pasar el borrado cuando la fila
padre ya no está. Toca migraciones aplicadas y el módulo de Cursos, y ninguna de
las dos cosas entra en este incremento.

---

# Eventos · Incremento 2

Tipos de entrada, inventario y reserva temporal. **No cobra nada.**

## 14. Qué es una reserva temporal y qué no es

Es «estas cuatro entradas quedan apartadas para ti durante diez minutos». No es
una compra, no es una orden, no es una entrada emitida y no mueve un céntimo.

El incremento llega hasta aquí a propósito: el cobro necesita decisiones que la
empresa no ha tomado —quién figura como vendedor, la comisión, los impuestos,
los comprobantes— y un carrito que no lleva a ninguna parte es peor que no
tenerlo. `event_ticket_holds.status` admite `CONSUMED` porque lo pide el
contrato, y **ningún camino lo escribe**: hay una prueba que lee el código para
comprobarlo.

## 15. Los dos modos de acceso

| | `FREE_RSVP` | `TICKETED` |
|---|---|---|
| Qué ofrece la ficha | «Reservar» | «Elegir entradas» |
| Qué se guarda | `event_registrations` | `event_ticket_holds` |
| Conviven | **No.** Nunca los dos a la vez | |

`INVITATION_ONLY` está en el contrato y **no tiene flujo**: la columna lo
admite, la aplicación no lo ofrece. Un modo que la base acepta y la interfaz no
enseña es honesto; uno que la interfaz enseña sin flujo detrás, no.

**Sin fila de configuración significa `FREE_RSVP`.** Es lo que son los ocho
eventos que existen, y por eso la 0061 **no hace backfill**: escribirles una
fila que dijera lo que ya se sabe por su ausencia haría creer que alguien
decidió algo sobre ellos. La migración se lo exige a sí misma.

**No se pasa de gratuito a con entradas con reservas encima.** Convertirlas en
compradas sería regalar entradas que nadie pagó; borrarlas, echar a quien ya se
apuntó. La conversión necesita decidir qué pasa con cada una.

En el móvil, `accessMode` a `null` significa **«no se preguntó»** —es lo que
llega del listado, que no lo trae para no hacer una consulta por fila— y
entonces se ofrece lo de siempre.

## 16. La migración 0061

Cuatro tablas: `event_ticketing_settings`, `event_ticket_types`,
`event_ticket_holds`, `event_ticket_hold_items`. RLS en las cuatro, cero
concesiones, **ninguna política** (una `for select` entrega la fila entera, y la
de un tipo lleva el cupo y los topes, que son inventario).

### Lo que sostiene la base, y no un `if`

| Invariante | Cómo |
|---|---|
| Una sola moneda por evento | Clave ajena **compuesta** `(event_id, currency)` de los tipos contra la configuración |
| Un tipo de otro evento no entra en una reserva | Otra clave compuesta, la forma de `quiz_answers` en la 0058 |
| `subtotal = cantidad × precio` | CHECK por línea |
| La suma de líneas cuadra con la cabecera | Disparador **diferido**: es una restricción entre filas, se comprueba al confirmar |
| Una sola reserva `ACTIVE` por persona y evento | Índice parcial |
| Una clave de idempotencia no se repite | `unique (event_id, user_id, idempotency_key)` |
| No se borra un tipo con reservas | `on delete restrict` |

El índice parcial **no puede mirar el reloj** (`now()` no es inmutable). Lo
resuelve el servicio: antes de crear un hold marca `EXPIRED` los pasados de hora
de esa persona. Así el índice sostiene la invariante sin depender de que la
limpieza haya corrido.

## 17. Inventario y concurrencia

```
aforo aprobado
  − reservas gratuitas confirmadas
  − lo apartado en holds ACTIVOS y no vencidos
  − entradas vendidas          ← no existen todavía, y no se inventan
```

El tercer sumando está en la fórmula y vale cero: no hay tabla que las guarde.
Se deja escrito para que añadirla no obligue a rehacer el cálculo.

**Se calcula, no se guarda.** Un contador es una copia que se desincroniza en
cuanto una transacción se deshace.

**El mismo cerrojo que el aforo gratuito.** `crear_hold` bloquea la fila del
evento: un evento no reparte aforo por dos caminos a la vez y no hay dos órdenes
de bloqueo que puedan invertirse. Los tipos se leen después, ordenados por
identificador.

**Comprobado con una mutación:** quitando `bloquear_evento` se ponen rojas cinco
pruebas —dos por la última entrada, diez por tres, dos tipos compartiendo aforo,
un evento sin aforo y la idempotencia simultánea—.

## 18. Expiración

Un hold dura diez minutos. Dos mecanismos, y el orden importa:

1. **La lectura es correcta sola.** Un hold con `expires_at <= now()` no ocupa
   inventario aunque su fila siga diciendo `ACTIVE`.
2. **La limpieza es comodidad.** `POST /admin/events/ticket-holds/expire`,
   protegida, por lotes, idempotente y sin bucle: devuelve cuántas procesó y
   quien la llame decide si vuelve. Pensada para un programador externo; un
   temporizador dentro de FastAPI la ataría a que hubiera exactamente un proceso
   vivo.

La disponibilidad **no espera** a la limpieza. Si esa fuera la única forma de
liberar inventario, un fallo del programador dejaría el evento agotado con la
sala vacía.

## 19. El dinero

Enteros, en unidad menor. **4900 son S/ 49.00.** Ni una división, ni un
`toFixed`, ni un `parseFloat` en ninguna cuenta de dinero, en Python ni en
TypeScript. Hay una prueba que lo comprueba sobre el código sin comentarios y
acotada al tramo del dinero.

**El servidor calcula todo.** El cliente manda tipo y cantidad; el precio **no
cabe en el contrato**. Y se congela en la reserva junto con el nombre del tipo:
si el organizador los cambia después, el resumen sigue contando lo que se apartó.

### Lo que la interfaz dice, y lo que no

- Dice **«subtotal de entradas»**. Nunca «total».
- Avisa de que los cargos y las condiciones finales se mostrarán antes de una
  compra real, cuando estén definidos.
- **No muestra una comisión de cero** como si estuviera decidida.
- **No hay botón de pagar, ni siquiera apagado.** Uno deshabilitado sugiere que
  llega en un minuto, y lo que falta no es un botón.

## 20. La bandera

`FEATURE_EVENT_TICKETING`, apagada.

| | Migración sin aplicar | Aplicada, bandera apagada |
|---|---|---|
| Rutas nuevas | 503 `event_ticketing_not_available` | 503, el mismo |
| Catálogo y ficha | igual | igual |
| Reserva gratuita | igual | igual |
| Datos | no existen | existen, sin ofrecerse |

## 21. Qué depende de negocio

Del capítulo 24 del blueprint, ninguno resuelto y ninguno inventado: vendedor de
registro, disponibilidad de Stripe Connect por país, tratamiento tributario y
comprobantes, texto jurídico de protección y reembolso, garantías y permisos por
categoría, **porcentaje de comisión**, SLA de soporte y fondo de reserva.

Mientras no estén cerrados no hay cobro, y por eso el subtotal se llama subtotal.
