# Z Servicios: admisión de prestadores (Incremento 1), catálogo (Incremento 2) y descubrimiento (Incremento 3)

Qué se construyó, qué impone la base, qué se decidió en cerrado y qué sigue
esperando a una persona. La Parte I se escribió el 29/09/2026 al cerrar el
Incremento 1 en la rama `Edson`; la **Parte II** (§18 en adelante), el mismo
día, con el Incremento 2 implementado y probado; la **Parte III** (§33 en
adelante), también ese día, con el Incremento 3 implementado y probado.

## Estado

| | |
|---|---|
| **Incremento 1** | **técnicamente cerrado; únicamente queda pendiente el QA físico** (§16). Admisión completa del prestador: condiciones versionadas, borrador, documentos privados, credenciales, envío, revisión, correcciones, reenvío, aprobación, rechazo, suspensión y retirada |
| **Migraciones 0086, 0087 y 0088** | **APLICADAS** en Supabase y verificadas en sesión de solo lectura con **cero divergencias** (la 0088, el 29/09/2026: §9). Son históricas: no se editan |
| **Migración 0089** (plataforma) | **APLICADA** en Supabase y verificada en solo lectura el 29/09/2026: **sin divergencias** (`Z_BAJA_DE_CUENTA.md` §15). Hace que borrar la cuenta funcione sin borrar la historia (§12) |
| **`FEATURE_SERVICES`** | **apagada.** Todas las rutas contestan 503 `services_disabled` sin mirar la base |
| **Incremento 2 (catálogo)** | **técnicamente cerrado; únicamente queda pendiente el QA físico** (§32) |
| **Migración 0090** | **APLICADA** en Supabase el 29/09/2026 y verificada ese día en solo lectura: **sin divergencias** (§32). La puerta de esquema, con el rol real de la API, la reconoce. Ya es histórica: no se edita |
| **Incremento 3 (descubrimiento y confianza)** | **implementado y probado; pendiente de aplicar y verificar la 0091 y de hacer el QA físico** (§33). Catálogo público, búsqueda, filtros, orden, perfil público del prestador, señales de confianza, guardados y sugerencias con su razón |
| **Migración 0091** | **ESCRITA, SIN APLICAR** en Supabase. Solo crea `saved_services`. Sin ella, todo el descubrimiento funciona salvo guardar (503 controlado). Pasos: §44–§45; **reiniciar la API** después |
| **Pagos, reservas** | **no existen**, y ninguna tabla los anticipa. Los pagos de la plataforma siguen **apagados** |
| **Bloqueo para encender** | **Resuelto** (§12): la 0089 aplicada y verificada, y `DELETE /auth/me` corregido en `Edson` |
| **Código** | En la rama `Edson`, **sin desplegar**: sin push, PR ni merge. La API de producción sigue con el backend anterior |
| **QA físico** | pendiente de los tres incrementos: `docs/Z_QA_FISICO_PENDIENTE.md`, sección de Servicios |

## 1. Lo que NO es

Servicios **no es todavía un directorio de profesionales**. Este incremento
solo decide **quién puede llegar a ofrecer servicios en Z**: una persona o una
empresa postula, Z revisa su identidad, sus documentos y sus credenciales, y
administración aprueba, rechaza o suspende. No hay servicios publicados, ni
agenda, ni reservas, ni cobros: la vista pública de un prestador existe en el
contrato (`PrestadorPublicoRead`) y **solo** para uno activo, pero ninguna
ruta la sirve todavía.

## 2. Qué se reutilizó, sin tocarlo

- **Perfiles y roles**: `profiles.role` (`admin`, `moderator`, `user`). No se
  inventaron roles nuevos: *revisar* es de `admin` y `moderator`; *decidir*
  (aprobar, rechazar, suspender, publicar condiciones) solo de `admin`.
- **Auditoría** (`gobernanza.auditoria.anotar`, tabla `audit_events`).
- **Avisos**: la bandeja de la app (`notifications.add_notification`) y la
  cola de push con reintentos (`notifications.entregas`), con textos en
  es/en/pt (`notifications.textos`).
- **Almacenamiento**: `shared/storage.py` (subir, firmar, borrar) y el barrido
  de `USER_BUCKETS` al borrar la cuenta.
- **Patrones** de Cursos, Eventos y Productos: versiones inmutables con huella,
  puertas de bandera y de esquema, 404 para lo ajeno, `Idempotency-Key`.

## 3. El modelo de datos (7 tablas)

| Tabla | Migración | Para qué |
|---|---|---|
| `service_policies` | 0086 | Condiciones del prestador por país (y categoría), versionadas. Publicada = inmutable |
| `service_providers` | 0086 | Una fila por perfil: tipo (`individual`/`company`), nombre, datos legales, estado (`pending`/`active`/`suspended`) |
| `service_provider_applications` | 0086 (+0087, +0088) | La postulación y su estado. **Una sola viva** por prestador |
| `service_provider_documents` | 0086 (+0088) | Solo METADATOS del documento; el archivo está en el depósito privado |
| `service_provider_credentials` | 0086 (+0088) | Credenciales declaradas: número solo enmascarado, evidencia documental |
| `service_provider_application_events` | 0086 (+0088) | El historial. Solo se añade |
| `service_provider_application_submissions` | 0088 | Cada envío y reenvío, CONGELADO: condiciones aceptadas y foto de lo enviado |

Todas con **RLS activa, cero políticas y cero privilegios** para `anon` y
`authenticated`: la única puerta es la API.

## 4. Los nueve estados

```
draft ──▶ submitted ──▶ under_review ──▶ approved ──▶ suspended
                              │  ▲  ▲                     │
                              │  │  └─────────────────────┘
                              │  └── resubmitted ◀── changes_requested
                              ├──▶ changes_requested
                              └──▶ rejected (final)

draft, submitted, under_review, changes_requested, resubmitted
      ──▶ withdrawn (final): la retira QUIEN POSTULA, nadie más
```

| Salto | Quién |
|---|---|
| `draft → submitted`, `changes_requested → resubmitted` | quien postula |
| `submitted/resubmitted → under_review`, `under_review → changes_requested`, `suspended → under_review` | revisión (`moderator`) o administración |
| `under_review → approved/rejected`, `approved → suspended` | solo administración |
| `* → withdrawn` (desde los cinco de arriba) | solo quien postula, y **antes de la decisión** |

El **estado del prestador se deriva** del de su postulación actual (la viva
o, si no hay, la última): `approved` ⇒ `active`; `suspended` ⇒ `suspended`;
cualquier otro ⇒ `pending`, salvo que ya estuviera suspendido, que sigue
suspendido. El código lo escribe en la misma transacción y **la base lo
comprueba al confirmar** (0088, disparadores diferidos).

## 5. Lo que la base impone (y no solo el código)

- Los saltos del mapa (disparador) y el mismo mapa en un CHECK del historial.
- Nadie revisa ni decide su propia admisión, ni siendo administrador.
- Una postulación viva por prestador; el rechazo y la retirada liberan el hueco.
- Una enviada está completa (resumen, condiciones aceptadas con su huella,
  declaración de veracidad).
- El historial y los envíos congelados **solo se añaden**; la evidencia solo
  se borra en cascada desde el perfil.
- La retirada la firma el dueño (0087) y es **antes de la decisión** (0088).
- Prestador y postulación coinciden al confirmar cada transacción (0088).
- Ciclo de vida de la evidencia: `active`/`replaced`/`removed`; un reemplazo
  es de la misma persona; una credencial observada es una `declared` con
  motivo.

## 6. Qué se exige

**Para enviar** (`missing`, códigos traducibles):
- datos: `legal_name`, `country_code`, `summary`; empresa además `tax_id` y
  `representative_name`;
- documentos base: persona → `identity`; empresa → `identity` y
  `legal_representation`; más los que la **política vigente** exija
  (`parameters.required_documents[tipo]`);
- credenciales que exija la política (`parameters.required_credentials`), y
  toda credencial declarada con su **evidencia**;
- las **condiciones vigentes aceptadas** con su huella exacta
  (`provider_terms_not_published` / `_not_accepted` / `_changed`).

**Para reenviar**, además: lo observado corregido (`document_observed:<k>`,
`credential_observed`, `field_not_corrected:<campo>` comparando con el último
envío congelado).

**Para aprobar** (`approval_blockers`): cada documento exigido aceptado y
ninguno pendiente u observado; cada credencial exigida verificada y ninguna
pendiente.

## 7. La API (35 rutas)

Prestador, bajo `/api/v1/services` (siempre SU postulación; nunca recibe un
identificador de postulación):

| Ruta | Qué |
|---|---|
| `POST /provider/application` | empezar (idempotente; 201 nueva, 200 la viva) |
| `GET /provider/application` | el expediente propio, con `missing`, `can_submit`, `can_resubmit`, `can_withdraw` |
| `PATCH /provider/application` | datos del borrador. **Nunca el estado** |
| `GET /provider/application/history` | historial visible (sin nombres de Z ni notas internas) |
| `GET /provider/terms` · `POST /provider/application/terms` | leer y aceptar las condiciones vigentes |
| `POST /provider/application/documents` (+ `/{id}/replace`, `DELETE /{id}`, `/{id}/view`) | documentos privados; `view` da un enlace de **120 s** |
| `POST/PATCH/DELETE /provider/application/credentials[/{id}]` | credenciales |
| `POST /provider/application/submit` · `/resubmit` · `/withdraw` | los saltos del prestador |

Administración, bajo `/api/v1/admin/services`:

| Ruta | Quién |
|---|---|
| `GET /policies`, `GET /policies/{id}/preview` | revisión |
| `POST /policies/provider-terms/draft`, `PATCH /policies/{id}`, `POST /policies/{id}/publish` | administración |
| `GET /applications` (cursor, `status`, `provider_type`), `GET /applications/{id}`, `/history` | revisión |
| `POST /applications/{id}/documents/{doc}/view\|accept\|observe` | revisión (`view` queda auditado) |
| `POST /applications/{id}/credentials/{cred}/verify\|observe\|reject` | revisión |
| `POST /applications/{id}/start-review\|request-changes` | revisión |
| `POST /applications/{id}/approve\|reject\|suspend` | administración |

Orden de las puertas: prestador `401 → 503 → 422`; administración
`401 → 403 → 503`. Todas las acciones aceptan `Idempotency-Key` (8–100
caracteres; la misma clave para otra acción es `409 idempotency_key_reused`).

## 8. Documentos privados

- Depósito `service-provider-documents` (0088): **privado, sin políticas**,
  10 MB, PDF/JPEG/PNG/WebP.
- La ruta la pone el servidor: `<perfil>/<postulación>/<uuid>.<ext>`. Ninguna
  respuesta la devuelve.
- El tipo se decide **mirando los bytes**, no lo que declara el teléfono.
- Ver un documento = un enlace firmado de 120 s, uno por petición, que no se
  guarda. En administración, cada enlace queda en la auditoría.
- Reemplazar deja el anterior como evidencia (`replaced`); retirar solo cabe si
  **nunca** se envió.
- **Sin antivirus**: los bytes se validan por firma de formato y tamaño, no se
  analizan. Queda como endurecimiento posterior.

## 9. Migraciones

**La 0088 está aplicada** (29/09/2026) y se verificó ese mismo día en una
única sesión de solo lectura: `transaction_read_only = on`, sonda de escritura
rechazada con 25006 y `ROLLBACK`. Se comparó definición por definición con el
repositorio y con los modelos, y no hay divergencias ni filas incoherentes
(detalle en `Z_BAJA_DE_CUENTA.md` §9). Lo que sigue es cómo se aplicó, por si
hay que repetirlo en otra base:

1. Comprobar que la 0086 y la 0087 están (lo comprueba también la 0088).
2. Ejecutar `supabase/migrations/0088_servicios_documentos_y_envios.sql`
   entero, en el editor SQL de Supabase. Es **una única transacción**: si algo
   falla, no queda nada.
3. **Reiniciar la API**: la puerta de esquema guarda en memoria el «no».
4. Verificar en solo lectura (el mismo procedimiento que la 0086/0087): el
   depósito privado, los 4 disparadores, la tabla nueva con RLS y cero
   privilegios, y las restricciones nuevas validadas.

La 0088 se detiene sin tocar nada si falta la 0086, la 0087, alguna de sus
funciones, o si algún prestador existente no coincide con su postulación.

## 10. Avisos

Doce tipos. A quien postula: `service_application_review_started`,
`_changes_requested`, `_approved`, `_rejected`, `_suspended`, `_withdrawn`,
`service_document_observed`, `service_credential_observed`, `_rejected`. Al
equipo (`admin` y `moderator`, sin el interesado): `service_application_submitted`,
`_resubmitted`, `_withdrawn_review`. La bandeja va con `payload` vacío (el
teléfono pone el texto en su idioma); el push, con el idioma del dispositivo.
**Un aviso que falla nunca deshace la decisión.**

## 11. Decisiones

