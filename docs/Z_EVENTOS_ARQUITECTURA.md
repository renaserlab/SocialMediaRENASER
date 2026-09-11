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


---

# Eventos · Incremento 3

Hold vigente → orden → intento de pago → aviso verificado → entrada → check-in.

**NO SE COBRA NADA TODAVÍA.** `FEATURE_EVENT_PAYMENTS` nace apagada y
`EVENT_PAYMENTS_PROVIDER` nace en `none`. No hay credenciales en el repositorio,
no se llama a ninguna pasarela y ninguna prueba simula un cobro real. Lo único
que se confirma solo es una orden de total CERO —una cortesía dentro de un
evento con entradas—, y no porque se salte nada: es que no hay dinero que
confirmar.

## 22. La migración 0062

Cuatro tablas, ninguna columna sobre las anteriores, sin backfill y detrás de
las mismas puertas de capacidad que el resto del módulo.

| Tabla | Qué guarda |
|---|---|
| `event_orders` | La intención comercial nacida de una reserva vigente |
| `event_order_items` | Copia comercial de las líneas: nombre y precio congelados |
| `event_tickets` | Una fila por entrada emitida, con el `sha256` de su credencial |
| `event_checkins` | Cada intento de admisión, el bueno y los malos |

Lo que sostiene la base, y no un `if`:

* **Una orden por reserva.** `unique (hold_id)`.
* **La orden y su reserva son del mismo evento, comprador y moneda.** Una sola
  clave ajena compuesta de cuatro columnas contra `event_ticket_holds`. La 0062
  añade —de forma aditiva, sin tocar la 0061— la pareja única que necesita.
* **Una referencia del proveedor no confirma dos órdenes.** Índice único parcial
  sobre `(provider, environment, external_payment_id)`.
* **Una orden pagada con pasarela tiene evidencia.** `PAID` con proveedor y sin
  identificador externo no entra.
* **El total cuadra con sus líneas y la orden tiene al menos una.** Disparador
  diferido sobre las dos tablas, comprobado al confirmar.
* **Se emiten exactamente las entradas compradas**, y solo cuando la orden está
  `PAID`. También diferido, y también sobre las líneas: cambiar una cantidad de
  una orden ya pagada movería lo comprado sin mover lo emitido.
* **Una entrada se usa una vez.** Índice único parcial sobre el check-in
  correcto, `where result = 'OK'`.
* **El estado y las fechas dicen lo mismo.** `PAID` sin `paid_at`, `USED` sin
  hora de entrada o `REVOKED` sin fecha no entran.

RLS en las cuatro, `revoke all` y **ninguna política**. Aquí menos que en
ninguna otra tabla del módulo: esto es dinero y es acceso a un recinto, y una
política `for select` pondría el histórico de compras de otras personas a un
`select` de distancia desde el teléfono. El móvil no lee estas tablas: pregunta
por la API, que además de comprobar quién pregunta decide qué campos devuelve.

## 23. El flujo, y dónde se corta

**El inventario sigue siendo del hold.** Crear la orden NO consume la reserva:
la reserva sigue apartando las entradas mientras se prepara el pago, y si vence,
vence con la orden dentro. Consumirla al crear la orden dejaría entradas
apartadas por una orden que puede no pagarse nunca.

**Quien decide que hubo un cobro es el aviso verificado del proveedor**, y nadie
más: ni que el navegador vuelva de la pasarela, ni que el móvil lo diga, ni que
la orden lleve un rato en `PAYMENT_PROCESSING`.

**Un pago tardío no concede aforo.** Si la reserva venció mientras se pagaba, el
aforo volvió al común y puede estar vendido: se falla en cerrado y el caso queda
conciliable por administración. Inventar capacidad para no dar una mala noticia
es como se meten 210 personas en una sala de 200.

Cada comprobación de `_por_que_no_cuadra` es una forma conocida de regalar una
entrada: sin importe, importe cero, pago parcial, importe de más, sin moneda,
otra moneda, otro entorno, otra pasarela, y una orden que nunca abrió un cobro.
**La ausencia del dato no vale como coincidencia**: sustituirla por el valor
esperado —un `or`, un `coalesce`— convierte un aviso incompleto en una entrada
regalada.

## 24. Lo emitido ocupa sitio

La disponibilidad resta cuatro cosas del aforo aprobado: reservas gratuitas,
entradas apartadas en holds vivos, **entradas emitidas** y nada más.

Ese tercer sumando faltaba, y era el fallo más grave de este incremento: al
pagar, la reserva pasa a `CONSUMED` y deja de contar como apartada; si lo
emitido tampoco contaba, el aforo volvía entero al común. Con aforo 3 se vendían
3, y otras 3, y otras 3, sin límite y sin concurrencia. Lo encontraron dos
revisores independientes por separado y uno lo reprodujo empíricamente.

`REVOKED` no cuenta —una entrada retirada deja de ocupar, o el aforo se iría
agotando con entradas que ya no existen— y `USED` sí, que quien ya entró ocupa
el sitio más que nadie.

La disponibilidad devuelve además `exceso`: cuánto se pasa del aforo lo ya
comprometido. `general` no puede decirlo porque nunca baja de cero, y por eso la
recomprobación bajo cerrojo de `confirmar_pago` era código muerto.

## 25. Orden de bloqueo

**Evento → orden → hold**, y ese orden no cambia en ninguna función. El cerrojo
de la fila de `events` sigue siendo el punto de serialización del módulo entero:
reserva gratuita, hold, orden y confirmación pasan todos por él y en el mismo
orden, así que no hay dos órdenes de bloqueo que puedan invertirse.

Dos cosas que aprendimos aquí y no son evidentes:

1. **`with_for_update()` sobre un objeto que ya está en la sesión no lo
   refresca.** El cerrojo se toma, sí, pero lo que se comprueba debajo es la
   foto anterior. Todas las relecturas bajo cerrojo llevan
   `populate_existing=True`.
2. **Un `rollback` dentro de un savepoint ajeno deshace la transacción
   entera.** En el camino del webhook eso se llevaba por delante la fila
   anti-repetición del aviso: cobro hecho, sin entrada, sin rastro y con un 204
   que le dice a la pasarela que no reintente. `bloquear_evento` y
   `espera_traducida` aceptan `deshacer=False` para quien corre dentro de uno.

