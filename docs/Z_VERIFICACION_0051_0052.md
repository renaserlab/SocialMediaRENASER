# Verificación posterior a las migraciones 0051 y 0052

**Fecha:** 8 de septiembre de 2026.
**Qué se aplicó a mano y en qué orden:** 0050 → 0051 → 0052 → código.
**Entorno inspeccionado:** base gestionada de Supabase. No se puede descartar que
sea la de producción, así que **todo lo que sigue se comprobó con consultas de
lectura**: solo `select`, ni un dato de prueba, ninguna prueba destructiva,
ninguna prueba de concurrencia y ninguna política sembrada. La cadena de conexión
no aparece en ningún sitio de este documento ni de los registros.

> **Aviso sobre el guardia de solo lectura, y es una corrección.** Estas consultas
> se lanzaron con la intención de que la sesión llevara puesto
> `default_transaction_read_only = on`, pasándolo por `connect_args` /
> `server_settings` al crear el motor. **Ese guardia nunca llegó a aplicarse**:
> comprobado después, `current_setting('default_transaction_read_only')` valía
> `off`. Las consultas fueron todas de lectura y no se escribió nada, pero
> durante la verificación no hubo la red de seguridad que se creía tener.
>
> La forma que **sí** funciona es una sentencia explícita nada más abrir la
> conexión, y comprobar que ha tomado efecto antes de consultar nada:
>
> ```sql
> set session characteristics as transaction read only;
> select current_setting('default_transaction_read_only');  -- tiene que ser 'on'
> ```
>
> No se probó a forzar una escritura para demostrar que el guardia rechaza: sobre
> una base que puede ser la de producción, comprobar un guardia intentando
> romperlo es exactamente lo que no se hace. (Un `create temporary table` sí pasa
> con el guardia puesto, y no es un fallo: PostgreSQL solo prohíbe escribir en
> tablas no temporales.)

Continúa [Z_VERIFICACION_0050.md](Z_VERIFICACION_0050.md).

---

## 1. La 0051 quedó aplicada, y correctamente

El disparador de inmutabilidad de `course_versions` protege ahora **las siete
columnas**, que era justo lo que le faltaba:

| Columna | Protegida |
|---|---|
| `snapshot`, `content_hash`, `version`, `course_id` | sí, ya lo estaban |
| `origin`, `published_at`, `published_by` | **sí, las añade la 0051** |

Y lo que importa tanto como eso:

- Hay **un solo disparador** sobre la tabla (`course_versions_inmutable`), y
  apunta a esa función. No hay dos que se contradigan.
- Está **habilitado** (`tgenabled = 'O'`).
- **No cambió ni una fila**: siguen las cuatro versiones reconstruidas del
  backfill, con `origin = 'backfill'`, una por cada curso publicado, sin
  huérfanas ni duplicadas.
- No creó ninguna tabla.
- Su rollback documentado es volver a la definición de la 0050, que es esa misma
  sin las tres comparaciones nuevas. Coincide con el SQL real.

Con esto, `update course_versions set origin = 'publish'` —convertir una
fotografía reconstruida en SQL en una prueba de lo que se vendió— ya no es
posible, y tampoco lo es reescribir quién publicó ni cuándo.

**No se probó escribiendo.** Comprobar el disparador con un `update` de verdad
exige una base desechable; ver §6.

## 2. La 0052 quedó aplicada, y correctamente

`public.puede_mover_dinero()` existe con la forma que se pretendía: devuelve
`boolean`, es `stable`, `security definer`, con `search_path` fijado a `public`,
y acepta **solo `admin`** consultando `auth.uid()`. Sin sesión devuelve falso,
que es lo correcto: sin identidad no se mueve dinero.

Las **nueve políticas** de la 0052 usan `puede_mover_dinero()` y **ninguna
conserva `is_admin()`**:

| Tabla | Política | Condición actual |
|---|---|---|
| `audit_events` | `audit_events_read` | `puede_mover_dinero()` |
| `refund_request_events` | `refund_request_events_read` | `puede_mover_dinero()` |
| `consent_records` | `consent_records_read` | `subject_id = auth.uid() or puede_mover_dinero()` |
| `refund_requests` | `refund_requests_read` | `user_id = auth.uid() or …` |
| `course_refund_windows` | `course_refund_windows_read` | `user_id = auth.uid() or …` |
| `refund_policy_acceptances` | `refund_policy_acceptances_read` | `user_id = auth.uid() or …` |
| `owner_payout_accounts` | `owner_payout_accounts_read` | `owner_id = auth.uid() or …` |
| `owner_sale_balances` | `owner_sale_balances_read` | `owner_id = auth.uid() or …` |
| `owner_transfers` | `owner_transfers_read` | `owner_id = auth.uid() or …` |