**Tomadas en cerrado (derivadas de reglas ya dadas):**
- Todo pasa por `under_review`; aprobar sin revisión no existe.
- Suspender no es definitivo: vuelve a revisión.
- **Una aprobada que se suspende y vuelve a revisión no se retira**: ya tuvo su
  decisión (`service_application_already_decided`, y la base lo impide).
- La nueva postulación tras una retirada **no hereda** condiciones,
  documentos ni credenciales.
- Moderación y administración reutilizan los roles existentes; «Operaciones» y
  «Cumplimiento» del alcance no existen como roles.

**Pendientes de la empresa (no se inventaron):**
- **Volver a postular tras un rechazo**: sin el parámetro
  `reapplication_after_rejection` en la política vigente, `409
  service_reapplication_not_configured`.
- Documentos y credenciales por categoría o país: se configuran en los
  parámetros de la política; hoy no hay ninguna publicada.
- Personas de una empresa, teléfono verificado, antivirus, retención de
  documentos tras un rechazo o una retirada.

## 12. `DELETE /me` y la auditoría: resuelto (0089 aplicada el 29/09/2026)

`audit_events` (0050) es de solo añadir, pero su `actor_id` es
`on delete set null`. Borrar el perfil de alguien que figuraba como actor pedía
un `UPDATE` que el disparador rechazaba (23001), y `DELETE /me` fallaba. Con
Servicios, cada prestador y cada persona del equipo figura como actor.

**La regla la decidió la empresa el 29/09/2026**: se borran los datos
personales y los archivos privados; lo histórico se conserva sin nombrar a la
persona. Se implementó en tres partes:

- **La 0089**: admite exactamente una cosa, anular al actor en la cascada de la
  baja de su perfil. Lo hace en `audit_events` y en otras doce columnas con el
  mismo choque, en Cursos, Eventos, Productos y consentimientos.
- **`DELETE /auth/me`, todo o nada**: los archivos se borran antes de
  confirmar, y un bloqueo legítimo devuelve 409 sin tocar nada.
- En Servicios, la nota de retirada ya no queda en la auditoría.

La prueba que era una xfail estricta ahora pasa. El detalle, el inventario, la
política de retención y cómo aplicar y verificar la 0089 están en
[`Z_BAJA_DE_CUENTA.md`](Z_BAJA_DE_CUENTA.md). La 0089 **ya está aplicada y
verificada** en Supabase (§15 de ese documento). **No encender Servicios en
producción antes de desplegar el código de `Edson`** (la puerta endurecida de
la baja) y de pasar el QA físico.

## 13. Las vistas

**Quien postula** (`app/servicios/prestador/*`). Se entra por Perfil › «Ofrecer
un servicio», que solo aparece con la bandera encendida. Diez pantallas cubren
las catorce vistas:

- entrada y explicación;
- persona o empresa;
- información básica;
- condiciones;
- documentos;
- credenciales (lista y formulario);
- resumen con envío o reenvío;
- estado con observaciones;
- historial;
- retirada.

**Administración** (`app/admin/servicios/*`). Se entra por Panel de
administración › Servicios, solo con la bandera. Cuatro pantallas cubren las
catorce vistas:

- bandeja con filtros y cursor;
- expediente con documentos, credenciales, enlace temporal y decisiones;
- historial completo;
- condiciones del prestador, con parámetros.

Todas siguen las mismas reglas:

- piden al servidor lo que se puede hacer (`missing`, `can_*`,
  `available_actions`, `approval_blockers`);
- tienen carga, vacío, error con reintento y un cerrojo contra el doble toque;
- confirman lo que no tiene vuelta atrás;
- recargan tras un 409;
- no escriben textos en duro: 363 claves en es/en/pt con los mismos huecos.

La correspondencia vista por vista está en
[`Z_MATRIZ_DE_VISTAS.md`](Z_MATRIZ_DE_VISTAS.md), en la sección de Servicios.

## 14. Pruebas y mutaciones (29/09/2026)

| Suite | Resultado |
|---|---|
| Backend completo con PostgreSQL real (docker `postgres:16`) | **3645 pasan, 1 xfail estricta (§12), 0 fallan, 0 omitidas** (tras las correcciones de §15). Línea base antes de Servicios: 3449 |
| Backend completo sin PostgreSQL | 2818 pasan y 814 omitidas (las de PostgreSQL), antes de §15 |
| Servicios sobre SQLite | API: 52 · estados y saltos: 40 · almacenamiento: 3 nuevas |
| Servicios sobre PostgreSQL | 0086: 29 · 0087: 30 · 0088: 30 · flujo y concurrencia: 6 + 1 xfail |
| Móvil completo | **3270/3270** en copia LF (en la copia CRLF de Windows fallan las 3 de siempre, ajenas a Servicios). Línea base: 3178 |
| Móvil de Servicios | 92: lógica contra el código del servidor (32) y vistas, contratos, bandera y avisos (60) |
| TypeScript (`tsc --noEmit`) | limpio |
| Expo Doctor | 18/18 |
| Exportación web | correcta, con las rutas de Servicios en el paquete |

**Mutaciones: 23/23 cazadas** (repetidas tras las correcciones de §15). Cada
una se aplicó en una copia aparte, se corrieron las pruebas que la deben
detectar y se restauró. Son:

- permitir autoaprobación;
- transición ilegal;
- aprobar sin requisitos;
- enviar sin política;
- filtrar la ruta del documento;
- acceso a un documento ajeno;
- reutilizar una aceptación anterior;
- heredar documentos de una retirada;
- omitir el historial;
- duplicar una decisión, por clave y por salto a sí mismo;
- ignorar el bloqueo de fila (cazada 5 de 5 veces);
- retirada administrativa;
- editar una versión publicada;
- mostrar notas internas;
- ignorar `FEATURE_SERVICES`;
- retirar tras la decisión;
- quitar la evidencia de una credencial (H1);
- escribir sin bloquear la postulación (M2);
- en el móvil:
  - Servicios encendido si el servidor calla;
  - la entrada del perfil sin bandera;
  - el doble toque en el envío;
  - un código de error sin texto.

La carrera de dos decisiones simultáneas no es determinista por sí sola. La
mutación del bloqueo la cazan también los envíos simultáneos.

## 15. Revisión independiente (29/09/2026)

Revisión hecha por otra sesión, con otro criterio, sobre `891cffe..93ef55c`. No
hubo bloqueantes. Encontró **1 alto, 3 medios y 7 bajos**. **Cada uno se
reprodujo con una prueba que fallaba antes de corregirlo**, y esas pruebas
quedan en la suite.

| # | Hallazgo | Corrección |
|---|---|---|
| **H1** | Se podía quitar el documento que respaldaba una credencial (el archivo se borraba) y después verificarla y aprobar | Un documento que respalda una credencial activa no se quita (`service_document_in_use`) ni se ofrece para quitar. Reemplazarlo mueve la evidencia de las credenciales declaradas. Enviar exige una evidencia activa y verificar la exige disponible |
| M1 | Vaciar el resumen al corregir daba un 500 (CHECK `enviada_completa`) | 422 `service_application_field_required` |
| M2 | Las escrituras de quien postula no bloqueaban la fila: un cambio colado durante el envío alteraba lo ya congelado | Todas las escrituras bloquean la postulación antes de leerla. Probado contra PostgreSQL con un bloqueo real |
| M3 | El borrado de la cuenta no bajaba a las carpetas del depósito: los documentos en `<perfil>/<postulación>/…` se quedaban. **También afectaba a `seller-documents` (0085)** | `delete_user_files` baja a las carpetas (tope de 4 niveles), probado con una imitación del listado no recursivo de Storage. **Conviene confirmarlo una vez contra el proyecto real** |
| L1 | Un fallo de red del almacenamiento daba 500 | 503 `service_storage_failed` |
| L2 | Si algo fallaba entre la subida y el commit, el archivo quedaba huérfano | Se borra, falle lo que falle en ese tramo |
| L3 | Un fallo al borrar un objeto dejaba su ruta en el registro | El registro dice el depósito y el estado, no la ruta |
| L4 | Alguien del equipo que también postula leía las notas internas de su propia postulación | Lo propio sale sin notas internas ni autores |
| L5 | Volver a postular tras un rechazo no miraba la política de la categoría | Mira la de su categoría |
| L6 | Dos borradores o dos publicaciones de condiciones a la vez daban 500 | El segundo recibe el que ganó; publicar bloquea la fila |
| L7 | Reemplazar no tenía tope y cada archivo se guardaba | Tope de 60 documentos guardados por postulación (tres veces los 20 activos): es una barrera técnica, no una regla de negocio |

Lo que la revisión comprobó y dio por bueno:

- la seguridad del depósito;
- permisos y autorrevisión;
- la 0088 (RLS, una sola transacción, reejecutable);
- que los mapas de saltos del código y de la base coinciden;
- concurrencia de las decisiones, idempotencia y privacidad del prestador;
- que el historial y los envíos solo se añaden;
- avisos, sin textos en duro ni códigos crudos;
- compatibilidad: servidor viejo con app nueva, API antes de la 0088 (503),
  y bandera apagada.

## 16. Cierre técnico (29/09/2026): la baja de cuenta y la 0089

Lo que quedaba para poder encender Servicios era el choque de §12. Se cerró
en la rama `Edson`; el detalle está en
[`Z_BAJA_DE_CUENTA.md`](Z_BAJA_DE_CUENTA.md).

| Suite | Resultado |
|---|---|
| Backend completo con PostgreSQL real (docker `postgres:16`, 0001–0089) | **3775 pasan, 0 fallan, 0 omitidas, ninguna xfail**. Antes del cierre: 3645 + 1 xfail |
| Backend completo sin PostgreSQL | **2881 pasan, 894 omitidas** (las de PostgreSQL) |
| Baja de cuenta por el endpoint, contra PostgreSQL | 42 (`test_baja_de_cuenta_postgres.py`) |
| La 0089 y la inmutabilidad | 53 (`test_migracion_0089.py`) |
| El servicio de baja sin PostgreSQL | 18 (`test_baja_de_cuenta.py`) |
| Storage y procesado de medios | 21 + 26 |
| Móvil completo (copia LF) | **3278/3278** |
| TypeScript, Expo Doctor, exportación web | limpio · 18/18 · correcta |
| Paridad es/en/pt, rutas duplicadas (457 de la API, 145 del móvil) | sin diferencias · ninguna |
| `git diff --check`, secretos, atribución de IA | limpios |

**Mutaciones: 42/42 cazadas**, cada una por la prueba que debe cazarla y
ninguna por una selección vacía. Rompen, una por una:

- la excepción de la auditoría: editarla toda, cambiar un actor por otro,
  tocar el actor y otra columna a la vez, restaurar un actor anónimo, no
  mirar si el perfil existe, no mirar la profundidad;
- las cascadas: borrar una versión de curso suelta, borrar la historia en
  cascada, saltarse el borrado de una credencial;
- la migración: debilitar la RLS, conceder permisos, quitar la precondición
  de las huellas, la de la forma de los disparadores o la de la clave única;
- Storage: no bajar a las carpetas, callar un error, olvidar un depósito,
  dejar los adjuntos de chat, listar de uno en uno, saltar carpetas hondas,
  cortar las demás conversaciones al fallar una, dejar tareas colgando;
- el servicio: borrar los archivos antes que la base, un bloqueo legítimo
  como 500, borrar lo ajeno antes de confirmar, callar el fallo de después,
  dejar escapar una excepción, «tienes ventas» sin la 0089, `auth.users`
  fuera de PostgreSQL;
- las órdenes con dinero: de evento, de curso, las de pruebas y el checkout
  abandonado;
- Servicios: copiar a la auditoría el mensaje del equipo;
- el procesado de medios: no retirar los derivados, no bloquear la fila;
- el modelo del consentimiento desalineado de la base;
- el móvil: la cuenta bloqueada como «inténtalo de nuevo», la espera corta,
  y el «sigue activa» sin respuesta o con el 504 del CDN.

**Revisión independiente, en dos pasadas.** La primera encontró 1 hallazgo
alto, 5 medios y 6 bajos; la segunda, 2 medios y 6 bajos más. El alto está
cerrado y **no queda nada alto ni bloqueante**. Los que dependen de una
decisión de la empresa quedan como S8–S14 en `Z_REQUISITOS_Y_DECISIONES.md`.
La tabla completa está en `Z_BAJA_DE_CUENTA.md` §14.

**Tras aplicar la 0089 en Supabase (29/09/2026, tarde).** El detalle está en
`Z_BAJA_DE_CUENTA.md` §15.

- **Primera aplicación**: la versión de `c6d3cd6`, sin los frenos de las
  órdenes con dinero. La verificación de solo lectura lo detectó y la versión
  completa se ejecutó encima.
- **Segunda verificación**: **0089 sin divergencias**.
  - El esquema público coincide entero con el repositorio.
  - Los cuatro objetos que faltaban están, definición por definición.
  - Las transacciones de la 0089 no escribieron datos.
  - Hay 0 órdenes de Cursos y 0 de Eventos.