## 26. QR y check-in

**La credencial no se guarda: se guarda su `sha256`.** El valor en claro se
entrega una vez, viaja dentro del QR y no vuelve a existir en el servidor. Quien
lea la tabla —una copia de seguridad, un volcado, una consulta de más— no puede
fabricar un QR con lo que ve.

**Rota al pedirla**, y con ella rota el código que se teclea. Los dos admiten y
los dos viajan en la misma pantalla: rotar solo el QR dejaba la defensa a medias
y quien fotografiara la entrada entraba tecleando el código. Por lo mismo, la
lista de asistentes no devuelve códigos: se BUSCA por el que la persona enseña.

**Dentro del QR va un token opaco y nada más**: ni nombre, ni correo, ni precio,
ni el identificador de la entrada.

**El check-in lo decide un `UPDATE ... WHERE status = 'VALID'`**, no un `if`: dos
lectores escaneando el mismo QR en el mismo segundo leen los dos `VALID`. Un
segundo escaneo devuelve «ya utilizada» con la hora a la que entró, sin volver a
escribir. Por debajo, el índice único parcial de la 0062.

**La puerta de un evento no es de cualquiera.** Crear un evento es libre, así que
bastar con ser su organizador convertía el identificador de un borrador propio en
un oráculo de validez de entradas ajenas: la respuesta distingue «no existe» de
«es de otro evento». Se exige además que el evento esté publicado y venda
entradas, y todas las rutas de la puerta responden 404 —nunca 403— sobre lo que
no se puede operar.

## 27. Banderas

| Bandera | Qué gobierna | Nace |
|---|---|---|
| `FEATURE_EVENT_TICKETING` | Tipos, disponibilidad, reservas y **pedidos** | apagada |
| `FEATURE_EVENT_PAYMENTS` | Abrir un cobro | apagada |
| `EVENT_PAYMENTS_PROVIDER` | Qué pasarela cobra | `none` |

Separadas a propósito. Apagar `FEATURE_EVENT_PAYMENTS` detiene la VENTA y deja
intacto el inventario; **no impide confirmar lo ya iniciado**, porque quien pagó
no puede quedarse sin su entrada, y no convierte un evento de pago en uno
gratuito. `STRIPE_PAYMENTS_ENABLED` es de Cursos y no tiene nada que decir sobre
una entrada: el reparto por dominio ocurre antes de mirarla.

## 28. Integración futura con Stripe

El puerto ya existe y es el de Cursos: `PaymentProvider` con `create_checkout` y
`verify_and_parse`. Eventos no conoce Stripe; habla con esa interfaz.

Lo que falta para cobrar de verdad, y ninguna de las dos es código:

1. Cuenta de Stripe habilitada, claves y secreto del webhook en el entorno
   —**nunca en el repositorio**— y `EVENT_PAYMENTS_PROVIDER=stripe`.
2. Las decisiones del capítulo 24 del blueprint, que siguen abiertas.

El webhook comparte endpoint con Cursos (`/payments/webhook/stripe`) y reparte
por `metadata.dominio`, que fijamos nosotros al abrir el cobro. Las garantías son
las mismas: firma verificada antes de cualquier efecto, aviso guardado en crudo
contra el índice anti-repetición, savepoint para que un fallo no se lleve ese
registro, y el error anotado **sin propagar** —reintentar un aviso que no cuadra
no lo arregla y pone a la pasarela a repetirlo durante días.

## 29. Rollback y despliegue progresivo

La 0062 se deshace con los `drop` que lleva escritos en su cabecera, y deshacerla
devuelve la base al estado de la 0061 sin perder un evento, una reserva ni una
decisión de admisión.

Segura en los dos órdenes: **código antes que esquema**, las rutas nuevas
responden 503 `event_orders_not_available` y todo lo anterior funciona igual;
**esquema antes que código**, cuatro tablas que nadie lee y sin una sola fila.

Orden recomendado para encender: aplicar la 0062 → `FEATURE_EVENT_TICKETING` en
un evento de prueba → comprobar el camino de total cero, que no necesita
pasarela → configurar Stripe → `FEATURE_EVENT_PAYMENTS`.

## 30. Monitoreo y conciliación

Qué mirar cuando esto esté encendido:

* Órdenes en `PAYMENT_PROCESSING` con la reserva vencida: las cierra
  `POST /admin/events/orders/expire`, que audita el lote.
* Filas de `payment_events` con `error` no vacío y `dominio = evento`: la cola
  de conciliación. Hay **dos clases distintas** y conviene no confundirlas:
  * las que no cuadraron —importe distinto, reserva vencida, pedido
    cancelado—: **cada una es un cobro sin entrada**;
  * las que empiezan por «Devolución o disputa de un pedido de entradas»:
    **es dinero que vuelve**, lo contrario. No se ha revocado ninguna entrada
    ni se ha tocado el pedido, porque retirar la entrada es una decisión
    comercial —plazos, penalización, quién decide— que nadie ha aprobado
    todavía. Se anotan para que las mire una persona.
* Órdenes `PAID` sin entradas: no deberían existir —lo impide el disparador
  diferido— y si aparecen, es que alguien escribió por fuera del servicio.
* `event_checkins` con `result <> 'OK'` agrupado por evento: una puerta con
  muchos `NOT_FOUND` suele ser un lector mal configurado, no fraude.

## 31. Lo que el Incremento 3 NO hace

Nada de esto está a medias ni apagado: no existe, y documentarlo es lo que
impide que alguien lo dé por hecho.

Reventa · transferencia entre personas · lista de espera · asiento numerado ·
mapa de asientos · descuentos · cupones · impuestos · factura o boleta ·
comisión de plataforma · liquidación al organizador · devolución de entradas ·
cancelación masiva con reembolso · eventos recurrentes · varias monedas en un
evento · `INVITATION_ONLY` · pagos reales.


## 32. El Incremento 4: la puerta

