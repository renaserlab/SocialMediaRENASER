# Z Servicios: admisión de prestadores (Incremento 1), catálogo (Incremento 2), descubrimiento (Incremento 3), agenda (Incremento 4) y reserva (Incremento 5)

Qué se construyó, qué impone la base, qué se decidió en cerrado y qué sigue
esperando a una persona. La Parte I se escribió el 29/09/2026 al cerrar el
Incremento 1 en la rama `Edson`; la **Parte II** (§18 en adelante), el mismo
día, con el Incremento 2 implementado y probado; la **Parte III** (§33 en
adelante), también ese día, con el Incremento 3 implementado y probado; y la
**Parte IV** (§50 en adelante), el 30/09/2026, con el Incremento 4
implementado y probado y, ese mismo día, técnicamente cerrado con la 0092
aplicada y verificada (§61); y la **Parte V** (§62 en adelante), también el
30/09/2026, con el Incremento 5 implementado y probado y, tras ejecutarse la
0093 a mano y verificarse el 01/10/2026 (02:13 UTC), **técnicamente cerrado**
(§80).

## Estado

| | |
|---|---|
| **Incremento 1** | **técnicamente cerrado; únicamente queda pendiente el QA físico** (§16). Admisión completa del prestador: condiciones versionadas, borrador, documentos privados, credenciales, envío, revisión, correcciones, reenvío, aprobación, rechazo, suspensión y retirada |
| **Migraciones 0086, 0087 y 0088** | **APLICADAS** en Supabase y verificadas en sesión de solo lectura con **cero divergencias** (la 0088, el 29/09/2026: §9). Son históricas: no se editan |
| **Migración 0089** (plataforma) | **APLICADA** en Supabase y verificada en solo lectura el 29/09/2026: **sin divergencias** (`Z_BAJA_DE_CUENTA.md` §15). Hace que borrar la cuenta funcione sin borrar la historia (§12) |
| **`FEATURE_SERVICES`** | **apagada.** Todas las rutas contestan 503 `services_disabled` sin mirar la base |
| **Incremento 2 (catálogo)** | **técnicamente cerrado; únicamente queda pendiente el QA físico** (§32) |
| **Migración 0090** | **APLICADA** en Supabase el 29/09/2026 y verificada ese día en solo lectura: **sin divergencias** (§32). La puerta de esquema, con el rol real de la API, la reconoce. Ya es histórica: no se edita |
| **Incremento 3 (descubrimiento y confianza)** | **técnicamente cerrado; únicamente queda pendiente el QA físico** (§49). Catálogo público, búsqueda, filtros, orden, perfil público del prestador, señales de confianza, guardados y sugerencias con su razón |
| **Migración 0091** | **APLICADA** a mano en Supabase y verificada el 29/09/2026 en solo lectura: **sin divergencias** (§49). La puerta de esquema, con el rol real de la API, la reconoce. Ya es histórica: no se edita |
| **Incremento 4 (disponibilidad y agenda)** | **técnicamente cerrado; únicamente queda pendiente el QA físico** (§61). Agenda por servicio, semana, excepciones, bloqueos privados y horarios calculados por el servidor |
| **Migración 0092** | **APLICADA** a mano en Supabase y verificada el 30/09/2026 en solo lectura: **sin divergencias** (§61). La puerta de esquema, con el rol real de la API, la reconoce. Ya es histórica: no se edita. Al desplegar `Edson`, reiniciar la API |
| **Incremento 5 (reserva y contratación)** | **técnicamente cerrado; únicamente queda pendiente el QA físico** (§80). Retener, resumen, condiciones versionadas, confirmar lo gratuito, mis reservas, la bandeja del prestador y la supervisión |
| **Migración 0093** | **APLICADA** a mano en Supabase y verificada el 01/10/2026 (02:13 UTC) en solo lectura: **sin divergencias** (§80). Las cinco puertas de esquema, con la conexión y el rol reales de la API, la reconocen. Ya es histórica: no se edita. El código que la usa está en `Edson`, **sin desplegar**: producción todavía no la conoce |
| **Pagos** | **no existen**: solo se contrata lo gratuito; lo que tiene precio se detiene sin cobrar y la base no admite un pedido con precio (§68). `FEATURE_SERVICE_BOOKING` y `FEATURE_SERVICE_PAYMENTS`, **apagadas**; la pasarela, `none`. Los pagos de la plataforma siguen **apagados** |
| **Bloqueo para encender** | **Resuelto** (§12): la 0089 aplicada y verificada, y `DELETE /auth/me` corregido en `Edson` |
| **Código** | En la rama `Edson`, **sin desplegar**: sin push, PR ni merge. La API de producción sigue con el backend anterior |
| **QA físico** | pendiente de los cinco incrementos: `docs/Z_QA_FISICO_PENDIENTE.md`, sección de Servicios |

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

Escrito el 29/09/2026 en la rama `Edson`. **Técnicamente cerrado ese mismo
día (§49): la 0091 aplicada y verificada sin divergencias; únicamente queda
pendiente el QA físico.**

## 33. Estado del Incremento 3

| | |
|---|---|
| **Qué hace** | Cualquiera descubre servicios desde Explorar. Puede: <ul><li>buscarlos por lo que necesita;</li><li>filtrarlos y ordenarlos;</li><li>abrir su ficha y conocer al prestador, con lo que Z comprobó de él;</li><li>guardarlos para después.</li></ul>Las sugerencias llevan su razón. Termina **antes** de reservar o contratar |
| **Migración 0091** | **APLICADA** a mano en Supabase y verificada el 29/09/2026 en solo lectura, **sin divergencias** (§49). Solo crea `saved_services`. Pasos y verificación: §44–§45 |
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

La **puerta de la 0091** (`esquema.hay_guardados`) exige, por
**definición** y no por nombre (desde el cierre, §49):
- la tabla con las columnas del modelo, **sus tipos**, `NOT NULL` y, en
  `created_at`, `now()` (guardar no la manda: sin ese valor sería un 500);
- la clave primaria `(profile_id, service_id)`;
- las **dos** claves ajenas en cascada y validadas, una a `profiles` y otra
  a `services`;
- la comprobación del título entre 1 y 300, validada;
- sus dos índices con sus columnas y su orden: btree, no únicos, sin
  condición, válidos y listos;
- RLS sin políticas;
- y ni `anon` ni `authenticated` (tampoco por PUBLIC) con permisos
  efectivos, en la tabla o en una columna.

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

**Hecho el 29/09/2026** (§49): se ejecutó a mano y se verificó sin
divergencias. Los pasos quedan como referencia para otra base.

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

- **La 0091**: aplicada y verificada (§49). La API de producción todavía no
  tiene este código; al desplegar `Edson` se reinicia y la puerta la ve. En
  cualquier otra base sin ella, todo funciona salvo guardar (503
  controlado), y al aplicarla **hay que reiniciar la API**.
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

**El Incremento 4 se implementó el 30/09/2026 (Parte IV, §50).** Lo que
sigue es lo que se pedía antes de empezarlo; lo que falta de ello sigue en
pie. Antes, una persona tenía que:

1. ~~Aplicar la 0091 y verificarla~~ **Hecho el 29/09/2026** (§49, sin
   divergencias). Queda desplegar `Edson` cuando se apruebe: el despliegue
   reinicia la API y la puerta ve la 0091.
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

## 49. Cierre técnico del Incremento 3 (29/09/2026)

**La 0091 se ejecutó a mano en Supabase el 29/09/2026** y se **verificó ese
mismo día** (23:03 hora de Lima, 04:03 UTC del 30/09) **sin divergencias**. No
se volvió a ejecutar, no se tocó el fichero y no se escribió ningún dato en
Supabase.

### La verificación, en solo lectura

El verificador de la 0090, adaptado a la 0091, abre dos sesiones sobre
Supabase:
- **catálogos** (psycopg): `BEGIN READ ONLY`; `transaction_read_only = on` y
  una sonda de escritura (`create temp table`) **rechazada con 25006** antes
  de consultar nada; al terminar, sigue en solo lectura, **sin id de
  transacción de escritura**, y `ROLLBACK`;
- **la de la API**: la misma `DATABASE_URL`, asyncpg y el pool de
  `app/shared/database.py`; `SET TRANSACTION READ ONLY` como primera
  sentencia, la misma sonda rechazada y `ROLLBACK`.

La URL sale del fichero de secretos autorizado y nunca se imprime.
Referencia: prólogo + 0001–0091 sobre PostgreSQL 17 local desechable
(Supabase: 17.6).

| Comprobación | Resultado |
|---|---|
| Esquema público entero frente a la referencia (1587 columnas, 1188 restricciones, 503 índices, 75 disparadores, 50 funciones, 154/154 tablas con RLS, 149 políticas) | **igual**: la 0001–0090 siguen intactas |
| `saved_services` | tabla normal y permanente, propietaria `postgres` (también su tipo y sus índices), RLS activa, **0 políticas** |
| Columnas | `profile_id uuid`, `service_id uuid`, `title_at_save text`, `created_at timestamptz default now()`; las cuatro `NOT NULL`, en ese orden |
| Clave primaria | `(profile_id, service_id)`, válida |
| Claves ajenas | a `profiles(id)` y a `services(id)`, `ON DELETE CASCADE`, validadas y no diferibles |
| Título | `saved_services_titulo`: entre 1 y 300 caracteres sin contar espacios de los extremos, validada |
| Índices | `saved_services_mios (profile_id, created_at desc, service_id desc)` y `saved_services_del_servicio (service_id)`: btree, no únicos, sin condición, válidos y listos |
| Disparadores | solo los internos de las dos claves ajenas, como en la referencia |
| Permisos de PUBLIC, `anon` y `authenticated` | **ninguno**: ni declarados (en la tabla o en una columna) ni efectivos. Con permisos, solo `postgres` y `service_role` (la clave del servidor) |
| Datos de `saved_services` | 0 filas; 0 títulos nulos, vacíos o fuera de 1–300; 0 sin perfil o sin servicio; 0 duplicados |
| Integridad de `public` | 334 claves ajenas: 0 filas huérfanas, 0 sin validar |
| Lo que escribió la transacción de la 0091 | una sola transacción; en el catálogo, solo `saved_services`, sus índices, sus restricciones, su TOAST y los disparadores internos de sus claves, igual que en la referencia; **ninguna fila de datos** en las 189 tablas de public, auth y storage |
| Modelo `SavedService` del backend | igual: columnas, tipos, nulabilidad, `now()`, claves ajenas, clave primaria, CHECK e índices |
| §45, ejecutado tal cual | los nueve resultados esperados |

El verificador se ensayó antes contra la referencia local (sin divergencias)
y contra la referencia estropeada a propósito (un permiso a `anon`,
`created_at` sin `now()`, un índice parcial y una política): las detectó
todas y la puerta dijo que no.

### La puerta de esquema, con la conexión y el rol de la API

El rol es `postgres`: **no** superusuario, con BYPASSRLS. En un proceso nuevo
la memoria de la puerta empieza **vacía**, y el código real dice **sí** a las
tres (`hay_admision`, `hay_catalogo`, `hay_guardados`) y lo recuerda.

**Corregido en el cierre.** La puerta de la 0091 miraba en parte nombres
(§41): no la nulabilidad, ni el `now()` del que depende guardar, ni el
título, ni la definición de los índices, ni las políticas, ni los permisos.
Ahora mira definiciones y permisos. Lo que la cierra, con el mismo código y
PostgreSQL 17 local (`test_la_puerta_de_los_guardados_mira_lo_que_hace_falta`):

| Caso | Puerta |
|---|---|
| la 0091 completa; y también con `service_role` con permisos o tras un `CLUSTER` | sí |
| la tabla o una columna que falta; una columna de otro tipo o nulable; `created_at` sin `now()` | no |
| la clave primaria que falta o en otro orden; una clave ajena a la misma tabla que la otra, con otra acción o sin validar | no |
| la comprobación del título que falta, con otro límite o sin validar | no |
| un índice que falta, en otro orden, con otras columnas, parcial, único, de otro tipo (hash) o no válido | no |
| RLS apagada, o con una política | no |
| un permiso para `anon`, `authenticated` o PUBLIC, en la tabla o en una columna | no |
| un **error al mirar** | 503 `services_not_ready` al guardar y en la lista, **nunca 500**; no se recuerda y, en cuanto deja de fallar, responde sin reiniciar (`test_un_error_al_mirar_la_0091_es_503_y_no_se_recuerda`) |

**Mutaciones:** 17 nuevas (G1–G13 y G16–G19) y las tres anteriores que tocan
la puerta (M14, R7, R8): **20 de 20 en rojo**, cada una en su caso roto y
ninguna en el control positivo, así que ninguna prueba es tautológica. Tres
primeras versiones sobrevivieron y resultaron **equivalentes**: una
comprobación sin validar ya no coincide por su propia definición («NOT
VALID»), y lo concedido a PUBLIC ya lo ve el permiso efectivo de `anon` (todo
rol tiene lo de PUBLIC). Se quitaron esas tres condiciones redundantes y la
G5 pasó a retirar la protección de verdad.

### El recorrido local, con la API reiniciada de verdad

La API real, en su propio proceso (uvicorn) y **sin `dependency_overrides`**:
tokens HS256 de verdad firmados con un secreto de usar y tirar,
`FEATURE_SERVICES` encendida **solo en ese proceso** y PostgreSQL 17 local
desechable. Lo único sustituido es Supabase Storage, por el almacén en memoria
de las pruebas. Nada tocó Supabase. **63 de 63 comprobaciones verdes:**

1. Con 0001–0090, sin la 0091: la admisión real, el catálogo y la
   publicación por el flujo real. El catálogo responde y **guardar, quitar y
   la lista contestan 503 `services_not_ready`**.
2. Se aplica la 0091 a esa base: **la misma API sigue en 503**. Recuerda el
   «no», y su registro lo dice una sola vez.
3. **Se reinicia la API** (un proceso nuevo): guardar responde 200.
4. Con la API reiniciada:
   - el catálogo público, sin nada privado y con las portadas firmadas;
   - la búsqueda con y sin tildes, con mayúsculas y con espacios de más;
   - los filtros: gratis, a consultar, rangos en soles, modalidad, zona,
     categoría madre con su hija y credencial;
   - el orden por precio y por recientes, y el cursor de a dos sin repetir
     ni saltar;
   - la ficha y el perfil con la confianza real (admisión, identidad y
     credencial) y las reseñas en 0 con media `null`;
   - guardar dos veces y quitar dos veces (200 y 200), y la lista;
   - un guardado que se suspende queda «no disponible» con su título; lo
     retirado y lo de una categoría desactivada salen del catálogo (y quien lo
     ofrece lo ve «no visible»);
   - los bloqueos en los dos sentidos;
   - las sugerencias con su código de razón;
   - y el aislamiento entre personas.