- **La puerta de la baja (`_hay_0089`)** decía que sí con la versión a medias.
  Ahora mira cada protección, va antes de tocar nada y se cierra ante la duda.
- **Recorrido integral** de `DELETE /auth/me`, con una persona en todas las
  verticales: verde. La API local de verdad reconoce la 0089 completa y
  rechaza la base a medias.
- **Servicios: L6 era intermitente por una carrera real** (dos borradores de
  condiciones del mismo país). Corregido con un bloqueo de la transacción,
  sin tocar el esquema.
- **Mutaciones**: 31 de 31.
- **Batería completa, tras el arreglo**: 3809 pasan con PostgreSQL (0
  fallan, 0 omitidas); 2887 pasan sin él (922 omitidas).

## 17. Punto exacto de continuación hacia el Incremento 2

> **Actualización (29/09/2026):** el Incremento 2 ya se implementó en `Edson`
> (Parte II). Lo de abajo es la foto del cierre del Incremento 1.

**No se empezó el Incremento 2.** Antes de abrirlo, una persona tiene que:

1. ~~Aplicar la 0089 y verificarla~~ **Hecho el 29/09/2026** (sin
   divergencias, `Z_BAJA_DE_CUENTA.md` §15). Queda **desplegar el código de
   `Edson`** cuando se apruebe: ese despliegue reinicia la API de producción,
   que es lo que hace que la puerta de la baja vea la 0089 completa.
   Antes de encender los pagos, decidir **S8** (Google Play exige poder
   borrar la cuenta desde la app).
2. **Hacer el QA físico** de Servicios y de la eliminación de cuenta
   (`Z_QA_FISICO_PENDIENTE.md`).
3. **Decidir S1** (el texto de las condiciones por país): sin él nadie puede
   enviar, y el Incremento 2 parte de prestadores aprobados.

El Incremento 2 empieza donde termina la admisión: un `service_providers` en
`active` es lo único que el Incremento 2 puede dar por supuesto. Lo reservado
para él y para los siguientes (servicios y variantes, disponibilidad, reservas,
pagos, incidencias y valoraciones) está en `Z_REQUISITOS_Y_DECISIONES.md`,
«Límites del Incremento 1». Nada de eso tiene tabla, ruta ni pantalla todavía.

---

# Parte II · Incremento 2: catálogo y publicación de servicios

Escrito el 29/09/2026 en la rama `Edson`. **Técnicamente cerrado ese mismo
día (§32): la 0090 está aplicada y verificada sin divergencias; únicamente
queda pendiente el QA físico.**

## 18. Estado del Incremento 2

| | |
|---|---|
| **Qué hace** | Un prestador **activo** crea servicios, los completa, sube imágenes y los envía; Z los revisa, pide cambios, aprueba y publica; el público ve solo lo publicado. Editar lo publicado abre una versión nueva sin tocar la visible. Suspender, reactivar y retirar |
| **Migración 0090** | **APLICADA** en Supabase el 29/09/2026 y **verificada** en solo lectura: sin divergencias (§32) |
| **Sin la 0090** | Todas las rutas del catálogo contestarían **503 `services_not_ready`** (la puerta de esquema, §24). Con la 0090 aplicada, la puerta la reconoce con el rol real de la API (§32) |
| **`FEATURE_SERVICES`** | **apagada.** Con ella apagada, las 30 rutas nuevas contestan 503 `services_disabled` sin mirar la base, y la app no enseña ninguna entrada nueva |
| **Dinero** | **ninguno.** El precio se registra y se enseña; no hay cobro, comisión, saldo, reserva ni agenda |
| **Código** | En `Edson`, **sin desplegar**: sin push, PR ni merge. La API de producción sigue con el código anterior, que no conoce el catálogo |
| **QA físico** | **pendiente**: `Z_QA_FISICO_PENDIENTE.md`, sección «Incremento 2». Es lo único que falta |

## 19. Lo que NO es

No es un directorio con búsqueda, ni recomendaciones, ni filtros públicos, ni
guardados, ni disponibilidad, horarios, reservas, pagos, atención, mensajes,
reprogramaciones, cancelaciones, incidencias, reseñas ni saldos. Ninguna tabla
los anticipa. La ficha pública de un servicio existe y se alcanza desde el
servicio propio, desde la revisión del equipo y desde el aviso de
«publicado»; **no hay botón de contratar**.

## 20. El modelo (5 tablas nuevas, 0090)

| Tabla | Para qué |
|---|---|
| `service_categories` | Dos niveles como mucho (`parent_id`). `slug` único y fijo, nombre en es y, si se quiere, en en/pt; país opcional; `active`/`inactive`. **No se borran**: se desactivan. No se siembra ninguna |
| `services` | La **identidad estable**: prestador, categoría y estado (`draft`, `published`, `suspended`, `retired`). La categoría solo cambia mientras nunca se publicó |
| `service_versions` | El **contenido**, versionado: título, resumen, descripción, modalidad, duración, capacidad, precio (modelo, importe en unidades menores y moneda), alcance, qué incluye y qué no, requisitos, condiciones y zona. `based_on_version_id` dice de cuál salió |
| `service_version_images` | Las imágenes **de una versión**, con texto alternativo, posición, portada, tipo, peso, medidas y huella. La ruta la pone el servidor |
| `service_events` | El historial. **Solo se añade.** Motivo visible y nota interna separados; `Idempotency-Key` con índice único |

Todas con **RLS activa, cero políticas y cero privilegios** para `anon` y
`authenticated`. El depósito `service-media` es **privado**, de 5 MB, solo
JPEG, PNG y WebP. Los identificadores del personal (quién revisó, decidió o
publicó) **no tienen clave ajena**, igual que en la 0086 (S10): la historia
sobrevive a la cuenta.

## 21. Estados y saltos

**El servicio**: `draft → published` (al publicar su primera versión),
`published ↔ suspended`, y `draft | published | suspended → retired`
(definitivo). Todos, de administración.

**La versión**:

| Salto | Quién |
|---|---|
| `draft → submitted` | prestador |
| `submitted → under_review` | moderación o administración |
| `under_review → changes_requested` | moderación o administración, **con motivo visible** |
| `under_review → approved` | solo administración |
| `approved → published` | solo administración (aprobar **no** publica) |
| `published → superseded` | el sistema, al publicar la siguiente |
| `draft | submitted | under_review | approved → withdrawn` | el prestador (o el sistema al retirar el servicio) |

El mapa vive en `catalogo_estados.py` y **el mismo** lo impone la base
(`service_versions_salto_valido`, `services_salto_valido`); una prueba compara
los dos, salto a salto.

**Corregir es abrir otra versión.** Pedir cambios cierra la versión
(`changes_requested`); el prestador abre un borrador que copia el contenido y
las imágenes de la última y lo reenvía: el historial lo llama `resubmitted`.

**Lo publicado no se toca.** Editar un servicio publicado abre un borrador
nuevo; el público sigue viendo la versión publicada hasta que Z publique la
nueva, que supera a la anterior en la misma transacción. Publicar una versión
de un servicio **suspendido** no lo reactiva: levantar la suspensión es otra
decisión, con motivo.

## 22. Lo que impone la base (y no solo el código)

- Una versión nace en borrador; solo da los saltos del mapa; **fuera del
  borrador su contenido está congelado** (solo cambian el estado y sus fechas).
- Enviar exige portada, qué incluye y qué no, un prestador activo y una
  categoría activa (además de lo que exige el código, §23).
- **Una abierta y una publicada** por servicio (índices únicos parciales), y
  un servicio publicado o suspendido tiene exactamente una versión publicada
  (comprobado al confirmar la transacción).
- Las imágenes solo cambian en un borrador, y su ruta empieza por
  `<perfil del prestador>/<servicio>/`.
- **Nadie revisa, aprueba ni publica su propio servicio**, ni siendo admin.
- El historial no se reescribe; nada se borra suelto, solo en cascada desde la
  cuenta del prestador.
- Pedir cambios, suspender, reactivar y retirar llevan motivo visible.

## 23. Qué hace falta para enviar

Lo decide **una sola función**, `catalogo_requisitos.faltantes`, y la app solo
lo pinta (`missing`). Códigos estables: prestador activo, categoría activa,
título, resumen, descripción, modalidad (y que esté permitida), duración (y en
rango), modelo de precio (y permitido), importe y moneda cuando el modelo los
lleva (y moneda permitida), alcance, qué incluye, qué no, requisitos, zona
fuera de lo virtual, portada, y no pasar del máximo de imágenes.

**«Sin configurar» no es gratis**: el precio sin modelo impide enviar; «gratis»
se elige. Un modelo sin importe (gratis, a consultar) **no admite** importe:
el servidor lo rechaza y borra el que hubiera.

## 24. La API (30 rutas) y la puerta de esquema

- **Prestador** (`/services/provider/services…`): listar (cursor), crear
  (idempotente), leer, abrir borrador, editar el borrador (PATCH, nunca un
  estado), qué falta, subir, ordenar y quitar imágenes, enviar, retirar la
  versión y su historial visible. Más `GET /services/categories`: las que
  quien pregunta puede usar (activas, de su país o de todos, sin madre
  inactiva). Solo un prestador **activo** abre borradores, edita y sube
  imágenes.
- **Público**: `GET /services/catalog/{id}`. Solo lo publicado, de un
  prestador activo; lo demás es el mismo 404.
- **Administración** (`/admin/services/catalog…` y `/admin/services/categories…`):
  bandeja con colas y filtros (cursor), el servicio con la propuesta, lo
  publicado y qué cambia (`changed_fields`, con los mismos nombres que se
  señalan al pedir cambios; las imágenes cuentan), cualquier versión, el
  historial completo, las siete decisiones y las categorías (alta, edición,
  activar, desactivar).
- Un servicio sin versión abierta ni publicada (volvió con cambios, o se
  retiró la versión) se nombra por su **última** versión, y
  `last_version_status` dice si hay cambios pedidos.
- Cada alta y cada salto llevan `Idempotency-Key`. Cada decisión bloquea la
  fila del servicio (`FOR UPDATE`): dos a la vez dan un 200 y un 409.
- Lo ajeno es 404. Los errores tienen código estable y la app los traduce.

**La puerta** (`esquema.hay_catalogo`) exige, antes de contestar nada, las
cinco tablas con todas las columnas de los modelos, los **12 disparadores con
su función y su forma exacta, activos**, los **5 índices únicos**, RLS en las
cinco tablas y el depósito privado. Recuerda el resultado hasta que la API se
reinicia: **tras aplicar la 0090 hay que reiniciar la API**.

## 25. Imágenes, avisos y auditoría

- **Imágenes**: el archivo viaja a la API, que abre la imagen (bytes reales,
  no la extensión), pone la ruta `<perfil>/<servicio>/<versión>/<id>.<ext>`
  y la guarda en el depósito privado. La primera es la portada. Al abrir un
  borrador nuevo se copian las filas con **la misma ruta**; quitar una imagen
  solo borra el archivo si ninguna otra versión lo usa (lo publicado conserva
  la suya), y **después de confirmar** la base. Si la base falla después de
  subir, el archivo recién subido se borra; con `Idempotency-Key`, un
  reintento pisa el archivo de un intento que no llegó a contestar. Salen
  siempre como **URL firmada que caduca**; ninguna respuesta lleva la ruta
  como campo, pero la URL firmada la contiene, **con el identificador del
  perfil** (igual que en Productos; decisión C15). Al borrar la cuenta del
  prestador, sus servicios caen en cascada y el barrido de `USER_BUCKETS` se
  lleva `service-media/<perfil>/`.
- **Avisos** (bandeja y push, es/en/pt), cada uno en su propio punto de
  guardado: un aviso que falla no deshace la decisión. Al prestador: revisión
  iniciada, cambios pedidos, aprobado, publicado, **publicado en un servicio
  que sigue suspendido** (no dice «ya se ve» ni lleva a la ficha), suspendido,
  reactivado y retirado. Al equipo: enviado, reenviado y retirado de la
  revisión. Once tipos en total.
- **Auditoría**: `service.<acción>` en `audit_events`, con la función con la
  que se actuó y datos mínimos (versión, si hubo nota, los campos señalados).
  **Nunca** copia textos libres.

## 26. Cómo aplicar la 0090

> **Hecho el 29/09/2026**: Edson la aplicó a mano en Supabase y terminó sin
> errores; la verificación está en §32. El fichero conserva en su cabecera
> «SIN APLICAR» porque las aplicadas no se editan (cambiaría su huella git,
> que ahora vigila `test_servicios_migracion_0090.py`). Lo de abajo queda como
> procedimiento para otro entorno.

1. Comprobar que el fichero es el completo:
   `supabase/migrations/0090_servicios_catalogo_y_publicacion.sql`, 978
   líneas, que empieza por «-- SIN APLICAR» y termina en
   «notify pgrst, 'reload schema';» y «commit;».