No hay migración nueva. La 0062 ya sostiene todo lo que la puerta necesita, y
lo que faltaba estaba en el código, no en el esquema.

### 32.1 La credencial

`secrets.token_urlsafe(32)` —256 bits, opaca, sin estructura, sin nada de la
persona ni del precio—. **La base guarda su `sha256`, no ella.** El valor en
claro se entrega una vez a quien compró, viaja dentro del QR y no vuelve a
existir en el servidor.

Pedirla otra vez **rota**: se genera una nueva, la anterior deja de valer, y
**el código escrito debajo rota con ella**, porque quien fotografía la pantalla
se lleva los dos. Rotar deja rastro en auditoría —invalida el QR que alguien ya
tiene guardado— y ni la credencial ni el código entran en ese rastro.

Y la rotación es atómica frente a la puerta: la escritura del check-in lleva la
credencial en su condición, así que un QR rotado a mitad de escaneo **no
admite**. Sin eso, el QR viejo seguía dejando pasar y rotar no prometía nada.

**Y el código tecleado recibe el mismo trato desde la 0063.** Era el agujero
que quedaba: corto y legible a propósito —se dicta en la puerta cuando la cámara
falla— y `_buscar` lo acepta como credencial, así que un volcado de la tabla
entregaba un juego completo de entradas. Ahora la base guarda `code_hash` y la
columna en claro se deja vacía; el valor lo ve su dueño una sola vez, al rotar.

La 0063 es **aditiva y no destruye nada**: calcula el resumen a partir del
código que ya existe —no inventa ninguno— y relaja la columna para que la
aplicación pueda dejar de escribirla. Una entrada anterior a la migración sigue
admitiendo con su texto legible, pero **solo mientras esa fila no tenga
resumen**: en cuanto lo tiene, manda el resumen, así que una rotación invalida
de verdad el código anterior aunque su texto siga en la columna. Purgar esos
textos es un `UPDATE` escrito al final de la migración y **no se ejecuta ahí**:
borrar datos lo decide una persona.

Efecto lateral que cierra otra cosa: la búsqueda de asistentes pasa a ser
**exacta**, porque un resumen no admite «empieza por». El recorrido letra a
letra deja de ser caro y pasa a ser imposible.

### 32.2 Verificar y hacer check-in

Dos preguntas distintas. `verify` mira y no escribe; se puede hacer mil veces.
`check-ins` deja pasar **una vez**, y lo que lo garantiza no es un `if` sino un
`UPDATE ... WHERE status = 'VALID'` y su `rowcount`, con el índice único parcial
de la 0062 por debajo.

Seis respuestas: `OK`, `ALREADY_USED`, `REVOKED`, `NOT_FOUND`, `WRONG_EVENT`,
`NOT_ADMITTING`. Una entrada cuya credencial acaba de rotar responde
`NOT_FOUND`, **no** `ALREADY_USED`: decir lo segundo sería mentir sobre una
entrada que nadie ha usado.

**El camino tecleado y el de la cámara son el mismo.** Un solo endpoint, una
sola implementación, las mismas reglas. Lo único que los distingue es el rastro.

### 32.3 La espera acotada, que no es un detalle

Registrar un intento inserta en `event_checkins`, y su clave ajena a `events`
pide un `for key share` sobre la fila del evento. Eso **choca** con el
`for update` que toma cualquier compra, confirmación de pago o cambio de
ajustes. Sin límite de espera, cada escaneo se queda parado hasta que la otra
transacción termine, ocupando una conexión: con el tamaño del pool, diez
escaneos parados no paran esa puerta, paran la API.

Por eso la puerta usa el mismo `limitar_la_espera` + `espera_traducida` que el
resto del módulo, y el choque sale como un 409 reintentable con nombre.

### 32.4 El rastro

Cada intento deja dos cosas: la fila operativa en `event_checkins` y la línea
de auditoría. La línea identifica **actor, evento, entrada, resultado, fecha y
canal**, y el canal —`qr` o `code`— **lo decide el servidor**, mirando cuál de
las dos búsquedas encontró la fila. No lo declara el cliente: quien teclea no
puede decir que escaneó.

Importa porque el camino tecleado es el débil. Doscientos check-ins a mano desde
la trastienda eran, en el histórico, idénticos a doscientos escaneos.

`outcome` distingue `ok` de `denied`, y cuando no hay entrada la línea dice ser
de un **evento**, no de una entrada que no existe.

Si la auditoría no se puede escribir, **el check-in no se confirma**: la entrada
no se consume y se puede volver a escanear. Es la única salida que no miente.

### 32.5 Los siete números

Aforo · apartadas · emitidas · válidas · usadas · revocadas · **presentes**.

No significan lo mismo y enseñar uno por otro es cómo un organizador cree que
vendió lo que sigue en la cesta de alguien. Los **presentes** salen de
check-ins correctos distintos: ni de pedidos, ni de reservas, ni de compradores,
ni de una suma guardada a mano.

### 32.6 El escáner

`expo-camera`, que el proyecto ya usaba. **Ninguna dependencia nueva.**

El permiso se pide solo al entrar. Se distinguen los cuatro estados —sin
resolver, concedido, rechazado y **bloqueado**—, y el bloqueado lleva a los
ajustes del sistema en vez de a un botón que no hace nada. En la web se empieza
a mano, porque el navegador puede no tener cámara.

La cámara se apaga cuando nadie mira (`useSeccionActiva`). Un QR sostenido
delante del objetivo manda **una** petición. Se ve que está comprobando antes
de que llegue el resultado. Y **lo que falla se puede reintentar**: el código
descartado solo se recuerda mientras haya un veredicto en pantalla.

Si se pierde la respuesta de un check-in —que escribe y no es idempotente— se
pregunta con `verify`, que no escribe: sin eso, la entrada podía quedar
consumida mientras la puerta decía «no dejes pasar todavía».

### 32.7 El personal de puerta: la limitación, y por dónde se amplía

**Hoy la admisión es un rol de CUENTA, no una relación con un evento.**
`permissions.ROLES_ADMISION` es `{"admin"}`, así que quien lo tiene alcanza
cualquier evento publicado que venda entradas. Para el organizador la puerta sí
está acotada: solo administra los suyos.