### Los permisos por columna

La parte que la primera versión de la 0052 hacía mal —revocar por columna sobre
una concesión de tabla, que en PostgreSQL no quita nada— quedó bien: la
concesión de tabla se retiró y se volvió a conceder la lista explícita de
columnas visibles. Comprobado en la base:

- `consent_records` y `audit_events`: **no** se conceden `ip_hash`, `ip_prefix`
  ni `user_agent_family` a `anon` ni a `authenticated`.
- `refund_requests`: **no** se conceden `external_refund_id`, `reviewer_id`,
  `provider` ni `environment`.
- Una columna que se añada en el futuro **no** queda concedida, porque la
  concesión es una lista y no la tabla entera.

`explanation` y `review_notes` **sí** siguen concedidas en `refund_requests`, y
es deliberado: la política limita la fila a `user_id = auth.uid()`, y la API le
devuelve las dos al propio solicitante (`RefundRequestRead`). Lo que el alumno no
ve —ni por API ni por RLS— es el expediente de otra persona ni el historial
interno de estados, que vive en `refund_request_events` y es solo de tesorería.

## 3. Lo que la verificación encontró abierto: el comercio

Aquí está el hallazgo de esta fase, y es del mismo tipo que el anterior.

La 0052 corrigió nueve políticas y el problema se dio por cerrado. Contra la base
real aparecieron **seis más**: las cinco de la 0035 y una de la 0001, que es la
tabla de compras original y la más antigua de todas:

```
purchases.purchases_read_own          <- de la 0001
orders.orders_read_own
payment_transactions.payment_transactions_read_own
entitlements.entitlements_read_own
course_enrollments.course_enrollments_read_own
provider_products.provider_products_admin_read
```

Con su propio JWT y la clave anónima, una cuenta que solo modera podía pedir
`GET /rest/v1/orders?select=*` y llevarse el historial de compras de todo el
mundo, con importe, moneda, proveedor y entorno. La API no le da eso a nadie.

**Por qué se escapó, dos veces.** La primera, porque la lista de tablas a revisar
se escribió a partir del incidente en vez de a partir de qué tablas guardan
dinero: la prueba estaba en verde y lo que significaba era «moderar no llega a
estas nueve». Se corrigió deduciéndola del esquema… y `purchases` **siguió sin
aparecer**, porque la expresión que busca los `create table` exigía
`if not exists` y las 23 tablas de la 0001 no lo llevan. La lista que presumía de
deducirse del esquema no veía medio esquema, y el primer fallo quedaba tapado por
el segundo. Lo encontró la revisión independiente, no yo.

Y una segunda capa que no existía: `pg_default_acl` confirma que Supabase concede
por defecto **todos** los privilegios de cada tabla a `anon` y `authenticated`
(`anon=arwdDxtm`). En las tablas de dinero la RLS era lo único que había entre la
clave anónima y los datos. Entre esos privilegios está `truncate`, **que la RLS
no controla**: una política no impide vaciar la tabla de auditoría.

### Lo que hace la 0053

1. Redefine las cinco políticas con `puede_mover_dinero()`.
2. Retira la concesión de tabla de `anon` y `authenticated` sobre las trece
   tablas de dinero, y los privilegios de escritura —incluido `truncate`— sobre las tres
   que la 0052 dejó con lectura por columnas.
3. Cambia los privilegios por defecto del esquema para que la próxima tabla no
   nazca concedida. Va en una sección aparte porque **cambia el comportamiento
   futuro**, no el estado actual, y se puede aplicar en otro momento.

**Se puede revocar sin romper nada.** El móvil alcanza por PostgREST exactamente
ocho tablas —`courses`, `course_modules`, `course_lessons`,
`course_lesson_resources`, `stories`, `story_views`, `testimonials`,
`device_tokens`— y ninguna es de estas. (Una versión anterior de este documento
decía nueve e incluía `lessons`: esa tabla **no existe**, y el propio
`repositories/lessons.ts` lo explica.) Todo el comercio, las devoluciones y la
gobernanza pasan por FastAPI, que entra por SQLAlchemy con identidad propia.