2. Pegarlo **entero** en el editor SQL de Supabase y ejecutarlo. Es **una
   única transacción**:
   - primero comprueba la 0086–0089 (tablas, columnas y funciones que usa); si
     falta algo, se detiene sin crear nada;
   - crea las cinco tablas, los disparadores, el depósito y cierra los
     permisos;
   - al final se **verifica a sí misma** (depósito, RLS, cero permisos, cero
     políticas, los 12 disparadores con su forma y los 5 índices **únicos**) y
     aborta entera si algo no cuadra;
   - se puede ejecutar dos veces.
3. **Reiniciar la API.** La puerta recuerda el «no» del arranque: sin
   reinicio, el catálogo seguiría contestando 503.
4. Verificarla en solo lectura (§27).
5. Con `FEATURE_SERVICES` **apagada**, nada cambia para nadie. Encenderla es
   otra decisión, y antes va el QA físico.

Si hubiera que deshacerla con las tablas **vacías**, el procedimiento está en
la cabecera del propio fichero.

## 27. Verificar la 0090 (solo lectura)

> **Ejecutado el 29/09/2026 contra Supabase**, tal cual, dentro de la
> verificación de §32: las ocho consultas devolvieron exactamente lo que dicen
> los comentarios y las dos tablas de abajo.

```sql
begin transaction read only;
select current_setting('transaction_read_only');           -- 'on'
savepoint sonda;
create temp table sonda_de_escritura (x int);              -- TIENE que fallar con 25006
rollback to savepoint sonda;

-- 1. Cinco tablas, con RLS, sin políticas y sin privilegios sueltos.
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as politicas
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relname in ('service_categories', 'services', 'service_versions',
                     'service_version_images', 'service_events')
 order by 1;
-- → 5 filas, t, 0
select count(*) from information_schema.table_privileges
 where table_schema = 'public' and grantee in ('anon', 'authenticated')
   and table_name in ('service_categories', 'services', 'service_versions',
                      'service_version_images', 'service_events');
-- → 0

-- 2. Los 12 disparadores: función, forma exacta y activos.
select c.relname, t.tgname, p.proname, t.tgtype, t.tgenabled
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
 where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
   and c.relname in ('service_categories', 'services', 'service_versions',
                     'service_version_images', 'service_events')
 order by 1, 2;
-- → las 12 filas de la tabla de abajo, todas con tgenabled 'O'

-- 3. Los cinco índices, únicos.
select i.indexrelid::regclass, i.indisunique from pg_index i
 where i.indexrelid in (
   to_regclass('public.service_versions_una_abierta'),
   to_regclass('public.service_versions_una_publicada'),
   to_regclass('public.service_version_images_una_portada'),
   to_regclass('public.services_una_por_clave'),
   to_regclass('public.service_events_una_por_clave'));
-- → 5 filas, t

-- 4. El depósito privado.
select id, public, file_size_limit, allowed_mime_types
  from storage.buckets where id = 'service-media';
-- → service-media | f | 5242880 | {image/jpeg,image/png,image/webp}

-- 5. Las funciones, por su huella (tabla de abajo).
select proname, md5(regexp_replace(replace(prosrc, E'\r', ''), '\s+', ' ', 'g'))
  from pg_proc where pronamespace = 'public'::regnamespace
   and proname in ('service_categories_dos_niveles', 'services_salto_valido',
     'service_versions_salto_valido', 'service_version_images_solo_en_borrador',
     'servicios_catalogo_nadie_se_publica', 'servicios_catalogo_historial_inmutable',
     'servicios_catalogo_coherente')
 order by 1;

-- 6. Recién aplicada: vacía (no se siembra ninguna categoría).
select (select count(*) from public.service_categories) as categorias,
       (select count(*) from public.services) as servicios;
-- → 0 | 0

rollback;
```

Los 12 disparadores esperados:

| Tabla | Disparador | Función | tgtype | tgenabled |
|---|---|---|---|---|
| `service_categories` | `service_categories_dos_niveles` | `service_categories_dos_niveles` | `31` | `O` |
| `service_events` | `service_events_ajena` | `servicios_catalogo_nadie_se_publica` | `7` | `O` |
| `service_events` | `service_events_inmutables` | `servicios_catalogo_historial_inmutable` | `19` | `O` |
| `service_events` | `service_events_solo_en_cascada` | `servicios_borrado_solo_en_cascada` | `11` | `O` |
| `service_version_images` | `service_version_images_solo_en_borrador` | `service_version_images_solo_en_borrador` | `31` | `O` |
| `service_versions` | `service_versions_ajena` | `servicios_catalogo_nadie_se_publica` | `23` | `O` |
| `service_versions` | `service_versions_coherente` | `servicios_catalogo_coherente` | `21` | `O` |
| `service_versions` | `service_versions_saltos` | `service_versions_salto_valido` | `23` | `O` |
| `service_versions` | `service_versions_solo_en_cascada` | `servicios_borrado_solo_en_cascada` | `11` | `O` |
| `services` | `services_coherente` | `servicios_catalogo_coherente` | `21` | `O` |
| `services` | `services_saltos` | `services_salto_valido` | `23` | `O` |
| `services` | `services_solo_en_cascada` | `servicios_borrado_solo_en_cascada` | `11` | `O` |

Las huellas esperadas de las siete funciones nuevas:

| Función | Huella tras la 0090 |
|---|---|
| `service_categories_dos_niveles` | `d09691eae2b7f1412d02daeefac4d8b2` |
| `service_version_images_solo_en_borrador` | `8d9bc80fba608e1913f3dde54d229ef0` |
| `service_versions_salto_valido` | `218b636da96797ccb7cdbddccff22586` |
| `services_salto_valido` | `9390e721cb1abcb47ee1f65e45ef6da8` |
| `servicios_catalogo_coherente` | `acc5be2ca2b5016886ea5029753afd10` |
| `servicios_catalogo_historial_inmutable` | `8bcd4309a3b2b9c625550053fe9f05f8` |
| `servicios_catalogo_nadie_se_publica` | `e29d76b60f10b418513497f0a6d5f768` |

Después, con la API **reiniciada**: `GET /services/categories` con una sesión
de prueba contesta 503 `services_disabled` mientras la bandera siga apagada
(lo esperado); con la bandera encendida **solo en un entorno de pruebas**,
contesta 200 y una lista vacía.

## 28. Las vistas

**Prestador** (`app/servicios/prestador/catalogo/*`). Perfil › «Ofrecer un
servicio» (con la bandera) › en la postulación, «Mis servicios» (solo con el
prestador **activo**). Siete pantallas:

- **Mis servicios**: lista con estado y versión en curso, cursor;
- **Crear servicio**: la categoría (radios), y nace el borrador;
- **El servicio**: estado, lo último que dijo Z con los campos señalados, la
  versión en curso, lo publicado, y lo que se puede hacer (`can_*`): completar
  información, imágenes, revisar y enviar, editar o «Corregir y reenviar»,
  retirar la versión, historial y ficha pública;
- **Completar información**, por secciones (lo básico, cómo se presta, precio,
  qué incluye), con los campos señalados por Z marcados y aviso al salir sin
  guardar;
- **Imágenes**: texto alternativo antes de elegir, portada, orden y quitar;
- **Revisar y enviar**: lo que falta (pedido al servidor, cada cosa lleva a
  donde se arregla), cómo se verá, y el envío o reenvío;
- **Historial** visible.

**Público**: la **ficha** (`app/servicios/ficha/[serviceId]`), sin botón de
contratar.

**Administración** (`app/admin/servicios/catalogo/*` y
`app/admin/servicios/categorias`). Panel de administración › Servicios ›
«Catálogo de servicios» y «Categorías de servicios» (con la bandera):

- **bandeja** con colas, estado de la versión, modalidad, categoría y cursor;
- **el servicio**: propuesta con lo que cambia marcado, lo publicado para
  comparar, versiones, las decisiones que ofrece el servidor (`actions`) con
  motivo y nota interna, confirmación en todas, «es tuyo» sin acciones;
- **una versión** cualquiera;
- **historial completo** con función, notas internas y campos;
- **categorías**: alta, edición (sin slug ni estado), madre, activar y
  desactivar.

Todas: carga, vacío, error con reintento («aún no eres prestador activo»
lleva a la postulación), cerrojo contra el doble toque, relectura tras un 409
o un envío incompleto, cero textos en duro (348 claves nuevas en es/en/pt con
los mismos huecos) y ninguna escritura directa a la base ni al almacenamiento.

## 29. Decisiones

Tomadas en el código (provisionales, revisables sin migración salvo donde se
indica): aprobar y publicar son **dos pasos**, ambos de administración;
moderación inicia la revisión y pide cambios; pedir cambios **cierra** la
versión y se corrige en otra; publicar no reactiva un servicio suspendido;
retirar es **definitivo**; una categoría inactiva no admite servicios nuevos
ni envíos, pero no se borra y los servicios que la usan la siguen nombrando;
la ficha pública enseña del prestador **solo su nombre público**; no se exige
volver a aceptar condiciones para publicar servicios.

**Pendientes de la empresa**, con lo que pasa mientras tanto: en
[`Z_REQUISITOS_Y_DECISIONES.md`](Z_REQUISITOS_Y_DECISIONES.md), «Incremento 2»
(C1–C16). Lo configurable está en `SERVICES_CATALOG_*`
(`apps/api/.env.example`); sus valores de fábrica son los **límites técnicos**
de la 0090, no una política.

## 30. Pruebas, mutaciones y revisión (29/09/2026)

**Pruebas nuevas del catálogo:**

| Batería | Qué vigila | Resultado |
|---|---|---|
| `test_servicios_catalogo_reglas.py` (sin base) | el mapa de estados es el aprobado y **el mismo** que imponen los disparadores; qué falta para enviar; la configuración; ninguna entrada admite un estado | 26 pasan |
| `test_servicios_migracion_0090.py` (PostgreSQL) | la 0090 desde cero, cerrada; los modelos son la base; cada regla de la base (saltos, congelado, portada, imágenes, nadie se publica, historial, una abierta y una publicada, categorías, cascada de la cuenta); sobre la 0089 con datos no toca nada; reejecutable; un fallo a mitad no deja nada; sin la 0089 se niega; un índice que no es único la aborta | 28 pasan |
| `test_servicios_catalogo_api.py` (PostgreSQL) | la API real con el Storage en memoria: el recorrido entero desde la admisión hasta el público, permisos, lo ajeno, concurrencia, idempotencia, imágenes, auditoría, avisos, bandeja, categorías, la bandera, la puerta de esquema y la baja de la cuenta | 45 pasan |
| `serviciosCatalogo.test.mts` (móvil) | los valores cerrados son los del servidor (leídos de su código); cada código de error y cada clave en es/en/pt; el formulario; imágenes; decisiones; categorías | 45 pasan |
| `serviciosCatalogoVistas.test.mts` (móvil) | las 13 vistas con ruta y alcanzables desde otra; estados; cerrojo; confirmaciones; las 30 rutas del servidor, ni una más ni una menos; idempotencia; ningún estado en las peticiones; los 11 avisos | 55 pasan |

**Mutaciones: 40 de 40 en rojo.** Las 20 pedidas, cuatro del teléfono, una del
arreglo de la nota interna y quince que deshacen, uno por uno, los arreglos
de la revisión. Cada una rompe una protección en una copia LF desechable, se
comprueba que una prueba **adecuada** se pone roja, y se restaura. Cuatro
salieron verdes en la primera pasada y cada una destapó una prueba débil, ya
reforzada:

- editar una versión **publicada** en la base (la prueba solo congelaba una
  enviada);
- omitir el motivo en el **dominio** (solo lo exigía el formulario);
- **ocultar el historial** (un «ninguno trae nota interna» sobre una lista
  vacía también pasaba);
- **filtrar notas internas** al prestador (la única nota interna del
  recorrido iba en un paso que ya tiene motivo visible). Esta destapó además
  un fallo real: iniciar la revisión **perdía** la nota interna.

**Revisión independiente** (solo lectura, adversarial): ningún hallazgo
bloqueante ni alto; cuatro medios y nueve bajos. Corregidos, con prueba capaz
de fallar:

| # | Hallazgo | Severidad | Arreglo |
|---|---|---|---|
| M1 | `changed_fields` hablaba el idioma de las columnas (`price_minor`) y no el de la app; las imágenes no contaban | media | vocabulario de `requisitos.CAMPOS` e imágenes comparadas |
| M3 | publicar la versión de un servicio **suspendido** avisaba «ya se puede ver» y llevaba a un 404 | media | aviso propio (`service_catalog_published_suspended`) que lleva al servicio; confirmación de administración con otro texto |
| M4 | un servicio con cambios pedidos salía «sin título» y sin decir que había algo que hacer | media | se nombra por su última versión; `last_version_status` |
| B1 | iniciar la revisión perdía la nota interna | baja | se guarda (lo encontró también una mutación) |
| B2 | se ofrecían categorías de otro país | baja | `GET /services/categories` filtra por el país del prestador y quita las hijas de una madre inactiva |
| B3 | quitar una imagen borraba el archivo antes de confirmar la base | baja | se borra después del `commit` |
| B4 | con `Idempotency-Key`, un archivo huérfano de un intento sin respuesta bloqueaba los reintentos | baja | con clave, la subida pisa |
| B5 | un prestador suspendido seguía abriendo borradores, editando y subiendo | baja | solo un prestador activo escribe |
| B6 | crear sin clave devolvía **otro** servicio si la base protestaba; cualquier choque al crear una categoría se llamaba «slug repetido» | baja | se relanza el error de verdad |
| B7 | un servicio que pasa a virtual conservaba la zona en lo público | baja | se limpia |
| B8 | «Se crea un borrador que solo ves tú» (también lo ve el equipo) | baja | texto corregido |
| B9 | «Ver más» en la bandeja podía mezclar un filtro viejo | baja | se descarta la página de otro filtro |
| — | una subcategoría activa bajo una madre inactiva admitía servicios | baja | ya no |