Ningún 500 ni ninguna traza en los registros de las dos API.

### Registrada como aplicada

La huella git de la 0091 (`d867002…`) entró en `APLICADAS`
(`test_servicios_migracion_0090.py`), igual que la 0090: añadir un solo
espacio al fichero pone roja la prueba. Su cabecera sigue diciendo «SIN
APLICAR» a propósito: cambiarla sería editar lo aplicado (§26).

### Pruebas y validación del cierre

| Comprobación | Resultado |
|---|---|
| Verificación de la 0091 en Supabase | **sin divergencias** |
| Puerta real con el rol de la API | **sí**, las tres |
| Recorrido local con la API reiniciada | **63 de 63** |
| Servicios con PostgreSQL 17 (todos los `test_servicios_*`) | **358 pasan**, 0 fallan |
| Servicios sin PostgreSQL | 199 pasan, 159 omitidas (las que necesitan la base), 0 fallan |
| Backend completo **con** PostgreSQL 17 (0001–0091 desde cero) | **3983 pasan**, 0 fallan, 0 omitidas (13 min 43 s) |
| Backend completo **sin** PostgreSQL | **2963 pasan**, 1020 omitidas (las que necesitan la base), 0 fallan (7 min 37 s) |
| Móvil del Incremento 3 (descubrimiento, vistas, catálogo y diccionarios) | **141 de 141** (sin cambios en el móvil) |
| `tsc --noEmit` | limpio |
| Rutas de la API | 499, **ninguna duplicada** |
| `git diff --check` | limpio |
| Mutaciones de la puerta | **20 de 20** |
| `FEATURE_SERVICES` | **apagada** |
| Código | en `Edson`, **sin desplegar** (sin push, PR ni merge) |

### Estado

- **Incremento 3 técnicamente cerrado. Únicamente queda pendiente el QA
  físico** (`Z_QA_FISICO_PENDIENTE.md`, «Incremento 3»).
- `FEATURE_SERVICES` sigue **apagada**, y **no hubo despliegue**.
- **C15** sigue pendiente, y conviene decidirla **antes de encender**
  Servicios (D6).
- El **push** de un aviso todavía no lleva al destino (§32).
- **No se empezó el Incremento 4** (§48).

# Parte IV · Incremento 4: disponibilidad y agenda del prestador

Escrito el 30/09/2026 en la rama `Edson`, con el Incremento 4 implementado y
probado y la 0092 sin aplicar. Ese mismo día la 0092 se aplicó a mano en
Supabase, se verificó en solo lectura (también con el rol real de la API), se
registró como aplicada y se repitió el recorrido de cierre: **técnicamente
cerrado; únicamente queda pendiente el QA físico** (§61). Lo que sigue de
§50 a §60 describe el incremento; donde decía «sin aplicar», manda §61.

## 50. Estado del Incremento 4

| | |
|---|---|
| **Qué hace** | Un prestador activo configura, para cada servicio, cuándo lo ofrece: zona horaria, semana, excepciones de fecha, bloqueos, preparación, descanso e intervalo. Una persona consulta fechas y horarios reales, calculados por el servidor. Termina al enseñar un horario |
| **Migración 0092** | **APLICADA** a mano en Supabase el 30/09/2026 y verificada ese día en solo lectura, **sin divergencias** (§61) |
| **Sin la 0092** | Las 14 rutas nuevas contestan **503 `services_not_ready`**, sin escribir nada; la ficha no enseña la sección de disponibilidad y el servicio propio no ofrece la agenda. Los Incrementos 1–3 siguen igual |
| **`FEATURE_SERVICES`** | **apagada.** Con ella apagada, las 14 rutas contestan 503 `services_disabled` sin mirar la base |
| **Reservas, retenciones, dinero** | **ninguno.** Ninguna tabla, ruta ni pantalla del incremento crea una reserva, una retención, un pedido o un cobro (§54) |
| **Código** | En `Edson`, **sin desplegar**: sin push, PR ni merge. Al desplegarlo, **reiniciar la API de producción** (la puerta recuerda el «no») |
| **QA físico** | **pendiente**: `Z_QA_FISICO_PENDIENTE.md`, «Incremento 4». Es lo único que falta |
| **Incremento 5** | **no se empezó** |

## 51. El modelo (5 tablas, 0092)

**La agenda es del servicio.** `services` es la identidad estable (0090):
editar la descripción abre una versión nueva y no toca ni una regla. Lo que sí
vive en la versión —duración, modalidad y capacidad— se lee de la **publicada**
cada vez que se calculan horarios (en la vista previa, de la que se prepara si
aún no hay publicada). Así, publicar una versión con otra duración cambia los
horarios sin reescribir la agenda, y nada de la agenda depende de qué versión
se edite. Se descartó colgarla del prestador (una empresa ofrece servicios con
duraciones y horarios distintos) y de la versión (cada edición la destruiría).

| Tabla | Para qué |
|---|---|
| `service_schedules` | Una por servicio: zona IANA, `active`/`paused`, preparación y descanso (0–240 min, de 5 en 5) e intervalo entre inicios (opcional) |
| `service_schedule_rules` | La semana: día ISO (1–7), franja en minutos del día LOCAL (de 5 en 5, hasta 1440 = 24:00), modalidad, capacidad y activa |
| `service_schedule_exceptions` | Una FECHA local: `closed` (sin franja, el día entero; con franja, esa franja), `extra` (añade) o `replace` (sustituye la semana ese día). Solo lo que abre lleva modalidad y capacidad |
| `service_schedule_blocks` | Un intervalo REAL (`timestamptz`) con motivo PRIVADO (1–200). Cambiar la zona no lo mueve |
| `service_schedule_events` | El historial: 10 acciones, actor sin clave ajena (S10), detalles sin el motivo, `Idempotency-Key` única por servicio. Solo se añade |

**Lo que impone la base**:
- las CHECK de forma (zona «Área/Lugar» sin `Etc/`, franjas, rejilla,
  capacidad, tipos, estados), con `is not null` escrito donde un nulo
  dejaría pasar la regla;
- **dos restricciones de exclusión**, que son la autoridad de los cruces:
  - dos reglas **activas** del mismo servicio y día no se pisan (tocarse sí:
    09–12 y 12–15);
  - dos excepciones de la misma fecha no se pisan, y el día cerrado entero
    ocupa las 24 horas.
- un disparador que valida que la zona **existe** en la base de zonas;
- el historial que no se reescribe (la función de la 0090);
- el borrado de la agenda y su historial solo en cascada con el servicio (la
  función de la 0086).

**Por qué exclusiones y no una comprobación en el código.** Una restricción de
exclusión vale con cualquier aislamiento y sin cerrojos: dos escrituras a la
vez no pueden dejar dos franjas cruzadas. Necesita `btree_gist` (comparar el
servicio y el día con `=` dentro del índice GiST), que Supabase ofrece y la
0092 crea en `extensions`, como `pg_trgm` en la 0040. El código no vuelve a
comprobar cruces: traduce el error de la base (`23P01`) a un 409. Además, cada
escritura bloquea primero la fila del servicio, así que dos altas cruzadas
llegan en fila y la segunda recibe el 409 limpio (sin cerrojo, PostgreSQL
puede resolver la carrera con un interbloqueo en vez de una violación; la
prueba de dos conexiones lo documenta).

**Lo que no se guarda**: los horarios. Se calculan al pedirlos (§52). No hay
reservas, retenciones ni «slots» materializados.

## 52. El cálculo: una sola autoridad

`agenda_calculo.py` es una función pura, sin base de datos, y la **única**
que:

- **convierte zonas**: `zoneinfo` con la base `tzdata`, fijada en
  `requirements.txt` para que Windows y el contenedor calculen con la misma.
  Nunca se suma un desplazamiento a mano;
- **decide las franjas de una fecha**, con esta **precedencia**:
  1. lo que **cierra** gana siempre: un bloqueo, una fecha cerrada entera o
     una franja cerrada;
  2. las **excepciones de esa fecha**: `replace` sustituye la semana ese día;
     `extra` añade solo lo que el día no tenía;
  3. la **regla semanal** de ese día;
  4. la **configuración general**: duración, preparación, descanso,
     intervalo, antelación y horizonte;
- **genera los horarios**: cada uno ocupa preparación + duración + descanso, y
  ese bloque ENTERO cabe en su franja y no toca un cierre ni un bloqueo. Sin
  intervalo propio van uno detrás de otro (09:00–12:00, 60 min y 15 de
  descanso: **09:00 y 10:15**, nunca 11:00 ni 11:30). Con intervalo, son
  inicios alternativos. La rejilla sale del inicio de la franja y no se mueve
  por un bloqueo;
- **calcula la capacidad teórica**: la de la franja, nunca más que la de la
  versión (individual: una). No se descuenta nada.

**Zonas horarias.** La agenda guarda su zona IANA; la semana y las
excepciones son horas locales; los bloqueos, instantes UTC. La API recibe
fechas «AAAA-MM-DD» y horas «HH:MM» locales de la agenda, y devuelve cada
horario con su instante UTC, su fecha y horas locales y su desplazamiento.
- **Horario de verano**: una hora local que no existe (el reloj salta) se
  lleva al primer instante que sí existe; una que se repite es la primera
  vez. Los horarios se cuentan en tiempo real desde el inicio de la franja:
  en la noche del salto, una franja de 00:00 a 04:00 da 00:00, 01:00 y 03:00;
  en la del retroceso, cinco, con dos «01:00» y su desplazamiento. Perú no
  tiene horario de verano; se prueba con Nueva York.
- **Medianoche**: una franja termina como tarde a las 24:00 (el día
  siguiente a las 00:00) y un horario pertenece al día en que empieza.
- **Cambiar la zona** de una agenda con semana o excepciones exige
  `confirm_timezone_change` (409 `service_schedule_timezone_unconfirmed` sin
  él); los bloqueos conservan su instante.

**Antelación y horizonte** (`agenda_politica.Politica`): 120 minutos y 60 días,
los provisionales del documento de reglas (4.5 y 4.6), configurables por
entorno. Son los únicos números de negocio; los demás límites son técnicos y
viven en `agenda_politica.py` (y en las CHECK de la 0092, comparadas con ellos
por una prueba).

## 53. Quién puede qué, y lo público

- **El dueño** del servicio, con prestador **activo** y servicio **no
  retirado**, escribe. Un **borrador** puede preparar su agenda. Un prestador
  suspendido la ve (`can_edit: false`) y no la cambia (403
  `service_provider_not_active`); un servicio retirado, 409 `service_retired`.
- **Lo ajeno es 404** (`service_not_found`), también para moderación y
  administración: no hay panel de agendas ajenas (el blueprint lo pide para
  las reservas, A04, que no existen).
- **El servicio propio dice si puede preparar su agenda**
  (`can_manage_schedule` en `ServicioPrivadoRead`, campo nuevo y opcional):
  prestador activo, no retirado y la 0092 en la base. La app no enseña la
  entrada sin él.
- **Lo público** solo sale de un servicio que cumple `condiciones_publicas()`
  (vía `descubrimiento.publico`, con los bloqueos entre personas), con agenda
  **activa**, en la modalidad de la versión publicada, desde «ahora +
  antelación» hasta el horizonte. Si deja de ser público, su disponibilidad
  es el mismo 404. Nunca salen reglas, excepciones, bloqueos, motivos,
  identificadores internos ni por qué no hay horarios (`issues` va vacío en lo
  público; solo la vista previa del prestador lo trae).
- **El motivo de un bloqueo** solo aparece en la agenda del propio prestador:
  ni en lo público, ni en el historial (el registro lo impide), ni en la
  auditoría, ni en un aviso, ni en un error.

## 54. La API (14 rutas) y la puerta

| Ruta | Qué hace |
|---|---|
| `GET /services/provider/services/{id}/schedule` | La agenda entera, con lo que falta para que el público vea horarios (`issues`), el próximo horario y los límites |
| `PUT …/schedule` | Crearla (201) o sustituir su configuración (200). Igual dos veces, un solo evento |
| `POST …/schedule/rules` · `PATCH`/`DELETE …/rules/{r}` | La semana. Alta con `Idempotency-Key` |
| `POST …/schedule/exceptions` · `PATCH`/`DELETE …/exceptions/{e}` | Las excepciones. Alta con `Idempotency-Key` |
| `POST …/schedule/blocks` · `DELETE …/blocks/{b}` | Los bloqueos. Alta con `Idempotency-Key` |
| `GET …/schedule/preview` · `GET …/preview/{fecha}` | Lo que vería una persona, aunque el servicio no sea público, con sus `issues` |
| `GET /services/catalog/{id}/availability` | Fechas con horarios (de 31 días en 31, dentro del horizonte) y el próximo |
| `GET /services/catalog/{id}/availability/{fecha}` | Los horarios de una fecha, paginados por cursor (48 por página, 96 como mucho) |

Cada escritura devuelve la agenda entera recién leída. Códigos estables (y con
texto en la app): `service_schedule_missing`, `…_timezone_invalid`,
`…_timezone_unconfirmed`, `…_settings_invalid`, `…_time_invalid`,
`…_exception_invalid`, `…_modality_invalid`, `…_capacity_invalid`,
`…_overlap`, `…_date_invalid`, `…_block_invalid`, `…_limit_reached`,
`…_item_not_found`, `…_block_in_use` (reservado para el Incremento 5: el
guardia `_contrataciones_que_protege` devuelve cero porque no hay
contrataciones), `service_availability_range_invalid`, `…_out_of_horizon` y
`…_modality_invalid`.

**Ninguna ruta crea una reserva.** Una prueba cuenta las filas de `bookings`,
`orders`, `entitlements`, `event_orders`, las retenciones de eventos, los
pedidos de productos, pagos, transferencias y devoluciones antes y después de
todo el recorrido: no cambian.