**La 0053 no condiciona el despliegue del código**: solo toca RLS y permisos, y
la API no pasa por ahí. Se puede aplicar antes o después. Cuanto antes, mejor,
porque hasta entonces moderación conserva ese acceso.

## 4. Matriz de permisos

`SÍ`/`NO` = coinciden la API y la RLS. `⚠` = no coinciden.
Estado **tras aplicar la 0053**; entre paréntesis, lo que pasa si no se aplica.

| Rol | Catálogo | Compras propias | Compras ajenas | Devol. propias | Motivo privado ajeno | Notas internas ajenas | Auditoría | Saldos propios | Saldos ajenos | Sembrar políticas |
|---|---|---|---|---|---|---|---|---|---|---|
| anónimo | SÍ | NO | NO | NO | NO | NO | NO | NO | NO | NO |
| alumno | SÍ | SÍ | NO | SÍ | NO | NO | NO | NO | NO | NO |
| creador | SÍ | SÍ | NO | SÍ | NO | NO | NO | SÍ | NO | NO |
| moderador | SÍ | SÍ | NO (⚠ **SÍ** sin la 0053) | SÍ | NO | NO | NO | NO | NO | NO |

> La celda «compras ajenas» del moderador decía `NO` en la primera versión de
> esta tabla **y era falsa también con la 0053 aplicada**, porque a la 0053 le
> faltaba `purchases` —la tabla de compras de la 0001—. Lo encontró la revisión
> independiente. Ya está incluida; la celda es correcta con la 0053 tal como
> queda ahora.
| administrador | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ |
| financiero (`FINANCE_ROLES`) | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ |
| sistema (`service_role`) | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ | SÍ |

Dos notas que conviene no perder:

- **`administrador` y `financiero` coinciden fila por fila** porque hoy
  `FINANCE_ROLES = {"admin"}`. Son roles distintos por diseño y sus filas se
  separarán en cuanto se añada uno de tesorería. Ese es el momento en que la
  copia SQL de ese reparto —`puede_mover_dinero()`, con `admin` escrito a mano—
  se separaría de la de Python; ahora hay una prueba que compara las dos.
- **Ningún endpoint devuelve compras de terceros**, ni siquiera a administración:
  ese acceso solo existe por PostgREST.

## 5. Los datos, después de las migraciones

Consultas de lectura, sin tocar nada:

| Qué | Resultado |
|---|---|
| Versiones de curso | 4, una por cada curso publicado |
| Versiones vigentes duplicadas | 0 |
| Versiones huérfanas | 0 |
| Órdenes, accesos, devoluciones | 0 · 0 · 0 |
| Consentimientos, auditoría, políticas | 0 · 0 · 0 |
| Saldos, garantías | 0 · 0 |
| RLS activa en las trece tablas | sí |
| Políticas de ESCRITURA sobre tablas de dinero | ninguna |
| Los cuatro índices parciales de la 0050 | existen |

Ninguna migración modificó órdenes, accesos, devoluciones ni saldos, ni creó
consentimientos o auditorías. **No hay diferencias que reparar.**

## 6. Lo que NO se pudo probar, y por qué

### 6.1 Las 12 pruebas sobre PostgreSQL — **omitidas, no aprobadas**

Se intentaron las tres vías, en el orden correcto:

1. **PostgreSQL local**: no hay servicio, ni `psql`, ni instalación.
2. **Docker**: el demonio no responde y **Docker Desktop no está instalado**.
3. **PostgreSQL embebido por pip** (`pgserver`, `postgresql-wheel`): no publican
   rueda para Windows.
4. **Nunca la base real.**

Las 12 pruebas de `test_migraciones_reales.py` siguen saltándose. **No están
aprobadas.** El trabajo de CI está conservado y su configuración validada: el job
`migraciones` de `.github/workflows/ci.yml` levanta un `postgres:16-alpine`
efímero con `pg_isready`, instala `psycopg[binary]` y ejecuta los dos módulos.
Correrán la primera vez que esta rama llegue a CI.

Lo que queda sin demostrar con ellas: la secuencia completa desde base vacía, los
disparadores ejecutándose de verdad, los índices parciales bajo concurrencia real
y que aplicar dos veces no rompe nada.