**Aceptados y documentados:**
- **M2**: la URL firmada de una imagen pública lleva el identificador del
  perfil en su ruta. Es el patrón de Productos (que además publica
  `seller_profile_id`), y cambiarlo exige otro barrido en la baja de cuenta:
  decisión **C15**; sin archivos todavía, mejor antes de encender Servicios (§32).
- **B2, resto**: el formulario ofrece PEN, USD y EUR aunque la configuración de
  fábrica solo admite PEN. Al guardar, `missing` lo dice con palabras (**C16**).
- Las imágenes de un borrador **retirado** se conservan hasta la baja de la
  cuenta (la 0090 no deja tocar las imágenes fuera de un borrador): **C12**.

**Validación final** (29/09/2026, sobre `8a3e519`):

| Comprobación | Resultado |
|---|---|
| Backend **con** PostgreSQL (0001–0090 desde cero, todas las verticales) | **3910 pasan**, 0 fallan, 0 omitidas (17 min 56 s) |
| Backend **sin** PostgreSQL | **2925 pasan**, 985 omitidas (las que necesitan la base), 0 fallan |
| Móvil, en la copia de trabajo | 3378 pruebas en 127 baterías: **3375 pasan**; las 3 que fallan son de Eventos (`eventoDelOrganizador`, `finanzasDeEventos`, `moderacionDeResenas`), no se tocaron y fallan **solo por CRLF** |
| Móvil, en una copia LF | 3356 de 3357: esas tres pasan; la única que falla allí es `recorridoDeAtras`, porque la copia no tiene `node_modules` (en la de trabajo pasa) |
| `tsc --noEmit` | limpio |
| Expo Doctor | 18 de 18 |
| Exportación web | correcta |
| Traducciones | 348 claves nuevas en es, en y pt, con los mismos huecos |
| Rutas | 159 en la app, ninguna duplicada; 487 operaciones en la API, ninguna repetida (30 del catálogo) |
| `git diff --check` y secretos | limpio; ningún secreto en lo añadido |
| Escritura directa desde el móvil | ninguna a las tablas ni al depósito del catálogo |
| `FEATURE_SERVICES` | apagada por defecto (`config.py`, `.env.example`, y el móvil solo la enciende con un `true` exacto) |
| Cursos, Eventos y Productos | sus baterías, dentro de las de arriba, en verde |

**Riesgos de integración** (escritos antes de aplicar la 0090; lo que se
comprobó después está en §32):
- **la puerta lee `storage.buckets`**, y es la primera vez que la API lo
  hace. Si el rol con el que conecta la API no pudiera leerlo, el catálogo
  contestaría 503 `services_not_ready` con la 0090 bien aplicada. **Resuelto
  el 29/09/2026**: el rol real (`postgres`, con BYPASSRLS y SELECT) lo lee y
  la puerta dice que sí (§32);
- la 0090 se probó en PostgreSQL 16 local; Supabase corre la 17.6. **Resuelto**:
  el esquema de Supabase coincide entero con el de la referencia local (§32);
- el depósito `service-media` lo crea la 0090 insertando en
  `storage.buckets`; si el proyecto ya tuviera uno con ese nombre, la 0090 lo
  deja privado, de 5 MB y solo con imágenes (lo corrige, no se niega).
  Ninguna política de `storage.objects` de las migraciones del repositorio lo
  alcanza. **Comprobado en Supabase** (§32): ninguna de sus 11 políticas lo
  alcanza, tampoco una creada a mano;
- tocar el push de un aviso abre la app, no el servicio (como los demás avisos
  al creador); la bandeja sí lleva. Revisado y clasificado en §32.

## 31. Punto exacto para empezar el Incremento 3

> **Actualización (29/09/2026):** el Incremento 3 ya está implementado y
> probado (Parte III, §33). Esta sección se conserva como se escribió al
> cerrar el Incremento 2; lo que sigue pendiente de ella (QA físico,
> decisiones C1, C5 y C15, el destino del push) se recoge en §48.

Cuando se escribió, **no se había empezado el Incremento 3**. Antes, una
persona tenía que:

1. ~~Aplicar la 0090 y verificarla~~ **Hecho el 29/09/2026** (§32, sin
   divergencias). Queda **desplegar el código de `Edson`** cuando se apruebe:
   ese despliegue reinicia la API, y la puerta ve la 0090.
2. **Hacer el QA físico** del catálogo (`Z_QA_FISICO_PENDIENTE.md`), con la
   bandera encendida solo en el entorno de pruebas.
3. **Decidir al menos C1** (categorías iniciales) y C5 (monedas y países): sin
   categorías nadie puede crear un servicio. **C15** (la ruta de las imágenes)
   conviene decidirla antes de encender Servicios (§32).
4. Antes de los avisos de reservas, que el push de la cola **lleve su destino**
   (§32, «Navegación de los avisos»).

El Incremento 3 parte de `services` publicados con su versión publicada
(`service_versions.status = 'published'`), que es lo único que puede dar por
supuesto. Lo que viene después (disponibilidad, reservas, pagos, atención,
incidencias, reseñas) sigue sin tabla, ruta ni pantalla.

## 32. Cierre técnico del Incremento 2 (29/09/2026)

**La 0090 se aplicó a mano en Supabase el 29/09/2026** (Edson; la ejecución
terminó sin errores) y se **verificó ese mismo día** (19:56 hora de Lima,
00:56 UTC del 30/09) **sin divergencias**. No se volvió a ejecutar ni se tocó
el fichero; no se escribió ningún dato en Supabase.

### La verificación, en solo lectura

Dos sesiones con la `DATABASE_URL` del fichero de secretos autorizado (la que
se cargó en AWS para la API), sin imprimirla nunca. Las dos:
`transaction_read_only = on` antes de consultar nada, una sonda de escritura
**rechazada** (SQLSTATE 25006), ningún id de escritura en toda la sesión y
`ROLLBACK` al final. Supabase: PostgreSQL 17.6.

La referencia es el repositorio (prólogo + 0001–0090) aplicado sobre
PostgreSQL 16 local desechable. El verificador se ensayó antes contra ella
(limpio) y contra una copia **estropeada a propósito** (un disparador
deshabilitado, el depósito público y un permiso a `anon`): dio 12
divergencias y la puerta en «no». No declara nada comprobando solo que los
objetos existen: compara definiciones.

| Qué | Resultado en Supabase |
|---|---|
| **El esquema público entero** frente a la referencia (así también se ve la 0086–0089) | **idéntico**: 1583 columnas, 1184 restricciones, 500 índices, 75 disparadores, 50 funciones, 153/153 tablas con RLS, 149 políticas |
| Las **cinco tablas**, definición por definición | **86 columnas** iguales (tipo con su modificador, nulabilidad, valor por defecto, identidad y generadas); **75 restricciones** iguales con su texto: 5 claves primarias, 8 ajenas (con su acción), 56 CHECK, 4 UNIQUE y 2 disparadores de restricción (la coherencia al confirmar) |
| Los **índices** | 24 iguales; los **5 críticos** (`service_versions_una_abierta`, `…_una_publicada`, `service_version_images_una_portada`, `services_una_por_clave`, `service_events_una_por_clave`) **únicos, válidos y listos** |
| Los **12 disparadores** | cada uno en su tabla, con su función, su `tgtype` (31, 23, 21, 11, 23, 23, 21, 11, 31, 7, 19, 11) y **habilitado `O`**: exactamente la tabla de §27 |
| Las **7 funciones** | las **huellas de §27**; sin `SECURITY DEFINER`, volátiles, `search_path=public, pg_temp`, sin permiso de ejecución para `anon`, `authenticated` ni `PUBLIC`. Byte a byte, el cuerpo solo difiere en los `\r` del fichero pegado desde Windows; sin ellos es **idéntico** |
| **Estados y saltos** | leídos **del código de las funciones en Supabase** (no del fichero): los 10 saltos de la versión y los 6 del servicio son los de `catalogo_estados.py`, y los CHECK admiten exactamente sus 8 y 4 estados |
| **Versiones protegidas e historial de solo añadir** | `service_versions_saltos`, `service_version_images_solo_en_borrador`, `service_events_inmutables` y los tres `…_solo_en_cascada`, activos y con la huella de la referencia, donde `test_servicios_migracion_0090.py` prueba su comportamiento |
| **RLS y permisos** | RLS activa en las cinco (sin `FORCE`), **cero políticas**; **cero privilegios** de `anon` y `authenticated`: declarados por tabla, por columna y **efectivos** (`has_table_privilege` y `has_any_column_privilege`). Solo `postgres` y `service_role` tienen permisos, como en el resto de tablas |
| **El depósito** `service-media` | **privado**, 5 242 880 bytes, `image/jpeg`, `image/png`, `image/webp`. **0 objetos**. Ninguna de las **11 políticas** de `storage.objects` lo alcanza: todas filtran por su propio depósito |
| **Filas** | las cinco tablas **vacías**; 16 comprobaciones de coherencia a cero (publicado sin una versión publicada, dos abiertas, dos publicadas, enviada sin portada, ruta ajena, historial de otro servicio, tres niveles de categoría, archivos sin fila…); las **332 claves ajenas** de `public` sin huérfanas ni sin validar |
| **Lo que escribió la transacción de la 0090** | solo sus objetos (ninguno de la 0086–0089) y **una** fila de datos: la del depósito. 188 tablas de `public`, `auth` y `storage` revisadas |
| **Los modelos del backend** | 86 columnas con el mismo tipo, nulabilidad y claves ajenas; los mismos CHECK e índices. Las 17 `String(n)` del modelo son `text` con su CHECK en la base, el patrón del proyecto |
| **Las consultas de §27** | ejecutadas tal cual: las ocho devuelven lo que dicen sus comentarios |
| **La 0086–0089** | sus ficheros, sin cambios (su huella git); su esquema, igual al del repositorio |

Desde ahora la 0090 está en `APLICADAS` de `test_servicios_migracion_0090.py`
(huella git `9abe063`): si alguien la edita, la prueba se pone roja. Su
cabecera sigue diciendo «SIN APLICAR» a propósito (ver §26).

### La puerta de esquema, con la conexión y el rol de la API

Con la misma `DATABASE_URL` que la API, asyncpg y los parámetros del pool de
`app/shared/database.py`, `SET TRANSACTION READ ONLY` como primera sentencia y
la misma sonda rechazada, se ejecutó **el código real**
(`esquema.hay_catalogo`):

- el rol es `postgres`: **no** superusuario, **con BYPASSRLS**, `USAGE` en
  `storage` y `SELECT` en `storage.buckets`. La RLS de `storage.buckets` está
  activa y sin políticas; el bypass la salta, así que no hace falta ningún
  permiso nuevo ni una 0091;
- **`hay_catalogo` → sí**, y lo recuerda: 12 de 12 disparadores, 5 de 5
  índices únicos, 5 de 5 tablas con RLS y el depósito privado visible.

Con la bandera encendida y la API reiniciada (el despliegue la reinicia), el
catálogo contestaría. Lo que la puerta rechaza, con el mismo código y
PostgreSQL local (`test_servicios_catalogo_api.py`, sección 10):

| Caso | Puerta |
|---|---|
| 0090 completa | sí |
| una tabla o una columna que falta | no |
| un disparador que falta, con otra función, con otra forma (`AFTER` en vez de `BEFORE`) o deshabilitado | no |
| un índice crítico que falta, o que existe pero **no es único** | no |
| RLS apagada | no |
| el depósito ausente o **público** | no |
| un rol **sin BYPASSRLS** frente a la RLS de `storage.buckets` (no falla, simplemente no lo ve) | no; y con BYPASSRLS, como en Supabase, sí |
| un rol **sin `SELECT` sobre `storage.buckets`** | la consulta falla con **42501**; la puerta dice que no **sin recordarlo**, y la API contesta **503 `services_not_ready`** en el prestador, las categorías, la ficha y la bandeja, **nunca 500**. Al conceder el permiso responde sin reiniciar |

### El recorrido integral (local)

