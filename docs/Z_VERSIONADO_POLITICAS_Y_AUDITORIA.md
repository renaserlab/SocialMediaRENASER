# Versiones de curso, políticas y auditoría (migración 0050)

Lo que cierra este incremento y, sobre todo, **lo que no cierra**. Si algo aquí
no coincide con el código, el que se equivoca es el documento.

- Estado general de Cursos: [`Z_REQUISITOS_Y_DECISIONES.md`](Z_REQUISITOS_Y_DECISIONES.md)
- El dinero, en detalle: [`Z_DEVOLUCIONES_Y_LIQUIDACIONES.md`](Z_DEVOLUCIONES_Y_LIQUIDACIONES.md)
- **Qué se encontró al verificar la 0050 ya aplicada, con sus diferencias y lo
  que quedó pendiente: [`Z_VERIFICACION_0050.md`](Z_VERIFICACION_0050.md)**

---

## 1. El problema que había

Editar un curso reescribía lo que alguien ya había comprado. La orden congelaba
el importe y la moneda —desde la 0035— y nada más: ni el título, ni el temario,
ni la promesa de garantía. A la pregunta **«¿qué compró exactamente esta
persona?»** no había respuesta, y el criterio A02 del blueprint la exige.

Además no había dónde guardar qué texto legal se le enseñó a nadie, ni quién
movió el dinero: publicar un curso, congelar un saldo o lanzar una transferencia
solo dejaban una línea de registro que nadie conserva.

---

## 2. Reglas del versionado

| | |
|---|---|
| **Cuándo nace una versión** | Solo al publicar, y solo si el contenido cambió (se compara por huella del snapshot canónico). |
| **Republicar sin cambios** | Devuelve la misma versión. Republicar no es versionar. |
| **Retirar y volver a publicar sin tocar nada** | Revive la versión retirada; no crea un duplicado. |
| **Una versión publicada** | Es inmutable. Ni el código ni la base permiten editarla. |
| **Borrar una versión** | Prohibido. Es lo que alguien compró. |
| **Despublicar un curso** | La versión pasa a `superseded`. No se borra ni se pierden accesos. |
| **Una devolución** | No toca la versión. |
| **Cuántas vigentes por curso** | Exactamente una, garantizada por el índice parcial `course_versions_vigente_unica`. |
| **Quién elige la versión** | El servidor. El cliente no la envía nunca. |

### Qué entra en la fotografía

Título, descripción, puntos destacados, la ficha de la 0034 (subtítulo, idioma,
nivel, público, requisitos) y el temario: módulos y lecciones con su orden, su
duración, su tipo y **si son muestra**.

`is_preview` entra porque decide qué se ve sin pagar: convertir en muestra la
única lección de pago de un curso ya vendido cambia el producto. Vive en las
columnas que añadió la 0034, **fuera del ORM**, así que hay que leerlo con
`cursos_v2.tipos_de_lecciones`; sacarlo con `getattr` devolvería siempre `False`
y el snapshot perdería ese campo en silencio.

### Qué NO entra, y por qué

| Fuera | Motivo |
|---|---|
| El precio | Es **oferta**, no contenido. Cambiarlo no puede invalidar el temario que alguien está viendo. Va congelado en la orden. |
| El estado de revisión | Eje aparte; vive en `courses`. |
| Las rutas de los medios | Apuntan a Storage, que es mutable por fuera. Guardarlas prometería una inmutabilidad que no se tiene. |
| El cuerpo de las lecciones | Corregir una errata generaría una versión nueva y ruido sobre las garantías vivas. |

### Cambios que NO obligan a versionar

Portada, vídeo de promoción, categoría y temas, «próximamente», estado de
revisión y visibilidad.

---

## 3. La oferta, congelada en la orden

Columnas nuevas en `orders`, y no una tabla aparte: la orden **ya era** el
snapshot del dinero, la relación es uno a uno, y una fila más que puede faltar
es una fila más que puede faltar justo donde el dinero no admite «casi».

| Columna | Qué guarda |
|---|---|
| `course_version_id` | Qué se compró. **Anulable**, ver abajo. |
| `guarantee_hours` | La promesa que se enseñó. 168 por defecto. |
| `guarantee_policy` | `refund_v1`. |
| `terms_version` | Reservada. **Hoy siempre nula.** |
| `offer_hash` | Reservada. |
| `snapshot_origin` | `live` o `legacy`. |

`entitlements.course_version_id` existe además porque el derecho es el **único
punto común a las tres vías de acceso**: compra web, compra por tienda y beta.
La beta no crea orden ninguna.