Eso significa que **no se puede dar la puerta de un concierto a una persona
contratada sin darle además acceso a la puerta de todos los demás**. La decisión
de si existe un rol de acomodador, quién lo asigna y con qué alcance no está
tomada, y no me la invento.

**El punto de extensión está en un solo sitio**: `_evento_de_la_puerta`, en
`order_router.py`, es el único predicado por el que pasan `verify`, `check-ins`,
`attendees` y `revoke`. El día que exista una asignación por evento, se añade
ahí una tercera vía —«tiene asignación viva para ESTE evento»— y ninguna ruta
cambia. `/sales` ya está fuera de ese predicado, precisamente para que ampliar
la puerta no reparta la recaudación.

## 34. Incremento 5 — Posventa: lo que hay, y por qué está apagado

### 34.1 La idea entera en un párrafo

La empresa todavía no ha decidido plazos, porcentajes, quién aprueba ni cuándo
se retira una entrada. Este incremento construye el sitio donde esas decisiones
van a vivir —`event_policies`, versionadas y publicadas— y hace que **todo lo
demás se bloquee mientras no existan**. No hay ni un plazo escrito en el código,
ni un porcentaje, ni una aprobación automática.

### 34.2 Por qué «no configurado» es una cuarta respuesta

La elegibilidad contesta cuatro cosas: `eligible`, `not_eligible`,
`needs_review` y `policy_not_configured`. La cuarta no es un fallo: es el estado
de fábrica, y existe para que «todavía no lo hemos decidido» no se convierta en
«no» —ni en «sí»— por descuido.

El mismo cuidado, abajo: `politicas.numero()` devuelve `None` cuando el
parámetro no está, **y no cero**; `politicas.bandera()` devuelve `False`. Un
plazo ausente leído como cero cierra la ventana para todo el mundo; un
porcentaje ausente leído como cero regala el importe entero. **Las dos cosas
cuadran**, así que ninguna prueba de resultado las delata: hay pruebas
explícitas de que el dato ausente no se sustituye, y una de que un booleano no
se lee como número, porque `True` vale 1.

### 34.3 Aprobar no es haber pagado

Es la regla que más importa de todo el incremento, y la impone la máquina de
estados: a `resolved` desde `refund_processing` **solo se llega con el rol
`system`**, es decir, con un aviso verificado del proveedor. Ni un
administrador puede declarar «devuelto» a mano.

Y los actores van **por transición, no por destino**: a `resolved` también se
llega desde `approved`, cuando no hay dinero que mover, y eso sí lo cierra quien
administra. Una tabla por destino no sabría distinguir los dos caminos, y
aprobar acabaría pudiendo declarar «devuelto».

### 34.4 Lo que NO revoca, que es casi todo

`efectos.py` es el único sitio donde vive «retirar el acceso». No revocan: abrir
una solicitud, pasarla a revisión, aprobarla, un intento de cobro sin confirmar,
un timeout, una respuesta ilegible, un aviso sin importe / moneda / referencia,
una devolución **parcial** sin política que lo diga, ni cancelar el evento.

Lo único que revoca es una devolución **total, confirmada, del pedido correcto**
y con la política publicada diciéndolo. Cinco condiciones; si falla cualquiera,
la entrada se queda **retenida** en vez de revocada. La diferencia es la que
importa: **retener es reversible y revocar no**.

«Total» se mide contra el total del **pedido**, no contra el importe que tecleó
quien revisa —medirlo contra sí mismo hacía que una parcial aprobada de 30 sobre
un pedido de 100 pasara por completa—, y **cero no es total**.

### 34.5 La puerta aprende «retenida»

`ON_HOLD` no es `REVOKED` —no se ha retirado nada— ni `NOT_ADMITTING`, que habla
del evento entero. Se comprueba **antes** de escribir, así que una entrada
retenida no se consume; y la condición baja además al `where` del `UPDATE`, para
cerrar la ventana entre leerla y escribir.

Pero **el estado de la entrada se mira primero**: si alguien ya entró con ese
QR, eso es lo que la puerta necesita saber. Contestar «retenida» taparía justo
el dato que importa cuando se presentan dos personas con el mismo código.

### 34.6 Registrar un cambio no es clasificarlo

`PATCH /events/{id}/published` permite corregir un evento ya publicado —una sala
que cambia el mismo día no espera a curaduría— y escribe **una fila por
diferencia**, con su valor anterior y el nuevo, en `event_changes`. Todo en una
transacción: una versión sin sus cambios diría que algo se editó sin decir qué.

Las filas nacen en `pending`, que **no** es «no esencial», y nadie recibe aviso
de ningún derecho. Si un cambio es esencial lo decide una persona, desde
`/admin/events/changes/{id}/classify`.

### 34.7 Restaurar no devuelve la credencial vieja

Reactivar un QR que estuvo fuera de servicio deja entrar a quien lo tuviera
fotografiado. Se invalida —`tickets.invalidar_credencial`, que genera y descarta
sin entregar nada— y su dueño recibe uno nuevo al abrir su entrada.

### 34.8 Lo que el Incremento 5 NO hace todavía

Vistas móviles de posventa · notificaciones (el módulo existente solo tiene
plantillas en español y no tiene reintentos, y las dos cosas hay que arreglarlas
antes de depender de él) · reseñas verificadas · respuesta del organizador ·
ejecución del reembolso contra la pasarela.

## 33. Lo que el Incremento 4 NO hace

Devoluciones de entradas · cancelación de un evento con reembolso · rol de
acomodador atado a un evento concreto (hoy la admisión es un rol de cuenta y
alcanza a cualquier evento publicado con venta) · check-in sin conexión ·
lectura de códigos de barras que no sean QR · resumen del código en la base ·
transferencia de una entrada a otra persona.


## 35. Incremento 5 y 6 — lo que se construyó, y lo que sigue cerrado

### 35.1 El aviso verificado llega hasta la entrada