`tests/test_servicios_catalogo_recorrido.py`, contra PostgreSQL local
desechable (0001–0090), el Storage en memoria y `FEATURE_SERVICES` encendida
**solo en la prueba**. Un único servicio pasa por todo, en orden, y en cada
etapa se comprueba qué pueden y qué no pueden hacer **la prestadora dueña,
otro prestador, moderación, administración y el público**:

1. prestadora aprobada **por la admisión real** del Incremento 1;
2. categoría: solo administración la crea;
3. servicio: solo un prestador activo lo crea, con `Idempotency-Key`; lo
   ajeno es 404 para otro prestador, y quien no es prestador no lo alcanza;
4. **los 21 requisitos**: cada código sale y se resuelve (categoría
   desactivada y activada, prestador que deja de estar activo, modalidad,
   duración y modelo de precio fuera de lo configurado, zona, importe,
   moneda, moneda no admitida, portada, demasiadas imágenes…) hasta que no
   falta nada;
5. imágenes: la primera es la portada, orden, URL firmada;
6. envío (lo enviado ya no se edita); 7. revisión; 8. cambios pedidos con
   motivo y campos (la nota interna no llega a la prestadora);
9. corrección en la versión 2; 10. reenvío (`resubmitted`);
11. aprobación: moderación no; 12. publicación: moderación no;
13. **ficha pública** para cualquiera, sin nada interno;
14. **versión 3**: la 2 **sigue siendo la pública** mientras se revisa y aprueba;
15. publicar la 3: **la 2 pasa a superada**;
16. **suspender**: desaparece de la ficha para todos; la prestadora lee el
    motivo; 17. reactivar: vuelve;
18. **retirar**: definitivo. Ni reactivar, ni suspender, ni retirar otra vez,
    ni abrir un borrador; y un `UPDATE` directo a la base lo rechaza el
    disparador de saltos.

Al final, el historial (18 pasos, igual para la prestadora y el equipo, que
además ve las notas internas) y los siete tipos de aviso que recibió la
prestadora. **Verde.**

### Las pruebas móviles

Las 3 pruebas de Eventos que fallaban solo en local (`eventoDelOrganizador`,
`finanzasDeEventos`, `moderacionDeResenas`) eran **anteriores al
Incremento 2**:

- fallan igual en `161cf71`, sacado con `core.autocrlf`;
- sus ficheros no cambian desde el 24/09.

La causa: buscan en el fuente de la pantalla un fragmento de varias líneas
escrito con `\n`, y en una copia de Windows el fuente llega con `\r\n`.

El arreglo es seguro y acotado: normalizar `\r\n` al leer el fuente, en esas
tres pruebas y en nada más (ni una línea de la app). Una mutación comprueba
que la de Eventos sigue cazando lo que vigila. La batería completa en el
árbol real: **3379 de 3379, salida 0**.

### Navegación de los avisos

- **En la bandeja** (el centro de avisos), cada uno de los 11 lleva a su sitio
  (`rutaDelAviso`, probado):
  - los del prestador, a su servicio (`/servicios/prestador/catalogo/{id}`),
    donde lee el estado y el motivo;
  - «publicado», a la ficha;
  - «publicado en un servicio suspendido», a su servicio, no a una ficha
    que daría 404;
  - los del equipo, a la revisión (`/admin/servicios/catalogo/{id}`).

  Si el destino ya no existe o no hay permiso, la pantalla lo dice sin
  romperse: «No encontramos ese servicio» (404), «sin permiso» (403) o
  «todavía no disponible» (503). Cada una de las 13 vistas lo hace, y lo
  vigila `serviciosCatalogoVistas.test.mts`.
- **Tocar el push abre la aplicación, sin llevar a ningún sitio.** Hay dos
  causas:
  - los avisos de Servicios (admisión y catálogo) salen por la **cola de
    entregas**, cuyo envío (`entregas.procesar` → `push.enviar_de_la_cola`)
    no manda `data`;
  - y la app solo sabe a dónde lleva el push de un directo (`rutaDelPush`
    conoce únicamente `live_started`).

  Por lo segundo, pasa igual con los avisos al creador de Cursos, Eventos y
  Productos (`notifications/decisiones.py`), aunque esos sí mandan el tipo y
  la entidad. No se inventó ninguna ruta ni se construyó nada nuevo. Una
  prueba fija el comportamiento de hoy, para que cambiarlo sea a propósito.
- **Clasificación:**
  - el blueprint (§23) pide `deepLink` en cada notificación, y su lista
    obligatoria es la de las reservas (Incremento 3 en adelante);
  - las capturas no muestran la navegación desde el push;
  - en el Incremento 2 el aviso llega por los dos canales y la bandeja lleva
    a su destino.

  **No bloquea el cierre del Incremento 2.** Sí hay que resolverlo antes
  de los avisos de reservas.
- **La tarea concreta:**
  1. que `entregas.procesar` pase el `correlation_id` al envío;
  2. que `enviar_de_la_cola` lo mande en `data` junto al tipo;
  3. que `rutaDelPush` reutilice `rutaDelAviso` para los tipos cuyo
     `correlation_id` sea la entidad (en el catálogo, el servicio),
     validando el UUID.

  Hay que cambiar a la vez la prueba que hoy fija el comportamiento.

### C15: el identificador del perfil en la ruta de las imágenes

- El depósito `service-media` es **privado** (verificado en Supabase) y
  ninguna política de `storage.objects` lo alcanza.
- Las imágenes solo salen como **URL firmada que caduca**, en 3600 s
  (`SEGUNDOS_DE_LA_FIRMA`). No existe ninguna ruta pública permanente, y
  ninguna respuesta lleva la ruta como campo.
- Pero la URL firmada **contiene la ruta**, que hoy es
  `<perfil>/<servicio>/<versión>/<id>.<ext>`: el **UUID del perfil** del
  prestador viaja en ella, igual que en Productos. Es lo que permite que la
  baja de cuenta barra `service-media/<perfil>/`.
- **La empresa decide** si acepta ese identificador o exige una ruta opaca.
- **Hoy no hay ningún archivo** en `service-media` (0 objetos, verificado).
  Si se decide cambiarla, se puede hacer **antes de encender Servicios** sin
  migrar contenido. Tocaría la ruta en `catalogo_imagenes.py`, el prefijo
  que exige la 0090 a las filas (con otra migración) y el barrido de la
  baja.

No se cambió nada durante esta verificación.

### Pruebas y validación del cierre

| Comprobación | Resultado |
|---|---|
| Verificación de la 0090 en Supabase | **sin divergencias** |
| Puerta real con el rol de la API | **sí** |
| Puerta en local, 16 pruebas (la tabla de arriba) | verdes |
| Recorrido integral, cinco actores | verde |
| Backend **con** PostgreSQL (0001–0090 desde cero) | **3918 pasan**, 0 fallan, 0 omitidas (24 min 45 s) |
| Backend **sin** PostgreSQL | **2926 pasan**, 992 omitidas (las que necesitan la base), 0 fallan |
| Móvil, árbol real (CRLF) | **3379 de 3379**, salida 0 |
| `tsc --noEmit` | limpio |
| Mutaciones del cierre | **10 de 10 en rojo**: la puerta sin mirar si el depósito es público, sin exigir índices únicos, sin mirar la forma del disparador, sin mirar el depósito; un error de permisos que revienta o que se recuerda; «demasiadas imágenes» que no sale; la ficha que enseña lo suspendido; la fecha de Eventos editable en solo lectura; la cola que manda datos sin enseñar a `rutaDelPush` |
| `FEATURE_SERVICES` | **apagada** |
| Código | en `Edson`, **sin desplegar** (sin push, PR ni merge) |

**Queda pendiente únicamente el QA físico** (`Z_QA_FISICO_PENDIENTE.md`,
«Incremento 2»).

---

# Parte III · Incremento 3: descubrimiento y confianza

Escrito el 29/09/2026 en la rama `Edson`. **Implementado y probado; pendiente
de aplicar y verificar la 0091 y de hacer el QA físico.** No está cerrado.

## 33. Estado del Incremento 3

| | |
|---|---|
| **Qué hace** | Cualquiera descubre servicios desde Explorar. Puede: <ul><li>buscarlos por lo que necesita;</li><li>filtrarlos y ordenarlos;</li><li>abrir su ficha y conocer al prestador, con lo que Z comprobó de él;</li><li>guardarlos para después.</li></ul>Las sugerencias llevan su razón. Termina **antes** de reservar o contratar |
| **Migración 0091** | **Escrita y probada solo en PostgreSQL local desechable. SIN APLICAR** en Supabase. Solo crea `saved_services`. Pasos y verificación: §44–§45 |
| **Sin la 0091** | Buscar, filtrar, la ficha, el perfil y las sugerencias funcionan; **guardar, quitar y la lista de guardados** contestan 503 `services_not_ready`. Nunca un 500 |
| **`FEATURE_SERVICES`** | **apagada.** Las 8 rutas nuevas contestan 503 `services_disabled`. El acceso «Servicios» de Explorar sigue como antes: avisa de que aún no está |
| **Dinero, reservas, reseñas** | **ninguno.** El precio se enseña; no hay reserva, pago, agenda ni reseña que crear |
| **Código** | En `Edson`, **sin desplegar**: sin push, PR ni merge |
| **QA físico** | pendiente: `Z_QA_FISICO_PENDIENTE.md`, sección «Incremento 3» |

## 34. Matriz de alcance (blueprint, capturas y datos)

| Requisito (blueprint / capturas) | Datos que existen | Decisión | Incremento 3 |
|---|---|---|---|
| S01 Entrada a Servicios desde Explorar | la vertical ya estaba en Explorar | solo con la bandera | **sí**: el acceso lleva a `/servicios` |
| S01 «¿Qué necesitas resolver?» + ejemplos | texto | sin IA (prohibida aquí) | **sí**, como búsqueda; sin interpretación ni voz |
| S01 «Frecuentes» (máx. 4) + «Ver más» | categorías; **no** hay datos de uso | «frecuentes» no se puede afirmar | **sí**, como «Categorías», en su orden; «Ver todas» |
| S01 Recomendados con razón | guardados, fecha de publicación | criterio pendiente | **sí**, dos razones de verdad (§40) |
| S02 Taxonomía | categorías de dos niveles | — | **sí** (chips, madre incluye hijas) |
| S03 Resultados por servicio | versión publicada | — | **sí** |
| S03 Orden «ajuste + disponibilidad + calidad» | no hay disponibilidad ni calidad | registrado | relevancia (con búsqueda) o recientes |
| S04 Filtros: modalidad, zona, precio cerrado/rango/cotización, credencial | sí | — | **sí** |
| S04 Filtros: híbrida, radio, fecha/hora, calificación, idioma, accesibilidad, urgente | **no existen** | — | **no** (no se inventan) |
| S04 Orden: precio menor/mayor | sí, por moneda | sin mezclar monedas | **sí**, exige moneda |
| S04 Orden: mejor valorados, disponibilidad | no | — | **no** |
| S05 Perfil: identidad, sellos, servicios, credenciales, reputación, contacto | nombre público, tipo, admisión, identidad y credencial verificadas | qué credenciales se publican: **pendiente** | **sí**, sin nombre ni número de credencial; sin foto propia; sin contacto (Inc. 4+) |
| S06 Ficha en su orden | contenido de la versión publicada | — | **sí**, sin disponibilidad, cancelación ni pago (no existen) |
| S06 / §17 Calificación y reseñas | **no existen** reseñas verificadas | origen futuro pendiente | **sección vacía honesta**; media `null` |
| Guardados («solo servicios y profesionales») | — | profesionales guardados: no | **sí**, servicios |
| §23 `deepLink` en notificaciones | bandeja sí; push no (§32) | — | sin cambios (tarea abierta) |

**Diferencias registradas:**
- el blueprint pide un orden por «ajuste, disponibilidad y calidad», y hoy no
  hay ninguna de esas señales;
- «frecuentes» exige datos de uso que no existen;
- el perfil del blueprint abre la evidencia de cada sello y muestra el número
  parcial de la credencial, y no está decidido qué se publica.

Se conservó la seguridad: no se inventa nada y se registra la decisión.

## 35. Lo que NO es

No hay:
- disponibilidad, agenda, franjas, retenciones ni reservas;
- contratación, pagos ni mensajes por reserva;
- reprogramaciones, cancelaciones, check-in ni sesiones por 100ms;
- incidencias ni devoluciones;
- crear, responder ni moderar reseñas, finanzas ni transferencias.

Tampoco hay:
- IA, embeddings ni un buscador externo;
- un segundo recomendador;
- una aplicación aparte.

## 36. Lo público: UNA autoridad

`descubrimiento.condiciones_publicas()` decide qué servicio se puede ver. La
usan el catálogo, la búsqueda, la ficha, el perfil, las sugerencias y los
guardados. Un servicio es público si cumple **todo** esto:

- está **publicado**, con su versión **publicada**;
- su prestador está **activo**;
- su categoría está **activa**, y también su madre;
- si la categoría es de un país, es el del prestador;
- tiene **portada**;
- y no hay un **bloqueo** entre quien mira y el prestador, en ningún sentido
  (como en la búsqueda global).