**Congelar `guarantee_hours` no cambia ningún plazo vivo.** Las ventanas guardan
su propio `expires_at` desde la 0049 y nadie las recalcula. Se congela ahora,
con el valor único de hoy, para no tener que migrar órdenes ya pagadas el día
que la duración deje de ser única.

---

## 4. Compatibilidad

| Caso | Qué pasa |
|---|---|
| Cursos existentes sin versión | El backfill crea una v1 `origin='backfill'` **solo para los publicados**. |
| Órdenes existentes | Se quedan con `course_version_id` nulo y `snapshot_origin='legacy'`. |
| Compras beta | Sin orden. La versión, si la hay, va en el derecho. |
| Accesos gratuitos (`price_minor = 0`) | Entran por `/enroll`; no hay oferta que congelar. |
| Cursos en borrador | No se versionan: solo publicar crea versión. |
| Cursos rechazados | Rechazar no despublica; la versión vigente no se retira. |
| Cursos con devoluciones | Sin cambio: nada del circuito de reembolsos mira el temario. |
| Cursos con alumnos activos | Sin cambio: el acceso lo decide el producto, no la versión. |
| **Código desplegado antes que la 0050** | **Se cae el comercio.** Ver el aviso de abajo. |

### El orden de despliegue no es opcional

**La 0050 se aplica ANTES de desplegar el código.**

| | |
|---|---|
| Base con 0050 + código viejo | Funciona. Las columnas están y nadie las lee. |
| Base sin 0050 + código nuevo | **Checkout, webhook de pago e historial de compras responden 500.** |

El motivo: `Order` y `Entitlement` mapean las columnas nuevas **sin guarda de
esquema**, así que cualquier `select(Order)` las pide. Los módulos de versiones,
políticas, consentimientos y auditoría sí aguantan un despliegue adelantado
—preguntan por su esquema antes de tocarlo—, pero eso no salva al comercio.

Dárselo exigiría leer esas columnas por un `MetaData` aparte, como hace
`cursos_v2` con la 0034. No se ha hecho: se ha preferido decirlo aquí, en la
cabecera de la migración y en el propio modelo, y fijarlo con una prueba
(`test_sin_la_0050_el_comercio_SE_CAE_y_hay_que_saberlo`) que se rompería si
alguien lo arregla de verdad.

### El backfill, y lo que no afirma

**Se afirma:** que un curso publicado tiene *hoy* este contenido. Por eso la
versión reconstruida lleva `origin='backfill'`, el snapshot lleva
`"reconstruido": true` dentro, y el endpoint la devuelve con
`reconstruida: true`.

**No se afirma, y no se puede:** qué contenido se vendió. `course_modules` y
`course_lessons` **no tienen ninguna marca temporal**, y el móvil las edita
directamente contra Supabase sin pasar por la API. Por eso el backfill **no
toca ni una orden**: rellenar `course_version_id` con la v1 reconstruida sería
afirmar que se vendió lo que hay hoy.

Si algún día se quiere poder afirmarlo, el primer paso no es este: es añadir
`updated_at` a esas dos tablas.

---

## 5. Políticas y consentimientos

### Lo que se hizo

`policy_versions` guarda el texto como **dato** y no como constante de código.
Hasta ahora la huella guardada en una aceptación solo demostraba algo mientras
esa versión del código siguiera en el repositorio.

- **La elige el servidor.** El cliente pide el *tipo*, nunca la versión.
- **Una sola vigente** por tipo, jurisdicción e idioma. Lo garantiza un índice
  parcial: sin él, el servidor tendría que elegir entre dos textos legales.
- **Sin política vigente, la operación se para.** No se coge la más parecida.
- **Una publicada no se edita.** Lo impide un disparador, no la RLS: la API
  entra con la clave de servicio y la RLS se la salta.

`consent_records` guarda quién aceptó qué, cuándo y desde dónde. Tres
invariantes, y las tres las sostiene la base:

1. Un doble toque no crea dos (`consent_records_pendiente_unico`).
2. Una aceptación no la consumen dos órdenes (`consent_records_consumo_unico`).
3. Nada se reescribe ni se borra (disparadores).

### Lo que NO se hizo, y es deliberado

**No se escribió ni una línea de términos de compra.** No hay texto aprobado
porque faltan decisiones que no son técnicas: entidad vendedora, jurisdicción,
impuestos y modelo de cobro. Redactar uno provisional para que «algo haya» es
justo lo que no se debe hacer con un documento que alguien va a firmar.