**La puerta de la 0092** (`esquema.hay_agenda`) mira por DEFINICIÓN, con
identificadores y no con nombres escritos (no depende del `search_path`):
- cada columna con su tipo y su NOT NULL, y ninguna de más;
- las claves primarias y las cinco ajenas en cascada, validadas;
- las dos exclusiones **tal cual**, y las 18 CHECK validadas;
- los cinco índices por su definición (el de la clave, único y parcial), y
  TODOS los de las cinco tablas —también los de las claves primarias y los
  de las exclusiones— válidos, listos y vivos (añadido en el cierre, §61);
- los cuatro disparadores con su función y su forma;
- la función de la zona sin SECURITY DEFINER, con su `search_path` y su
  cuerpo (su huella se calcula sin retornos de carro, por si el editor de
  Supabase los trae);
- `btree_gist`, RLS sin políticas y ningún permiso efectivo para `anon` ni
  `authenticated` (tampoco por PUBLIC) en tabla, columna o función.

Sin la 0092 completa, 503 `services_not_ready`; un error al mirar cierra la
puerta sin recordarlo. **Recuerda el «sí» y el «no» hasta reiniciar: tras
aplicar la 0092 hay que reiniciar la API.**

## 55. Vistas y navegación

Mis servicios › un servicio › **Disponibilidad y agenda** (solo con
`can_manage_schedule`) › ajustes, horario semanal, excepciones, bloqueos y
vista previa. Servicios › ficha › **Disponibilidad** › «Ver horarios» ›
selector de fecha y horarios. Todas con «Atrás» que respeta la pila y un
respaldo a la pantalla de la que se vino. El detalle, en
`Z_MATRIZ_DE_VISTAS.md`.

- **La app no decide**: no calcula horarios ni convierte zonas; pinta la hora
  local que manda el servidor, dice la zona de la agenda y avisa si el
  teléfono está en otra. Los formularios avisan antes de lo evidente con los
  límites que manda el servidor (`limits`).
- **Estados vacíos**: agenda sin configurar, en pausa, sin horarios ese día o
  en esas fechas, fuera de lo consultable y «no disponible ahora» (dejó de
  ser público).
- **Elegir un horario solo lo guarda en la ruta** (`fecha`, `inicio`, `hora`,
  `modalidad`: el contrato `horarioElegidoDesdeRuta` para el Incremento 5).
  No hay botón de reservar, confirmar ni pagar, y se dice que el horario no
  queda apartado. Ningún texto dice «reservado», «confirmado» ni «último
  cupo» (lo vigila una prueba).
- Textos en es, en y pt con las mismas claves y los mismos huecos.

## 56. Cómo aplicar la 0092

1. Comprobar que la base tiene la 0086–0091 (la 0092 se niega sin ellas) y
   que ofrece `btree_gist` (`select * from pg_available_extensions where
   name = 'btree_gist'`; Supabase la ofrece).
2. Pegar el fichero ENTERO en el editor SQL de Supabase y ejecutarlo: es una
   sola transacción, comprueba lo anterior antes de crear nada y verifica lo
   que dejó; si algo falla, no queda nada.
3. **Reiniciar la API** (o desplegar `Edson`, que la reinicia): la puerta
   recuerda el «no».
4. Verificar (§57) en una sesión de solo lectura.
5. Registrar su huella en `APLICADAS` (`test_servicios_migracion_0090.py`),
   como la 0090 y la 0091, y repetir el recorrido de cierre.

**Hecho el 30/09/2026** (§61): pasos 2, 4 y 5 en Supabase; el 3, en la API
local del recorrido. La de producción corre el backend anterior y se
reiniciará al desplegar `Edson`.

**Rollback**: el que dice la cabecera del fichero (borra la agenda de cada
servicio; nada más depende de ella) y reiniciar la API.

## 57. Verificar la 0092 (solo lectura)

En una transacción `BEGIN READ ONLY`, tras comprobar que una escritura se
rechaza, y terminando con `ROLLBACK`:

```sql
-- 1. La puerta, con el rol de la API: tiene que decir true.
--    (la consulta de esquema.hay_agenda, _LO_QUE_NECESITA_LA_AGENDA)
-- 2. Las cinco tablas, con RLS y sin políticas.
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as politicas
  from pg_class c
 where c.oid in ('public.service_schedules'::regclass, 'public.service_schedule_rules'::regclass,
                 'public.service_schedule_exceptions'::regclass, 'public.service_schedule_blocks'::regclass,
                 'public.service_schedule_events'::regclass);
-- 3. Las dos exclusiones, tal cual.
select conrelid::regclass, conname, pg_get_constraintdef(oid)
  from pg_constraint where contype = 'x' and conname like 'service_schedule_%';
-- 4. Nadie de fuera con permisos (tiene que dar 0 filas).
select table_name, grantee, privilege_type from information_schema.table_privileges
 where table_schema = 'public' and table_name like 'service_schedule%'
   and grantee in ('anon', 'authenticated', 'PUBLIC');
-- 5. btree_gist y la función de la zona.
select extname, extnamespace::regnamespace from pg_extension where extname = 'btree_gist';
select proname, prosecdef, proconfig from pg_proc where proname = 'servicios_agenda_zona_valida';
-- 6. Vacías recién aplicada.
select (select count(*) from public.service_schedules) as agendas,
       (select count(*) from public.service_schedule_events) as eventos;
```

Y comparar el esquema entero con una referencia local 0001–0092, como en §49.

## 58. Pruebas, mutaciones y revisión (30/09/2026)

### Pruebas nuevas

| Fichero | Qué comprueba | Casos |
|---|---|---|
| `test_servicios_agenda_calculo.py` | Zonas válidas y no (`UTC-5`, `Etc/GMT+5`…); horas de 5 en 5 y 24:00; Lima UTC−5 todo el año; horario de verano de Nueva York (hora que no existe y que se repite; las dos noches del cambio); el ejemplo de 09–12 con 60 + 15 → 09:00 y 10:15; preparación; intervalo; 300 configuraciones al azar sin bloques fuera de su franja ni solapados; capacidad; modalidad; cada tipo de excepción y su precedencia; bloqueos (también contra la separación y cruzando la medianoche); antelación; horizonte; semanas que cruzan mes y año; el próximo horario; unir y buscar igual que uno por uno; el coste del peor caso; fechas extremas; las 24:00 de Santiago | **49** |
| `test_servicios_migracion_0092.py` | Última y tras la 0091; una transacción que comprueba antes de crear; sin permisos, borrados ni otras tablas; `btree_gist` como única extensión; sin reservas ni dinero; sus límites son los de la política; cerrada (RLS, políticas, permisos también de columna y de función); **igual al ORM por definición** (el ORM creado en otro esquema); cruces en serie y **con dos conexiones a la vez**; datos imposibles (incluido el hueco del nulo); la zona; el historial; la cascada; sobre la 0091 con datos; reejecutarla; fallo a mitad; incompleta; sin la 0091 | **18** |
| `test_servicios_agenda_api.py` | El recorrido del prestador en un borrador; la semana; las excepciones y su precedencia; el bloqueo privado; la clave repetida; el cambio de zona; lo público (campos, límites, 422 estables, cursor); pausa, sin agenda, suspendido, prestador suspendido, categoría, bloqueo entre personas; lo ajeno (otro prestador, sin prestador, administración, moderación) y sin sesión; prestador suspendido y servicio retirado; **carreras reales** (reglas, excepciones, misma clave ×4, crear y retirar a la vez, consultar mientras se edita); ninguna reserva ni dinero; la puerta (27 alteraciones y sus controles), un error al mirarla, sin la 0092, bandera apagada; los hallazgos de la revisión | **27** |
| `serviciosAgenda.test.mts` | Valores y códigos iguales al servidor; el repositorio pide exactamente las 14 rutas; claves en tres idiomas con los mismos huecos; ningún texto de reserva, cupo ni pago; formularios con los límites del servidor; fechas sin zonas; la hora repetida del cambio; el horario elegido solo como valor de la ruta | **17** |
| `serviciosAgendaVistas.test.mts` | Cada vista con ruta y alcanzable; el acceso solo con `can_manage_schedule`; «Atrás»; la ficha sin sección si falla; cargas, errores, cerrojo, claves; estados vacíos; nada de reservas ni zonas en el teléfono; el motivo solo en bloqueos; sin escrituras directas; accesibilidad; textos | **33** |

También se actualizaron, sin cambiar lo que vigilan: el inventario de rutas
(`test_servicios_admision_api.py`: 14 más), las tablas y claves de Servicios
(`test_servicios_migracion_0086.py`), el orden de la 0091, la última migración
(`test_migraciones_reales.py`) y las traducciones iguales a propósito.

### Mutaciones

**31 de 31 muertas**. Cada una se aplicó sola, con sus pruebas dirigidas en
verde antes de mutar (ninguna muere por una prueba ya rota), y se restauró el
original siempre. Las pruebas de la base corrieron contra un PostgreSQL 17
desechable aparte.

| # | Mutación | La mata |
|---|---|---|
| M01 | Permitir un cruce: la exclusión de las reglas nunca aplica (`where (active and false)`) | dos reglas activas no se cruzan |
| M02 | Ignorar la separación (preparación y descanso) | el ejemplo de 09–12 con 15 min; 300 configuraciones |
| M03 | Aceptar inicio igual al fin (en el dominio y en la base) | la semana sin franjas imposibles |
| M04 | Ignorar una excepción (el día cerrado entero) | cerrar la fecha entera gana a todo |
| M05 | Exponer el motivo privado de un bloqueo en el historial | el bloqueo es privado |
| M06 | Aceptar una modalidad que el servicio no ofrece | la semana sin franjas imposibles |
| M07 | Saltarse la zona horaria (leer las horas locales como UTC) | Lima UTC−5; «las nueve, antes y después del cambio» |
| M08 | Generar un horario que termina fuera de la franja | 300 configuraciones; el ejemplo |
| M09 | Ignorar la suspensión del servicio | en pausa, sin configurar o no público |
| M10 | Permitir un rango público ilimitado | lo público respeta el horizonte |
| M11 | Permitir una capacidad que el servicio no admite | la semana sin franjas imposibles |
| M12 | Aceptar una escritura duplicada (la clave no se mira) | la misma clave; la misma clave ×4 a la vez |
| M13 | Abrir la puerta con RLS apagada | la puerta de la agenda |
| M14 | Abrir la puerta con un permiso indebido | la puerta de la agenda |
| M15 | Crear una reserva (una fila de `bookings`) al consultar los horarios | nada crea una reserva ni mueve dinero |
| M16 | Ignorar los bloqueos al generar | un bloqueo choca también con la separación |
| M17 | «Sustituir» no sustituye la semana | sustituir la semana ese día |
| M18 | Saltarse la antelación y el horizonte | la antelación; el horizonte |
| M19 | Un prestador suspendido sigue escribiendo | el prestador suspendido ve pero no toca |
| M20 | Un servicio retirado sigue escribiendo | ídem |
| M21 | La consulta pública enseña por qué no hay horarios | lo público solo trae horarios |
| M22 | La puerta no mira la definición de las exclusiones | la puerta de la agenda |
| M23 | El móvil enseña la agenda sin preguntar al servidor | vistas: solo con `can_manage_schedule` |
| M24 | El móvil reserva algo al elegir un horario | vistas: lo público solo lee |
| M25 | El móvil calcula la hora en su propia zona | vistas: ninguna zona en el teléfono |
| M26 | Volver a mirar todos los bloqueos uno por uno (coste) | el peor caso de una consulta pública |
| M27 | Sumar al inicio del rango antes de acotarlo (desborda) | el rango no desborda; fechas extremas |
| M28 | La clave repetida no mira el contenido | la misma clave con otro contenido es 409 |
| M29 | La zona que la base rechaza vuelve a ser un 500 | una zona que la base no conoce es 422 |
| M30 | En pausa se sigue anunciando el próximo horario | en pausa no hay próximo |
| M31 | La puerta no mira la definición de los CHECK | la puerta mira la definición |

**M21 sobrevivió en la primera pasada, y era EQUIVALENTE**: invertía
`con_motivos` en la ruta pública, pero el dominio nunca rellena motivos en la
consulta pública, así que el parámetro no decidía nada. Se quitó la condición
redundante (`d5edbd2`) y la mutación pasó a atacar al dominio, donde muere.

### Revisión independiente

Una revisión de solo lectura, sobre los cuatro primeros commits, dio **12
hallazgos: ninguno bloqueante ni alto**. Cada uno se reprodujo con una prueba
que falla contra el código anterior (11 del backend y 4 del móvil, todas en
rojo) y pasa con la corrección:

| # | Severidad | Hallazgo | Estado |
|---|---|---|---|
| 1 | medio | `from=9999-12-31` desbordaba el calendario: 500 en una ruta pública | corregido: el inicio se acota antes de sumar |
| 2 | medio | Elegir un horario volvía a cargar el selector (y perdía la página) | corregido: la fecha de la ruta solo al entrar |
| 3 | medio | Una respuesta vieja de un día podía pintarse bajo otro y elegirse con su fecha | corregido: solo vale la última petición |
| 4 | medio | 200 bloqueos × 288 inicios × 91 días: 0,24 s de CPU por consulta anónima | corregido: filtrar por día, unir y bisección (12 ms) |
| 5 | bajo | Un bloqueo con fechas extremas desbordaba (500) | corregido: fechas acotadas antes de convertir |
| 6 | bajo | Una zona que tzdata conoce y PostgreSQL no: 500 | corregido: 422 `service_schedule_timezone_invalid` |
| 7 | bajo | En pausa se anunciaba un «próximo horario» | corregido |
| 8 | bajo | La `Idempotency-Key` no iba atada al contenido | corregido: otro contenido es 409; la app renueva la clave al abrir el formulario. El motivo privado no se compara (no está en el historial) |
| 9 | bajo | «24:00» se rechazaba la víspera de un cambio de hora a medianoche | corregido: una hora que no existe va al salto |
| 10 | bajo | Un PATCH arrastraba valores (capacidad nula → 1; `closed` con la modalidad de antes) | corregido |
| 11 | bajo | La puerta no miraba la definición de los CHECK ni los argumentos de los disparadores | corregido |
| 12 | bajo | Cerrar una franja no reanuda la rejilla | **decisión de la empresa** (E12); se documenta, no se cambia |

Además, al redactar los riesgos apareció el 6 por separado, y la batería
completa encontró que la prueba de la última migración seguía en la 0091.

### Validación final

Sobre el código final (`d5edbd2`), el 30/09/2026:

| Comprobación | Resultado |
|---|---|
| Backend completo **con** PostgreSQL 17 (0001–0092 desde cero) | **4079 pasan**, 0 fallan, 0 omitidas (14 min 31 s) |
| Backend completo **sin** PostgreSQL | **3019 pasan**, 1060 omitidas (las que necesitan la base), 0 fallan (8 min 6 s) |
| Servicios y migraciones con PostgreSQL (`-k "servicios or migraciones_reales"`, tras la revisión) | **501 pasan**, 0 fallan |
| Móvil completo (131 baterías) | **3484 de 3484** |
| `tsc --noEmit` | limpio |
| Expo Doctor | 18/18 |
| Exportación web | correcta; las 7 rutas nuevas están en el paquete |
| Paridad de idiomas | es, en y pt con las mismas 159 claves de la agenda y los mismos huecos |
| Rutas de la API | 513 (499 + 14), **ninguna duplicada** |
| `git diff --check` | limpio |
| Búsqueda de secretos en todo el cambio | limpia |
| Escrituras directas desde el móvil | ninguna (`supabase`, `.from(`, `.rpc(`: 0) |
| Mutaciones | **31 de 31** |
| `FEATURE_SERVICES` | **apagada** (por defecto `False`) |
| Código | en `Edson`, **sin desplegar** (sin push, PR ni merge) |

## 59. Riesgos

- **La 0092 ya está en Supabase** (§61), pero la API de producción corre el
  backend anterior, que no la usa. **Al desplegar `Edson`, reiniciar la
  API**: la puerta recuerda el «no». Una base nueva necesita `btree_gist`
  (la 0092 lo comprueba antes de crear nada).
- **Dos bases de zonas**: el cálculo usa `tzdata` (Python) y el disparador de
  la base, la de PostgreSQL. Una zona tiene que existir en las dos. Si alguna
  vez discrepan (una zona nueva en una y no en la otra), la API la rechaza con
  un 422, nunca con un 500; y una agenda guardada con una zona que el cálculo
  no conozca no enseña horarios.
- **Las franjas no cruzan la medianoche**: una atención nocturna larga
  necesita dos franjas y no genera un horario que las junte.
- **Un intervalo menor que la duración** da horarios que se solapan; hasta el
  Incremento 5 no hay reservas que los excluyan.
- **Rendimiento**: cada consulta lee la agenda entera (acotada: 50 reglas,
  200 excepciones y 200 bloqueos por venir) y calcula como mucho 31 días. El
  próximo horario recorre hasta el horizonte. Con el volumen previsto es
  inmediato; si creciera, el siguiente paso sería guardar el próximo horario,
  no materializar la agenda.
- **Sin auditoría general**: los cambios de agenda quedan en su historial, no
  en `audit_events`.
- **C15** (D6) sigue pendiente antes de encender Servicios, y el **push**
  sigue sin llevar al destino (§32).

## 60. Estado y punto exacto de continuación

- **Incremento 4 de Z Servicios técnicamente cerrado; únicamente queda
  pendiente el QA físico** (§61).
- `FEATURE_SERVICES` sigue **apagada**; **no hubo despliegue**.
- **C15** pendiente antes de encender; el **push** sin destino; las
  decisiones E1–E12 de la empresa (`Z_REQUISITOS_Y_DECISIONES.md`).
- **No se empezó el Incremento 5.** Parte de: un servicio público, su agenda
  activa, el horario elegido en la ruta (`horarioElegidoDesdeRuta`) y el
  guardia de los bloqueos (`_contrataciones_que_protege`), que tendrá que
  contar sus reservas.

## 61. Cierre técnico del Incremento 4 (30/09/2026)

**La 0092 se ejecutó a mano en Supabase el 30/09/2026** y se **verificó ese
mismo día** (12:41 hora de Lima, 17:41 UTC, y otra vez a las 13:05, 18:05
UTC, con el código final de la puerta) **sin divergencias**. No se volvió a
ejecutar, no se tocó el fichero y no se escribió ningún dato en Supabase.

### La verificación, en solo lectura

El verificador de la 0091, adaptado a la 0092, abre dos sesiones sobre
Supabase:
- **catálogos** (psycopg): `BEGIN READ ONLY`; `transaction_read_only = on` y
  una sonda de escritura (`create temp table`) **rechazada con 25006** antes
  de consultar nada; al terminar, sigue en solo lectura, **sin id de
  transacción de escritura**, y `ROLLBACK`;
- **la de la API**: la misma `DATABASE_URL`, asyncpg y el pool de
  `app/shared/database.py`; `SET TRANSACTION READ ONLY` como primera
  sentencia, la misma sonda rechazada (25006) y `ROLLBACK`.

La URL sale del fichero de secretos autorizado y nunca se imprime.
Referencias: prólogo + 0001–0092 sobre PostgreSQL 17.11 local desechable
(Supabase: 17.6); el ORM (`agenda_models`), creado de verdad en un esquema
aparte; §57 tal cual; y la puerta de `esquema.py`.

| Comprobación | Resultado |
|---|---|
| Esquema público entero frente a la referencia (1630 columnas, 1218 restricciones, 515 índices, 79 disparadores, 51 funciones, 159/159 tablas con RLS, 149 políticas) | **igual**: la 0001–0091 siguen intactas |
| Las cinco tablas | normales y permanentes, de `postgres` (también sus tipos y sus índices), RLS activa, **0 políticas** |
| Columnas | las 43, con su tipo, su nulabilidad, su valor por defecto y su orden |
| Claves | 5 primarias de una columna; 5 ajenas `ON DELETE CASCADE`, validadas y no diferibles (a `services`, la agenda y el historial; a `service_schedules`, reglas, excepciones y bloqueos) |
| CHECK | los 18, con su nombre y su definición, validados |
| Exclusiones | `service_schedule_rules_sin_cruces` (`… WHERE (active)`) y `service_schedule_exceptions_sin_cruces`, **tal cual**; operadores `=(uuid,uuid)`, `=(smallint,smallint)` o `=(date,date)` y `&&(anyrange,anyrange)`; sus índices GiST, válidos |
| `btree_gist` | una sola, en `extensions`, versión 1.7, creada en la misma transacción que la 0092; de `supabase_admin`, igual que `pg_trgm` (0040): es el rol con el que Supabase crea las extensiones. Lo de la 0092 es de `postgres` |
| Índices | 12 (5 propios, 5 primarios y 2 de exclusión): definición, método, columnas, orden, clases de operadores y condición (el parcial de la `Idempotency-Key`); válidos, listos y vivos |
| Disparadores | los 4, habilitados y antes de la fila: `service_schedules_zona_valida` (INSERT o UPDATE OF `timezone`), los dos `…_solo_en_cascada` (DELETE, con `('services', 'service_id')`) y `service_schedule_events_inmutables` (UPDATE); y los internos de las claves, como en la referencia |
| Función de la zona | `servicios_agenda_zona_valida()`: plpgsql, devuelve `trigger`, SECURITY INVOKER, `search_path=public, pg_temp`, volátil, de `postgres`, cuerpo idéntico (`e672312f…`), sin EXECUTE para PUBLIC, `anon` ni `authenticated`. Las dos que reutiliza (0086 y 0090), idénticas a la referencia |
| Permisos de PUBLIC, `anon` y `authenticated` | **ninguno**: ni declarados (en una tabla o una columna) ni efectivos. Con permisos, solo `postgres` y `service_role` |
| Datos | 0 filas en las cinco tablas; **0** en los 16 recuentos de incoherencias (huérfanas, zonas que no existen, reglas activas cruzadas, excepciones incompatibles, bloqueos inválidos, claves repetidas, valores imposibles, fechas futuras) |
| Integridad de `public` | 339 claves ajenas: 0 filas huérfanas, 0 sin validar |
| Lo que escribió la transacción de la 0092 | una sola transacción; en el catálogo, solo sus tablas, índices, restricciones, tipos, TOAST, disparadores, la función y la extensión (271 filas de `btree_gist`, las mismas que en la referencia); **ninguna fila de datos** en las 205 tablas de todos los esquemas que no son del sistema |
| Modelo `agenda_models` del backend | **igual**: columnas y orden, tipos, nulabilidad, valores por defecto, claves, CHECK e índices. Solo en la base, por diseño: las 2 exclusiones, los 4 disparadores y el `gen_random_uuid()` de los `id` (el ORM los genera en Python) |
| §57, ejecutado tal cual | los seis resultados esperados (el recuento: 0 agendas y 0 eventos) |

El verificador se ensayó antes contra la referencia local (sin divergencias)
y contra la referencia estropeada a propósito (un permiso a `anon`, un valor
por defecto quitado, un índice distinto, una política, SECURITY DEFINER, un
disparador apagado, una exclusión y un CHECK quitados, y datos incoherentes):
dio 48 divergencias y la puerta dijo que no.

### La puerta de esquema, con la conexión y el rol de la API

El rol es `postgres`: **no** superusuario, con BYPASSRLS. En un proceso nuevo
la memoria de la puerta empieza **vacía**, y el código real dice **sí** a las
cuatro (`hay_admision`, `hay_catalogo`, `hay_guardados`, `hay_agenda`) y lo
recuerda. Sus dos mitades, por separado, también dicen sí.

**Corregido en el cierre.** Probando la puerta ante cada alteración
(PostgreSQL 17 local), tres la dejaban **abierta**: el índice de una
exclusión no válido o a medias (`indisready`), y el de una clave primaria a
medias. Una exclusión con su índice a medias **no impide los cruces**. La
puerta ahora exige que TODOS los índices de las cinco tablas estén válidos,
listos y vivos. La prueba se puso roja con esos tres casos antes de
corregir. Lo que la cierra, con el mismo código
(`test_la_puerta_de_la_agenda_mira_lo_que_hace_falta`):

| Caso | Puerta |
|---|---|
| la 0092 completa; y con `service_role` con permisos | sí |
| una tabla que falta (bloqueos, historial), una columna que falta o de más | no |
| una columna de otro tipo (`timestamp`, `integer`) o con otra nulabilidad (en los dos sentidos) | no |
| una exclusión que falta o con otra definición | no |
| un CHECK que falta, distinto, o el **mismo sin validar** | no |
| una clave ajena con otra acción, o la **misma sin validar** | no |
| un índice distinto (no único), no válido o a medias; también el de una exclusión o una clave primaria | no |
| un disparador que falta, deshabilitado, **solo en réplica**, en otro momento (AFTER) o con otra función | no |
| la función de la zona con otro cuerpo, SECURITY DEFINER u otro `search_path` | no |
| sin `btree_gist` | no |
| RLS apagada, o con una política | no |
| un permiso para `anon`, `authenticated` o PUBLIC: en una tabla, en una columna o EXECUTE en la función | no |
| un **error al mirar** | 503 `services_not_ready`, **nunca 500**; no se recuerda |

Y **por HTTP**, con cada una de esas 39 alteraciones (en una transacción que
se deshace): la agenda del prestador, dar de alta una regla, el calendario
público y los horarios de un día contestan **503 `services_not_ready`**, nada
se escribe y nunca hay un 500
(`test_con_la_0092_alterada_la_api_contesta_503_y_nunca_500`).

**Mutaciones:** una nueva (M32: la puerta no mira si todos los índices están
válidos) y las cuatro anteriores que tocan la puerta (M13, M14, M22, M31):
**5 de 5 en rojo**. Las otras 27 del incremento no se repitieron: su código no
cambió.

### Reiniciar la API

La puerta recuerda el «sí» y el «no» hasta reiniciar. En local, el recorrido
lo demuestra (abajo). **Producción** corre el backend anterior, que no usa la
0092: **el día que se despliegue `Edson`, la API de producción tiene que
reiniciarse** (el despliegue lo hace). No se desplegó nada.

### El recorrido integral, con la API real reiniciada

La API real, en su propio proceso (uvicorn) y **sin `dependency_overrides`**:
tokens HS256 de verdad firmados con un secreto de usar y tirar,
`FEATURE_SERVICES` encendida **solo en ese proceso** y PostgreSQL 17 local
desechable. Lo único sustituido es Supabase Storage, por el almacén en memoria
de las pruebas. Nada tocó Supabase. **103 de 103 comprobaciones verdes:**

1. Con 0001–0091, sin la 0092, y los servicios publicados por el flujo real:
   la agenda, el calendario y los horarios contestan **503
   `services_not_ready`**; la ficha sigue en 200 y el servicio propio no
   ofrece la agenda.
2. Se aplica la 0092 a esa base: **la misma API sigue en 503** (recuerda el
   «no»).
3. **Se reinicia la API**: la agenda responde y el servicio propio la ofrece.
4. **El prestador** (Lima; 60 min de la versión publicada, 10 de preparación
   y 15 de descanso): la agenda sin configurar («schedule_missing»); zonas
   que no son IANA con lugar o que no existen, 422; configurar dos veces deja
   un solo evento; lunes a viernes 09–12; un cruce, 409; tocarse, 201; horas
   imposibles, otra modalidad u otra capacidad, 422; editar, desactivar y
   retirar una regla (y retirarla otra vez, 404); la vista previa y lo
   público dan **09:10 y 10:35**; cerrar un lunes entero; cerrar la franja
   09–10 de un miércoles (queda 10:35: la rejilla no se mueve, E12); una
   extra el sábado (15:10), que no admite cerrar el día entero (409), y
   editarla (15:10 y 16:35); sustituir el martes (14:10 y 15:35); retirar la
   franja cerrada; un bloqueo con motivo que solo ve el dueño (ni el
   calendario, ni el día, ni con sesión, ni el historial lo dicen) y que quita
   el de las 10:35; otro prestador, administración y moderación, 404; sin
   sesión, 401; cambiar la zona sin confirmar, 409 con «de dónde a dónde»;
   confirmada (Nueva York), el bloqueo es el mismo instante con otra hora
   local, y de vuelta a Lima; en pausa, nada público; reanudada, vuelve.
5. **Lo público**: fechas con zona, modalidad, duración y «próximo» con su
   desplazamiento; horarios con hora local, instante, desplazamiento y
   capacidad teórica; la modalidad que ofrece (200) y la que no (422); un
   servicio presencial; 34 horarios de 5 en 5 en 4 páginas sin repetir ni
   saltar; rangos de más de 31 días, al revés, ilegibles, antes de hoy, más
   allá del horizonte o del año 9999, 422; 31 días exactos, 200; una fecha a
   90 días, 422; un cursor malo, 422; más de 96 por página, 422; un domingo
   sin reglas, vacío; **Nueva York el 01/11/2026**: la franja 00–04 dura 5
   horas reales y da 5 horarios, la 01:00 dos veces (−04:00 y −05:00), y las
   09:00 siguen siendo las 09:00 antes y después (13:00 y 14:00 UTC); un
   borrador, 404 (pero su vista previa sí, con «service_not_public»);
   suspendido por Z, 404; retirado, 404 (y ya no se escribe: 409
   `service_retired`); el bloqueo entre personas, 404 para quien bloqueó y
   200 para los demás.