La ficha del Incremento 2 tenía su propia copia sin la categoría activa. Ahora
comparten esta. **Cambio de la decisión provisional 5 del Incremento 2**: una
categoría desactivada saca del público los servicios que la usan. Los
servicios no se borran, y al reactivarla vuelven.

El móvil nunca recibe nada privado para esconderlo después.

## 37. Búsqueda

- **Solo PostgreSQL**, con las palabras de la búsqueda global
  (`search.normalizacion`): quita las palabras vacías, incluidos verbos de
  intención como «necesito» o «quiero», y trata los plurales.
- **Tildes, eñe y cedilla se pliegan en los dos lados**: la palabra y, EN LA
  BASE, la columna (`translate`, mayúsculas incluidas). Así «cafe» encuentra
  «Café», «peru» a «Perú» y «diseno» a «Diseño».
- El `_` que se escriba separa palabras; nunca llega a `LIKE` como comodín.
- **Ni extensiones nuevas ni índices**. `pg_trgm` ya existe (0040), pero no
  hacía falta.
- **Cada palabra tiene que aparecer** en algún sitio: título, categoría o su
  madre (en es, en y pt), resumen, descripción, nombre del prestador, zona
  (fuera de lo virtual) o una palabra de modalidad («virtual», «online»,
  «presencial», «domicilio», también en plural).
- **Relevancia con pesos DOMINANTES**: título 64; categoría y resumen 8;
  descripción, prestador, zona y modalidad 1.
  - Cada nivel pesa más que todo el de abajo junto: coincidir en tres sitios
    secundarios no adelanta a quien coincide en el título.
  - Se suma por palabra, en SQL, con desempate total.
  - Cada resultado dice **dónde** coincidió (`reason_fields`).
- Sin ninguna palabra de dos letras o más (una letra, o solo `_`) es un
  422 `service_catalog_query_too_short`. El móvil aplica la misma regla antes
  de preguntar y, si el servidor la rechaza, lo explica con «Limpiar
  filtros», nunca con «Reintentar».

## 38. Filtros y orden

| Filtro | Parámetro | Regla |
|---|---|---|
| Categoría | `category_id` | incluye sus subcategorías |
| Modalidad | `modality` | `virtual`, `in_person`, `at_home` |
| Precio | `price` | `free`, `priced` (con importe) u `on_request`. **Gratis no es «sin precio»** |
| Moneda y rango | `currency`, `min_price`, `max_price` | en **unidades menores** de esa moneda. **Sin moneda no hay rango**. Nunca se mezclan ni se convierten. Un precio «desde» cuenta por su importe mínimo, y la app lo dice |
| Zona | `area` | texto, sobre la zona general (nunca una dirección) |
| Credencial | `credential_verified` | Z verificó al menos una credencial **vigente** |

**Orden**: `relevance` (con búsqueda), `recent` (primera publicación),
`price_asc` y `price_desc`.
- El orden por precio **exige** moneda y solo incluye lo que tiene importe.
- No hay «más popular», «mejor valorado» ni «más contratado»: no hay datos.
- Cada orden tiene un **desempate total** (`id`).
- El cursor es opaco y **lleva su orden**: uno de otro orden, o manipulado,
  es 422 `invalid_cursor`.
- Un filtro que no se entiende es 422 `service_catalog_filter_invalid`, con
  el campo en `details`.
- Un rango o un orden por precio sin moneda es 422
  `service_catalog_currency_required`.

**En el móvil** los filtros viven en la ruta (`/servicios?q=…&categoria=…`):
«Atrás» y un enlace los conservan, y limpiarlos devuelve el catálogo.

## 39. Ficha, perfil, confianza y reseñas

- **Ficha** (`GET /services/catalog/{id}`, la del Incremento 2 ampliada), en
  el orden del blueprint:
  - el contenido;
  - quien lo ofrece, que lleva a su perfil;
  - **lo que Z comprobó**;
  - «servicio revisado y aprobado por Z», con la fecha;
  - «lo declara el prestador»;
  - las reseñas;
  - guardar;
  - más servicios del prestador y de la categoría, **con su razón** (quien
    ofrece el servicio no ve lo suyo como «más de este prestador»).

  **Sin botón de contratar.**
- **Perfil público** (`GET /services/providers/{id}` y
  `…/{id}/services`). Muestra:
  - el nombre público y el tipo (profesional independiente o empresa);
  - lo que Z comprobó;
  - las categorías, modalidades y zonas generales de lo publicado;
  - las reseñas (ninguna todavía) y sus servicios.

  Un prestador sin nada público, o suspendido, es 404: no se puede recorrer
  la lista de admitidos. **Nunca** sale el nombre legal, los documentos, el
  número o el nombre de la credencial, el contacto, el perfil social ni las
  notas.
- **Confianza.** Solo lo verdadero, nombrando exactamente qué comprobó Z:
  - «Prestador admitido por Z desde mm/aaaa»;
  - «Identidad verificada por Z»: documento de identidad aceptado en la
    admisión;
  - «Credencial profesional verificada por Z y vigente», con el mismo «hoy»
    UTC que la admisión.

  Debajo, siempre: «Estas comprobaciones no garantizan el resultado del
  servicio».
- **Reseñas**: `count: 0`, `average: null`.
  - «Todavía no hay reseñas verificadas».
  - Ni estrellas, ni «0.0», ni las reseñas de perfiles
    (`profile_reviews`), cursos, eventos o productos.
  - Llegan en el Incremento 6.

## 40. Guardados y sugerencias

- **Guardar** (`POST /services/catalog/{id}/save`) y **quitar**
  (`DELETE …/save`) son **idempotentes**. Guardar a la vez es `on conflict do
  nothing` sobre la clave `(perfil, servicio)`.
  - Solo se guarda lo público; quitar vale siempre.
  - No reserva nada, no avisa al prestador y **no se cuenta** en ninguna
    parte pública.
- **La lista** (`GET /services/saved`, por cursor) va de lo más reciente a lo
  más antiguo. Lo que ya no está disponible (suspendido, retirado, prestador
  fuera, categoría inactiva, bloqueo) queda con `available: false`, sin
  tarjeta y con el **título que tenía al guardarse** (`title_at_save`), para
  poder quitarlo. Nunca con el título vivo, que puede ser el de una versión
  que no llegó a verse. Nunca parece contratable.
- **Sugerencias** (`GET /services/suggestions`). No es un recomendador
  nuevo: se reutiliza el contrato del existente (un **código** de razón que la
  app traduce, nunca una frase) y el grafo social (bloqueos). Hay dos
  señales:
  - `similar_to_saved`: de la categoría (o la familia) de lo guardado;
  - `recently_published`: primera publicación en los últimos 30 días.

  Nunca lo propio de quien mira ni lo ya guardado, y cada servicio sale en
  una sola sección. **Sin señal no hay sección**: nunca se rellena con
  cualquier cosa.

  No se usó «prestador seguido»: revelaría quién es en la red social el
  prestador. En la ficha, `same_provider` y `same_category`. En la búsqueda,
  `matches_search` con los campos.

## 41. La API (8 rutas nuevas) y la puerta

| Ruta | Sesión | Para qué |
|---|---|---|
| `GET /services/catalog` | opcional | catálogo, búsqueda, filtros y orden, por cursor |
| `GET /services/public-categories` | opcional | categorías con algo público (y sus madres) |
| `GET /services/suggestions` | opcional | secciones con razón |
| `GET /services/providers/{id}` | opcional | perfil público |
| `GET /services/providers/{id}/services` | opcional | sus servicios, por cursor |
| `POST /services/catalog/{id}/save` | obligatoria | guardar |
| `DELETE /services/catalog/{id}/save` | obligatoria | quitar |
| `GET /services/saved` | obligatoria | la lista propia |

La ficha sigue en `GET /services/catalog/{id}`, ahora con sesión opcional
(para `saved` y los bloqueos). Todas pasan primero por la bandera y la
0090.

La **puerta de la 0091** (`esquema.hay_guardados`) exige:
- la tabla con las columnas del modelo y **sus tipos**;
- la clave primaria `(profile_id, service_id)`;
- las **dos** claves ajenas en cascada, una a `profiles` y otra a `services`;
- sus dos índices;
- RLS.

No mira el número de la migración. Sin la 0091 completa, guardar es 503.
Como la del catálogo, recuerda el sí y el no hasta reiniciar, y un error al
mirar no se recuerda. Además, los guardados se LEEN en un punto de guardado:
si la tabla desapareciera con la API en marcha, el catálogo sigue (sin
marcar guardados) y la puerta vuelve a mirar.

Cada página hace un **número fijo de consultas**, sea cual sea su tamaño:
- la página;
- las portadas;
- las credenciales;
- los guardados;
- y una sola firma de imágenes.

## 42. Vistas y navegación

**Acceso:** Explorar › «Servicios», solo con la bandera encendida. Apagada,
avisa de que aún no está, como antes.

- **Servicios** (`/servicios`):
  - la pregunta y la búsqueda;
  - las categorías (cuatro y «Ver todas»);
  - los filtros en una hoja inferior, con su número;
  - el orden;
  - sin búsqueda, las **sugerencias**;
  - los resultados con «Ver más»;
  - en la cabecera, **Guardados**.
- **Ficha** (`/servicios/ficha/[id]`), la del Incremento 2 ampliada.
- **Perfil del prestador** (`/servicios/prestadores/[id]`), desde la ficha.
- **Guardados** (`/servicios/guardados`), desde la cabecera de Servicios.

Todas tienen carga, «Ver más», estado vacío, error con reintento (sin
conexión, no disponible, sin permiso), «no lo encontramos», atrás con
respaldo, sin textos en duro (100 claves nuevas en es, en y pt), lector de
pantalla y áreas táctiles de 44.

La tarjeta de servicio es la misma en todas. Muestra:
- la portada, o su texto alternativo;
- el título y el prestador;
- la categoría, la modalidad y la zona;
- el precio; «a consultar» y «sin precio» no son lo mismo;
- «Prestador con credencial verificada», solo si es verdad (la insignia es
  del prestador, no del servicio: D15);
- el motivo;
- el marcador de guardar.

**Avisos:** sin cambios. La bandeja sigue llevando a su destino, y el push
solo abre la app (§32, tarea abierta).

## 43. Decisiones

**Tomadas en el código** (provisionales):
- la categoría inactiva saca del público (§36); quien lo ofrece lo ve como
  «no visible» y la confirmación de administración lo avisa;
- el rango de precio incluye los «desde» por su importe mínimo;
- la insignia de la tarjeta es del prestador: «Prestador con credencial
  verificada»;
- las categorías se muestran en su orden, no como «frecuentes»;
- sin búsqueda, el orden es «recientes»;
- el orden por precio y el rango exigen moneda;
- el perfil muestra el tipo de prestador y la fecha de admisión (mes y año),
  pero no foto ni presentación: no hay un campo público propio, y el resumen
  de la postulación es de la admisión;
- se oculta a quien está bloqueado, en los dos sentidos;
- los guardados no disponibles quedan con el título que tenían al
  guardarse;
- «publicado recientemente» son 30 días (`DIAS_DE_RECIENTE`).

**Pendientes de la empresa**: `Z_REQUISITOS_Y_DECISIONES.md`, «Incremento 3»
(D1–D15).

## 44. Cómo aplicar la 0091

1. Comprobar que el fichero es el completo:
   `supabase/migrations/0091_servicios_guardados.sql`, que empieza por
   «-- 0091» y termina en «notify pgrst, 'reload schema';» y «commit;».
2. Pegarlo **entero** en el editor SQL de Supabase y ejecutarlo. Es una
   única transacción:
   - comprueba la 0086–0090;
   - crea `saved_services`;
   - se verifica al final: la clave, las cascadas, los índices, la RLS, cero
     políticas y cero permisos;
   - se puede ejecutar dos veces.
3. **Reiniciar la API**: la puerta recuerda el «no» del arranque.
4. Verificarla en solo lectura (§45).

## 45. Verificar la 0091 (solo lectura)

```sql
begin transaction read only;
select current_setting('transaction_read_only');   -- 'on'
savepoint sonda;
create temp table sonda_de_escritura (x int);      -- TIENE que fallar con 25006
rollback to savepoint sonda;

-- La tabla (profile_id uuid, service_id uuid, title_at_save text,
-- created_at timestamptz), con RLS, sin políticas ni permisos sueltos.
select c.relrowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid)
  from pg_class c where c.oid = 'public.saved_services'::regclass;          -- t | 0
select count(*) from information_schema.table_privileges
 where table_schema = 'public' and table_name = 'saved_services'
   and grantee in ('anon', 'authenticated');                                -- 0

select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'saved_services'
 order by ordinal_position;
  -- profile_id uuid · service_id uuid · title_at_save text · created_at timestamp with time zone
select pg_get_constraintdef(oid) from pg_constraint
 where conname = 'saved_services_titulo';
  -- CHECK (((length(TRIM(BOTH FROM title_at_save)) >= 1) AND (length(TRIM(BOTH FROM title_at_save)) <= 300)))

-- La clave (perfil, servicio) y las dos cascadas.
select a.attname from pg_index i join pg_attribute a
    on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
 where i.indexrelid = 'public.saved_services_pkey'::regclass and i.indisprimary
 order by a.attnum;                                                         -- profile_id, service_id
select confrelid::regclass, confdeltype from pg_constraint
 where conrelid = 'public.saved_services'::regclass and contype = 'f';      -- profiles c · services c

-- Los índices y, recién aplicada, vacía.
select indexname from pg_indexes where tablename = 'saved_services' order by 1;
  -- saved_services_del_servicio, saved_services_mios, saved_services_pkey
select count(*) from public.saved_services;                                 -- 0
rollback;
```