**La aceptación de recompra no cambió de sitio.** `refund_policy_acceptances`
(0049) sigue siendo la autoridad que consulta el checkout para dejar comprar, y
no se migró ni una fila. Lo que se añade es trazabilidad *además*: de dónde vino
la aceptación y un evento auditable. Mover un historial legal en la misma ronda
en que se crea la tabla nueva es la clase de cambio que se hace mal.

### Siembra, obligatoria una vez

Después de aplicar la 0050:

```bash
curl -X POST https://<api>/api/v1/admin/policies/seed-refund-repurchase \
  -H "Authorization: Bearer <token de un admin>"
```

Idempotente. Sin ella, la aceptación de recompra sigue funcionando —se guarda en
`refund_policy_acceptances` como siempre— pero no se registra el consentimiento
compartido, y queda un aviso en el registro.

No se siembra en la migración porque el texto vive en `refunds/politica.py` y
las dos copias se separarían al primer cambio de redacción. Ni al arrancar,
porque eso significa que cada réplica escribe en la base durante el despliegue.

---

## 6. Auditoría

`audit_events` es el rastro **transversal**. No sustituye a
`refund_request_events`, que es la máquina de estados del expediente de
devolución, con sus claves foráneas y consultas de negocio encima.

**Vive en la misma transacción que la operación que describe.** La propiedad que
se busca es «no existe cambio sin su registro»; en una transacción aparte, un
fallo entre los dos `commit` deja dinero movido sin rastro. Si la escritura de
auditoría falla, **falla la operación**: es una tabla local sin dependencias
externas, y abortar es lo correcto.

Lo que se audita hoy:

| Acción | Dónde |
|---|---|
| `course.published` / `course.unpublished` | `catalog/router.py` |
| `consent.accepted` | `refunds/router.py` |
| `refund.<estado>` | `refunds/router.py`, incluidos los **intentos rechazados** |
| `balances.released` | `commerce/router.py` |
| `transfer.executed` | `commerce/router.py` |

**Distingue lo intentado de lo conseguido** (`outcome`: `ok`, `denied`,
`error`). Un rastro que solo cuenta éxitos no sirve para investigar nada.

### Datos sensibles

Antes no se capturaba IP ni agente de usuario en ningún sitio. Ahora sí, y
**nunca en claro**:

| Campo | Qué es |
|---|---|
| `ip_hash` | SHA-256 de la IP con la sal del servidor. Compara sin leer. |
| `ip_prefix` | /24 en IPv4, /48 en IPv6. Agrupa sin identificar. |
| `user_agent_family` | «Chrome 141», «okhttp». Nunca la cadena completa. |

**Sin `IP_HASH_SALT` configurada, `ip_hash` se guarda nulo.** No se escribe
igualmente: el hash de una IPv4 sin sal se revierte por fuerza bruta en
segundos, y escribirlo daría una protección que no existe.

`X-Forwarded-For` solo se cree si `TRUST_PROXY_HEADERS` está encendido, porque
esa cabecera la manda cualquiera: con ella activa sin un proxy que la reescriba,
quien pide elige qué IP se le apunta.

**Nada de esto sale por ninguna respuesta de la API**, ni siquiera a quien lo
firmó ni a administración. La protección no es la RLS —la API se la salta— sino
que los esquemas de salida no lo enumeran.

---

## 7. Permisos

| Quién | Puede | No puede |
|---|---|---|
| Anónimo | Leer una política publicada; ver la versión publicada de un curso | Lo demás |
| Alumno | Ver sus consentimientos (sin origen), su compra y su versión | Ver los de nadie más |
| Creador | Editar sus borradores, publicar y retirar sus cursos | Editar una versión publicada; ver IP ni agente de sus alumnos |
| Moderador | Moderar contenido | **Mover dinero; leer la auditoría** |
| Administración financiera | Auditoría, saldos, devoluciones, sembrar políticas | — |
| Webhook / sistema | Escribir por su circuito | Usar permisos humanos |

La auditoría se protege con `puede_mover_dinero` (`FINANCE_ROLES`, hoy solo
`admin`) y **no** con `is_admin`, que incluye `moderator`.

---

## 8. Migraciones: cómo se validan ahora

Las migraciones se aplican **a mano**, pegándolas en el editor de Supabase. No
hay herramienta. Eso significa que el código puede ir por delante o por detrás
del esquema, y por eso cada módulo pregunta si su migración está aplicada.

Dos comprobaciones:

**Estática** (`test_secuencia_de_migraciones.py`), corre siempre. Numeración
continua, ninguna dependencia hacia el futuro, ninguna sentencia destructiva,
RLS en las tablas de dinero con cero políticas de escritura, y el contrato entre
el SQL y los modelos: tablas, columnas y restricciones con nombre.