6. **Elegir un horario**: la app solo guarda fecha, inicio, hora y modalidad
   en la ruta. Tras todo lo público y la selección, **las mismas filas** en
   reservas, pedidos, retenciones, cobros, transferencias, devoluciones,
   avisos a los prestadores y la agenda. La API no tiene con qué apartar: lo
   público de la agenda solo se lee (GET) y ninguna de sus 14 operaciones es
   de reserva, retención o pago.
7. **Carreras** (peticiones simultáneas, conexiones distintas, PostgreSQL de
   verdad):
   - tres reglas cruzadas a la vez, tres rondas: **201, 409, 409** y una
     sola activa cada vez;
   - cerrar y sustituir la misma fecha a la vez, tres rondas: **201 y 409**,
     una sola guardada;
   - la misma `Idempotency-Key` cinco veces a la vez: un 201, cuatro 200 y
     **un** bloqueo; con otro contenido, 409 `idempotency_key_reused`;
   - retirar un bloqueo dos veces mientras se crea otro: 200 y 404, 201, y
     queda solo el nuevo;
   - 48 peticiones mezcladas (leer el calendario, los días y la vista previa
     mientras se crean excepciones y se activa y desactiva una regla):
     **ningún 5xx**.

Ningún 500 ni ninguna traza en los registros de las dos API.

### Registrada como aplicada

La huella git de la 0092 (`eba1a48…`) entró en `APLICADAS`
(`test_servicios_migracion_0090.py`), igual que la 0090 y la 0091, y la
batería de la 0092 exige además ese registro
(`test_esta_aplicada_y_ya_no_se_edita`): añadir un solo espacio al fichero
pone rojas las dos. Su cabecera sigue diciendo «SIN APLICAR» a propósito:
cambiarla sería editar lo aplicado.

### Pruebas y validación del cierre

| Comprobación | Resultado |
|---|---|
| Verificación de la 0092 en Supabase (dos veces) | **sin divergencias** |
| Puerta real con el rol de la API | **sí**, las cuatro |
| Recorrido integral con la API reiniciada | **103 de 103** |
| Migración 0092 (`test_servicios_migracion_0092.py`) | **19 pasan**, 0 fallan |
| Puerta de la agenda (en `test_servicios_agenda_api.py`) | **6 pasan** (39 alteraciones, también por HTTP) |
| Cálculo de horarios (`test_servicios_agenda_calculo.py`) | **49 pasan** |
| API de la agenda (`test_servicios_agenda_api.py`, con carreras) | **28 pasan**, 0 fallan |
| Servicios con PostgreSQL 17 (todos los `test_servicios_*`) | **456 pasan** (16 ficheros), 0 fallan |
| Servicios sin PostgreSQL | 256 pasan, 200 omitidas (las que necesitan la base), 0 fallan |
| Backend completo **con** PostgreSQL 17 (0001–0092 desde cero) | **4082 pasan**, 0 fallan, 0 omitidas (24 min 13 s, junto a la otra batería) |
| Backend completo **sin** PostgreSQL | **3021 pasan**, 1061 omitidas (las que necesitan la base), 0 fallan (13 min 14 s) |
| Móvil del Incremento 4 (agenda, vistas y diccionarios) | **83 de 83** (sin cambios en el móvil) |
| Móvil completo | **3484 de 3484** |
| `tsc --noEmit` | limpio |
| Rutas de la API | 513, **ninguna duplicada** |
| `git diff --check` | limpio |
| Secretos en el cambio | ninguno |
| Escrituras directas desde el móvil | ninguna |
| Mutaciones de la puerta | **5 de 5** |
| `FEATURE_SERVICES` | **apagada** (por defecto `False`) |
| Código | en `Edson`, **sin desplegar** (sin push, PR ni merge) |

### Estado

- **Incremento 4 técnicamente cerrado. Únicamente queda pendiente el QA
  físico** (`Z_QA_FISICO_PENDIENTE.md`, «Incremento 4»).
- `FEATURE_SERVICES` sigue **apagada**, y **no hubo despliegue**. Al
  desplegar `Edson`, **reiniciar la API de producción**.
- Las decisiones **E1–E12** siguen siendo de la empresa
  (`Z_REQUISITOS_Y_DECISIONES.md`); la antelación de 2 horas y el horizonte de
  60 días, provisionales.
- **C15** sigue pendiente, y conviene decidirla **antes de encender**
  Servicios (D6).
- El **push** de un aviso todavía no lleva al destino (§32).
- **No se empezó el Incremento 5** (§60).

# Parte V · Incremento 5: reserva y contratación protegida

Escrito el 30/09/2026 en la rama `Edson`, con el Incremento 5 **implementado y
probado**. Después la 0093 se ejecutó a mano en Supabase y se verificó el
01/10/2026 (02:13 UTC) sin divergencias: el incremento quedó **técnicamente
cerrado** (§80). El código sigue en `Edson`, **sin desplegar**: nada de esta
parte está en producción. Solo queda el QA físico
(`Z_QA_FISICO_PENDIENTE.md`, «Incremento 5»). De §62 a §79 se describe el
incremento tal como se escribió; donde decía «sin aplicar», manda §80.

## 62. Estado del Incremento 5

| | |
|---|---|
| **Qué hace** | Una persona elige un horario de un servicio público, lo **aparta** unos minutos, escribe solo lo necesario, revisa servicio, horario, modalidad, precio y condiciones, **acepta una versión concreta** de las condiciones y **confirma**: nacen juntos el pedido, la reserva, lo aceptado y el historial. Consulta sus reservas y su detalle; el prestador, las de sus servicios; administración, lo operativo |
| **Migración 0093** | **APLICADA** a mano en Supabase y verificada en solo lectura el 01/10/2026, **sin divergencias** (§80). Cómo se aplica, en §74; qué se consulta, en §75 |
| **Sin la 0093** | Las 12 rutas de la reserva y la de las condiciones de contratación contestan **503 `services_not_ready`**, sin escribir nada; el calendario público dice `booking_available: false` y la app no ofrece «Continuar». Los Incrementos 1–4 siguen igual |
| **Banderas** | `FEATURE_SERVICES` **apagada**; `FEATURE_SERVICE_BOOKING` **apagada** (nueva); `FEATURE_SERVICE_PAYMENTS` **apagada** (nueva); `SERVICE_PAYMENTS_PROVIDER=none` (nueva). Con Servicios apagado: 503 `services_disabled`; con la contratación apagada: 503 `service_booking_disabled`. Las dos, **antes de mirar la base** |
| **Dinero** | **Ninguno.** Solo se contrata lo **gratuito**. Lo que tiene precio se aparta y se detiene: 503 `service_booking_payments_not_configured`, sin pedido ni reserva. «A consultar» y «desde» no se apartan (409). La base **no admite** un pedido con precio, cobro o pasarela |
| **Código** | En `Edson`, **sin desplegar**: sin push, PR ni merge |
| **QA físico** | **pendiente** (`Z_QA_FISICO_PENDIENTE.md`, «Incremento 5») |
| **Incremento 6** | **no se empezó** (§78) |

## 63. El modelo (6 tablas, 0093)

| Tabla | Qué es |
|---|---|
| `service_holds` | **La retención: el registro que OCUPA.** Servicio, versión, persona, inicio y fin, lo que ocupa con preparación y descanso (`occupied_from`/`occupied_until`), zona, fecha local, modalidad, capacidad y plaza **congeladas**, vencimiento. Estados `active` → `consumed` / `released` / `expired` |
| `service_orders` | **El pedido**: lo comercial. Solo `free`, `payment_status = not_required`, `payment_provider = none`, sin importe ni moneda y total 0; entorno `sandbox`/`production` congelado; título y prestador congelados |
| `service_bookings` | **La reserva**: la cita, con su código (`ABCD-2345`, sin 0/O/1/I) y su **fotografía**: servicio, versión, prestador, persona, inicio y fin, ocupación, zona, fecha local, modalidad, duración, separación antes y después, capacidad y plaza, título, prestador y zona pública |
| `service_booking_intakes` | **Lo que pide la atención**: una nota y, a domicilio, distrito, dirección y referencia. Privado: solo quien contrata y su prestador |
| `service_booking_acceptances` | **Lo aceptado**: las condiciones de Z (id, versión y huella de `service_policies`) y las del servicio (la versión publicada y su huella), con quién y cuándo |
| `service_booking_events` | **El historial**, solo se añade: acción, de qué estado a cuál, quién (persona o sistema), la clave de idempotencia (única por persona) y detalles **sin nota ni dirección** |

La fotografía del precio está en el pedido (modelo, importe, moneda, total,
estado del pago, pasarela y entorno); la de las condiciones, en lo aceptado.
Juntas cubren todo lo que el incremento pide congelar. **Una reserva nunca
lee la versión de hoy**: cambiar el servicio no cambia la reserva.

**Las claves de pedidos y reservas al prestador no borran nada y se
comprueban al confirmar la transacción** (`deferrable initially deferred`).
La baja de quien presta llega a sus pedidos y reservas por **un solo
camino**, el del servicio (como en la 0090). Con dos caminos en cascada, el
orden de los disparadores (el de sus OID, distinto en cada base) decidía si
la baja funcionaba (hallazgo R4 de la revisión, §76).

## 64. La doble reserva la impide la BASE

Una sola autoridad para «qué está ocupado»: **las retenciones `active` y
`consumed`**. Una retención confirmada no desaparece: pasa a `consumed` y
sigue ocupando por su reserva.

- **Exclusión `service_holds_sin_cruces`** (`btree_gist`): dos sesiones
  **distintas** (otro inicio) del mismo servicio no pueden ocupar a la vez,
  contando preparación y descanso **congelados**.
- **`service_holds_una_plaza`**: una plaza no se da dos veces; **CHECK** plaza
  ≤ capacidad congelada.
- **`service_holds_una_por_persona`**: una persona, una plaza por sesión.
- **`service_holds_una_activa`**: una persona, una retención activa por
  servicio (elegir otro horario del mismo servicio suelta el anterior en la
  misma transacción, y solo si el nuevo se consigue).
- **Disparadores diferidos** (al confirmar la transacción): ningún pedido sin
  su reserva ni sin las condiciones de Z aceptadas; ninguna reserva sin su
  retención consumida y su pedido confirmado (y coherentes entre sí); ninguna
  retención consumida sin su reserva. Una interrupción entre el pedido y la
  reserva no deja nada: se deshace todo.
- **Saltos de estado** con su disparador: `active` → `consumed` | `released`
  | `expired`; los finales no vuelven. Lo contratado no se reescribe ni se
  borra suelto.

El cálculo público (`agenda_calculo.horarios_del_dia`) es el **mismo** que
revalida al retener y al confirmar: lee las ocupaciones (una sesión ajena que
se cruza con su separación quita el horario; la misma sesión cuenta plazas) y
nunca ofrece un horario que la base rechazaría (prueba con 300 agendas al
azar). La base es la última palabra: si dos llegan a la vez, una gana y la
otra recibe **409 `service_slot_not_available`**.

**Orden de los cerrojos**: la fila del servicio (`FOR NO KEY UPDATE`, con
`lock_timeout` de 5 s: si no llega, **409 `service_booking_busy`**, nunca un
500) → la fila de la retención → un cerrojo de la persona, para su tope y
para su clave de idempotencia.

- **`FOR NO KEY UPDATE` y no `FOR UPDATE`**: sigue en fila con las demás
  contrataciones y con quien edita el servicio, pero no choca con la
  comprobación de una clave ajena (`FOR KEY SHARE`). El barrido bloquea una
  retención, la vence y después escribe su línea del historial; con `FOR
  UPDATE`, quien tenía el servicio y esperaba esa retención y el barrido se
  esperaban el uno al otro (40P01, y un 500). Hallazgo R2.
- **La persona, en fila también al confirmar y al soltar**: la misma clave a
  la vez en dos retenciones de servicios distintos no compartía ningún otro
  cerrojo y la segunda chocaba con el índice único (23505, y un 500).
  Hallazgo R3.
- **Última red**: un 55P03 o un 40P01 son 409 `service_booking_busy`.

## 65. Retener, soltar, vencer y confirmar

**Retener** (`POST /services/catalog/{id}/holds`): el horario se vuelve a
calcular con la agenda de ahora; antes, las retenciones vencidas de ese
servicio se marcan vencidas **en la misma transacción**. 201 con la
retención, su `expires_at`, la hora del servidor y `seconds_left`. La misma
clave con lo mismo devuelve la misma (200, **sin alargarla**); con otra cosa,
**409 `idempotency_key_reused`**. El mismo horario ya apartado por la misma
persona con otra clave: **409 `service_hold_already_active`** con su id. Tope
de retenciones activas por persona (3, configurable): **409
`service_hold_limit_reached`**.

**Vencer**: lo decide la HORA, no una limpieza. Una `active` cuyo plazo pasó
se lee `expired`, no ocupa en el cálculo, no se confirma (**409
`service_hold_expired`**) y se marca al retener otra del mismo servicio. El
**barrido** (`POST /admin/services/holds/expire`, solo administración) marca
las vencidas por lotes (200, hasta 1000) con `SKIP LOCKED` y deja su línea
(`hold_expired`, actor `system`); repetirlo no hace nada. **Nadie lo llama
todavía**: sin cron, Lambda ni EventBridge (decisión de la empresa, F13).

**Soltar** (`POST /services/holds/{id}/release`): 200; soltar lo soltado o lo
vencido es lo mismo; lo reservado no se suelta (409).

**Resumen** (`GET /services/holds/{id}/checkout`): solo lectura. Servicio y
horario **de la retención**, precio, forma de contratar (`free`, `paid`,
`quote_required`, `price_not_closed`), si se puede confirmar y por qué no
(`blockers`), las condiciones de Z **vigentes** (id, versión, título, texto,
huella), las del servicio (texto y huella), si pide dirección y los largos.