## 46. Pruebas, mutaciones, revisión y validación (29/09/2026)

### Pruebas nuevas

| Dónde | Qué |
|---|---|
| `test_servicios_descubrimiento_api.py` (PostgreSQL, 19) | Solo sale lo público (cada estado no publicado, publicado con una versión nueva en borrador o en revisión, suspendido, retirado, prestador fuera, categoría o madre inactiva, categoría de otro país; la portada siempre firmada), y quien lo ofrece ve «no visible»; búsqueda por cada campo, `_`, plurales de modalidad, tildes en palabras cortas y pesos dominantes; filtros combinados sin mezclar monedas; credencial vencida, rechazada o declarada; cursor estable en los cuatro órdenes (también la relevancia con puntuaciones distintas); ficha y perfil sin nada privado ni reseñas de otra vertical; guardar, quitar y la lista con el título al guardar; bloqueos; la bandera; la puerta de la 0091 (tipos, una clave a cada tabla); la tabla que desaparece con la API en marcha; sin la 0091; número fijo de consultas; el recorrido entero |
| `test_servicios_descubrimiento_reglas.py` (sin base, 30) | Filtros, cursor y sus topes, `_` y tildes, pesos dominantes, campos privados ausentes, reseñas `null`, códigos de razón |
| `test_servicios_migracion_0091.py` (11) | Es la última y sigue a la 0090; una sola transacción que comprueba antes de crear; no concede ni toca otra tabla; nada de dinero, reservas ni popularidad; desde cero, cerrada (RLS, cero políticas, cero privilegios) e igual al modelo; sin duplicados, con el título obligatorio (ni vacío ni de más de 300) y en cascada con la cuenta y el servicio; sobre la 0090 con datos no toca nada; reejecutarla deja lo mismo; un fallo a mitad no deja nada; se niega sin la clave, sin RLS o sin la 0090 |
| `serviciosDescubrimiento.test.mts` y `serviciosDescubrimientoVistas.test.mts` (móvil) | Filtros en la ruta, reglas iguales a las del servidor, órdenes posibles, juntar sin repetir, textos sin códigos; las vistas solo se alcanzan desde Explorar con la bandera, el 422 con «Limpiar filtros», una sola acción de guardar, sin botón de contratar |

**Concurrencia**, contra PostgreSQL de verdad:
- `test_guardar_a_la_vez_y_guardar_y_quitar_a_la_vez`: cuatro «guardar» a la
  vez contestan 200 y dejan una sola fila; «guardar» y «quitar» cruzados
  contestan todos 200 y dejan cero o una fila, nunca dos;
- `test_publicar_mientras_se_pagina_no_repite_ni_salta`: publicar un servicio
  entre dos páginas no repite ni salta ninguno;
- `test_suspender_o_desactivar_mientras_se_consulta`: con la suspensión a la
  vez que la ficha, la ficha es 200 o 404 y después, 404; con la categoría
  desactivándose a la vez que la lista, la lista es 200 y después, vacía.

### Mutaciones

**20 mutaciones del incremento** (M1–M20), **20 de 20 en rojo** sobre el código
final: mostrar borradores, suspendidos o prestadores suspendidos; exponer
notas internas o una ruta privada; mezclar monedas; convertir sin moneda;
tratar `null` como 0 en el móvil; inventar un promedio; guardados duplicados;
filtrar en el móvil; omitir la categoría inactiva; ignorar la bandera; aceptar
una migración incompleta; recomendaciones sin razón; incluir lo propio; romper
el cursor estable; introducir N+1; credencial no verificada como verificada;
reutilizar reseñas de otra vertical. En la primera pasada, M1 (mostrar
borradores) sobrevivió: la prueba no tenía un servicio publicado con un
borrador encima. Se añadió y se pone roja.

**15 mutaciones de la revisión** (R1–R15), **15 de 15 en rojo**: ver abajo.
Las 35 se repitieron sobre el código final, con el árbol restaurado después.

### Revisión independiente

**Revisión independiente** (solo lectura, adversarial, sobre una copia limpia
de `9a9d1c1`). Resultado: nada bloqueante, **un hallazgo alto**, cinco medios
y una docena de bajos. Cada uno se reprodujo, se clasificó y, si era del
alcance, se corrigió con una prueba capaz de ponerse roja. **15 mutaciones más**
(R1–R15) deshacen esos arreglos uno por uno: **15 de 15 en rojo** sobre el
código final. En la primera pasada la R14 (el 422 pintado como error con
«Reintentar») sobrevivió: la prueba solo miraba que existiera el estado, no
que el 422 fuera a él. Se reforzó y ahora se pone roja. La R15 quita de la 0091
la comprobación del título al guardar; la prueba de la migración la exige.

| # | Hallazgo | Severidad | Arreglo |
|---|---|---|---|
| 1 | La lista de guardados enseñaba el título **vivo** de un servicio no disponible: el de una versión publicada durante una suspensión (que nunca se vio) o lo que cambiara después de un bloqueo | **alta** | la 0091 (sin aplicar) guarda `title_at_save`, el título público al guardar, y es lo único que sale cuando no está disponible |
| 2 | El `_` que escribe la persona llegaba a `LIKE` como comodín: «____» traía todo el catálogo con un motivo inventado | media | el guion bajo separa palabras; «____» es «escribe al menos dos letras» |
| 3 | La relevancia sumaba pesos: coincidir en categoría, resumen y descripción adelantaba a quien coincide en el título | media | pesos dominantes (64 / 8 / 1): cada nivel pesa más que todo el de abajo |
| 4 | Las tildes solo se toleraban en palabras de cinco letras o más: «cafe», «peru» y «diseno» no encontraban nada | media | en PostgreSQL, la columna se pliega con `translate` (tildes, eñe y cedilla, mayúsculas incluidas), igual que la palabra |
| 5 | Desactivar una categoría despublicaba en silencio | media | quien lo ofrece ve «no visible» (misma autoridad), la confirmación de administración lo avisa, y queda como decisión D13 |
| 6 | C15 se amplía: cada tarjeta del catálogo, también sin sesión, lleva en la URL firmada el identificador del perfil | media | **no se cambió** (decisión de la empresa); corregido el texto que decía lo contrario y documentado el riesgo mayor (§47, D6) |
| 7 | Un 422 al cargar se pintaba como error con «reintentar», y la regla de «dos letras» del móvil no era la del servidor | baja | se explica con su texto y «Limpiar filtros»; mismas reglas que el servidor; un enlace contradictorio no deja un orden por precio sin moneda |
| 8 | Un rollback de la 0091 sin reiniciar tumbaba el catálogo con sesión; la puerta no miraba los tipos ni que las claves fueran a tablas distintas | baja | los guardados se leen en un punto de guardado y, si fallan, la puerta vuelve a mirar; la puerta exige tipos y una clave a cada tabla; el rollback dice «reiniciar» |
| 9 | Un cursor con números enormes acababa en 404 | baja | topes: es `invalid_cursor` |
| 10 | Las sugerencias metían todos los guardados como parámetros | baja | subconsultas |
| 11 | La insignia «Credencial verificada» es del prestador, no del servicio | baja | el texto dice «Prestador con credencial verificada» (D15) |
| 12 | «virtuales» no contaba como la modalidad | baja | se mira la palabra y su singular |
| 13 | La prestadora veía lo suyo en «Más de este prestador» | baja | ya no |
| 14 | El icono de Guardados se anunciaba como «Acción derecha»; los chips que navegan, como casillas | baja | `rightLabel` en `AppHeader` y chips con papel de botón |
| 15 | Un rango incluía los precios «desde» sin decirlo | baja | la hoja de filtros lo dice (D14) |
| 16 | Volver de una ficha reiniciaba la lista | baja | se carga al cambiar los filtros, no al volver |
| 17 | Pruebas débiles (cursor de relevancia solo con empates, sin orden en `price_desc` ni `recent`, sin `_`, sin tildes cortas) | baja | añadidas |

Verificado como correcto por la revisión: una sola autoridad de lo público
(y `catalogo.publico` retirado sin referencias), bloqueos en los dos sentidos,
sin N+1, monedas separadas, reseñas sin inventar, guardar idempotente, las dos
puertas, el cursor atado a su orden, la 0091 y el orden del historial.

### Validación final

| Comprobación | Resultado |
|---|---|
| Backend **con** PostgreSQL (0001–0091 desde cero) | **3981 pasan**, 0 fallan, 0 omitidas (18 min 24 s). La prueba de la 0091 que exige el título se añadió después y pasa (11 de 11 en su fichero) |
| Backend **sin** PostgreSQL | **2962 pasan**, 1019 omitidas (las que necesitan la base), 0 fallan (9 min 26 s) |
| Móvil, árbol real (CRLF) | **3434 de 3434**, salida 0 |
| `tsc --noEmit` | limpio |
| Expo Doctor | **18 de 18** |
| Exportación web | correcta; las rutas nuevas están en el paquete |
| Paridad de textos es / en / pt | la vigila `diccionariosSincronizados.test.mts` (verde) |
| Rutas de la API | **499** (método y ruta), **ninguna duplicada**; 66 de Servicios |
| `git diff --check` | limpio |
| Secretos en el diff | ninguno |
| Escrituras directas del móvil a Supabase | ninguna |
| Migraciones 0086–0090 | sin tocar (las pruebas vigilan su huella git) |
| Cursos, Eventos, Productos, Explorar, Incrementos 1 y 2 | verdes en las suites completas |
| `FEATURE_SERVICES` | **apagada** por defecto |
| Código | en `Edson`, **sin desplegar** (sin push, PR ni merge) |

## 47. Riesgos de integración

- **La 0091 sin aplicar**:
  - Si se despliega el código antes, todo el descubrimiento funciona salvo
    guardar (503 controlado).
  - Si se aplica después, **hay que reiniciar la API**.
- **Categorías inactivas**: desde este incremento, desactivar una categoría
  **saca del público** sus servicios publicados. Es la regla pedida: quien lo
  ofrece lo ve como «no visible» y la confirmación de administración lo avisa,
  pero no hay aviso a la prestadora ni recuento previo (D13).
- **C15, AMPLIADO.** Con el catálogo público, cada tarjeta, también sin
  sesión, lleva en la URL firmada de su portada la ruta
  `<perfil>/<servicio>/…`. Quien recorra el catálogo puede enlazar cada
  prestador con el identificador de su perfil social. Hoy no hay archivos
  (0 en `service-media`): **conviene decidir una ruta opaca antes de encender
  Servicios** (D6).
- **El rollback de la 0091** exige reiniciar la API (lo dice el fichero).
- **Rendimiento de la búsqueda**:
  - `LIKE` con comodines no usa índices. Con el volumen de hoy es inmediato.
  - Si el catálogo crece mucho, el siguiente paso es un índice de trigramas
    (la 0040 ya instala `pg_trgm`) en una migración nueva. No hace falta
    ahora.
- **Relevancia y cursor**: si el contenido de un servicio cambia entre dos
  páginas (se publica una versión nueva), su puntuación puede cambiar. Nunca
  se duplica en pantalla, porque el móvil junta sin repetir; lo peor es que
  una tarjeta cambie de sitio. Con «recientes» y por precio no pasa.
- **El push** sigue sin llevar al destino (§32), igual que antes.

## 48. Punto exacto para empezar el Incremento 4

**No se empezó el Incremento 4.** Antes, una persona tiene que:

1. **Aplicar la 0091** y verificarla (§44–§45); reiniciar la API.
2. Desplegar `Edson` cuando se apruebe y **hacer el QA físico** de los
   Incrementos 1, 2 y 3.
3. Decidir al menos **C1** (categorías iniciales) y **C5** (monedas y
   países), que siguen de §31; **D1–D4** y **D13**; y **C15** (D6), esta
   última antes de encender Servicios.
4. Antes de los avisos de reservas, que el push de la cola **lleve su
   destino** (§32, «Navegación de los avisos»): hoy solo abre la app.

El Incremento 4 (disponibilidad y reservas) parte de:
- un servicio **público** según `condiciones_publicas()`;
- su ficha, como punto de entrada para reservar;
- y el hueco que la ficha deja para la barra de reserva.

Todo lo de reservas, agenda y pago sigue sin tabla, ruta ni pantalla.