**Además, la concurrencia sigue sin prueba propia.** Los seis escenarios que
harían falta —dos publicaciones a la vez, dos consentimientos, dos compras
consumiendo la misma aceptación, dos administradores sobre el mismo expediente,
dos liquidaciones, dos conciliaciones— no están escritos. Escribir pruebas que no
puedo ejecutar sería justo lo que este documento critica en otro sitio, así que
se dejan declaradas como pendientes.

### 6.2 La siembra de la política de recompra — **bloqueada**

No se ejecutó, porque no se puede descartar que la base sea la de producción. El
comando queda preparado:

```
POST /api/v1/admin/policies/seed-refund-repurchase
Authorization: Bearer <token de una cuenta con role = 'admin'>
```

Antes de ejecutarlo hay que comprobar: que la base es local o un staging
autorizado, que las 0050, 0051 y 0052 están aplicadas (lo están), y que el token
es de una cuenta con rol financiero, no de moderación.

Lo que se sembraría es la política `refund_repurchase` v1, en castellano,
jurisdicción por defecto: un solo reembolso voluntario por persona y curso,
ninguna segunda garantía tras recomprar, y aceptación previa obligatoria.

**Su idempotencia sí está probada**, en el banco de pruebas: sembrar dos veces no
duplica, solo la primera deja nota de auditoría, y quien solo modera recibe un
acceso denegado.

### 6.3 QA físico — **pendiente, requiere personas y aparatos**

Sigue sin validar, y no se da por bueno nada de esto: botón Atrás de Android,
Predictive Back, micrófono concedido/denegado/bloqueado, grabar y enviar audio,
cámara, adjuntos, recorte, tipografía ampliada, lector de pantalla real, modo
claro y oscuro, Live con dos teléfonos y superficie de vídeo de 100ms.

### 6.4 La sal y el proxy — **acción de una persona**

`IP_HASH_SALT` y `TRUST_PROXY_HEADERS` están declaradas en `render.yaml` sin
valor. Hasta que alguien ponga la sal en el panel —32 caracteres o más, distinta
por entorno— `ip_hash` será nulo en todas las filas, a propósito. Y
`TRUST_PROXY_HEADERS` solo se pone en `true` sabiendo cuántos proxys hay delante:
con una CDN por medio, la última entrada de `X-Forwarded-For` es la del proxy
interior y no la de quien pide.

## 7. El código contra el esquema real

- La aplicación importa y arranca; `/health` responde `200`.
- Las **67 tablas del ORM** se consultan sin error contra el esquema real: no hay
  ninguna columna que el modelo declare y la base no tenga.
- La restricción por columnas de la 0052 **no rompe la API**, y no podía
  hacerlo. Comprobado en la propia conexión: la API entra como `postgres`, un rol
  con `rolbypassrls`, así que ni las políticas ni las concesiones a `anon` y
  `authenticated` le afectan. Y no hay una sola llamada a PostgREST en todo
  `apps/api`. Lo mismo vale para la 0053.
- La aplicación **no depende** del acceso directo del móvil a ninguna tabla que
  la 0052 o la 0053 tocan.

## 8. Prueba funcional controlada

Sobre el banco de pruebas, no sobre la base real. Sin dinero real, con Stripe,
Connect, transferencias y Live apagados y `platform_fee_bps = -1`.

| Escenario | Estado |
|---|---|
| Versionado: publicar, congelar, republicar sin cambios, cambiar contenido, precio que no versiona, una sola vigente | probado |
| Una orden apunta a su versión; editar el curso no cambia lo que dice una orden vieja | probado |
| Una versión reconstruida no se reescribe al republicar | probado |
| Garantía: no arranca al pagar, arranca al primer acceso protegido, 168 h, no se reinicia, muestras gratuitas no la arrancan | probado |
| Devolución: solicitud única viva, moderador no mueve dinero, creador no aprueba, rechazo no consume garantía | probado |
| Reembolso en trámite, fallido y **parcial** no revocan el acceso; **total confirmado** sí | probado |
| **Recompra de punta a punta** | **prueba nueva de esta fase** |
| Doble pulsación en solicitar, aceptar, comprar, restaurar, aprobar | probado |