**Confirmar** (`POST /services/holds/{id}/confirm`): en fila con el servicio,
se comprueba OTRA VEZ todo: la retención (suya, activa, a tiempo), el
servicio (público para esa persona), **la misma versión** que retuvo (si no,
**409 `service_booking_version_changed`**), el precio (solo gratis), la
modalidad (se confirma sola), las condiciones (**las vigentes, por su id y su
huella**; si cambiaron, **409 `service_booking_terms_changed`**; si no hay,
**409 `service_booking_terms_unavailable`**), los datos y EL HORARIO (el
cálculo de ahora, sin contarse a sí misma; la antelación y el horizonte, desde
que se retuvo; y **una sesión que ya empezó no se confirma**, aunque la
retención siga viva: 409 `service_slot_not_available`, hallazgo R6). Nacen el
pedido, la reserva (con código único), los datos de
la atención, lo aceptado, la retención consumida, la línea del historial y los
dos avisos. La misma clave con lo mismo: la misma reserva (200). Confirmar
otra vez con otra clave: **409 `service_hold_already_consumed`** con el id de
la reserva.

## 66. Estados: una autoridad, en la base

| | Estados | Quién cambia | Finales |
|---|---|---|---|
| Retención | `active`, `consumed`, `released`, `expired` | Confirmar (persona), soltar (persona), vencer (sistema: al retener otra o al barrer) | `consumed`, `released`, `expired` |
| Pedido | `confirmed` | Nace confirmado (solo gratis) | sí |
| Reserva | `confirmed` | Nace confirmada | sí |

No hay `pending_payment` porque **no hay cobro**: la base no admite un pedido
con precio (§68). No hay cancelación: la política es de la empresa (F6) y
llegará con su propio estado y su historial. Cada salto: una función del
dominio, su comprobación en la base, su línea en el historial con el actor y
su idempotencia.

## 67. Las condiciones de contratación

Un **tipo nuevo** de `service_policies`: `booking_terms` (la 0093 amplía su
CHECK, como la 0086 prevé). Se escriben y publican con las mismas rutas y la
misma pantalla que las del prestador (`/admin/services/policies?kind=booking_terms`,
`POST /admin/services/policies/booking-terms/draft`), **sin parámetros**. Una
por país del prestador; publicar una supera la anterior en la misma
transacción.

**Sin una publicada para el país del prestador no se confirma ninguna
reserva.** **No se publicó ninguna**: el texto es de la empresa (F9). La
persona acepta **una versión concreta** (id + huella); si se publica otra
mientras lee, confirmar da 409 y la app vuelve a enseñar la nueva. **En la app,
la casilla «Acepto» guarda la versión y la huella que se veían al marcarla**,
no un «sí»: si el resumen trae otras, aparece sin marcar y no se manda nada
(antes, un borrador marcado con la v1 confirmaba la v2 sin que nadie la
aceptara; hallazgo R1). Lo aceptado queda en `service_booking_acceptances`
para siempre.

La creación del borrador exige la 0093 (sin ella, 503; antes de la revisión
era un 500 por el CHECK de la 0086) y **no** la bandera de la contratación: la
empresa puede preparar el texto antes de abrirla.

## 68. El dinero: nada se cobra, y nada se finge

- `feature_service_payments=False`, `service_payments_provider="none"` y
  **ningún adaptador** (`ADAPTADORES_DE_COBRO = {}`): `cobro_disponible()` es
  falso, y lo sería aunque se encendieran las banderas.
- **Gratuito**: pedido `free`, `not_required`, `none`, total 0.
- **Precio fijo**: se aparta (para que la persona vea el resumen), se detiene:
  503 `service_booking_payments_not_configured`; ni pedido, ni reserva, ni un
  «pagado». La retención vence sola o se suelta.
- **«Desde»**: 409 `service_booking_price_not_closed`; **«a consultar»**: 409
  `service_booking_quote_required`. Ninguno se aparta, y la app no ofrece
  «Continuar». **Nunca se tratan como gratis ni como 0.**
- **La base** solo admite pedidos `free` / `not_required` / `none` sin importe:
  aunque el código fallara, no podría guardarse un cobro fingido.
- Ninguna tabla de dinero de la plataforma (`orders`, `payment_*`,
  `owner_*`, `refund_requests`, `product_*`, `event_orders`, `bookings`) cambia
  (lo comprueban las pruebas y el recorrido).

## 69. Privacidad

- **Solo lo necesario**: una nota opcional (500) y, **a domicilio**, distrito
  (100), dirección (200) y referencia opcional (200). En línea o presencial,
  una dirección es un **422**: no se guarda lo que no hace falta.
- **A domicilio no se confirma sola** hoy (`SERVICES_BOOKING_INSTANT_MODALITIES
  = virtual,in_person`): 409 `service_booking_provider_confirmation_required`
  (F3). Probado encendiéndolo solo en la prueba.
- La nota y la dirección **solo** las ven quien contrata y su prestador, y
  solo en una reserva válida. Nunca en el historial, los avisos, la
  administración, lo público ni la ruta de la app (viajan en memoria).
- El prestador ve la **identidad pública** de quien contrata (usuario y
  nombre), **nunca** correo ni teléfono.
- **Lo ajeno es 404** (retención, reserva, detalle del prestador); sin sesión,
  401; administración, solo `admin` (403 el resto).
- **La baja**: una reserva **por venir** impide borrar la cuenta de quien
  contrata o de quien presta (409 `account_deletion_blocked`); con las
  pasadas, quien contrata queda en `NULL` y su nota y su dirección se borran.
  La baja de **quien presta** se lleva, como en la 0090, sus servicios y con
  ellos sus reservas **pasadas**, incluido lo que aceptó quien contrató: si
  eso debe conservarse es una decisión de la empresa (F21).

## 70. La API (12 rutas + 1) y la puerta

| Ruta | Quién | Qué |
|---|---|---|
| `POST /services/catalog/{id}/holds` | persona | Apartar (Idempotency-Key) |
| `GET /services/holds/{id}` | persona | La retención, con `server_now` y `seconds_left` |
| `POST /services/holds/{id}/release` | persona | Soltar (Idempotency-Key) |
| `GET /services/holds/{id}/checkout` | persona | El resumen |
| `POST /services/holds/{id}/confirm` | persona | Contratar lo gratuito; con precio, 503 (Idempotency-Key) |
| `GET /services/me/bookings` | persona | Mis reservas (`upcoming`/`past`, cursor) |
| `GET /services/me/bookings/{id}` | persona | Detalle, lo aceptado e historial |
| `GET /services/provider/bookings` | prestador | Las de sus servicios (cursor) |
| `GET /services/provider/bookings/{id}` | prestador | Detalle limitado |
| `GET /admin/services/holds` | admin | Retenciones por estado (cursor) |
| `GET /admin/services/bookings` | admin | Reservas (cursor), sin nada privado |
| `POST /admin/services/holds/expire` | admin | El barrido (lotes) |
| `POST /admin/services/policies/booking-terms/draft` | admin | Borrador de las condiciones de contratación |

- **Paginación por cursor** con orden total estable (`starts_at`, `id`):
  por venir de la más próxima; pasadas de la más reciente. Un cursor inválido
  es 422.
- **Idempotency-Key obligatoria** en retener, soltar y confirmar (sin ella,
  422 `idempotency_key_required`); una por persona en la base. El barrido no
  la lleva: no tiene identidad y repetirlo no hace nada.
- **Códigos estables** (22), traducidos en la app; **ningún 500** (las
  carreras, los cerrojos y la puerta están probados).
- **La puerta `hay_reservas`**: 91 columnas, 6 claves primarias, 21 claves
  foráneas con sus reglas de borrado (diferidas solo las dos al prestador),
  4 restricciones únicas, la exclusión
  palabra por palabra, 42 CHECK con su huella, 14 definiciones de índice y los
  25 índices válidos y listos, 15 disparadores (3 diferidos) con su función,
  7 funciones por su huella, el CHECK de los tipos de política, `btree_gist`,
  RLS, sin políticas ni privilegios. Recuerda el «sí» y el «no» hasta
  reiniciar; un error al mirar no se recuerda (503).

## 71. Vistas y navegación (móvil)

| # | Vista | Ruta |
|---|---|---|
| 1 | Horarios (Inc. 4) con «Continuar» (aparta) | `/servicios/horarios/[serviceId]` |
| 2 | Tus datos | `/servicios/contratar/[holdId]` |
| 3 | Resumen y confirmación | `/servicios/contratar/[holdId]/resumen` |
| 4 | Condiciones completas | `/servicios/contratar/[holdId]/condiciones` |
| 5 | Reserva confirmada / con precio, detenida | la reserva con `?confirmada=1` / el estado «todavía no se puede pagar» del resumen |
| 6 | Mis reservas | `/servicios/reservas` |
| 7–8 | Detalle e historial | `/servicios/reservas/[bookingId]` |
| 9 | Reservas de mis servicios | `/servicios/prestador/reservas` |
| 10 | Detalle limitado del prestador | `/servicios/prestador/reservas/[bookingId]` |
| 11 | Supervisión (A04) | `/admin/servicios/reservas` |
| + | Condiciones de contratación (administración) | `/admin/servicios/condiciones-de-contratacion` |

- **Elegido ≠ apartado ≠ reservado**: tres palabras y tres estados en los
  tres idiomas.
- **La cuenta atrás es la del servidor**: `seconds_left` menos lo que pasó
  desde que llegó la respuesta; un teléfono con la hora mal no cambia nada. Se
  anuncia al vencer, no cada segundo.
- **Antes de confirmar se vuelve a leer el resumen**; si cambiaron las
  condiciones (las de Z o las del servicio, por versión o huella) o ya no se
  puede, no se manda nada. **La casilla «Acepto» es de la versión que se ve**.
- **Un 409 que invalida el horario vuelve a elegir**; uno ya apartado sigue
  con esa retención.
- **Claves**: una por horario elegido (renovada tras apartar); una por
  petición al confirmar (repetir lo mismo usa la misma).
- **Doble toque**: cerrojo y botón apagado.
- **Nota y dirección en memoria**, nunca en la ruta; se olvidan al confirmar o
  soltar.
- Carga, vacío, error con reintento, sin sesión y sin permiso en cada vista;
  ningún código interno ni cero inventado; es/en/pt con los mismos huecos.
- **Ninguna escritura directa** a la base desde el teléfono.

Entradas: «Mis reservas» en Servicios; «Reservas de mis servicios» en el área
del prestador **activo o suspendido** (suspenderlo no cancela sus reservas por
venir; hallazgo R7); «Condiciones de contratación» y «Reservas y
retenciones» en la administración de Servicios; y los avisos.

## 72. Avisos

`service_booking_confirmed` (a quien contrata) y `service_booking_received`
(al prestador), con la entidad `service_booking` y el id de la reserva;
**sin fecha, nota ni dirección**; textos en es/en/pt en el servidor y en la
app; idempotentes por suceso. En la bandeja, tocarlos lleva a la reserva (la
propia o la de la bandeja del prestador). **El push** sigue abriendo solo la
aplicación: el contrato actual de la cola no lleva datos de destino (§32).
No hay aviso de vencimiento (F12).

## 73. Concurrencia (probada con PostgreSQL de verdad)

| Caso | Resultado |
|---|---|
| 10 personas a la vez por el mismo horario | 1 lo consigue; 9 → 409 `service_slot_not_available` |
| La misma clave 4 veces a la vez | Una retención |
| La misma clave con otro contenido | 409 `idempotency_key_reused` |
| Confirmar dos (o cinco) veces a la vez | Una reserva; el resto 409 |
| Confirmar mientras vence (barrido) o se suelta | O reservada (retención consumida) o no (vencida/soltada); nunca las dos |
| Capacidad agotada / grupo de 2 con 6 a la vez | 409 / 2 lo consiguen, plazas 1 y 2 |
| Confirmar mientras el prestador bloquea ese horario | O se reserva o 409; nunca un 500 ni media reserva |
| Leer mientras se retiene, vence y se barre | Nunca un 500 |
| Interrupción entre pedido y reserva | La transacción no se confirma (disparadores diferidos) |
| Dos conexiones con sesiones que se pisan | La base rechaza la segunda |
| El barrido a medias (retención vencida, sin su línea) con quien espera esa retención: confirmar, soltar o retener | Sin interbloqueo: 409 `service_hold_expired` / 200 / 201 (antes, 40P01 y un 500) |
| La misma clave a la vez en dos retenciones de servicios distintos (confirmar o soltar) | Una gana; la otra 409 `idempotency_key_reused` (antes, 23505 y un 500) |

## 74. Cómo aplicar la 0093

**Aplicada** a mano en Supabase y verificada el 01/10/2026 (§80): los pasos 1,
2, 4 y 5 están hechos; el 3 corresponde al despliegue de `Edson`, que no se ha
hecho; el 6 sigue siendo de la empresa. Así se aplica (y así se aplicaría en
otra base):

1. Comprobar que la base tiene la **0086–0092** (la 0093 se niega sin ellas y
   sin `btree_gist`, que la 0092 ya instaló).
2. Pegar el fichero **entero** en el editor SQL de Supabase y ejecutarlo: es
   una sola transacción, comprueba lo anterior antes de crear nada y verifica
   lo que dejó; si algo falla, no queda nada. Es reejecutable.
3. **Reiniciar la API** (o desplegar `Edson`, que la reinicia): la puerta
   recuerda el «no».
4. Verificar (§75) en una sesión de solo lectura, también con el rol real de
   la API (la puerta tiene que decir «sí»).
5. Registrar su huella en `APLICADAS` (`test_servicios_migracion_0090.py`) y
   repetir el recorrido de cierre.
6. **Después**, y solo si la empresa lo decide: publicar las condiciones de
   contratación del país (F9) y encender `FEATURE_SERVICE_BOOKING` (con
   `FEATURE_SERVICES`). Sin condiciones publicadas no se confirma nada.

**Rollback**: el de la cabecera del fichero, en una transacción: borra
retenciones, reservas y pedidos de Servicios y los **borradores** de las
condiciones de contratación; las **publicadas no se borran** (la 0086 no deja
borrar una política publicada: son la evidencia de lo aceptado) y, si queda
alguna, el CHECK de los tipos de política se queda ampliado, que no molesta.
Después, reiniciar la API. Probado con condiciones publicadas y sin ellas
(antes fallaba justo cuando haría falta; hallazgo R5).