`efectos.py` existía y estaba probado, pero **nadie lo llamaba**: un
`charge.refunded` de un pedido de entradas se anotaba para conciliar y ahí se
quedaba. Ahora el webhook —repartido a Eventos por la **referencia del cobro**,
porque el objeto `refund` no hereda la metadata del `charge`— localiza el
pedido, abre o recupera su expediente y le entrega el aviso.

Las condiciones no se duplican: siguen una sola vez en
`efectos.revocar_por_devolucion`, y este camino no puede saltárselas.

**Una disputa no es una devolución.** La abre el banco del titular, todavía se
puede ganar, y quién asume la pérdida no está decidido: abre su expediente,
bloquea el importe con una reserva y **no revoca nada**.

### 35.2 Dos defectos que esto destapó

`abrir` y `transicionar` hacían `Session.rollback()`, y el webhook los llama
**dentro del savepoint que protege la fila anti-repetición**. Ese rollback
deshace la transacción entera y se lleva justo el registro que impide procesar
el aviso dos veces. Ahora cada uno deshace dentro de su propio savepoint, con el
`add` dentro —deshacerlo no saca el objeto de la sesión, y el siguiente flush lo
reintentaba—.

Y la máquina de estados no dejaba cerrar un expediente recién abierto: un
reembolso hecho desde el panel de la pasarela dejaba el caso diciendo «enviado»
sobre una compra ya devuelta. Tres saltos nuevos hacia la ejecución, **solo para
el sistema**: registran lo que pasó, no aprueban nada.

### 35.3 Avisos: tres idiomas y una cola

El módulo tenía dos huecos que había que tapar antes de depender de él:
plantillas solo en español, y un envío que fallaba se registraba en un log y
desaparecía.

**El idioma vive en el dispositivo** (`device_tokens.locale`, 0066). No hay
columna de idioma en el perfil, y añadirla obligaría a inventar una preferencia
que nadie ha elegido. El teléfono sí sabe en qué idioma está.

**La cola es una tabla, no un sistema.** Una entrega por suceso de negocio
—índice único—, reintentos con tope y espera creciente, último error saneado,
identificador de correlación, y `sent` solo después de que el envío termine
bien. `tomar` es un `UPDATE` condicional: dos procesos vaciando la cola, uno
cambia una fila y el otro cero.

**Dentro de la API no hay temporizador**: hay varias réplicas y cada una
dispararía el suyo. La vacía `POST /admin/notifications/deliveries/process`, que
invoca un planificador externo.

Ningún texto promete un plazo ni un importe, y hay una prueba que lo comprueba
con una expresión regular sobre los cuarenta y cinco textos.

### 35.4 Reseñas: el sello se deriva

«Asistencia verificada» **no es una columna que alguien pueda escribir**. Una
reseña apunta a su `checkin_id`, y esa fila solo existe si esa persona entró; la
clave ajena lo impone y hay una prueba de que el modelo no tiene ninguna columna
que se le parezca.

Cinco ejes de 1 a 5 —contenido, organización, recinto, seguridad, valor— y una
puntuación general **aparte**, que responde a otra pregunta y por eso no es su
media: promediarlas exigiría decidir cuánto pesa cada eje.

**Un evento sin reseñas no tiene promedio cero: no tiene promedio.** `null`, y
el contrato lo dice. Lo mismo con el porcentaje de recomendación: un porcentaje
sobre cero respuestas no es cero por ciento, es ninguno.

Moderar **esconde**, no borra, y nunca toca autor ni puntuación. La respuesta
del organizador nace apagada: exige una política que nadie ha aprobado, y una
sola visible por reseña —varias serían una forma de hostigar a quien opinó—.

### 35.5 Finanzas: una columna, no un módulo nuevo

`owner_sale_balances` ya guardaba bruto, comisión y neto con su versión de
reglas; `owner_payout_accounts` y `owner_transfers` ya colgaban del perfil. Lo
único que ataba todo eso a Cursos eran **dos columnas NOT NULL**.

La 0068 las relaja, añade `event_id` y `event_order_id`, y un CHECK obliga a que
un saldo tenga **exactamente un origen**. No se usa un par `(tipo, id)`
polimórfico: eso renuncia a la integridad referencial justo en la tabla del
dinero. **Los saldos existentes no se tocan.**

**Sin comisión configurada no se crea ningún saldo.** `platform_fee_bps = -1`
significa que nadie decidió el número; suponer 0 % transferiría el bruto entero
y ninguna prueba lo delataría, porque el resultado cuadra.

**El organizador queda congelado.** Cambiar después el organizador del evento no
redirige dinero ya vendido.

**Nada se libera solo.** `available_at` sale de una política de retención
publicada; sin ella es nulo y `por_que_no_se_libera` devuelve un código
concreto: sin comisión, sin cuenta, sin política, retención en curso, reserva
viva, disputa abierta o expediente abierto. La primera que falte, para decirle
al organizador **una** cosa y no siete.

### 35.6 Conciliar es comparar, no corregir

Una diferencia de dinero no se arregla escribiendo el número que falta: eso no
concilia, tapa. Hay una prueba que descuadra un saldo, comprueba que la
conciliación lo encuentra, y comprueba que **no lo ha tocado**.

### 35.7 Qué sigue apagado, y por qué

| Bandera | Valor | Qué impide |
|---|---|---|
| `FEATURE_EVENT_TICKETING` | `false` | vender entradas |
| `FEATURE_EVENT_PAYMENTS` | `false` | abrir cobros |
| `EVENT_PAYMENTS_PROVIDER` | `none` | pasarela |
| `platform_fee_bps` | **`-1`** | crear saldos, y con ellos todo lo financiero |
| `stripe_connect_enabled` | `false` | cuentas de cobro |
| `creator_transfers_enabled` | `false` | transferir |

Y por encima de las banderas, **nueve políticas sin publicar**. Sin ellas la
elegibilidad contesta `policy_not_configured`, no se revoca ninguna entrada, no
se libera ningún saldo, no se puede reseñar y no se puede responder
públicamente. Publicar una política es lo que enciende cada cosa, y es una
decisión de la empresa.

### 35.8 El orden de despliegue

Las migraciones **0066, 0067 y 0068 están escritas y sin aplicar**. Se aplican
en ese orden; cada una es aditiva y segura en los dos sentidos (código antes que
esquema, y al revés). Las rutas nuevas responden 503 con un código estable
mientras falte su esquema, así que desplegar el código primero no rompe nada.