La prueba de recompra de punta a punta es nueva y cubre lo que estaba probado a
trozos: que la aceptación se consume una sola vez y queda atada a la orden
concreta, que la segunda compra **no** abre una segunda garantía, y que una
segunda devolución voluntaria se rechaza con el motivo de fondo —«ya la usaste»—
y no con «se te pasó el plazo». Verificada inyectando el defecto en una copia.

## 9. Lo que encontró el QA del móvil

| Gravedad | Hallazgo | Estado |
|---|---|---|
| Grave | **Prueba tautológica**: la que custodia los cerrojos de compra miraba que la referencia se declara, se lee y se suelta, nunca que se **eche**. Borrando las tres asignaciones, dos toques abrían dos checkouts sobre el mismo curso y las 1134 pruebas seguían verdes | corregido, verificado en los dos sentidos |
| Grave | **Mensaje falso**: «Compras restauradas» aparecía aunque el servidor no hubiera restaurado nada, y tapaba la pista de estar en la cuenta de tienda equivocada | corregido, con mensaje propio en los tres idiomas |
| Grave | Tras pagar, Stripe devuelve a `/pago`, una ruta que no existe en expo-router, y no hay `+not-found` | **pendiente**, ver §10 |
| Media | **Prueba tautológica**: «rechazar sin motivo no llega al servidor» pasaba igual quitando el `return` | corregido, verificado |
| Media | `POST /payments/native/sync` no exige la aceptación de recompra: en móvil la casilla del cliente es la única puerta | **pendiente**, ver §10 |
| Media | El plazo de garantía está escrito «7 días» a mano mientras cada orden guarda su `guarantee_hours` | pendiente |
| Media | Los mensajes de estos flujos están en castellano dentro del código, fuera del diccionario | pendiente |
| Media | Los errores del backend se pintan crudos, sin traducir y sin acción | pendiente |
| Media | Dos formatos de dinero distintos en el mismo recorrido | pendiente |
| Baja | `StateView` sin región viva; dos controles sin `accessibilityState`; el aviso legal siempre en castellano; tres acciones sin cerrojo síncrono | pendiente |

## 10. Pendientes que necesitan una decisión de negocio

1. **La ruta de vuelta de Stripe.** `payments_return_url` apunta a `/pago` y
   `payments_cancel_url` a `/pago/cancelado`; ninguna de las dos existe en la
   aplicación, y tampoco hay `+not-found`. Hoy no se dispara porque las compras
   están apagadas. **Se dispara el día que se enciendan**, y quien acabe de pagar
   caerá en una pantalla de ruta no encontrada sin saber si se le cobró. Hay que
   decidir si esas rutas se crean o si la URL apunta a `/confirmation`.
2. **La aceptación de recompra en las tiendas.** Solo se exige en el checkout
   web. `native/sync` concede el acceso sin comprobarla, así que en iOS y Android
   la casilla del cliente es la única puerta. **No basta con rechazar**: cuando
   ese endpoint corre, la compra en la tienda ya ocurrió y el dinero ya se movió;
   negar el acceso sería cobrar y no entregar. Lo razonable es atar la aceptación
   a la orden nativa y dejar nota de auditoría cuando falte. Es una decisión de
   producto sobre dinero, y por eso no se ha implementado aquí.
3. **El móvil edita el contenido del curso directamente por PostgREST**
   (`courses`, `course_modules`, `course_lessons`). El versionado y la auditoría
   solo existen si el cambio pasa por la API, así que un autor puede alterar lo
   que vendió sin dejar rastro. Cerrarlo es mover esas escrituras a endpoints, o
   poner disparadores de auditoría en las tres tablas.
4. **Poner `IP_HASH_SALT` y decidir `TRUST_PROXY_HEADERS`** (§6.4).
5. **Aplicar la 0053**, y decidir si se aplica también su sección 4.

## 11. Cómo se deshace

Cada migración lleva su rollback escrito en la cabecera. Para la 0053: volver a
crear las cinco políticas con `is_admin()` con el texto de la 0035, devolver las
concesiones de tabla, y —si se aplicó la sección 4— restaurar los privilegios por
defecto del esquema. No hay datos que deshacer en ninguna de las tres: 0051, 0052
y 0053 tocan disparadores, políticas y permisos, nunca filas.

## 12. Incidencias de la propia verificación