## 75. Verificar la 0093 (solo lectura)

En una transacción `BEGIN READ ONLY`, tras comprobar que una escritura se
rechaza (25006), y terminando con `ROLLBACK`:

```sql
-- 1. La puerta, con el rol de la API: tiene que decir true
--    (la consulta de esquema.hay_reservas, _LO_QUE_NECESITA_LA_RESERVA).
-- 2. Las seis tablas, con RLS y sin políticas.
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as politicas
  from pg_class c
 where c.relname in ('service_holds', 'service_orders', 'service_bookings', 'service_booking_intakes',
                     'service_booking_acceptances', 'service_booking_events')
   and c.relnamespace = 'public'::regnamespace;
-- 3. La exclusión, tal cual.
select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'service_holds_sin_cruces';
-- 4. Los tres disparadores diferidos.
select tgname, tgdeferrable, tginitdeferred from pg_trigger
 where tgname in ('service_bookings_coherentes', 'service_orders_completos', 'service_holds_con_reserva');
-- 5. El tipo de las políticas.
select pg_get_constraintdef(oid) from pg_constraint where conname = 'service_policies_tipo';
-- 6. Nadie de fuera con permisos (0 filas).
select table_name, grantee, privilege_type from information_schema.table_privileges
 where table_schema = 'public' and table_name like 'service\_%' and table_name in (
       'service_holds', 'service_orders', 'service_bookings', 'service_booking_intakes',
       'service_booking_acceptances', 'service_booking_events')
   and grantee in ('anon', 'authenticated', 'PUBLIC');
-- 7. Las dos claves al prestador: sin borrar nada (a) y diferidas (t, t).
select conrelid::regclass, conname, confdeltype, condeferrable, condeferred from pg_constraint
 where contype = 'f' and confrelid = 'public.service_providers'::regclass
   and conrelid in ('public.service_orders'::regclass, 'public.service_bookings'::regclass);
-- 8. Vacías recién aplicada, y ninguna condición de contratación publicada.
select (select count(*) from public.service_holds) as retenciones,
       (select count(*) from public.service_bookings) as reservas,
       (select count(*) from public.service_policies where kind = 'booking_terms') as condiciones;
```

Y comparar el esquema entero con una referencia local 0001–0093, como en §61.

## 76. Pruebas, mutaciones y revisión (30/09/2026)

Todo contra un PostgreSQL 17 **local y desechable** (contenedor de pruebas,
`127.0.0.1`); **nada tocó Supabase**. Resultados del 30/09/2026 sobre el
código final (tras las correcciones de la revisión).

| Qué | Dónde | Resultado |
|---|---|---|
| A. La migración | `test_servicios_migracion_0093.py` (26) | Desde cero; sobre la 0092 con datos (no toca nada); reejecutarla deja lo mismo; un fallo a mitad no deja nada; se niega a terminar incompleta y sin cada dependencia; igual al modelo (ORM en un esquema aparte); RLS, cero políticas y cero privilegios; estados, CHECK, índices, disparadores y funciones; la 0086–0092 intactas; la baja de quien presta en **los dos órdenes** de disparadores; el **rollback** de la cabecera con condiciones publicadas y sin ellas |
| B. El dominio | `test_servicios_reserva_api.py` (44), `test_servicios_reserva_calculo.py` (11) | Gratuito, con precio (503, sin escribir nada) y «a consultar»/«desde» (409); aceptación versionada; fotografía; todos los estados; lo vencido no se confirma aunque nadie lo barra; **lo que ya empezó no se confirma**; aislamiento de personas y prestadores; bloqueos entre personas; servicio suspendido o retirado; categoría desactivada; prestador suspendido; agenda cambiada; horario bloqueado; versión nueva; condiciones que cambian; separación congelada |
| C. Carreras (PostgreSQL de verdad) | las mismas | §73, incluidas las dos nuevas de la revisión (el barrido a medias, sin azar, y la misma clave en dos retenciones a la vez) |
| D. HTTP | `test_servicios_reserva_api.py`, `test_servicios_admision_api.py` (53) | Roles; 401/403/404/409/422/503; ningún 500; cursores; idempotencia; banderas apagadas (503 **sin mirar la base**); la puerta con 30 alteraciones de la 0093 |
| E. Móvil | `serviciosReserva.test.mts` (32), `serviciosReservaVistas.test.mts` (46) y las demás de Servicios | Navegación y entradas; cuenta atrás del servidor; doble toque; volver de las condiciones; cambiar de horario; vencer con la pantalla abierta; horario tomado (409 → volver a elegir); sin dirección fuera de «a domicilio»; pagos apagados; gratuito; «a consultar»; carga, vacío y error; tres idiomas; ninguna escritura directa; **la casilla «Acepto» es de la versión que se ve** |
| F. Regresión | | Backend **con PostgreSQL: 4166 aprobadas, 0 fallidas, 0 omitidas**; **sin PostgreSQL: 3040 aprobadas, 0 fallidas** (1126 omitidas por necesitar PostgreSQL); **móvil 3563/3563**; `tsc --noEmit` limpio; **Expo Doctor 18/18**; exportación web correcta (4 páginas, sin `.env`); **522 operaciones de la API sin duplicadas** (100 de Servicios); `git diff --check` limpio; ningún secreto en el cambio; es/en/pt con las mismas claves y huecos |
| Recorrido con la API real | proceso aparte, base local desechable | **63/63 comprobaciones**: antes de la 0093 (503, nunca 500), aplicarla con la API en marcha (sigue en 503: recuerda el «no»), reejecutarla, **reiniciar** y de punta a punta (condiciones, retener, resumen, confirmar, consultar, prestador, supervisión, barrido, precio, «a consultar», lo ajeno, la baja, carreras, banderas apagadas) |
| Mutaciones dirigidas | 48 | **48/48 muertas** (§ abajo) |

### Mutaciones

48 mutaciones dirigidas (37 del bloque 5E y 11 de la revisión), cada una
aplicada sola, con sus pruebas verdes antes de mutar, y restaurada:
**48/48 muertas**. Dos sobrevivieron la primera vez y NO se maquillaron:

- **M03** (no congelar la separación al retener) **sobrevivía**: la prueba era
  débil. Se añadió `test_la_separacion_se_congela_al_retener_y_sigue_ocupando`,
  que la mata sola.
- **M10** sobrevivía porque la mutación estaba mal planteada (alteraba las dos
  respuestas por igual): se rehízo para leer el título de la versión actual y
  muere.

Las 11 de la revisión (M29–M36, MM10–MM12) mueren por el motivo esperado; M34
y M35 se comprobaron a mano: `service_orders no se borra` y `Una política
published de Servicios no se borra`.

### Hallazgos y correcciones

Cada uno **reproducido** con una prueba que fallaba sobre el código anterior,
**corregido** y **vuelto a verificar** (y su mutación, muerta). Commits
`1197841` y `440c91c`.

| # | Origen | Gravedad | Hallazgo | Reproducción (antes) | Corrección |
|---|---|---|---|---|---|
| E1 | Recorrido | Media | Crear el borrador de las condiciones de contratación sin la 0093 daba **500** (el CHECK de la 0086); con la 0093 a medias, 201 | la batería de la 0093 alterada: 201 en vez de 503 | 503 `services_not_ready` (puerta propia, sin la bandera) |
| E2 | Batería completa | Media | Las banderas de dinero nuevas no estaban en `.env.example` | `test_toda_palanca_de_dinero_esta_en_el_ejemplo_de_entorno` fallaba | Documentadas, apagadas / `none` |
| R1 | Revisión | **Alta** | La casilla «Acepto» era un «sí» sin versión: un borrador marcado con la v1 confirmaba la v2 | guion y prueba: la v2 salía como aceptada | La casilla guarda versión y huella; con otras, sin marcar |
| R2 | Revisión | Media | Interbloqueo del barrido con retener, confirmar o soltar (40P01 → 500) | 3 pruebas deterministas: `deadlock detected` | Servicio `FOR NO KEY UPDATE`; 40P01 → 409 `service_booking_busy` |
| R3 | Revisión | Baja | La misma clave a la vez en dos retenciones: 23505 → 500 | 2 pruebas: `service_booking_events_una_por_clave` | La persona en fila antes de mirar su clave: 409 |
| R4 | Revisión | Media | La baja de quien presta dependía del orden de los disparadores (OID) | 2 pruebas forzando el orden: `service_orders no se borra` | Claves al prestador diferidas y sin borrar: un solo camino |
| R5 | Revisión | Baja | El rollback de la cabecera fallaba con condiciones publicadas | prueba: `Una política published … no se borra` | Solo borradores; el tipo se estrecha si no queda ninguna |
| R6 | Revisión | Baja | Se podía confirmar una sesión ya empezada (antelación < retención) | prueba: 201 un minuto después de empezar | 409 `service_slot_not_available` |
| R7 | Revisión | Baja | Un prestador suspendido perdía «Reservas de mis servicios» | prueba de la vista | Activo o suspendido |

La primera batería completa con PostgreSQL tras R4 falló en **una** prueba:
`test_claves_ajenas_y_su_comportamiento_al_borrar` (la de la 0086, que lista
las claves ajenas de todo Servicios) esperaba todavía la cascada de las dos
claves al prestador. Se actualizó esa expectativa (`a`, sin acción) y la
batería completa se repitió entera: 4166 de 4166.

La revisión confirmó como correctos (sin cambio): la doble reserva (exclusión,
plazas, una por persona, una activa, reemplazo con SAVEPOINT), los
vencimientos, las zonas horarias y los cursores, la fotografía, el dinero, la
privacidad, la idempotencia y los avisos, los recuentos de la puerta y que
todas las rutas y claves de texto existen.

## 77. Riesgos

- **La 0093 está en Supabase; el código que la usa, no.** Producción sigue
  con el código anterior, que no conoce estas tablas. Al desplegar `Edson` la
  API arranca de nuevo y la puerta mira la base entonces; un proceso que
  hubiera mirado antes de la 0093 recuerda el «no» hasta reiniciarse
  (comprobado en local, §80).
- **Sin condiciones publicadas, nada se confirma**: es lo correcto hasta que
  la empresa escriba el texto (F9), pero encender la bandera sin publicarlas
  deja a la gente en «todavía no hay condiciones».
- **El barrido no lo llama nadie** (F13). No hace falta para la corrección
  (el vencimiento lo decide la hora), pero sin él las vencidas quedan `active`
  en la base hasta que alguien retiene en ese servicio: la supervisión lo
  dice por su estado efectivo.
- **Cambiar la agenda no toca las reservas** (E11/F10): un bloqueo o una
  excepción sobre una reserva confirmada no la cancela ni avisa. Borrar un
  bloqueo nunca deja una reserva sin protección: las reservas se protegen
  solas (la retención consumida ocupa en la base).
- **A domicilio no se contrata** hasta que la empresa decida la aceptación
  del prestador (F3).
- **Pagos**: la base no admite pedidos con precio. Encenderlos exigirá una
  migración nueva (estados `pending_payment`, importe, pasarela), un
  adaptador y su revisión: no basta con una bandera.
- **Un servicio muy disputado** espera como mucho 5 s por la fila del servicio
  y contesta 409 `service_booking_busy`: con el volumen previsto, no ocurre.
- **La baja de quien presta borra sus reservas pasadas** y lo que aceptó
  quien contrató (por el camino del servicio, como desde la 0090). Hasta que
  la empresa decida qué se conserva (F21), borrar la cuenta de un prestador
  con reservas pasadas se lleva esa evidencia.
- **C15** (D6) sigue pendiente antes de encender Servicios, y el **push**
  sigue sin llevar al destino (§32).

## 78. Qué queda para el Incremento 6 (no empezado)

Cancelar y reprogramar (con su política, F6), la aceptación del prestador y
lo que queda pendiente de ella (a domicilio, F3), el cobro real (estados de
pago, pasarela, comisión, costo de pasarela, comprobantes, devoluciones:
F14–F17) con su migración, recordatorios y avisos de vencimiento, el
planificador del barrido (F13), asistencia y cierre de la atención, reseñas
de lo contratado y posventa.

## 79. Estado y punto exacto de continuación

- **Incremento 5 de Z Servicios técnicamente cerrado; únicamente queda
  pendiente el QA físico** (§80). Al escribirse esta parte, el 30/09/2026, el
  estado era «implementado y probado; pendiente de aplicar y verificar la
  0093»: la 0093 se aplicó después y se verificó el 01/10/2026.
- `FEATURE_SERVICES`, `FEATURE_SERVICE_BOOKING` y `FEATURE_SERVICE_PAYMENTS`
  **apagadas**; `SERVICE_PAYMENTS_PROVIDER=none`; **no hubo despliegue**.
- Condiciones de contratación (`booking_terms`): **ninguna publicada**.
- Decisiones **F1–F21** de la empresa (`Z_REQUISITOS_Y_DECISIONES.md`); la
  **F21**, resaltada en §81.
- **No se empezó el Incremento 6.**

## 80. Cierre técnico del Incremento 5 (01/10/2026)

**La 0093 se ejecutó a mano en Supabase** después del informe del 30/09 y se
**verificó el 01/10/2026 a las 02:13 UTC** (30/09, 21:13 en Lima) **sin
divergencias**. No se volvió a ejecutar, no se tocó el fichero y **no se
escribió ningún dato en Supabase**. De §62 a §79 se describe el incremento;
donde decía «sin aplicar», manda esta sección.

Cuatro cosas distintas, que no hay que confundir:

| | Estado |
|---|---|
| **El esquema en Supabase** | La 0092 y la 0093 están **aplicadas y verificadas** (PostgreSQL 17.6) |
| **La verificación local** | Referencia 0001–0093 en PostgreSQL 17.11 desechable, puertas, recorrido y pruebas: todo correcto |
| **El código en `Edson`** | Completo y probado; **sin push, sin PR, sin merge y sin desplegar** |
| **Producción** | Sigue con el código anterior, que **no conoce** estas tablas: nada de esto afirma que producción reconozca la 0093. Lo hará cuando se despliegue `Edson` (la API arranca entonces y mira la base) |

### La verificación, en solo lectura

El verificador de la 0092, adaptado a la 0093, abre dos sesiones:
- **catálogos** (psycopg): `BEGIN READ ONLY`; `transaction_read_only = on` y
  una sonda de escritura (`create temp table`) **rechazada con 25006** antes
  de consultar nada; al terminar sigue en solo lectura, **sin id de
  transacción de escritura**, y `ROLLBACK`;