Tras aplicarlas, el planificador externo debe invocar, con la frecuencia que se
decida:

- `POST /api/v1/admin/notifications/deliveries/process` — vaciar la cola de avisos.
- `POST /api/v1/admin/events/finance/reconcile` — conciliar y reportar.
- `POST /api/v1/admin/events/finance/transfers/run` — hoy devuelve cero y la
  lista de bloqueos.


## 36. Lo que encontró la revisión independiente

Todo lo del capítulo 35 pasaba sus pruebas. Una revisión hecha aparte, sobre el
código ya escrito y sin ver cómo se había escrito, encontró seis agujeros de
dinero y de avisos. **Ninguno lo veía una prueba, y casi ninguno lo veía
SQLite.** Están arreglados; esto cuenta qué eran, porque el patrón importa más
que el parche.

### 36.1 Un saldo reembolsado volvía a estar disponible

El peor de los seis, y el más fácil de no ver.

`liquidacion.congelar`, `descongelar` y `cancelar` filtran todas por
`OwnerSaleBalance.order_id`. En un saldo de EVENTO esa columna es **nula** —el
origen es `event_order_id`—, así que ninguna de las tres tocaba nunca un saldo
de entradas. Y `efectos` y `posventa` no tocan la tabla del dinero en absoluto.

La secuencia completa: se vende cien; el comprador pide devolución y el
expediente abierto bloquea; la pasarela confirma el reembolso, se revocan las
entradas y el expediente pasa a `resolved` —que **no** está entre los vivos—;
vence la retención; y `por_que_no_se_libera` contesta `None`. «No hay nada que
lo impida», sobre cien que ya se le devolvieron al comprador.

Ahora `finanzas.atender_devolucion` lo mueve, y lo llama el mismo webhook que
revoca las entradas —**antes** de revocarlas y aparte de ellas, porque son dos
decisiones distintas: que la política de entradas diga «retener» no significa
que el dinero siga siendo del organizador—:

- confirmada y **total** → el saldo se cancela. No hay nada que pagarle a nadie.
- **parcial**, o todavía sin confirmar → se **retiene** el importe que dice el
  aviso, con el mecanismo de reservas que ya existía. Cuánto se queda el
  organizador de una parcial es una política que nadie ha publicado; bloquear lo
  devuelto es un hecho, restarlo del neto sería inventar el reparto.

Y `por_que_no_se_libera` mira **el estado del propio saldo** como primera
puerta. Contestar `None` sobre un saldo cancelado era la peor respuesta posible
de esa función.

### 36.2 El motor de Cursos se comía los saldos de Eventos

Segunda consecuencia de compartir tabla, y en dirección contraria.

`liquidacion.liberar_vencidos` seleccionaba `pending` con fecha pasada **sin
restringir a Cursos**. Tras la 0068 eso incluye los saldos de entradas, que
tienen sus propias puertas —reserva viva, disputa abierta, expediente abierto— y
las estaba saltando **todas**.

Después, el mismo endpoint lista los `eligible` sin filtrar y los pasa por
`puede_transferirse`, que hacía `db.get(Order, None)` y devolvía
`order_not_payable`. No salía dinero, eso sí; pero eran saldos permanentemente
`eligible` y permanentemente omitidos, **copando el `limite` del turno de pago
de los creadores de cursos**. La inanición que el docstring de ese endpoint
describe, provocada por la migración que decía «Cursos no cambia en nada».

Cursos vuelve a mirar solo lo suyo en las cuatro consultas, y
`puede_transferirse` rechaza un saldo que no es de curso diciendo lo que pasa de
verdad.

### 36.3 Dos 500 que SQLite esconde

`columna_uuid.in_(lista or [""])`. Con la lista vacía manda la cadena vacía
contra una columna `uuid`: **SQLite la acepta y PostgreSQL la rechaza.** El
repositorio ya tenía esa advertencia escrita en seis sitios, y aun así estaba en
dos:

- el panel financiero del organizador, que hoy es el caso de **todos** los
  eventos, porque sin comisión configurada no existe ningún saldo;
- el cursor de la lista de reseñas, que es una ruta **anónima**: cualquiera
  podía provocar el 500 sin sesión, mandando un cursor sin `|`.

La regla es la misma de siempre: **lista vacía = no se consulta**, y si la
segunda mitad de un cursor va a una columna `uuid`, se valida como `uuid`.

### 36.4 La cola mandaba el mismo aviso dos veces

`tomar` apartaba la fila `ESPERAS[0]` —un minuto— y la dejaba en `pending`. Un
envío a Expo va en lotes de cien con diez segundos de margen cada uno: pasar del
minuto es normal. Al minuto y un segundo, otra réplica cogía la misma fila y el
teléfono sonaba dos veces. **El índice único de la clave de suceso no protege de
esto: protege el ENCOLADO, no el ENVÍO.**

Y lo que venía después era peor. La réplica lenta volvía con su resultado cuando
la que la relevó ya había cerrado la entrega, y `marcar_enviada` y `marcar_fallo`
escribían sin mirar el estado: una entrega `failed` volvía a `sent`, o una `sent`
pasaba a `failed` **con la fecha de envío puesta**, que viola el CHECK de la
0066 y tumbaba el `commit` del lote entero fuera de todo `try`.

El arreglo no necesitó estado nuevo ni tocar la migración: el turno dura quince
minutos, y **el número de intento es la prenda**. `tomar` lo devuelve; las dos
funciones que cierran exigen que la fila siga en ese intento y siga pendiente.

### 36.5 La cuenta de cobro salía del entorno del proceso

`_cuenta_de` filtraba por `get_settings().payments_environment`, pero el pedido
tiene **su propio** `environment` y `confirmar_pago` lo valida. Un pedido de
pruebas confirmado por una réplica configurada como producción apuntaba a la
cuenta de cobro **real** del organizador. Y `owner_sale_balances` no guarda
entorno ni proveedor, así que después no había forma de distinguirlos.