**Real** (`test_migraciones_reales.py`), ejecuta las 50 sobre una base vacía:

```bash
docker run --rm -d --name renaser-mig \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=renaser_mig -p 55432:5432 postgres:16-alpine

export MIGRACIONES_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/renaser_mig
cd apps/api && python -m pytest tests/test_migraciones_reales.py

docker rm -f renaser-mig
```

Se salta sin esa variable. En CI corre en el trabajo `migraciones`, con un
PostgreSQL efímero del propio runner.

**La variable NO es `DATABASE_URL`**, y hay un guardia que lo comprueba: esa
apunta al pooler de Supabase de producción en cuanto existe `apps/api/.env`, y
la prueba borra y recrea el esquema `public`.

### Rollback de la 0050

Está escrito en la cabecera del propio fichero. Solo vale si **ninguna fila** se
ha escrito todavía. Con filas escritas, la vuelta atrás real es **retirar el
código y dejar las tablas**: son historial, y el historial no se borra para
deshacer un despliegue.

---

## 9. Contrato del planificador externo

Los dos endpoints de la ronda anterior siguen sin temporizador dentro de la API,
y así deben seguir: corre en varias réplicas y un planificador en el proceso son
tantas pasadas simultáneas como réplicas haya.

| | `POST /admin/owner-balances/settle` | `POST /admin/refund-requests/reconcile-stale` |
|---|---|---|
| Frecuencia sugerida | cada hora | cada 6 horas |
| Autenticación | JWT de una cuenta con rol `admin` | igual |
| Acotado por | `limite` (1–500, por defecto 100) | `horas` (1–720), `limite` (1–200) |
| Idempotente | sí | sí |
| Reintento | seguro; la clave de idempotencia solo cambia tras un fallo terminal | seguro |
| Qué vigilar | `omitidos` con un motivo estable y repetido en cada pasada | `conciliadas` siempre 0 con expedientes viejos vivos |
| Alerta | `pending` sin fecha creciendo, o `frozen` antiguos (`/admin/owner-balances/health`) | expedientes en `refund_processing` de más de 48 h |

**Límite conocido de `settle`:** los elegibles se toman por fecha de vencimiento
y acotados por `limite`. Con `limite` saldos permanentemente bloqueados, los de
detrás no llegarían a pagarse nunca; se detecta porque `omitidos` repite el
mismo motivo en cada pasada.

**No se ha configurado nada**: ni cron de AWS, ni EventBridge, ni credenciales.
Esto es el contrato para conectarlo cuando se decida.

---

## 10. QA

### Hecho

Suite de backend y de móvil completas, TypeScript, Expo Doctor, exportación web,
comprobación del diff y búsqueda de secretos. Las pruebas nuevas cubren:
versionado y sus carreras a nivel de índice, compatibilidad con órdenes
antiguas, políticas, consentimientos, auditoría, permisos, y el comportamiento
sin la 0050 aplicada.

### No hecho, y no se declara aprobado

- **Las migraciones no se han ejecutado en secuencia contra un PostgreSQL
  desechable.** Docker está instalado pero el demonio no corre. La prueba, el
  trabajo de CI y el prólogo que suple lo que Supabase da por hecho quedan
  preparados; lo que no se ha visto es la secuencia entera corriendo sobre una
  base limpia.
- **Las políticas RLS y los disparadores de la 0050 no se han ejercido**, aunque
  sí se han **leído** en la base donde alguien aplicó la 0050 a mano: están, y
  uno de ellos resultó no proteger `origin` —corregido en la 0051—. Ver
  [`Z_VERIFICACION_0050.md`](Z_VERIFICACION_0050.md). Lo que la suite comprueba
  es que están escritos y que ningún código de la aplicación actualiza ni borra
  esas tablas.
- **La carrera real de dos publicaciones simultáneas no se ha ejecutado.**
  SQLite en memoria comparte una sola conexión entre sesiones, así que lanzar
  dos peticiones a la vez no prueba nada. Lo que sí se comprueba es que la base
  rechaza la segunda versión vigente.
- **Nada se ha probado en un dispositivo físico** (botón Atrás, micrófono,
  cámara, fuente ampliada, lector de pantalla, directo con dos teléfonos).
- **Nada se ha probado contra Stripe, Google Play ni Apple reales.**

### Sigue apagado

Todas las banderas de dinero, `platform_fee_bps = -1`, `feature_live = false`.
No hay términos de compra aprobados, no hay proveedor de correo, y Eventos,
Servicios y Productos siguen sin implementar.