- **la de la API**: la misma `DATABASE_URL`, con asyncpg y SQLAlchemy como
  `app/shared/database.py`; `SET TRANSACTION READ ONLY` como primera
  sentencia, la misma sonda rechazada (25006) y `ROLLBACK`.

La URL sale del fichero de secretos autorizado: ni ella, ni el host, ni el
usuario se imprimen ni se guardan. Referencia: prólogo + 0001–0093 sobre
PostgreSQL 17.11 local desechable.

| Comprobación | Resultado |
|---|---|
| Esquema público entero frente a la referencia (1721 columnas, 1295 restricciones, 540 índices, 94 disparadores, 58 funciones, 165/165 tablas con RLS, 149 políticas; de Servicios, 24 tablas y 333 columnas) | **igual**: la 0001–0092 siguen intactas |
| Las seis tablas | normales y permanentes, RLS activa, **0 políticas**, del propietario esperado (también sus índices y sus funciones) |
| Columnas | las **91**, con su orden, tipo, nulabilidad, valor predeterminado (los 18), identidad o generación e intercalación |
| Claves primarias y únicas | **6** primarias y **4** únicas, validadas |
| Claves ajenas | **21**, validadas, con su tabla y columna de destino, `ON UPDATE` y `ON DELETE`: 15 en cascada, 3 `SET NULL` (quien contrata), 1 `RESTRICT` (la política aceptada) y **2 sin acción y diferidas** |
| **Las dos claves al prestador** | `service_orders_provider_id_fkey` y `service_bookings_provider_id_fkey`: `FOREIGN KEY (provider_id) REFERENCES service_providers(id) DEFERRABLE INITIALLY DEFERRED`, sin borrar nada. Es la **versión final** del fichero (la de la revisión, commit `440c91c`), no la primera |
| CHECK | los **42**, con su nombre y su definición, validados (estados, importes, modalidades, direcciones, aceptación) |
| Exclusión | `service_holds_sin_cruces`, **tal cual**: `EXCLUDE USING gist (service_id WITH =, tstzrange(occupied_from, occupied_until, '[)') WITH &&, starts_at WITH <>) WHERE (status IN ('active', 'consumed'))`; operadores `=(uuid,uuid)`, `&&(anyrange,anyrange)` y `<>(timestamptz,timestamptz)`; su índice GiST, válido |
| Índices | los **25** (6 primarios, 4 de las únicas, 1 de la exclusión y 14 propios, 4 de ellos únicos y parciales): definición, método, columnas, orden, clases de operadores y condición; **válidos, listos y vivos** |
| Disparadores | los **15**, habilitados y por fila, con su función, momento, evento y argumentos; **3 diferidos** (`service_bookings_coherentes`, `service_orders_completos`, `service_holds_con_reserva`); y los internos de las claves, como en la referencia |
| Funciones | las **7** nuevas: plpgsql, devuelven `trigger`, **SECURITY INVOKER**, `search_path=public, pg_temp`, cuerpo idéntico por su huella, sin EXECUTE para PUBLIC, `anon` ni `authenticated`. Las 3 que reutiliza (0086, 0089, 0090), idénticas a la referencia |
| Permisos de PUBLIC, `anon` y `authenticated` | **ninguno**: ni declarados (tabla o columna), ni en la ACL, ni efectivos. Con permisos, solo el propietario y `service_role` |
| Lo que escribió su transacción | **una sola** transacción; en el catálogo, sus 131 objetos y lo mismo que en la referencia (el CHECK de los tipos de política incluido); **ninguna fila de datos** en las 211 tablas de los esquemas que no son del sistema |
| Integridad de `public` | 360 claves ajenas: 0 filas huérfanas, 0 sin validar |
| §75, ejecutado tal cual | los siete resultados esperados |

**Los datos: las seis tablas están VACÍAS** (0 retenciones, pedidos, reservas,
datos de la atención, aceptaciones y líneas de historial) y no hay ninguna
condición de contratación en ningún estado. Los 25 recuentos de incoherencias
(huérfanas, estados imposibles, retenciones activas vencidas, reservas sin
pedido, pedidos sin reserva, aceptaciones sin reserva, sesiones superpuestas,
plazas por encima de la capacidad, importes o pasarela en un pedido,
direcciones fuera de «a domicilio»…) dan 0, pero **solo porque no hay filas**:
no prueban nada más que eso. Lo que impide esas incoherencias es el esquema,
que sí se comprobó.

El verificador se ensayó antes contra la referencia local (sin divergencias)
y contra la referencia estropeada a propósito (un permiso a `anon`, un valor
predeterminado quitado, la clave al prestador otra vez en cascada, un índice
único vuelto normal, una política, SECURITY DEFINER, un disparador apagado,
la exclusión quitada y datos incoherentes): dio **49 divergencias** y la
puerta dijo que no.

### Las puertas, con la conexión y el rol de la API

En un proceso nuevo la memoria de la puerta empieza **vacía**. Con la misma
conexión que usa la API (su rol: no superusuario, con BYPASSRLS, propietario
de las tablas), el código real dice **sí** a las cinco: `hay_admision`,
`hay_catalogo`, `hay_guardados`, `hay_agenda` y `hay_reservas`, y lo recuerda.
Las dos mitades de `hay_reservas` (las columnas del modelo y la consulta de
la 0093), por separado, también. Con las banderas como están (apagadas),
`exigir_reservas` y la puerta de las condiciones de contratación contestan
`services_disabled` **sin mirar la base**; con las dos encendidas solo en ese
proceso, las dos pasan.

En la referencia local, dentro de transacciones que se deshacen, la puerta
se cierra ante **30 alteraciones**: una columna ausente, de más o de otro
tipo, una nulabilidad distinta, una clave ajena con otra acción, **una clave
que deja de ser diferida**, un CHECK ausente o distinto o sin validar, la
exclusión ausente o distinta, un índice único vuelto normal, ausente, no
válido o no listo, un disparador ausente, deshabilitado o no diferido, una
función cambiada o SECURITY DEFINER, RLS apagada, una política, y un permiso
a `anon`, `authenticated` o PUBLIC (de tabla, de columna o de función). Un
error al mirar es **503 `services_not_ready`**, nunca 500, y **no se
recuerda**; el «no» sí se recuerda hasta reiniciar, que es el diseño (por eso
hay que reiniciar tras aplicar una migración).

**Lo único que la puerta no mira: los valores predeterminados.** Se midió si
eso deja pasar una base incompatible: con los **18** predeterminados de las
seis tablas quitados, los recorridos reales de la API (contratar lo gratuito,
lo que tiene precio, soltar, el barrido, a domicilio, las condiciones del
servicio, un grupo y reemplazar un horario) **pasan todos**, porque el dominio
envía cada valor explícitamente. No es un defecto y la puerta no se tocó. Queda
como prueba permanente (`test_servicios_reserva_predeterminados.py`): si el
código pasara a apoyarse en uno, falla (comprobado quitando el estado de la
retención: `NotNullViolation`), y entonces la puerta tendrá que mirarlo. En
Supabase los 18 están, comparados uno a uno.

### El reinicio y el recorrido integral (local, API real)

PostgreSQL 17 desechable; la API real en su propio proceso (uvicorn), con
`FEATURE_SERVICES` y `FEATURE_SERVICE_BOOKING` encendidas **solo en ese
proceso**, pagos apagados, sesiones HS256 reales con un secreto de usar y
tirar y el almacén de pruebas. **100 de 100 comprobaciones, 390 peticiones,
cinco procesos, ningún 500.**

- **La memoria de la puerta**: con 0001–0092, la reserva contesta 503
  `services_not_ready` y el calendario no ofrece continuar; se aplica la 0093
  en local y **el mismo proceso sigue en 503** (recuerda el «no»); se
  **reinicia** y la reconoce.
- **Lo gratuito, de punta a punta**: disponibilidad, retención (`seconds_left`
  del servidor), resumen, condiciones publicadas solo en la base local,
  confirmar con su versión y su huella; reserva, pedido gratuito, aceptación e
  historial; la retención, `consumed`; ningún movimiento de dinero; la ve
  quien contrata y su prestador; otra persona, 404.
- **Idempotencia**: repetir la retención (la misma, sin alargarla), la misma
  clave con otro contenido (409), confirmar dos veces y cinco a la vez (una
  reserva), soltar tres veces (una línea en el historial); en toda la base,
  ni dos reservas por retención o pedido.
- **Vencimiento**: lo vencido no se confirma ni ocupa aunque nadie lo barra;
  confirmar mientras se suelta, mientras vence y se barre, y el barrido (dos a
  la vez) mientras otros retienen, confirman, sueltan y leen.
- **Condiciones**: sin publicar no se confirma; la v2 publicada mientras se
  lee, 409; la huella antigua con la versión nueva, 409; vuelto a leer, 201
  con la v2; la reserva anterior conserva la v1.
- **Dinero**: precio fijo, 503 `service_booking_payments_not_configured` sin
  pedido ni reserva; «desde» y «a consultar», 409 sin apartar nada.
- **Agenda y seguridad**: servicio suspendido, retirado, con la categoría
  desactivada, de un prestador suspendido o con un bloqueo entre las dos
  personas (409 al confirmar, 404 al apartar); el prestador bloquea ese rato,
  pausa la agenda o cierra el día (409); una sesión ya empezada (409); una
  dirección fuera de «a domicilio» (422, no se guarda); un prestador
  suspendido conserva sus reservas; ningún correo ni teléfono.
- **Privacidad** (a domicilio encendido solo en ese proceso): la dirección, la
  referencia y la nota las ven quien contrata y su prestador; no están en
  administración, lo público, el historial, los avisos **ni los registros**.
- **Registros**: sin trazas, sin 500, sin el secreto de las sesiones ni
  cabeceras de autorización ni URL de base de datos.
- **Banderas**: con la contratación apagada, 503 `service_booking_disabled`;
  con Servicios apagado, 503 `services_disabled`.

### Concurrencia (muestra, sobre la 0093 tal como está aplicada)

La referencia local es idéntica a Supabase, así que estas pruebas valen para
la 0093 aplicada: diez personas por el mismo horario (una lo consigue);
capacidad de dos plazas con seis a la vez (dos); la misma `Idempotency-Key`
a la vez (una retención) y en dos retenciones distintas (409, nunca 500);
confirmar a la vez (una reserva); vencer contra confirmar; el barrido a
medias contra retener, confirmar y soltar, sin interbloqueo; dos conexiones
con sesiones que se pisan (la base rechaza la segunda). Nunca una doble
reserva, más plazas que capacidad, un pedido sin reserva ni una reserva sin
pedido; los conflictos, 409.

### Pruebas ejecutadas en el cierre

No cambió código funcional (solo dos ficheros de pruebas y la
documentación), así que la batería es la acotada:

| Qué | Resultado |
|---|---|
| Backend de Servicios con PostgreSQL (migraciones 0086–0093, puertas, admisión, catálogo, descubrimiento, guardados, agenda, reserva, la baja de cuenta y la configuración del dinero) | **648 aprobadas, 0 fallidas, 0 omitidas** |
| Lo mismo sin PostgreSQL | **322 aprobadas, 0 fallidas (326 omitidas por necesitar PostgreSQL)** |
| Móvil: Servicios (Incrementos 1–5) y las dos de traducciones (claves usadas y paridad es/en/pt) | **408/408** |
| `tsc --noEmit` | limpio |
| Rutas de la API | 522 operaciones, **0 duplicadas** (100 de Servicios) |
| `git diff --check` · secretos en el cambio | limpio · ninguno |
| Recorrido integral | **100/100** |

**No se repitió**, por no haber cambiado código funcional: la batería completa
del backend con y sin PostgreSQL (4166 y 3040 aprobadas sobre `6a74c85`), el
móvil completo (3563), Expo Doctor, la exportación web y las 48 mutaciones.
La única mutación nueva es la de la prueba de los predeterminados, descrita
arriba.

### La huella

`0093_servicios_reserva_y_contratacion.sql` consta en `APLICADAS`
(`test_servicios_migracion_0090.py`) con su huella git `1d878ace…`: desde
ahora una edición del fichero pone roja `test_las_aplicadas_no_han_cambiado`
(comprobado añadiéndole una línea). Su cabecera sigue diciendo «SIN APLICAR»
a propósito, como las anteriores: cambiarla sería editar lo aplicado.

### Veredicto

**Incremento 5 de Z Servicios técnicamente cerrado; únicamente queda
pendiente el QA físico.**

## 81. Lo que sigue pendiente y NO se implementó

Nada de esto se resolvió en el cierre, a propósito:

> **F21 · La baja de quien presta se lleva sus reservas pasadas.** Hoy,
> borrar la cuenta de un prestador borra sus servicios y, con ellos, sus
> reservas pasadas, sus pedidos, su historial **y lo que aceptó quien
> contrató**. Es el camino de borrado de la 0090, anterior a que hubiera
> reservas que conservar. Qué se conserva, cuánto tiempo y con qué base legal
> es una **decisión de la empresa**: no se modificó la 0090 ni se diseñó una
> solución. Hasta decidirlo, es un riesgo conocido antes de encender la
> contratación.

- **F1–F20** (`Z_REQUISITOS_Y_DECISIONES.md`): duración de la retención,
  tope por persona, qué modalidades se confirman solas, cancelación, avisos,
  monedas, comprobantes, comisión, devoluciones, identidad, conservación.
- **Publicar las condiciones de contratación** (`booking_terms`, F9): no hay
  ninguna publicada, y sin ellas no se confirma nada.
- **El planificador del barrido** (F13): nadie lo llama; el vencimiento lo
  decide la hora.
- **A domicilio** (F3): no se contrata hasta decidir la aceptación del
  prestador.
- **C15/D6**, antes de encender Servicios; y el **destino del push**, que
  sigue abriendo solo la aplicación.
- **Pagos, Stripe, comisiones, comprobantes y reembolsos**: no existen para
  Servicios, y la base no admite un pedido con precio.
- **Cancelar y reprogramar, la aceptación manual del prestador, la
  asistencia, las reseñas y la posventa**: Incremento 6, **no empezado**.
- **El QA físico** de los Incrementos 1–5 (`Z_QA_FISICO_PENDIENTE.md`).
- **Desplegar `Edson`**: no hubo push ni despliegue. Al hacerlo, la API
  arranca de nuevo y la puerta mira la base entonces.