La cuenta se elige con el entorno del pedido. La cabecera del módulo ya no
afirma que se congele el entorno, porque no se congela: llega por la cuenta, que
sí lo tiene. La conciliación compara esas dos, que es la comprobación que el
código declaraba y no sabía hacer.

También se comprueba que la cuenta **sirva**: `payout_account_id is not None` no
es lo mismo que poder pagar en ella. Un alta a medias, los cobros apagados o una
cuenta de otra persona pasaban por «nada lo impide». El camino de Cursos sí lo
exigía; este no.

### 36.6 La reserva de una disputa no se soltaba nunca

`liberar_reserva` estaba escrita, probada y exportada, y **no tenía ni un solo
llamante**. La reserva que abre una disputa no se soltaba jamás: ni ganándola
—el estado pasaba a `won` y nadie tocaba la retención—, ni con una ruta, ni de
ninguna otra forma que no fuera SQL a mano.

Ahora se suelta al ganarla o cerrarla, se da por **consumida** al perderla
—ese importe se fue de verdad, y marcarlo «liberado» lo devolvería a la cola del
organizador— y hay una ruta de administración para las demás, que deja nombre.

Y la ruta que las suelta necesitaba otra que las **listara**: el resumen del
organizador solo manda cuánto hay retenido en total. Una puerta de salida que
nadie puede encontrar es la misma retención eterna con otro nombre.

### 36.7 Lo demás

- **Una disputa bloquea por saldo O por pedido.** Abierta antes de que exista el
  saldo se quedaba con `balance_id` nulo para siempre —y hoy, sin comisión
  configurada, son **todas**—, así que el día que se configurara no habría
  bloqueado nada. Además se rellena en cuanto el saldo aparece.
- **La moneda de una reserva es la del saldo.** Un importe en otra divisa
  etiquetado con la del saldo es peor que no tenerlo: no se reserva, y el
  bloqueo lo pone la disputa misma.
- **La retención y la ventana de reseña cuentan desde que el evento TERMINA.**
  Con `starts_at`, en un festival de tres días el reloj corría mientras el evento
  seguía pasando, y se podía opinar a los cinco minutos de entrar. Y sin ninguna
  fecha **no** se pasa por alto la comprobación: dar por terminado un evento del
  que no se sabe nada es lo contrario de comprobarlo.
- **La puerta de los avisos mira `device_tokens.locale`**, no solo la tabla. Con
  media 0066 aplicada contestaba que sí, el encolado leía la columna ausente,
  PostgreSQL dejaba la transacción inservible, el fallo se tragaba —el encolado
  no debe tumbar nada— y el `commit` de la devolución ya confirmada se deshacía.
  El patrón ya estaba en `hay_ordenes`, `hay_posventa` y `hay_finanzas`.
- **El bruto es `bigint`.** Era `integer`: 21 474 836,47 en una moneda de dos
  decimales, con `event_orders.total_minor` ya en `bigint`. Un pedido
  corporativo por encima reventaba el INSERT dentro del savepoint del webhook.
- **Expo contesta 200 con los errores dentro.** `raise_for_status()` solo mira el
  HTTP; un token que ya no existe llega como `error` en una respuesta correcta y
  se marcaba como enviada. Y una entrega sin ningún aparato al que mandarla se
  cierra, pero **no se cuenta como enviada**: el contador de salud mentía.
- **La conciliación solo declara códigos que emite.** Había cuatro que ninguna
  consulta producía, y un panel que contesta cero de un código que nadie mira
  parece haber comprobado algo. Se añadió el descuadre que existe **hoy en
  masa**: pedido pagado sin saldo.
- **Las tres migraciones se reaplican con datos dentro.** Verificaban «este
  fichero no escribe ninguna fila» **contando** las filas, así que abortaban en
  cuanto hubiera una entrega, una reseña o una reserva: justo cuando alguien
  vuelve a pegar el fichero en el editor para terminar de aplicarlo.

### 36.8 Lo que esto enseña

Cuarenta y nueve mutaciones se detectaban antes de la revisión. Ninguna de las
que fallaban aquí era una mutación posible: no eran ramas sin probar, eran
**preguntas que nadie había hecho**. Mutar el código dice si las pruebas miran lo
que hay; no dice nada de lo que falta.

Las tres formas que tomaron:

1. **Una tabla compartida por dos dominios**, donde cada uno da por hecho que
   todas las filas son suyas. La 0068 relajó dos columnas y eso bastó para que
   seis consultas de Cursos empezaran a ver eventos, en las dos direcciones.
2. **Una base de pruebas más permisiva que la de verdad.** SQLite acepta `''`
   donde PostgreSQL quiere un `uuid`; las dos veces, el 500 solo existía en
   producción.
3. **Una función escrita, probada y sin llamar.** `efectos` ya había estado así
   —el capítulo 35.1 lo cuenta— y `liberar_reserva` lo estaba otra vez. Una
   prueba unitaria verde no dice que el código forme parte de ningún camino.

### 36.9 Las vistas, y lo que queda

Las pantallas de reseñas y las financieras están construidas y **enlazadas**:
las reseñas desde la ficha del evento, «Ventas y saldo» desde la pantalla de
quien organiza, y las dos bandejas de plataforma desde «Mis eventos», con la
misma regla que la cola de revisión de al lado —se ofrecen y el servidor
contesta—. Una ruta alcanzable solo tecleando la URL no existe.

`null` no es cero en ninguna de las cuatro: un evento sin reseñas no tiene
promedio; sin comisión configurada no se escribe ninguna cifra de comisión ni de
neto, **aunque llegara un número**; sin moneda no hay «0,00», hay estado vacío.

Queda **una** pantalla de Eventos sin construir que importe: **publicar una
política**. Sin ella, nueve funciones terminadas solo saben contestar «pendiente
de configuración», y eso no es un fallo: es la decisión que la empresa no ha
tomado, dicha en voz alta.


## 37. Cada organizador escribe sus propias reglas

La empresa decidió: **cada organizador define sus políticas de cambios,
cancelaciones y devoluciones**. Esto cuenta cómo se implementó sin romper nada
de lo versionado que ya existía, y qué sigue esperando una respuesta.