- Escribiendo una expresión regular a través de un heredoc, `\b` volvió a
  convertirse en un carácter de control (0x08) dentro del patrón, que entonces no
  casaba con nada. Es la segunda vez. Detectado con `cat -A` y sustituido por
  `(?<![A-Za-z_])`. **Los patrones no se escriben por heredoc**; se editan
  directamente en el fichero.
- Una prueba nueva se escribió buscando `comprarEnTienda` a secas y encontraba
  la línea del `import`, así que fallaba con el código correcto. Se corrigió a
  `await comprarEnTienda`. Se comprobó **en los dos sentidos**: verde con el
  código bueno, roja con el defecto puesto. Una prueba que solo se comprueba en
  un sentido no está comprobada.
- **El guardia de solo lectura no estaba puesto durante casi toda la
  verificación.** Se pasó por `connect_args`/`server_settings` y asyncpg lo
  ignoró en silencio; se descubrió al final, al preguntar por el rol de la
  conexión. Todo lo que se ejecutó fueron `select`, así que no se escribió nada,
  pero la protección que se creía tener no existía. La lección es la de siempre
  en este proyecto: **un guardia que no se comprueba no es un guardia.** La forma
  correcta está escrita arriba, con su verificación.
- Un commit salió mezclando la corrección de dos pruebas tautológicas con la de
  un mensaje falso. Se dejó así, con el motivo escrito: la prueba del tercer
  defecto vive en el mismo fichero que las otras dos y separarlas exigía partir
  el fichero.

---

## 13. La 0053, aplicada y verificada (8/09/2026)

El usuario la aplicó a mano. Comprobado con consultas de solo lectura, y **esta
vez con el guardia puesto de verdad**: `set session characteristics as
transaction read only` seguido de comprobar que
`current_setting('default_transaction_read_only')` vale `on` antes de consultar
nada. Si no lo valiera, el script aborta sin preguntar.

| Qué se comprobó | Resultado |
|---|---|
| Políticas de las 16 tablas financieras y de rastro que sigan con `is_admin()` | **ninguna** |
| Políticas que deciden con `puede_mover_dinero()` | 15 |
| RLS activa | 16 de 16 |
| Concesiones de tabla a `anon` / `authenticated` sobre esas tablas | **ninguna** |
| `TRUNCATE` para `anon` / `authenticated` | **retirado** |
| Columnas sensibles concedidas (`ip_hash`, `ip_prefix`, `user_agent_family`, `external_refund_id`, `reviewer_id`, `provider`, `environment`) | **ninguna** |
| Lectura por columnas que la 0052 sí concede | intacta: 15 columnas visibles en cada una de las tres tablas |
| `purchases` incluida | sí, sin política con `is_admin()` y sin concesiones |
| Privilegios por defecto del esquema para el rol `postgres` | ya **no** incluyen `anon` ni `authenticated` |

**Moderación conserva lo suyo:** más de treinta políticas siguen decidiendo con
`is_admin()`, y todas son de contenido —audios, comentarios, círculos, módulos y
lecciones de curso, catálogo comercial—. Moderar sigue siendo moderar; lo que se
fue es la caja.

**Los datos no cambiaron:** 4 versiones de curso, 4 cursos publicados, 0 órdenes,
0 accesos, 0 devoluciones, 0 consentimientos, 0 auditorías. Las 5 filas de
`purchases` son anteriores y la 0053 no toca filas, solo políticas y permisos.

**Queda un residuo conocido y ya previsto:** los privilegios por defecto del rol
`supabase_admin` siguen concediendo a `anon` y `authenticated`. Las migraciones
se aplican como `postgres`, así que las tablas que cree este proyecto nacen
cerradas; una tabla creada desde el panel de Supabase con ese otro rol, no.

### Las 12 pruebas de PostgreSQL siguen **omitidas**

Se intentó otra vez, en el mismo orden: no hay PostgreSQL local, no hay servicio,
**Docker Desktop no está instalado** y no existe rueda de Windows para un
PostgreSQL embebido. La única vía que queda es CI, y llegar a CI exige un push
que esta fase no puede hacer.

Lo que sí cambió: el prólogo de pruebas ahora reproduce el
`alter default privileges … grant all` de Supabase, así que cuando corran
significarán algo. Antes las tablas nacían sin concesiones y la verificación de
la 0052 y la 0053 no podía ponerse en rojo aunque el `revoke` estuviera mal.