### 37.1 No hizo falta un modelo nuevo

`event_policies` (0064) ya tenía todo lo que la decisión pide: el evento
(`scope='event'` + `event_id`), el tipo, la versión, el estado, el texto que lee
quien compra (`body`), las reglas estructuradas (`params`), quién la creó, quién
la publicó, cuándo, y la huella `params_sha256`.

**El dueño no se duplica en una columna.** Una política de evento pertenece a
quien organiza ese evento, y eso ya lo dice `events.organizer_id`. Copiarlo
crearía una segunda verdad que puede desincronizarse. Quién la escribió y quién
la publicó sí se guardan, porque eso es historia, no pertenencia.

Lo que faltaba eran dos cosas, y las trae la **0069**.

### 37.2 Nada impedía reescribir una política publicada

El estado estaba, la huella estaba, y un `update` cambiaba los parámetros sin
dejar rastro: justo lo que la huella existe para impedir. Ahora lo impone un
**disparador**, no una convención del código, y hay una prueba que lo intenta
desde `psycopg` —fuera del ORM— y comprueba que la base dice que no.

La única modificación que sigue permitida es la que hace publicar al superseder:
pasar de `published` a `superseded` y poner fecha de fin. Cualquier otra cosa,
incluidos los parámetros, el texto y la versión, está cerrada. Borrar una
publicada, también.

Un borrador sí se edita. Para eso es un borrador.

### 37.3 Nada ataba una compra a la versión que aceptó

Sin eso, «las compras existentes conservan la versión aceptada» era una promesa
sin respaldo: publicar una versión nueva cambiaba en silencio las reglas de todo
lo ya vendido, y nadie podía demostrar después qué se prometió.

`event_order_policy_acceptances` congela el identificador de la política **y su
huella** en el momento de crear el pedido. `aceptacion.la_que_rige()` devuelve
la versión que esa compra aceptó, no la vigente hoy, y **no cae a la vigente por
su cuenta**: caer sería justo lo que esto evita.

**No se inventa ninguna aceptación.** Un pedido anterior a que existiera
política no tiene fila, y eso es un hecho: a esa persona no se le enseñó nada
porque no había nada publicado. Rellenarlo hacia atrás sería falsificar un
consentimiento.

### 37.4 Qué puede decidir un organizador, y qué no

Decide **lo que le promete a quien compra**: cuándo se puede pedir un cambio o
una devolución (`aftersale_eligibility`) y qué pasa con la entrada
(`ticket_effect`).

NO decide cómo se mueve el dinero de la plataforma: ejecución del reembolso,
retención, reserva, quién asume una disputa, saldo negativo. Dejárselo sería
exactamente autoconcederse una excepción sobre dinero de terceros, que es lo que
`TIPOS_DEL_ORGANIZADOR` cierra con una lista de dos elementos.

Tampoco `review_window` ni `organizer_reply`: son reglas de producto de la
plataforma, no condiciones de venta.

### 37.5 Lo que no se publica

Dos cosas se rechazan, y ninguna es un juicio sobre el negocio:

* **Una política que no decide nada.** Un texto bonito con `params` vacío se
  publica como si configurara algo y no configura nada.
* **Una que se contradice.** Revocar con una devolución parcial pero no con la
  total es imposible de sostener: lo menos implica lo más. Permitir cancelar sin
  decir hasta cuándo, igual.

Aquí no se opina sobre si un plazo es corto o un porcentaje es bajo. Eso lo
decide quien organiza.

### 37.6 La cancelación total: la decisión que falta

    Si el organizador cancela completamente el evento, ¿Z exige SIEMPRE la
    devolución total, independientemente de la política particular?

La empresa no ha contestado. `cancelacion.DEVOLUCION_TOTAL_OBLIGATORIA` vale
`None`, que **no es «no» ni «sí»: es «sin decidir»**. No se pone `False`
mientras tanto, porque `False` es una respuesta y nadie la ha dado.

Mientras tanto, cancelar un evento:

1. lo saca del catálogo y deja `workflow_status = CANCELLED`;
2. abre —o recupera— un expediente `event_cancelled` por cada compra pagada;
3. **retiene el neto entero** del saldo de cada una, con el mecanismo de
   reservas que ya existía;
4. avisa a quien compró y a quien organiza de que está **en evaluación**;
5. anota la causa y **la política que regía para esa compra**, no la de hoy.

Y no hace nada más: ni devuelve, ni rechaza, ni libera, ni transfiere, ni revoca
ninguna entrada. Hay una prueba que lo comprueba campo por campo.

**Se retiene el neto entero y no un porcentaje** porque cuánto le corresponde al
organizador de un evento cancelado es justo la decisión que falta. Retener todo
es la única postura que no la adelanta, y es reversible; pagar no lo es.

**La regla vive en un solo sitio**, y hay una prueba que recorre el árbol y
comprueba que ningún otro fichero nombra esa constante. Repartida entre el
endpoint, la pantalla y el webhook, cambiarla significaría encontrar todos los
sitios y alguno se quedaría con la respuesta vieja.

### 37.7 Los saldos de evento se liberan por su propio camino

Al sacar Eventos del motor de Cursos —capítulo 36.2— los saldos de entradas se
quedaron sin ninguna forma de pasar a `eligible`. Ahora la tienen:
`finanzas.liberar_vencidos` pasa cada uno por `por_que_no_se_libera`, que es
donde viven las puertas de Eventos: reserva viva, disputa abierta, expediente
abierto, cuenta sin alta, retención en curso.

El de Cursos mira una orden, una solicitud de devolución y una garantía que aquí
no existen. Compartir tabla no es compartir reglas.

### 37.8 Qué sigue esperando a una persona

| Qué | Quién |
|---|---|
| Si una cancelación total obliga a devolver todo | la empresa |
| Las siete políticas de plataforma sin publicar | la empresa |
| La comisión (`platform_fee_bps = -1`) | la empresa |
| Cómo se identifica públicamente a quien opina | la empresa |
| Aplicar la 0069 en la base gestionada | operación |

Todo lo demás de los Incrementos 5 y 6 está construido, conectado y probado.
