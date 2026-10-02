# Z Servicios: admisión de prestadores (Incremento 1), catálogo (Incremento 2), descubrimiento (Incremento 3), agenda (Incremento 4), reserva (Incremento 5) y atención y posventa (Incremento 6)

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
(§80); y la **Parte VI** (§82 en adelante), el 01/10/2026, con el Incremento 6
implementado y probado y, tras ejecutarse la 0094 a mano y verificarse ese
mismo día (14:28 UTC), **técnicamente cerrado** (§102). La **Parte VII** (§106 en
adelante), ese mismo día: la política operativa de cada reserva, congelada al
confirmarla (G18), implementada y probada y, tras ejecutarse la 0095 a mano y
verificarse (18:05 UTC), **técnicamente cerrada** (§118). Con ella quedan
cerrados **los seis incrementos** (§119).

El 02/10/2026 se consolidaron las **políticas de la primera versión** y se
depuró el registro de decisiones (§121): solo documentación, sin código ni
migraciones. Ese mismo día, la **Parte VIII** (§122 en adelante) cerró en el
código cinco de las políticas que el sistema todavía no imponía (P29, P5, P2,
P51 y P101), con la migración **0096**, que se aplicó a mano en Supabase y se
verificó ese mismo día (19:51 UTC) en solo lectura, **sin divergencias** (§131).

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
| **Incremento 6 (atención, posventa y cierre)** | **técnicamente cerrado; únicamente queda pendiente el QA físico** (§102). Cancelar, reprogramar, el código de asistencia, empezar, terminar y confirmar, la inasistencia, el caso con su expediente y sus evidencias privadas, la resolución y la apelación, la reseña verificada con su moderación, 19 avisos y los barridos. Con YAGNI estricto: lo no necesario para una atención gratuita no se construyó (§100) |
| **Migración 0094** | **APLICADA** a mano en Supabase y verificada el 01/10/2026 (14:28 UTC) en solo lectura: **sin divergencias** (§102). Las seis puertas de esquema, con la conexión y el rol reales de la API, la reconocen. Ya es histórica: no se edita, y **no se deshace**: se corrige hacia delante (§104) |
| **Política operativa congelada (G18)** | **técnicamente cerrada; únicamente queda pendiente el QA físico** (§118). Cada reserva guarda al confirmarse los nueve plazos y topes con los que después se decide, y solo se decide con esos: cambiar la configuración ya no cambia una reserva hecha |
| **Migración 0095** | **APLICADA** a mano en Supabase y verificada el 01/10/2026 (18:05 UTC) en solo lectura: **sin divergencias** (§118). Las seis puertas de esquema, con la conexión y el rol reales de la API, la reconocen. Ya es histórica: no se edita, y no se deshace |
| **Políticas de la primera versión** | **consolidadas el 02/10/2026** (§121): 105 políticas iniciales. De las 96 decisiones, 43 decididas para la primera versión, 14 valores provisionales y 25 que siguen necesitando a la empresa |
| **Cinco políticas cerradas en el código** | **implementadas y probadas el 02/10/2026** (§122): rutas opacas (P29), sin «a domicilio» (P5), solo en soles (P2), la capacidad fuera de lo público (P51) y el piloto por perfiles (P101). Código en `Edson`, **sin desplegar** |
| **Migración 0096** | **APLICADA** a mano en Supabase y verificada el 02/10/2026 (19:51 UTC) en solo lectura: **sin divergencias** (§131). Las seis puertas de esquema, con la conexión y el rol reales de la API, la reconocen. Ya es histórica: no se edita, y no se deshace |
| **Los seis incrementos** | **técnicamente cerrados** (§119): quedan el QA físico, las decisiones de la empresa y las integraciones externas (§120) |
| **Pagos** | **no existen**: solo se contrata lo gratuito; lo que tiene precio se detiene sin cobrar y la base no admite un pedido con precio (§68). `FEATURE_SERVICE_BOOKING` y `FEATURE_SERVICE_PAYMENTS`, **apagadas**; la pasarela, `none`. Los pagos de la plataforma siguen **apagados** |
| **Bloqueo para encender** | **Resuelto** (§12): la 0089 aplicada y verificada, y `DELETE /auth/me` corregido en `Edson` |
| **Código** | En la rama `Edson`, **sin desplegar**: sin push, PR ni merge. La API de producción sigue con el backend anterior |
| **QA físico** | pendiente de los seis incrementos: `docs/Z_QA_FISICO_PENDIENTE.md`, sección de Servicios |

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
| **Incremento 6** | Al escribirse esta parte no se había empezado (§78). Se implementó después, el 01/10/2026: **Parte VI** |

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
   lo que dejó; si algo falla, no queda nada. Es reejecutable **mientras no
   esté la 0094 encima**: con ella, se niega sin cambiar nada (§102), y así
   debe ser. La 0093 ya no se vuelve a ejecutar.
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

> *Al 01/10/2026:* el Incremento 6 se implementó después (Parte VI). De
> esta lista llegaron cancelar y reprogramar, los recordatorios, la
> asistencia y el cierre, las reseñas y la posventa; **no** la aceptación
> del prestador, el cobro ni el planificador (§100).

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
- **No se empezó el Incremento 6** (al cerrarse el 5; se implementó después:
  Parte VI).

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
  asistencia, las reseñas y la posventa**: Incremento 6, **no empezado** al
  cerrarse el 5. Se implementó después (Parte VI), salvo la aceptación del
  prestador.
- **El QA físico** de los Incrementos 1–5 (`Z_QA_FISICO_PENDIENTE.md`).
- **Desplegar `Edson`**: no hubo push ni despliegue. Al hacerlo, la API
  arranca de nuevo y la puerta mira la base entonces.

# Parte VI · Incremento 6: atención, cancelación, reprogramación, posventa y cierre

Escrito el 01/10/2026 en la rama `Edson`, con el Incremento 6 **implementado y
probado**. Después la 0094 se ejecutó a mano en Supabase y se verificó ese
mismo día (14:28 UTC) sin divergencias: el incremento quedó **técnicamente
cerrado** (§102). El código sigue **sin desplegar** (sin push, PR ni merge),
Servicios **sin activar** y **nada mueve dinero**. Solo queda el QA físico. De
§82 a §101 se describe el incremento tal como se escribió; donde decía «sin
aplicar», manda §102.

Se hizo con **YAGNI estricto**, a petición expresa: solo lo necesario para
recorrer de principio a fin una atención **gratuita**, segura y verificable.
Lo que el alcance menciona y no hacía falta para eso **no se implementó** y
está listado en §100.

## 82. Estado del Incremento 6

| | |
|---|---|
| **Qué hace** | Sobre una reserva confirmada (Incremento 5): **cancelarla** o **cambiarle el horario** antes de que empiece; el **código de asistencia** de quien contrata; el prestador **empieza** y **termina**; quien contrata **confirma** (o un barrido la cierra, solo con la señal fuerte); declarar una **inasistencia**; abrir un **caso** con su expediente y sus **evidencias privadas**; administración **resuelve**, una parte **apela** una vez y resuelve otra persona; la **reseña verificada**, la respuesta del prestador y su **moderación**; recordatorios; y 19 avisos |
| **Migración 0094** | **APLICADA** a mano en Supabase y verificada en solo lectura el 01/10/2026, **sin divergencias** (§102). Cómo se aplica, en §96; qué se consulta, en §97 |
| **Sin la 0094** | La contratación del Incremento 5 **sigue funcionando**: el detalle de una reserva trae `care: null` y la app no ofrece ninguna acción nueva. Las 33 rutas privadas de la atención contestan **503 `services_not_ready`** sin escribir nada; las reseñas públicas contestan 200 con `available: false`; la ficha dice 0 reseñas y promedio `null`. Nunca un 500. *Era así hasta la corrección G18: desde ella la reserva exige además la 0095 y, sin ella, contesta 503 entera (§114)* |
| **Banderas** | Las mismas: `FEATURE_SERVICES` y `FEATURE_SERVICE_BOOKING` **apagadas**, `FEATURE_SERVICE_PAYMENTS` **apagada**, `SERVICE_PAYMENTS_PROVIDER=none`. **No hay bandera nueva**: la atención va con la contratación. Apagadas: 503 `services_disabled` / `service_booking_disabled`, antes de mirar la base |
| **Dinero** | **Ninguno.** Nada se cobra, se devuelve, se retiene ni se transfiere. El «efecto económico» de un caso es una **solicitud** con su estado, y ese estado **no puede decir «ejecutado»** (§90) |
| **Código** | En `Edson`, **sin desplegar**: sin push, PR ni merge |
| **QA físico** | **pendiente** (`Z_QA_FISICO_PENDIENTE.md`, «Incremento 6») |

## 83. El modelo (4 tablas, 0094) y lo que cambia de la 0093

Cuatro tablas nuevas, y ninguna más:

| Tabla | Qué es |
|---|---|
| `service_attendances` | **La atención** de una reserva (su clave es la de la reserva): el estado, el código de asistencia y sus intentos, cuándo empezó y si fue **con el código** (la señal fuerte), cuándo terminó, la confirmación de quien contrata, el cierre (cuándo y por quién: `client`, `system` o `admin`) y la inasistencia |
| `service_incidents` | **El caso**: uno por reserva **sin contar los retirados**. Quién lo abrió, el motivo, la descripción, su estado, lo resuelto (`outcome`), el efecto en la atención, el **efecto económico solicitado** y su estado, quién y cuándo resolvió, cuántas resoluciones (0–2) y la apelación |
| `service_incident_entries` | **El expediente**, que solo se añade: `message`, `evidence`, `resolution`, `appeal` e `internal_note`, con su autor y su función. La evidencia guarda la ruta que genera el servidor, el tipo, el peso y la huella |
| `service_reviews` | **La reseña verificada**: una por reserva, del servicio de esa reserva, con la nota (1–5), cuatro ejes opcionales, si lo recomienda, el comentario, el estado de moderación y la respuesta del prestador |

**No hay tabla de cancelaciones, de reprogramaciones ni de efectos
financieros.** Cancelar y reprogramar son un cambio **controlado** de
`service_bookings` más su línea en `service_booking_events`; el efecto
económico son dos columnas del caso. No se creó «un cuarto sistema
financiero».

**Lo que cambia de la 0093, y nada más** (ninguna columna nueva en sus tablas):

- tres CHECK se amplían: el estado de la reserva admite `cancelled`, y el
  historial admite las acciones y los roles (`provider`, `admin`) de este
  incremento;
- `servicios_reserva_inmutable()`: una reserva sigue sin reescribirse, salvo
  **cancelarla** (cambia el estado y nada más) y **reprogramarla** (cambia su
  retención y su horario y nada más: la duración, la versión, el precio y lo
  aceptado no se tocan), y solo si la atención no empezó;
- `servicios_retencion_salto_valido()`: una retención consumida se **libera**
  cuando ya no hay una reserva confirmada sobre ella;
- un disparador **diferido** nuevo (`service_bookings_coherentes_al_cambiar`):
  al confirmar la transacción, una reserva cancelada no sigue ocupando su
  horario y una reprogramada no sigue ocupando el anterior.

**Después de la 0094, la 0093 ya no se reejecuta** encima (se niega, cerrada,
sin cambiar nada): es deliberado y está probado. El orden es siempre
0093 → 0094.

La base impone, además: los saltos de la atención y del caso (§84), que una
reseña **solo se guarda con su atención cerrada**, de quien contrató esa
reserva y del servicio de esa reserva; que el expediente no se edita ni se
borra suelto; que nada se borra si no es en cascada desde su reserva; RLS
activa, **cero políticas** y cero permisos para `anon` y `authenticated`; y el
depósito **privado** `service-incident-evidence` (PDF, JPEG, PNG y WebP,
10 MB), sin políticas.

De paso se cierra un permiso de la 0086: `servicios_borrado_solo_en_cascada()`
era ejecutable por PUBLIC (inocuo: una función de disparador no se llama
directamente).

## 84. Estados: mapas pequeños y explícitos

**La reserva**: `confirmed` → `cancelled` (final). Reprogramar no cambia el
estado.

**La atención** (`service_attendances.status`; sin fila = no empezó):

| De | A |
|---|---|
| (sin fila) | `code_issued` (quien contrata pide su código), `in_progress` (el prestador empieza sin código), `no_show_client` / `no_show_provider` (una ausencia declarada) |
| `code_issued` | `in_progress`, `closed`, `no_show_*` |
| `in_progress` | `completed` (el prestador termina), `closed` (quien contrata confirma), `no_show_*` (solo por resolución) |
| `completed` | `closed` (quien contrata, el barrido o una resolución), `no_show_*` (solo por resolución) |
| `no_show_client` ↔ `no_show_provider` | entre sí y a `closed`, solo por resolución de administración |
| `closed` | **final**. Una atención cerrada no se desmiente, tampoco al resolver una apelación |

**El caso** (`service_incidents.status`): `open` → `resolved` | `withdrawn`;
`resolved` → `appealed`; `appealed` → `closed`. `closed` y `withdrawn` son
finales. Lo que lo abrió (reserva, quién, motivo, descripción) no se reescribe
y una resolución no se borra. `open` y `appealed` son los **vivos**: mientras
haya uno, la atención no se confirma ni se cierra sola.

**La reseña** (`service_reviews.status`): `pending` (a la espera de
moderación), `published`, `hidden`. Administración publica o esconde; nunca la
borra ni la reescribe.

**El efecto económico** (`financial_effect_status`): `not_applicable`,
`pending`, `blocked`. No existe ningún valor que diga que se ejecutó, ni en el
código ni en la base.

## 85. Lo que se puede hacer lo dice el servidor

`atencion.acciones_disponibles` es la **única autoridad**: calcula, para quien
mira, qué puede hacer **ahora** con esa reserva, y cada transición comprueba
exactamente lo mismo. Viaja en el detalle de la reserva (`care.available_actions`)
y en el expediente del caso. La app **no ofrece nada que no esté ahí** y no
decide por la hora del teléfono ni por el estado.

| Acción | Quién | Cuándo |
|---|---|---|
| `cancel` | quien contrata o el prestador | confirmada, sin empezar y **antes de la hora de inicio** |
| `reschedule` | quien contrata | confirmada, sin empezar, con la antelación mínima, sin haber agotado sus cambios y si el servicio sigue publicado en **la misma versión** |
| `issue_code` | quien contrata | desde que se abre la llegada hasta el final de la sesión |
| `start` | el prestador, **activo** | en esa misma ventana |
| `complete` | el prestador | en curso |
| `confirm` | quien contrata | en curso o terminada, **sin un caso vivo** |
| `report_absence` | cualquiera de los dos | pasada la tolerancia, si no empezó |
| `open_incident` | cualquiera de los dos | desde la hora de inicio, si no hay un caso vivo o decidido y **no retiró el suyo** |
| `add_incident_entry` | cualquiera de los dos | con el caso vivo |
| `withdraw_incident` | quien lo abrió | mientras nadie lo haya resuelto |
| `appeal_incident` | cualquiera de los dos | resuelto una vez, dentro del plazo, con las apelaciones encendidas y **si hay otra persona que pueda resolverlo** |
| `review` | quien contrata | atención **cerrada**, sin reseña y dentro del plazo |
| `reply_review` | el prestador | reseña publicada y sin respuesta |

Además, `care.incident_reasons` dice con qué **motivos** se puede abrir un
caso ahora (pasado el plazo ordinario, solo `safety`), y el expediente de
administración dice qué puede hacer quien lo mira (`add_internal_note`,
`add_incident_entry`, `resolve_incident`) y con qué efectos en la atención
(`attention_effects`).

## 86. Cancelar y reprogramar

**Cancelar** (`POST …/cancel`): quien contrata o su prestador, antes de la
hora de inicio y si la atención no empezó. Un motivo de la lista
(`change_of_plans`, `unavailable`, `operational`, `other`) y una nota; **el
prestador tiene que explicar por qué**. En una transacción: la reserva pasa a
`cancelled`, **su horario se libera** (la retención vuelve a `released`) y
queda la línea del historial. El pedido y lo aceptado **se conservan**. A la
otra parte se le avisa. Su efecto económico es «no aplica».

**Reprogramar** (`POST /services/me/bookings/{id}/reschedule`): solo quien
contrata. Primero **aparta** el horario nuevo como en el Incremento 5 (una
retención suya del mismo servicio) y después pide el cambio con esa retención.
En una transacción: la retención nueva se consume, la reserva cambia de
horario y la anterior se libera; si algo falla, **la reserva original sigue en
pie**. **El contrato no cambia**: mismo pedido, misma reserva y mismo código,
misma versión, mismo precio, mismas condiciones aceptadas, misma duración y
modalidad. Si el servicio publicó otra versión, **409
`service_booking_version_changed`**: no se reprograma a otro contrato. El
horario nuevo se vuelve a calcular con la agenda de ahora.

Provisionales (decisiones G1 y G2): **una** reprogramación y **24 horas** de
antelación; cancelar, hasta la hora de inicio y sin consecuencias (lo gratuito
no tiene ninguna). El prestador **no reprograma** (no se implementó).

## 87. La asistencia: llegar, empezar, terminar, confirmar

- **El código de asistencia.** Desde 15 minutos antes de la hora y hasta el
  final de la sesión, quien contrata pide su código: **seis cifras**, del
  servidor; pedirlo otra vez devuelve el mismo. Lo ve en su reserva; **el
  prestador nunca lo recibe** por ninguna respuesta ni por el historial.
- **Empezar.** El prestador empieza con el código (lo enseña o lo dicta quien
  contrata): es la **señal fuerte**. Cinco intentos, comparación en tiempo
  constante; un intento fallido **se guarda** y contesta 409 con los que
  quedan; agotados, ni con el bueno. También puede empezar **sin código**: es
  una declaración suya, la señal débil. Un prestador suspendido no empieza.
- **Terminar.** El prestador marca la atención como realizada: `completed`. No
  cierra nada ni libera nada.
- **Confirmar.** Quien contrata confirma: `closed`, cerrada por `client`.
- **El cierre automático.** Un barrido (§92) cierra las terminadas cuyo plazo
  de confirmación pasó (24 h, provisional), **solo si empezaron con el código
  y no tienen un caso vivo**. Sin la señal fuerte **no se cierran solas**: se
  cuentan y esperan a quien contrata o a un caso.
- **La inasistencia.** Pasada la tolerancia (15 min, provisional) y si no
  empezó, cualquiera de las dos partes declara que la otra no vino. Es una
  **declaración**, sin efecto económico; a la otra parte se le avisa y puede
  discutirla abriendo un caso.

No se implementó: QR, señales de sala de 100ms, geolocalización, ni que el
prestador acepte la reserva (a domicilio sigue sin contratarse).

## 88. El caso: expediente, evidencias, resolución y apelación

- **Abrirlo**: una de las dos partes, desde la hora de inicio, con un motivo
  de **su** lista y una descripción (20–2000). Motivos: `provider_absent`,
  `client_absent`, `incomplete`, `different_service`, `quality`, `safety`,
  `technical`, `other`; nadie se reporta ausente a sí mismo. Plazo: 48 h desde
  que terminó (provisional); **los de seguridad no tienen plazo**.
- **Uno por reserva, sin contar los retirados.** Con uno vivo o decidido no se
  abre otro (tampoco por seguridad: se escribe en ese). Uno **retirado** no lo
  impide a la otra parte; quien retiró el suyo ya no abre otro en esa reserva
  (como mucho, dos por reserva).
- **El expediente** solo se añade: mensajes de las dos partes y de
  administración, evidencias, la resolución, la apelación y las **notas
  internas**, que nunca salen de administración.
- **La evidencia**: PDF o foto, validada **por sus bytes**; va al depósito
  privado con una ruta que genera el servidor
  (`<perfil>/<caso>/<uuid>.<ext>`); se sube antes de bloquear nada y, si su
  fila no se llega a escribir, se borra; el mismo archivo dos veces es el
  mismo. Hasta **10 por parte**. Se mira con un **enlace firmado que caduca en
  120 segundos**, que piden las dos partes y administración. Nunca una URL
  permanente, nunca en un aviso, nunca su ruta en una respuesta.
- **Resolver** (solo administración): dice **por separado** qué se decidió
  (`upheld`, `partially_upheld`, `rejected`) y por qué, su efecto en la
  atención (`none`, `completed`, `provider_no_show`, `client_no_show`), el
  efecto económico **solicitado** y su estado, quién y cuándo. Un caso abierto
  queda `resolved`; uno apelado, `closed`. Si el efecto es `completed`, la
  atención queda cerrada por `admin` y se puede reseñar. **Una atención ya
  cerrada no se desmiente**: tampoco al resolver la apelación.
- **Nadie resuelve lo suyo**: quien es parte de la reserva no resuelve, no
  escribe ni **lee** el expediente de administración (409
  `service_incident_resolver_conflict`); y quien resolvió no resuelve su
  apelación.
- **Apelar**: una vez (o ninguna: `SERVICES_INCIDENT_APPEALS_MAX`, 0–1), de
  cualquiera de las partes, dentro de 5 días (provisional) y diciendo por qué.
  **Solo se ofrece si en administración hay otra persona que pueda
  resolverlo**; con una sola, la resolución es definitiva.
- **Retirar**: quien lo abrió, mientras nadie lo haya resuelto.

## 89. La reseña verificada y su moderación

De una atención **cerrada**, de quien la contrató, **una por reserva** y
dentro de 30 días (provisional). «Verificada» no es un campo que alguien pueda
editar: **la base no guarda una reseña sin su atención cerrada**. Nota de 1 a
5, cuatro ejes opcionales (cumplimiento, calidad, puntualidad, claridad), si
lo recomienda y un comentario (20–2000).

- **Moderación previa** (encendida de fábrica, provisional): nace `pending` y
  nadie más la ve hasta que administración la publica. Apagada, nace
  publicada.
- **Lo público**: `GET /services/catalog/{id}/reviews`, sin sesión, con las
  publicadas y su resumen. **Sin reseñas, el promedio es `null`, no cero.** La
  ficha y el perfil del prestador dicen cuántas y su promedio.
- **No dice quién la escribió.** La identidad pública de quien reseña es una
  decisión pendiente (G11): la reseña pública no lleva ningún identificador de
  su autor. Solo moderación lo sabe.
- **El prestador responde una vez**, en público; no se reescribe.
- **Administración** la publica o la esconde, con un motivo de una lista
  cerrada al esconder (`personal_data`, `threat`, `hate`, `extortion`,
  `off_topic`, `other`; **«es negativa» no existe**). No la borra ni la
  reescribe, queda en el historial, y quien es parte no modera.

## 90. El dinero: nada se mueve, y nada se finge

- Solo se contrata lo gratuito (Incremento 5), así que hoy **todo** efecto
  económico es `not_applicable`: el de cancelar, el de una inasistencia y el
  de una resolución.
- Una resolución puede **solicitar** `full_refund` o `partial_refund`. Su
  estado lo decide **una sola función** (`atencion.estado_del_efecto`): sin
  dinero en el pedido, `not_applicable`; con dinero y sin cobro disponible,
  `blocked`; con dinero y cobro, `pending`, a la espera de un adaptador. Hoy
  las dos últimas ramas son **inalcanzables**: no hay pedidos con importe.
- **Ningún estado dice «ejecutado»**: ni el código, ni el contrato de la API
  (pedirlo es un 422), ni la base (el CHECK no lo admite y la migración se
  niega a terminar si lo admitiera).
- No se llama a Stripe ni a ninguna pasarela, no se crea saldo, no se
  compensa con otro módulo, no hay comisión, webhooks ni transferencias.
  Tampoco se reutilizó el sistema de devoluciones de Cursos, Eventos o
  Productos: no hay nada que devolver.
- `GET /admin/services/incidents?with_financial_effect=true` es la vista de
  «efectos solicitados»: de **lectura**.

Cuando haya pagos, el punto de conexión es ese estado (`pending`) y el
adaptador de devoluciones existente; está descrito, no construido (G13).

## 91. Avisos (19 tipos)

En la bandeja y por push, en **es, en y pt**, con el contenido **vacío**
(`{}`): solo el tipo y la entidad a la que llevan (la reserva, o el caso para
el equipo). Nunca una dirección, una nota, un motivo, una evidencia ni un
código. Idempotentes: repetir una petición con su clave no vuelve a avisar.

| Aviso | A quién |
|---|---|
| `service_booking_cancelled_provider` / `_client` | a la otra parte de quien cancela |
| `service_booking_rescheduled_provider` | al prestador |
| `service_booking_reminder_client` / `_provider` | a las dos partes, una vez |
| `service_attention_completed_client` | a quien contrata: falta su confirmación |
| `service_attention_absent_client` / `_provider` | a quien se declaró ausente |
| `service_incident_opened_client` / `_provider` / `_team` | a la otra parte y a administración |
| `service_incident_updated_client` / `_provider` | a la otra parte (mensaje, evidencia, retirada, apelación) |
| `service_incident_resolved_client` / `_provider` | a las dos |
| `service_incident_appealed_team` | a administración |
| `service_review_available_client` | a quien contrata, al cerrarse la atención |
| `service_review_received_provider` | al prestador, cuando la reseña se ve |
| `service_review_replied_client` | a quien reseñó |

Los avisos llevan a la reserva, al caso o, para el equipo, a la bandeja de
casos. **El push sigue abriendo solo la aplicación** (pendiente desde el
Incremento 1): el destino funciona desde la bandeja.

## 92. La API (34 rutas) y la puerta

Todas bajo `/api/v1`. Las de las partes existen dos veces, con el mismo
contrato: `/services/me/bookings/{id}` (quien contrata) y
`/services/provider/bookings/{id}` (el prestador).

| Ruta | Quién |
|---|---|
| `POST …/cancel` | las dos partes |
| `POST …/no-show` | las dos partes |
| `POST …/incident` · `GET …/incident` | las dos partes |
| `POST …/incident/entries` · `POST …/incident/evidence` | las dos partes |
| `GET …/incident/entries/{entry_id}/file` | las dos partes (enlace firmado) |
| `POST …/incident/withdraw` · `POST …/incident/appeal` | las dos partes |
| `POST /services/me/bookings/{id}/reschedule` · `/check-in-code` · `/confirm` · `/review` | quien contrata |
| `POST /services/provider/bookings/{id}/start` · `/complete` · `/review/reply` | el prestador |
| `GET /services/catalog/{service_id}/reviews` | **público** |
| `GET /admin/services/incidents` · `GET …/{incident_id}` | administración |
| `POST /admin/services/incidents/{id}/entries` · `GET …/entries/{entry_id}/file` · `POST …/resolve` | administración |
| `GET /admin/services/reviews` · `POST …/{review_id}/moderate` | administración |
| `POST /admin/services/tasks/run` | administración (los barridos) |

Y dos rutas del Incremento 5 cambian sin romper a nadie: el detalle de una
reserva (de quien contrata y del prestador) trae ahora `care` (o `null` sin la
0094), y la ficha y el perfil públicos traen `reviews: {count, average}`.

**Respuestas**: 401 sin sesión; 403 a quien no es administración (el rol va
antes que las puertas); **404** para lo ajeno y lo que no existe, sin decir
cuál; **409** para lo que ya no se puede (con su código estable); **422** para
lo mal formado y para la falta de `Idempotency-Key`; **503** con las banderas
apagadas o sin la migración. Una evidencia que el almacén no puede guardar o
firmar es un **502 `service_evidence_unavailable`**.

**Toda transición lleva `Idempotency-Key`**: la misma clave con lo mismo es la
misma petición (200, sin repetir nada ni volver a avisar); con otra acción,
otra reserva u otro contenido, **409 `idempotency_key_reused`**.

**La puerta de la 0094** (`esquema.hay_atencion`) exige la migración
**completa por definición**: las 57 columnas y ninguna más, las claves con su
acción al borrar, los 37 CHECK por su huella, los índices por su definición
(entre ellos el único parcial del caso), los disparadores con su función y
sus argumentos, los cuerpos de las funciones por su huella, RLS sin
políticas, ningún permiso de fuera y el depósito privado; y la 0093 tal como
la 0094 la deja. Ante la duda, no. El «sí» y el «no» se recuerdan hasta
reiniciar; un error al mirar es un 503 y no se recuerda. **Si se retoca la
0094 hay que recalcular esas huellas.** `hay_reservas` (Incremento 5) acepta
la 0093 pura **y** la 0093 enmendada por la 0094, así que el código nuevo
funciona antes y después de aplicarla. *Desde la corrección G18 solo acepta
la 0093 tal como la dejan la 0094 y la 0095 (§114).*

**Los barridos** (`POST /admin/services/tasks/run`, por lotes de 200, hasta
1000): recuerdan las reservas que empiezan en las próximas 24 h (una vez cada
una) y cierran las atenciones que se pueden cerrar. Idempotentes; **cada fila
se confirma antes de pasar a la siguiente** (no retienen un lote de reservas
bloqueadas); lo que otra petición tiene bloqueado se salta; lo que no se
puede cerrar **no ocupa el lote**. **Nadie los llama todavía**: sin cron,
Lambda ni EventBridge (decisión de la empresa, G12).

## 93. Vistas y navegación (móvil)

| Ruta de la app | Pantalla |
|---|---|
| `/servicios/reservas/[bookingId]` | la reserva de quien contrata, ahora con el panel de la atención (`AtencionDeLaReserva`): el código, los plazos, las acciones que manda el servidor, el caso y la reseña |
| `/servicios/reservas/[bookingId]/cancelar` | cancelar, con lo que implica antes de confirmar |
| `/servicios/reservas/[bookingId]/reprogramar` | reprogramar: lleva a los horarios del servicio en modo «cambiar horario» y confirma el cambio |
| `/servicios/reservas/[bookingId]/caso` | abrir el caso o ver su expediente: mensajes, evidencias, retirar, apelar |
| `/servicios/reservas/[bookingId]/resena` | escribir la reseña |
| `/servicios/prestador/reservas/[bookingId]` | la reserva del prestador: empezar (con o sin código), terminar, declarar la ausencia, responder a la reseña |
| `/servicios/prestador/reservas/[bookingId]/cancelar` · `/caso` | lo mismo, para el prestador |
| `/admin/servicios/casos` · `/casos/[incidentId]` | la bandeja de casos (y la de efectos solicitados) y el expediente entero, con la resolución |
| `/admin/servicios/resenas` | la moderación de reseñas |

La ficha pública del servicio enseña las reseñas publicadas y su promedio
(`ListaDeResenasDelServicio`), o «todavía no hay reseñas». Todo en es, en y
pt. Ninguna pantalla decide por el estado ni por la hora del teléfono: lo que
se ofrece sale de `available_actions`, `incident_reasons` y
`attention_effects`.

## 94. Privacidad y permisos

- **Lo ajeno es un 404**: una tercera persona, otro prestador o administración
  por las rutas de las partes.
- **El código de asistencia** solo lo ve quien contrata, y solo hasta que la
  atención empieza. No está en el historial, en los avisos ni en los
  registros.
- **Las notas internas** no salen de administración; **la ruta de una
  evidencia** no sale del servidor.
- **La nota y la dirección de quien contrata** son para atenderle: de una
  reserva **cancelada**, el prestador deja de verlas.
- **La reseña pública** no lleva el identificador de quien la escribió.
- **Administración**: solo `admin` decide (la moderación de contenidos,
  `moderator`, no entra). Quien es parte de una reserva no lee, escribe,
  resuelve ni modera lo suyo.
- **La bandeja de casos** no enseña la descripción ni nada privado de las
  partes.
- **La baja de una cuenta**: la de quien contrata se lleva **sus evidencias**
  del depósito (el expediente conserva la fila, sin su archivo: pedir su
  enlace es un 502) y deja la reseña y el caso **sin su nombre**; con una
  atención por venir, la cuenta no se borra (como en el Incremento 5). La de
  quien presta sigue llevándose todo lo de sus servicios (**F21, sin
  resolver**).

## 95. Concurrencia (probada con PostgreSQL de verdad)

**Orden de los cerrojos**: la fila del servicio (solo al cancelar y al
reprogramar, que tocan su horario) → la fila de la reserva (`FOR NO KEY
UPDATE`) → las retenciones → el cerrojo de la persona → la búsqueda de la
clave. Un cerrojo que no llega (55P03) o un interbloqueo (40P01) son **409
`service_booking_busy`**, nunca un 500.

| Carrera | Resultado |
|---|---|
| Cancelar y reprogramar a la vez | gana una; nada queda a medias |
| Reprogramar dos veces a la vez | se mueve una vez |
| Reprogramar mientras el prestador bloquea ese día | 409 o se mueve, coherente |
| Empezar y cancelar a la vez | gana una |
| Terminar, confirmar y abrir un caso a la vez | ningún 500, estado coherente |
| Dos resoluciones a la vez | una resuelve; la otra, 409 |
| Dos reseñas y dos respuestas a la vez | queda una |
| Barridos a la vez, y mientras quien contrata confirma | cada atención se cierra **una** vez |
| La misma clave cinco veces a la vez | una sola acción y un solo aviso |
| Subir una evidencia con la reserva ocupada | 409, y el archivo no se queda |

## 96. Cómo aplicar la 0094

**Aplicada** a mano en Supabase y verificada el 01/10/2026 (§102): los pasos 1
a 4 y el 6 están hechos; el 5 corresponde al despliegue de `Edson`, que no se
ha hecho; el 7 sigue siendo de la empresa. Así se aplicó (y así se aplicaría
en otra base):

1. Comprobar que la base tiene la **0086–0093** (la 0094 se niega sin ellas).
2. **Antes de desplegar el código.** El código nuevo funciona sin la 0094
   (§82), pero la baja de una cuenta recorre también el depósito
   `service-incident-evidence`, que **no existe hasta aplicarla**. No se pudo
   comprobar contra Supabase cómo contesta el listado de un depósito que no
   existe; si fuera un error, las bajas fallarían (cerradas: no borran nada a
   medias) hasta aplicar la migración. Aplicando primero la 0094, el riesgo
   desaparece.
3. Pegar el fichero **entero** en el editor SQL de Supabase y ejecutarlo: es
   **una sola transacción**, comprueba lo anterior antes de crear nada y
   verifica lo que dejó; si algo falla, no queda nada. Es reejecutable.
4. Verificar (§97) en una sesión de **solo lectura**, también con el rol real
   de la API (la puerta `hay_atencion` tiene que decir «sí»).
5. **Reiniciar la API** (o desplegar `Edson`, que la reinicia): la puerta
   recuerda el «no».
6. Registrar su huella en `APLICADAS` (`test_servicios_migracion_0090.py`) y
   repetir el recorrido de cierre.
7. **Después**, y solo si la empresa lo decide: encender
   `FEATURE_SERVICE_BOOKING` (con `FEATURE_SERVICES` y con las condiciones de
   contratación publicadas, F9). Antes: que haya **al menos dos personas** en
   administración si se quieren apelaciones (G8/G15), y decidir quién llama a
   los barridos (G12).

**No hay rollback en producción.** El bloque de la cabecera del fichero solo
vale para una **base local desechable**, que es donde se probó: borra tablas
y la fila del depósito, y nunca se ejecutó contra Supabase. Una migración
aplicada **no se deshace**: se apagan las banderas y se corrige **hacia
delante**, con una migración nueva (§104).

## 97. Verificar la 0094 (solo lectura)

En una transacción `BEGIN READ ONLY`, tras comprobar que una escritura se
rechaza (25006), y terminando con `ROLLBACK`:

```sql
-- 1. La puerta, con el rol de la API: tiene que decir true
--    (las dos consultas de esquema.hay_atencion: _LO_QUE_NECESITA_LA_RESERVA y
--    _LO_QUE_NECESITA_LA_ATENCION. Desde la corrección G18 la primera exige,
--    además, la 0095: §114).
-- 2. Las cuatro tablas, con RLS y sin políticas.
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as politicas
  from pg_class c
 where c.relname in ('service_attendances', 'service_incidents', 'service_incident_entries', 'service_reviews')
   and c.relnamespace = 'public'::regnamespace;
-- 3. Un caso por reserva sin contar los retirados: único y parcial.
select pg_get_indexdef('public.service_incidents_una_por_reserva'::regclass);
-- 4. El efecto económico no admite «ejecutado».
select pg_get_constraintdef(oid) from pg_constraint where conname = 'service_incidents_estado_del_efecto';
-- 5. Los tres CHECK ampliados de la 0093.
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conname in ('service_bookings_estado', 'service_booking_events_accion', 'service_booking_events_rol');
-- 6. El disparador diferido nuevo de la reserva.
select tgname, tgdeferrable, tginitdeferred from pg_trigger
 where tgname = 'service_bookings_coherentes_al_cambiar';
-- 7. El depósito, privado, con su peso y sus formatos.
select id, public, file_size_limit, allowed_mime_types from storage.buckets
 where id = 'service-incident-evidence';
-- 8. Nadie de fuera con permisos (0 filas).
select table_name, grantee, privilege_type from information_schema.table_privileges
 where table_schema = 'public'
   and table_name in ('service_attendances', 'service_incidents', 'service_incident_entries', 'service_reviews')
   and grantee in ('anon', 'authenticated', 'PUBLIC');
-- 9. Vacías recién aplicada, y ninguna reserva cancelada.
select (select count(*) from public.service_attendances) as atenciones,
       (select count(*) from public.service_incidents) as casos,
       (select count(*) from public.service_reviews) as resenas,
       (select count(*) from public.service_bookings where status <> 'confirmed') as canceladas;
```

Y comparar el esquema entero con una referencia local 0001–0094, como en §61
y §80.

## 98. Pruebas, mutaciones y revisión (01/10/2026)

Todo contra un PostgreSQL 17 **local y desechable** (contenedor de pruebas,
borrado al terminar). Nada tocó Supabase.

| Qué | Resultado |
|---|---|
| **La migración 0094** (`test_servicios_migracion_0094.py`): desde cero, igual al modelo por definición, sobre la 0093 vacía y con reservas, reejecutada con datos, con un fallo a mitad, sin cada dependencia, incompleta, la 0093 que ya no se reejecuta encima, el rollback de la cabecera, los saltos, las bajas en cualquier orden | **32 aprobadas** |
| **Las reglas puras** (`test_servicios_atencion_reglas.py`): qué se puede hacer en cada momento, los plazos, la política y sus cotas, el efecto económico | **25 aprobadas** |
| **La API real contra PostgreSQL** (`test_servicios_atencion_api.py`): el recorrido entero, cancelar, reprogramar, la asistencia, los barridos, la inasistencia, el caso, la resolución, la apelación, la reseña, la moderación, permisos, idempotencia, banderas, la puerta, la baja y las carreras | **49 aprobadas**, también **una a una** sobre una base recién montada |
| **Backend completo con PostgreSQL** | **4276 aprobadas, 0 fallidas, 0 omitidas** |
| **Backend completo sin PostgreSQL** | **3073 aprobadas, 0 fallidas (1203 omitidas por necesitar PostgreSQL)** |
| **Móvil completo** (135 baterías) | **3646/3646** |
| `tsc --noEmit` · Expo Doctor · exportación web (`EXPO_NO_DOTENV=1`) | limpio · 18/18 · correcta |
| Paridad de traducciones es/en/pt y claves usadas | dentro del móvil completo, en verde |
| Rutas de la API | 564 operaciones, **0 duplicadas** (134 de Servicios: 100 + 34) |
| `git diff --check` · secretos en el cambio | limpio · ninguno |
| **Recorrido con la API real** en su propio proceso | **89/89**, 517 peticiones, cuatro procesos, ningún 500 |

**La primera regresión completa dejó dos pruebas en rojo**, las dos
inventarios que no conocían el incremento: el de las rutas de Servicios (sin
las 34 nuevas) y el de los depósitos que barre la baja (sin
`service-incident-evidence`). Se pusieron al día.

### El recorrido (local, API real)

La API real (uvicorn) en su propio proceso, con las dos banderas encendidas
**solo ahí**, sesiones HS256 con un secreto de usar y tirar y el almacén de
pruebas:

- **Sin la 0094**: se contrata como en el Incremento 5; `care` es nulo; las
  33 rutas privadas contestan 503 `services_not_ready`; las reseñas públicas,
  `available: false`; la ficha, 0 reseñas y promedio nulo.
- **Se aplica la 0094 dos veces** con la API en marcha: el mismo proceso
  **sigue en 503**. Se **reinicia**: la reserva contratada antes ofrece
  cancelar y reprogramar.
- **De punta a punta**: reprogramar (misma reserva, mismo código, el horario
  anterior vuelve), el código, un código equivocado, empezar, terminar,
  confirmar, la reseña pendiente, publicarla, verla sin sesión y sin autor,
  responder, esconderla; cancelar cinco veces a la vez con la misma clave;
  la inasistencia; el caso con su evidencia, su enlace firmado, la nota
  interna, la resolución con una devolución solicitada («no aplica»), la
  apelación resuelta por otra persona; retirar un caso sin quitárselo a la
  otra parte; los barridos con lote de uno y cuatro a la vez; tres carreras.
- **El dinero**: ninguna tabla de dinero cambió; todos los pedidos siguen
  gratuitos; ningún efecto dice otra cosa que «no aplica».
- **Los avisos**: todos con el contenido vacío; el historial y los registros,
  sin la nota, la descripción del caso, la nota interna ni el código.
- **Banderas**: con la contratación apagada, 503 `service_booking_disabled`;
  con Servicios apagado, 503 `services_disabled`.

### Mutaciones dirigidas

En un **árbol de trabajo desechable** (nunca sobre el repositorio) y contra su
propia base. **54 mutaciones, las 54 muertas.**

- Las del encargo: cancelar lo ajeno o lo empezado; reprogramar sin soltar el
  horario o a otra versión; empezar antes de tiempo; terminar sin empezar;
  cada parte actuando por la otra; reseñar sin atención (en el dominio y en la
  base) o dos veces; la evidencia de otro caso; las notas internas a las
  partes; el depósito público; la ruta del archivo en la respuesta; un efecto
  «ejecutado» (en el dominio y en la base); un efecto «pendiente» sobre algo
  gratuito; una columna de importe; cerrar con un caso vivo (confirmando y en
  el barrido) o sin la señal fuerte; el prestador viendo el código, un
  código que no se bloquea y una ausencia antes de la tolerancia; un
  recordatorio repetido; una clave que repite la acción; anunciar
  «cancelar» o «confirmar» cuando no toca; dos
  resoluciones; quien resolvió resolviendo su apelación; saltar la puerta o
  no mirar sus funciones.
- Las de cada corrección de la revisión (17) y cuatro de la app.

En la primera pasada murieron 49. **Dos sobrevivieron** y dieron dos pruebas:
leer la evidencia de otro caso por la reserva propia, y la ruta del archivo
viajando en el cuerpo de una entrada (se miraba el nombre del campo, no su
valor). **Tres no se podían juzgar**: su prueba dependía de que otra hubiera
dejado antes a otra persona en administración; se corrigió y las 49 pruebas de
la batería pasan también una a una. Repetidas, las cinco mueren.

### Revisión independiente

Una revisión adversarial de solo lectura sobre el cambio entero. **Ningún
bloqueante; 2 altos, 8 medios y 9 bajos.** Cada alto y cada medio se
reprodujo con una prueba en rojo antes de corregirlo:

| | Hallazgo | Qué se hizo |
|---|---|---|
| A1 | El barrido de cierre se atascaba: lo que no se cierra solo ocupaba el lote para siempre | El lote solo trae lo que se puede cerrar; lo que espera se cuenta aparte |
| A2 | Retirar un caso quemaba el único caso de la reserva, también para la otra parte | Índice único **parcial** en la 0094 (sin aplicar): uno por reserva sin contar los retirados |
| M1 | El tope de evidencias era del caso: una parte dejaba a la otra sin poder aportar | Es de cada parte |
| M2 | Un administrador que es parte leía el expediente con las notas internas | 409 también al leer |
| M3 | Subir una evidencia con la reserva ocupada era un 500; el barrido retenía el lote | 409 `service_booking_busy`; el barrido confirma cada fila |
| M4 | El efecto «se realizó» de la primera resolución es irreversible, y la pantalla ofrecía deshacerlo | Se mantiene (cerrada es final, G9) y **el servidor dice** qué efectos acepta |
| M5 | Con una sola persona en administración, apelar dejaba el caso sin salida | Apelar solo se ofrece si hay otra persona; y es configurable (0 o 1) |
| M6 | El prestador seguía viendo la nota y la dirección tras la cancelación | Ya no |
| M7 | La reseña pública llevaba el identificador de quien la escribió | Quitado; solo en moderación |
| M8 | Con el código desplegado antes de la 0094, la baja recorre un depósito que no existe | **No reproducible sin Supabase.** No se cambió código: se documenta el orden (§96). Si el listado fallara, la baja falla cerrada |

De los bajos se corrigieron tres: una prueba que afirmaba lo que no
comprobaba, los motivos anunciados fuera de plazo y la pantalla de
administración que decidía por el estado. Los demás, en §99.

## 99. Riesgos y limitaciones conocidas

> *Al cierre (§102):* la 0094 ya está aplicada y verificada (los dos primeros
> puntos de esta lista dejaron de ser riesgos), el recordatorio tras
> reprogramar se corrigió y el rollback se sustituye por la recuperación
> hacia delante (§104). Lo demás sigue igual.

- **La 0094 no está aplicada ni verificada en Supabase.** Todo lo de esta
  parte se probó en local. La puerta fija huellas de los CHECK y de las
  funciones: es estricta a propósito y **frágil ante cualquier retoque** del
  fichero (hay que recalcularlas).
- **Aplicar la 0094 antes de desplegar** (§96, M8).
- **F21 pesa más**: la baja de quien presta se lleva ahora también
  atenciones, casos, resoluciones y reseñas.
- **Con una sola persona en administración no hay apelaciones** (G15).
- **Una atención cerrada no se desmiente** (G9): si la primera resolución la
  dio por realizada, la apelación no lo cambia.
- **Un caso decidido impide abrir otro**, también por seguridad: hay que
  acudir a administración por fuera.
- **Sin planificador**: los recordatorios y el cierre automático solo ocurren
  si alguien lanza el barrido a mano.
- **Una reserva recordada y después reprogramada no se vuelve a recordar.**
- **Una atención terminada sin código que nadie confirma se queda
  `completed`**: pasado el plazo del caso, solo se cierra con un caso de
  seguridad o confirmando.
- **El prestador ve en el historial** que existe una reseña antes de que se
  publique (no su contenido).
- **La baja de una parte con un caso vivo** borra sus evidencias y deja la
  fila: el expediente queda incompleto (G16).
- **Orden de cerrojos**: quien reprograma con una retención de **otro**
  servicio mientras confirma esa misma retención puede cruzarse consigo
  mismo; acaba en 409, no en 500.
- **El rollback en Supabase** puede rechazar el borrado del depósito (§96).
- **Lo construido de más para lo gratuito** (señalado por la revisión, y
  dejado porque el encargo lo pide expresamente): el efecto económico
  solicitado, los ejes de la reseña y la moderación previa, los recordatorios
  sin planificador y los diez plazos configurables.
- **C15** (D6) sigue pendiente antes de encender Servicios, y el **push**
  sigue sin llevar al destino.

## 100. Lo que NO se implementó (YAGNI) y sigue pendiente

Por instrucción expresa, lo que no hacía falta para una atención gratuita
verificable **no se construyó**:

- la **aceptación manual del prestador** (a domicilio sigue sin contratarse,
  F3/G14);
- la **reprogramación pedida por el prestador** y la **cancelación por
  administración**;
- **QR**, señales de la sala de **100ms** y **geolocalización**;
- **cambios de alcance** de una atención contratada;
- **pedidos con precio**, cobro, comisión, saldos, el adaptador de
  devoluciones, webhooks, transferencias y conciliación;
- un **índice de desempeño**, **alertas de riesgo** y la nota ajustada;
- **fotos en una reseña** y la edición de la respuesta;
- el **planificador** de los barridos y el **push con destino**;
- una **pantalla de configuración** de la política, mensajes por reserva y
  «añadir al calendario».

Y sigue pendiente, sin resolver aquí:

> **F21 · La baja de quien presta se lleva su historia.** Sin cambios: no se
> tocó la 0090. **Recomendación técnica** (no es una decisión): conservar las
> reservas, lo aceptado y las resoluciones **anonimizados** y borrar solo lo
> personal.

- **G1–G16** (`Z_REQUISITOS_Y_DECISIONES.md`), además de C1–C15, D1–D15,
  E1–E12 y F1–F21: ninguna se dio por resuelta.
- **Aplicar y verificar la 0094**, y **reiniciar la API**.
- **El QA físico** de los Incrementos 1–6.
- **Desplegar `Edson`**: no hubo push ni despliegue.

## 101. Estado y punto exacto de continuación

- **Incremento 6 de Z Servicios técnicamente cerrado; únicamente queda
  pendiente el QA físico** (§102). Al escribirse esta parte, el 01/10/2026,
  el estado era «implementado y probado; pendiente de aplicar y verificar la
  0094»: la 0094 se aplicó y se verificó ese mismo día.
- `FEATURE_SERVICES`, `FEATURE_SERVICE_BOOKING` y `FEATURE_SERVICE_PAYMENTS`
  **apagadas**; `SERVICE_PAYMENTS_PROVIDER=none`; **no hubo despliegue**, ni
  push, ni PR, ni merge.
- **No se movió dinero** y no se escribió ningún dato en Supabase. La 0094 la
  aplicó Edson a mano; la verificación fue de solo lectura.
- Decisiones **G1–G18** de la empresa (`Z_REQUISITOS_Y_DECISIONES.md`); la
  **F21**, resaltada en §105.
- Siguiente paso: el **QA físico**. Con él termina Servicios; activarlo y
  desplegarlo son decisiones de la empresa.

## 102. Cierre técnico del Incremento 6 (01/10/2026)

**La 0094 se ejecutó a mano en Supabase** después del informe del 01/10 y se
**verificó ese mismo día a las 14:28 UTC** (09:28 en Lima) **sin
divergencias**. No se volvió a ejecutar, no se tocó el fichero y **no se
escribió ningún dato en Supabase**. De §82 a §101 se describe el incremento
tal como se escribió; donde decía «sin aplicar», manda esta sección.

Cuatro cosas distintas, que no hay que confundir:

| | Estado |
|---|---|
| **El esquema en Supabase** | La 0086–0094 están **aplicadas y verificadas** (PostgreSQL 17.6) |
| **La verificación local** | Referencia 0001–0094 en PostgreSQL 17.11 desechable, puertas, recorrido y pruebas: todo correcto |
| **El código en `Edson`** | Completo y probado; **sin push, sin PR, sin merge y sin desplegar** |
| **Producción** | Sigue con el código anterior, que **no conoce** estas tablas. Servicios **no está activado**: las tres banderas, apagadas |

### La verificación, en solo lectura

El verificador de la 0093, adaptado a la 0094, abre dos sesiones:

- **catálogos** (psycopg): `BEGIN READ ONLY`; `transaction_read_only = on` y
  una sonda de escritura (`create temp table`) **rechazada con 25006** antes
  de consultar nada; al terminar sigue en solo lectura, **sin id de
  transacción de escritura**, y `ROLLBACK`;
- **la de la API**: la misma `DATABASE_URL`, con asyncpg y SQLAlchemy como
  `app/shared/database.py`; `SET TRANSACTION READ ONLY` como primera
  sentencia, la misma sonda rechazada (25006) y `ROLLBACK`.

La URL sale del fichero de secretos autorizado: ni ella, ni el host, ni el
usuario se imprimen ni se guardan. Referencia: prólogo + 0001–0094 sobre
PostgreSQL 17.11 local desechable.

| Comprobación | Resultado |
|---|---|
| Esquema público entero frente a la referencia (1778 columnas, 1344 restricciones, 552 índices, 103 disparadores, 62 funciones, 169/169 tablas con RLS, 149 políticas; de Servicios, 28 tablas y 390 columnas) | **igual**: la 0001–0093 siguen como la 0094 las deja, y nada más cambió |
| Las cuatro tablas | normales y permanentes, RLS activa, **0 políticas**, del propietario esperado (también sus índices y sus funciones) |
| Columnas | las **57**, con su orden, tipo, nulabilidad, valor predeterminado, identidad o generación e intercalación |
| Claves primarias y únicas | **4** primarias y **1** única (una reseña por reserva), validadas |
| Claves ajenas | **6**, validadas, con su destino, `ON UPDATE` y `ON DELETE`: 4 en cascada, 1 `SET NULL` (quien reseña) y **1 sin acción y diferida** (la reseña a su servicio) |
| CHECK | los **37**, con su nombre y su definición, validados. El del estado del efecto económico admite `not_applicable`, `pending` y `blocked`, y **ningún valor que diga «ejecutado»** |
| Índices | los **12** (4 primarios, 1 de la única y 7 propios, **2 únicos y parciales**): definición, método, columnas, orden, clases de operadores y condición; **válidos, listos y vivos**. `service_incidents_una_por_reserva` es `UNIQUE … (booking_id) WHERE (status <> 'withdrawn')`: es la **versión final** del fichero (la de la revisión, commit `0f7d510`), no la primera |
| Disparadores | los **8** de las cuatro tablas, habilitados y por fila, con su función, momento, evento y argumentos; y el **diferido** nuevo de la reserva (`service_bookings_coherentes_al_cambiar`) |
| Funciones | las **4** nuevas y las **2** de la 0093 que la 0094 reescribe: plpgsql, devuelven `trigger`, **SECURITY INVOKER**, `search_path=public, pg_temp`, cuerpo idéntico por su huella, sin EXECUTE para PUBLIC, `anon` ni `authenticated`. Las 2 que reutiliza (0086, 0090), idénticas a la referencia |
| Lo que cambia de la 0093 | los tres CHECK ampliados (`cancelled`; las acciones y los roles `provider` y `admin`), validados; ninguna columna nueva en sus tablas |
| Permisos de PUBLIC, `anon` y `authenticated` | **ninguno**: ni declarados (tabla o columna), ni en la ACL, ni efectivos. Con permisos, solo el propietario y `service_role` |
| Lo que escribió su transacción | **una sola** transacción; en el catálogo, sus 83 objetos y lo mismo que en la referencia; **una sola fila de datos** en las 215 tablas de los esquemas que no son del sistema: la del depósito en `storage.buckets` |
| Integridad de `public` | 366 claves ajenas: 0 filas huérfanas, 0 sin validar |
| §97, ejecutado tal cual | los resultados esperados |

**El depósito de las evidencias** (`service-incident-evidence`): existe, es
**privado**, admite 10 MB y los cuatro formatos (PDF, JPEG, PNG, WebP);
**ninguna política** de `storage.objects` lo nombra ni vale para cualquier
depósito; **0 archivos**. Sin credenciales, su ruta pública contesta que el
depósito no existe y una firma inventada se rechaza: no sirve nada. Lo que
**no** se pudo comprobar contra Supabase es un enlace firmado de verdad: hace
falta un archivo real, y eso es del QA físico (en local, el enlace caduca a
los 120 segundos y solo lo piden las dos partes y administración).

**Los datos: las cuatro tablas están VACÍAS** (0 atenciones, casos, entradas
y reseñas), y también las de la 0093 (0 reservas, pedidos y retenciones); no
hay ninguna condición de contratación publicada. Los 21 recuentos de
incoherencias (atenciones o casos sin reserva, entradas sin caso, reseñas sin
atención cerrada o duplicadas, resoluciones imposibles, efectos económicos
«ejecutados», evidencias sin archivo y archivos sin evidencia, reservas
canceladas que siguen ocupando, pedidos con dinero…) dan 0, pero **solo
porque no hay filas**: no prueban nada más que eso. Lo que impide esas
incoherencias es el esquema, que sí se comprobó, y las pruebas locales.

El verificador se ensayó antes contra la referencia local (sin divergencias)
y contra la referencia **estropeada a propósito, una alteración cada vez**:
una columna de otro tipo, otra nulabilidad, un predeterminado quitado, un
CHECK ausente, un CHECK que admite «ejecutado», una clave ajena con otra
acción, un índice inválido, el índice único vuelto normal, un disparador
deshabilitado, otro ausente, una función con otro cuerpo, otra `SECURITY
DEFINER`, RLS apagada, una política, un permiso de tabla, de columna y de
función a los de fuera, el depósito ausente, público o con una política que
lo abre, un CHECK de la 0093 sin ampliar y datos incoherentes. **Detectó las
22.**

### Las puertas, con la conexión y el rol de la API

En un proceso nuevo la memoria de la puerta empieza **vacía**. Con la misma
conexión que usa la API (su rol: no superusuario, con BYPASSRLS, propietario
de las tablas), el código real dice **sí** a las seis: `hay_admision`,
`hay_catalogo`, `hay_guardados`, `hay_agenda`, `hay_reservas` y
`hay_atencion`, y lo recuerda. Por separado: la consulta de la 0093 **pura**
dice que no (como debe, la 0094 la enmendó), la de «la 0093 como la deja la
0094» dice que sí, y la de lo nuevo también. Con las banderas como están
(apagadas), `exigir_reservas`, `exigir_atencion` y la puerta de las
condiciones contestan `services_disabled` **sin mirar la base**; con las dos
encendidas solo en ese proceso, las tres pasan.

La puerta de la atención se cierra, en local y dentro de transacciones que se
deshacen, ante **47 alteraciones** (`test_servicios_atencion_api.py`): una
tabla ausente, una columna ausente, de más o de otro tipo, otra nulabilidad,
otro predeterminado, un CHECK distinto o sin validar, una clave ajena con otra
acción o sin diferir, un índice crítico ausente, no único, no parcial o
inválido, un disparador ausente o deshabilitado, una función distinta o
`SECURITY DEFINER`, RLS apagada, una política, un permiso de fuera (de tabla,
de columna o de función) y el depósito ausente o público. Un error al mirar es
**503 `services_not_ready`**, nunca 500, y **no se recuerda**.

**Lo único que la puerta no mira del depósito: sus políticas.** Una política
de `storage.objects` que abriera ese depósito no cierra la puerta (el
verificador de solo lectura sí la detecta). En Supabase no hay ninguna. Queda
anotado como deuda baja: las políticas de Storage solo las crea una migración
o una persona desde el panel.

### La 0093 no se reejecuta encima de la 0094

Comprobado en la referencia: reejecutar la 0093 sobre una base con la 0094
**se niega** con `P0001` («La 0093 no dejó sus disparadores»): su
verificación final cuenta los disparadores de sus tablas, ve uno más (el
diferido que añade la 0094) y aborta; la transacción entera se deshace y las
dos funciones que la 0094 reescribió **quedan como estaban**. Es deliberado:
si no se negara, devolvería a esas dos funciones el cuerpo de la 0093 y
cancelar y reprogramar dejarían de funcionar.

- La cadena limpia **0001–0094 funciona** (es como se construye cada
  referencia y cada base de pruebas).
- **Ningún procedimiento vigente invita a reejecutar la 0093**: §74 la da por
  aplicada, y lo que decía «después, reejecutar la 0093» era el rollback de la
  0094, que ya no aplica (§104).
- **Ninguna herramienta la ejecuta sola**: las migraciones se aplican a mano
  en Supabase; la integración continua solo las aplica, en orden y una vez,
  a su PostgreSQL desechable; el despliegue no las toca.

### El reinicio y el recorrido integral (local, API real)

PostgreSQL 17 desechable; la API real en su propio proceso (uvicorn), con
`FEATURE_SERVICES` y `FEATURE_SERVICE_BOOKING` encendidas **solo en ese
proceso**, pagos apagados, sesiones HS256 reales con un secreto de usar y
tirar y el almacén de pruebas; ningún servicio externo. **116 de 116
comprobaciones, 692 peticiones, cinco procesos, ningún 500.**

- **La memoria de la puerta**: con 0001–0093 se contrata como en el
  Incremento 5 y las 33 rutas privadas de la atención contestan 503
  `services_not_ready`; se aplica la 0094 en local (dos veces) y **el mismo
  proceso sigue en 503**; se **reinicia** y las reconoce.
- **Reserva gratuita**: el pedido y lo aceptado se conservan en todo el
  recorrido; las acciones son las que manda el servidor.
- **Cancelación**: de quien contrata (cinco a la vez con la misma clave: una);
  del prestador, que sin explicar por qué recibe un 422; el horario vuelve; el
  pedido y lo aceptado siguen; repetirla con otra clave, 409; empezada, 409.
- **Reprogramación**: misma reserva, código, pedido, versión, precio y
  condiciones; el horario anterior se libera **solo** al confirmarse el
  cambio; si el horario nuevo falla (su retención venció), 409 y la reserva
  conserva el suyo; dos a la vez, una; la segunda, 409 por el límite; y con la
  política de fábrica una reserva ya recordada **no se reprograma** (409: la
  antelación y la ventana del recordatorio son las mismas 24 h).
- **Recordada y después reprogramada** (con una antelación de 1 h, solo en
  ese proceso): el recordatorio era del horario viejo; el nuevo **se recuerda
  cuando se acerca, una sola vez**. Era la limitación anotada en §99, y se
  corrigió en el cierre (ver «Correcciones»).
- **Atención**: el código, un intento fallido, empezar con código y sin él,
  terminar, confirmar; el barrido cierra la que tiene la señal fuerte y deja
  la que no la tiene y la que tiene un caso vivo.
- **Inasistencia**: del prestador y de quien contrata, solo pasada la
  tolerancia; la otra parte lo discute con un caso y administración decide;
  **sin consecuencia económica** (`not_applicable`).
- **Incidencias**: abrir, evidencia válida, archivo inválido rechazado,
  respuesta de la otra parte, nota interna que las partes no ven, resolver con
  una devolución **solicitada y no ejecutada**, apelar, que resuelva otra
  persona, una sola apelación, cerrado, y retirar sin quitarle el suyo a la
  otra parte.
- **Reseñas**: antes del cierre, 409; verificada, una; promedio y cantidad;
  una respuesta; publicar y esconder **sin borrar**; el historial lo guarda; y
  sin el nombre de quien la escribió.
- **Dinero**: ninguna tabla de dinero cambió; todos los pedidos siguen
  gratuitos; ningún efecto dice otra cosa que «no aplica»; las tablas de la
  atención no tienen ni una columna de importe; el proceso no tenía ninguna
  clave de pasarela.
- **Privacidad**: lo ajeno es 404; la evidencia, por enlace firmado; a
  domicilio (encendido solo en ese proceso), la dirección la ve su prestador y,
  **cancelada, ya no**; no está en administración, en el historial ni en
  ningún aviso; una persona de administración que es parte **no lee ni decide**
  su caso.
- **Banderas**: con la contratación apagada, 503 `service_booking_disabled`;
  con Servicios apagado, 503 `services_disabled`.

### Concurrencia (sobre la 0094 tal como está aplicada)

La referencia local es idéntica a Supabase, así que estas pruebas valen para
la 0094 aplicada: cancelar y reprogramar a la vez; reprogramar dos veces;
reprogramar mientras el prestador bloquea ese día; empezar y cancelar;
terminar, confirmar y abrir un caso; dos resoluciones; dos reseñas y dos
respuestas; barridos a la vez y mientras se confirma; la misma clave cinco
veces; y subir una evidencia con la reserva ocupada. Siempre un resultado
coherente y un 409; nunca un 500, dos casos vivos, dos reseñas ni un horario
ocupado dos veces.

### Correcciones del cierre

Una, de código funcional, y nada más:

- **El recordatorio es de un horario, no de la reserva** (commit `8154118`).
  Una reserva recordada que después cambiaba de horario no se volvía a
  recordar. Con la política de fábrica no se alcanza; con una antelación menor
  (la del ejemplo del blueprint: 12 h), sí. Ahora consta como recordada solo
  si su último recordatorio es posterior a su último cambio de horario. Prueba
  en rojo antes del arreglo; cinco mutaciones dirigidas, las cinco muertas.

Y una prueba para algo que ya funcionaba y nadie comprobaba: una fila que
falla en el barrido se deshace ella sola, las demás siguen, la respuesta la
cuenta como saltada y la siguiente pasada la reintenta.

### Pruebas ejecutadas en el cierre

Cambió código funcional compartido (el barrido), así que se repitió todo:

| Qué | Resultado |
|---|---|
| Backend completo con PostgreSQL | **4279 aprobadas, 0 fallidas, 0 omitidas** |
| Backend completo sin PostgreSQL | **3074 aprobadas, 0 fallidas (1205 omitidas por necesitar PostgreSQL)** |
| Móvil completo (135 baterías) | **3646/3646** |
| `tsc --noEmit` · Expo Doctor · exportación web (`EXPO_NO_DOTENV=1`) | limpio · 18/18 · correcta |
| Rutas de la API | 564 operaciones, **0 duplicadas** (134 de Servicios) |
| `git diff --check` · secretos en el cambio | limpio · ninguno |
| Recorrido integral | **116/116** |
| Mutaciones dirigidas a lo cambiado | **5/5 muertas** |

**No se repitieron** las 54 mutaciones del incremento: su código no cambió.

### La huella

`0094_servicios_atencion_y_cierre.sql` consta en `APLICADAS`
(`test_servicios_migracion_0090.py`) con su huella git `1ed10ac8…`: desde
ahora una edición del fichero pone roja `test_las_aplicadas_no_han_cambiado`
(comprobado añadiéndole una línea). Su cabecera sigue diciendo «SIN APLICAR»
y describe un rollback **que solo vale para una base local desechable**: no
se corrige ahí porque cambiarla sería editar lo aplicado (§104).

### Veredicto

**Incremento 6 de Z Servicios técnicamente cerrado; únicamente queda
pendiente el QA físico.**

## 103. Lo que no se implementó: clasificación y evidencia

Cruzado con el blueprint (`Servicios de Excelencia Z`, v1.0), sus capturas, la
arquitectura y el código. Ninguna de estas funciones era necesaria para que el
recorrido gratuito fuera coherente; ninguna se implementó en el cierre.

| # | Función | Clasificación | Evidencia |
|---|---|---|---|
| 1 | **Aceptación manual del prestador** | Decisión empresarial pendiente (F3, G14) | Blueprint §2: una cita se confirma «automática al pagar **o** por aceptación del prestador», y la regla MVP deja el tipo «Solicitud» para «si el negocio lo necesita». Las modalidades que se contratan hoy se confirman solas; a domicilio no se contrata. La app lo dice tal cual («el prestador tiene que aceptar la reserva, y eso todavía no está disponible»), ninguna pantalla promete una aprobación y **no existe un estado de espera**: una reserva es `confirmed` o `cancelled` |
| 2 | **Reprogramación pedida por el prestador** | Decisión empresarial pendiente (G2) | Blueprint §15.2 y §22: reprogramar es de **quien contrata**; el prestador no tiene esa acción en sus permisos ni en sus capturas («Enviar mensaje» e «Iniciar atención»). El único texto que lo roza es un caso límite (§26): si el prestador cambia su horario, «no alterar reservas existentes; solicitar reprogramación individual». Lo primero se cumple (cambiar la agenda no toca las reservas). Lo segundo hoy se hace por fuera: el prestador avisa o **cancela explicando por qué**, y quien contrató vuelve a reservar |
| 3 | **Cancelación por administración** | Decisión empresarial pendiente (G1) | El blueprint **no la define**: sus estados son `CANCELLED_BY_CLIENT` y `CANCELLED_BY_PROVIDER` (§12), y de administración solo dice «consultar / reasignar excepcionalmente, sin editar historia» (A04). Ver §103.1 |
| 4 | **Señales de la sala (100ms)** | Integración externa pendiente (y decisión G17) | Blueprint §13: «ingreso a sala Z de ambas partes» es **una** de las señales fuertes, no la única; basta una, y el código de seis cifras lo es. La integración de 100ms no tiene cuenta conectada ni se probó en teléfonos (`FEATURE_LIVE` apagada). **Z no ofrece hoy una sala**: en un servicio virtual las partes se conectan por fuera |
| 5 | **QR** | Mejora futura | Blueprint §13.1: «Cliente escanea QR **o** entrega PIN». El PIN está: de un solo uso, solo dentro de su ventana y registrado en el historial (criterio 14) |
| 6 | **Geolocalización** | Fuera de alcance | Blueprint §13: «complementaria; nunca obligatoria general». Excluida expresamente del incremento |
| 7 | **Pagos** | Integración externa y decisión pendientes (F14–F18, G13) | Blueprint §14.1 y decisión D03: «procesador y payouts a Perú: no confirmado; pagos reales bloqueados»; criterio 28. Banderas apagadas, `SERVICE_PAYMENTS_PROVIDER=none`, ningún adaptador, y la base no admite un pedido con precio |
| 8 | **Conciliación** | Integración externa pendiente | Depende de los pagos: sin movimientos no hay nada que conciliar. No se inventó ninguna |
| 9 | **Planificador** | Decisión operativa pendiente (F13, G12) | Blueprint §13.1 y §23 piden el cierre automático y el recordatorio de 24 h; las **tareas existen** y son idempotentes. Quién las llama (cron, Lambda, EventBridge) es infraestructura que no se construyó a propósito. Ver §103.4 |
| 10 | **Push con destino** | Mejora de plataforma pendiente | Blueprint §23: cada aviso lleva `deepLink`. La bandeja interna sí lleva a la reserva o al caso; el push abre la aplicación desde el Incremento 1, en toda la plataforma |
| 11 | **Pantalla de configuración** | Decisión empresarial pendiente (G1–G12) | Blueprint A09: «políticas por país/categoría, versionado y fecha efectiva». Los textos legales ya se versionan y se publican desde administración; los **plazos** son variables de entorno porque ninguno está decidido |
| 12 | **Fotos en la reseña** | Mejora futura | Blueprint §17: «Multimedia: opcional» |
| 13 | **Índice de desempeño** | Mejora futura (y, en parte, pagos) | Blueprint §18.2 (índice de permanencia con umbrales) y P10 «Rendimiento», cuya captura incluye ingresos y saldo. No hay volumen ni decisión sobre los umbrales; la nota ajustada (§17.1) usa un `m = 10` «recomendado». Hoy se enseña el promedio **con su número de reseñas**, nunca solo |

**Encontrado en el cruce, y no estaba en la lista** (se registra, no se
resuelve):

- **La política operativa no se copia en la reserva.** El blueprint (§15.1,
  criterio 20) pide que la política aplicable se copie, inmutable, a cada
  reserva. Hoy se copia lo **aceptado** (las condiciones de Z y las del
  servicio, por versión y huella), pero los **plazos** (cuántas veces se
  reprograma, con cuánta antelación, la tolerancia, el plazo de confirmación)
  se leen de la configuración vigente en el momento de cada acción. Mientras
  todo sea gratuito no tiene consecuencia económica, y el propio blueprint
  deja la política de cancelación sin definir (D07). **Antes de que cancelar
  cueste dinero hay que congelarla en la reserva** (decisión G18).
  *Corregido en lo técnico ese mismo día: Parte VII (§106). La 0095 está sin
  aplicar y los valores siguen siendo provisionales.*
- **Cómo se encuentran las partes en un servicio virtual.** Sin sala de Z ni
  enlace en la reserva, se ponen de acuerdo por fuera (decisión G17).

### 103.1 Cancelación por administración

**¿Puede una resolución administrativa exigir cancelar una reserva y liberar
su horario?** No, y no hace falta que pueda:

- un caso solo se abre **desde la hora de inicio**, y una reserva solo se
  cancela **antes** de ella. Cuando administración resuelve, el horario ya
  pasó: no hay nada que liberar, y la consecuencia se expresa con el **efecto
  en la atención** (`provider_no_show`, `client_no_show`, `completed`) y el
  efecto económico solicitado;
- para una reserva **por venir**, cancelan quien contrata o el prestador (que
  explica por qué). Administración no tiene esa acción.

El hueco es operativo, no del blueprint: si administración **suspende** a un
prestador con reservas por venir, estas siguen confirmadas; el prestador ya
no puede empezarlas (y sí cancelarlas), quien contrató puede cancelar y,
llegada la hora, declarar la ausencia y abrir un caso. Nadie avisa de oficio a
quien contrató. Si la empresa quiere que administración cancele directamente,
es la decisión G1; el camino mínimo sería la misma transición de cancelar, con
el rol `admin` (que el historial ya admite), un motivo obligatorio y la regla
de no decidir lo propio. **No se construyó.**

### 103.2 Reprogramación del prestador

No está exigida como acción formal (fila 2). No se construyó la solicitud ni
la aceptación. Lo que el prestador puede hacer hoy sin salir de Z: cancelar
explicando por qué; quien contrató recibe el aviso y reserva otro horario.

### 103.3 Aceptación del prestador

No se implementó (fila 1). Comprobado: ninguna pantalla promete una
aprobación manual; ninguna reserva queda esperando (no existe ese estado); el
servidor no anuncia acciones de aceptar o rechazar; y «a domicilio» **no se
contrata** salvo que alguien cambie `SERVICES_BOOKING_INSTANT_MODALITIES`, que
la haría confirmarse sola, sin aprobación. No tocar esa variable sin la
decisión F3/G14.

### 103.4 Los barridos

`POST /admin/services/tasks/run` (y `…/holds/expire`, del Incremento 5):
idempotentes (repetirlos no hace nada); por lotes (200, hasta 1000); cada fila
en su propia transacción, con la reserva bloqueada y saltando lo que otra
petición tiene (`SKIP LOCKED`); una fila que falla se deshace sola y se
reintenta en la pasada siguiente; no duplican avisos; no mueven dinero; y
dicen cuántas recordaron, cerraron, quedan sin verificar y saltaron.

**Sin un planificador externo no hay recordatorios automáticos ni cierre
automático oportuno**: solo ocurren cuando alguien lanza el barrido desde
administración. Quién lo ejecutará, y cada cuánto, es una decisión operativa
pendiente (F13, G12). No se construyó cron, Lambda ni EventBridge.

## 104. Recuperación: hacia delante, nunca borrando

**Una migración aplicada no se deshace en producción.** El bloque de
«rollback» de la cabecera de la 0094 (y lo que §96 decía de él) **solo vale
para una base local desechable**, que es donde se probó:

- borra las cuatro tablas, y con ellas cualquier atención, caso, expediente y
  reseña;
- borra la fila del depósito con un `delete from storage.buckets`, que las
  versiones recientes de Supabase **rechazan** (protegen esas tablas) y que
  abortaría el bloque entero; nunca se probó contra Supabase;
- exige después reejecutar la 0093, que sobre una base de producción con datos
  no es una operación que deba improvisarse.

**No hay ninguna instrucción operativa vigente que borre evidencias, tablas o
depósitos en producción.** Si aparece un defecto:

1. **Apagar** `FEATURE_SERVICE_BOOKING` (y `FEATURE_SERVICES` si hace falta):
   todas las rutas contestan 503 sin mirar la base, y nada se pierde.
2. **Corregir hacia delante**: una migración nueva (la siguiente), aditiva, en
   una transacción, con su prueba y su verificación en solo lectura, como
   todas las anteriores.
3. **No editar** la 0094 ni ninguna aplicada, y **no borrar** el depósito ni
   sus archivos: las evidencias son de personas reales.

## 105. Lo que sigue pendiente y NO se implementó

> **F21 · La baja de quien presta se lleva su historia. Sin resolver, y es
> lo más importante que queda antes de encender la contratación.** Hoy, si
> un prestador borra su cuenta:
>
> | Se borra | Cómo |
> |---|---|
> | sus servicios y sus versiones | en cascada desde su perfil (0090) |
> | sus **reservas pasadas** y las canceladas | con el servicio |
> | sus **pedidos** y **lo que aceptó quien contrató** | con el servicio |
> | las **atenciones**, los **casos**, **su expediente** (mensajes, resoluciones, apelación, notas internas) y las **reseñas** | con la reserva (0094) |
> | el **historial** de esas reservas | con el servicio |
> | **sus** evidencias en el depósito | por el barrido de archivos de su cuenta |
>
> Y **no** se borran las evidencias que subió **quien contrató**: su fila
> desaparece con el caso, pero el archivo se queda en el depósito privado, sin
> nada que lo nombre, hasta que esa persona borre su propia cuenta. Lo único
> que frena la baja es una reserva **confirmada y por venir**.
>
> **Recomendación técnica (no es una decisión):** conservar la historia
> contractual (reservas, pedidos, lo aceptado), las resoluciones y, cuando
> existan, los movimientos económicos; **anonimizar** la identidad del
> prestador como ya se hace con quien contrata; definir un **plazo legal** de
> conservación; e impedir que una baja destruya evidencia necesaria para un
> caso vivo o reciente. Exige cambiar la clave de la 0090 con una migración
> nueva: no se tocó la 0090. (La 0095 que existe desde la Parte VII es la de
> la política congelada, y no cambia nada de esto.)

- **G1–G18** (`Z_REQUISITOS_Y_DECISIONES.md`), además de C1–C15, D1–D15,
  E1–E12 y F1–F21: **ninguna se dio por resuelta**. G17 y G18 son nuevas, del
  cruce con el blueprint (§103). *G18 quedó después resuelta en lo técnico
  (§106); sus valores, no.*
- **Publicar las condiciones de contratación** (F9): no hay ninguna, y sin
  ellas no se confirma nada.
- **El planificador** (F13, G12) y una **segunda persona en administración**
  si se quieren apelaciones (G15).
- **Pagos, Stripe, comisiones, comprobantes, devoluciones y conciliación**: no
  existen para Servicios.
- **El QA físico** de los Incrementos 1–6 (`Z_QA_FISICO_PENDIENTE.md`).
- **Desplegar `Edson`**: no hubo push ni despliegue. Al hacerlo, la API
  arranca de nuevo y la puerta mira la base entonces.
- **Servicios sigue sin activar**: las tres banderas, apagadas.

# Parte VII · La política operativa congelada (G18, 01/10/2026)

## 106. Estado

> *Al 01/10/2026, 18:05 UTC:* la 0095 ya está **aplicada y verificada** y la
> corrección, **técnicamente cerrada** (§118). Lo que sigue en esta parte se
> escribió antes de aplicarla y se conserva como estaba.

**Corrección G18 implementada y probada; pendiente de aplicar y verificar la
migración 0095 y de realizar el QA físico.** No es un incremento nuevo: cierra
el único hueco contractual que el cierre del Incremento 6 dejó registrado
(§103).

| | |
|---|---|
| **Código** | en `Edson`, **sin desplegar** (sin push, PR ni merge) |
| **Migración 0095** | **ESCRITA Y SIN APLICAR**. Probada solo contra PostgreSQL 17 local. No consta en `APLICADAS`: hasta que se aplique y se verifique, se puede corregir |
| **Banderas** | `FEATURE_SERVICES`, `FEATURE_SERVICE_BOOKING` y `FEATURE_SERVICE_PAYMENTS`, **apagadas**; la pasarela, `none` |
| **Valores** | **provisionales**: congelarlos no los decide (G1–G12 siguen siendo de la empresa) |
| **API y móvil** | sin rutas, pantallas ni campos nuevos: el contrato que consume la app no cambió |

## 107. La causa

Al confirmar, una reserva ya copiaba el servicio, su versión, el prestador, el
horario, la modalidad, el precio y lo aceptado (las condiciones, por versión y
huella). **Los plazos** con los que después se decide qué se puede hacer con
ella no: `PoliticaDeAtencion.de()` leía la configuración del proceso en cuatro
sitios (al abrir cualquier transición, al enseñar las acciones, en el barrido
y al calcular el plazo de apelación del expediente). Cambiar una variable de
entorno cambiaba, hacia atrás, todas las reservas ya confirmadas.

Dos pruebas del Incremento 6 **afirmaban** ese efecto («con otra política, sí
se reprograma»; «las apelaciones se quitan después»): son la evidencia del
defecto, y se reescribieron con el comportamiento correcto.

## 108. Qué se congela y qué no

Cada valor que el dominio lee, clasificado. **A**: decide qué puede hacer
alguien con una reserva ya hecha, o hasta cuándo; se congela. **B**: técnico u
operativo, no cambia ningún derecho; se lee al actuar. **C**: todos los de A
son, además, provisionales: se congela el valor que el código usa hoy, sin
darlo por decidido.

| Ajuste | En la fotografía | Qué decide | Clase |
|---|---|---|---|
| `services_attention_checkin_minutes` (15) | `attention_checkin_minutes` | desde cuándo se pide el código y se puede empezar | A · C (G3) |
| `services_attention_tolerance_minutes` (15) | `attention_tolerance_minutes` | desde cuándo se declara una ausencia | A · C (G3) |
| `services_attention_confirmation_hours` (24) | `attention_confirmation_hours` | el plazo para confirmar y el cierre automático | A · C (G4) |
| `services_booking_reschedule_max` (1) | `booking_reschedule_max` | cuántas veces se reprograma | A · C (G2) |
| `services_booking_reschedule_min_hours` (24) | `booking_reschedule_min_hours` | con cuánta antelación | A · C (G2) |
| `services_incident_window_hours` (48) | `incident_window_hours` | el plazo ordinario para abrir un caso | A · C (G7) |
| `services_incident_appeal_days` (5) | `incident_appeal_days` | el plazo para apelar | A · C (G8) |
| `services_incident_appeals_max` (1) | `incident_appeals_max` | si se puede apelar | A · C (G8) |
| `services_review_window_days` (30) | `review_window_days` | hasta cuándo se reseña | A · C (G11) |
| `services_booking_reminder_hours` (24) | — | cuándo sale el recordatorio | B: es un aviso, no un plazo de nadie |
| `services_reviews_premoderation` | — | si una reseña NUEVA espera a moderación | B: es de la moderación de Z; si se enciende tiene que valer para toda reseña que se escribe |
| `services_booking_hold_minutes`, `…max_active_holds`, `…instant_modalities` | — | la retención y qué se confirma solo | B: valen ANTES de que haya reserva |
| `services_agenda_notice_minutes`, `…horizon_days` | — | qué horarios se ofrecen (también al reprogramar) | B: es la disponibilidad del horario NUEVO, de la agenda de hoy |
| intentos y cifras del código, largos de texto, evidencias por parte, lotes, espera del cerrojo, minutos de un enlace firmado | — | límites técnicos | B: constantes del código, varias impuestas también por la 0094 |
| banderas y pasarela (`cobro_disponible`) | — | si hay cobro | B: estado del sistema, no un plazo |

**Cancelar no tiene ningún plazo configurable**, y por eso no hay nada suyo
en la fotografía: se cancela hasta la hora de inicio y sin coste (no hay
dinero). No se inventó un valor para completar la lista. Cuando la empresa
decida plazos o costes de cancelación (G1), entrarán como claves nuevas, con
otra versión de la estructura y su migración.

## 109. La fotografía: forma, versión y huella

Tres columnas de `service_bookings`, escritas en el mismo `INSERT` que la
reserva (la fecha de captura es `confirmed_at`):

| Columna | Qué es |
|---|---|
| `operating_policy` (jsonb) | los nueve valores, por su clave. Solo enteros. Ni textos, ni la configuración del sistema |
| `operating_policy_version` (integer) | la versión de su estructura: **1**. Otra estructura es otra versión, con su migración: la base solo admite las que conoce |
| `operating_policy_sha256` (text) | el SHA-256 de su **forma canónica** |

La forma canónica es `{"schema_version":1,"values":{…}}` con las claves en
orden alfabético y sin espacios. La calcula la API
(`reserva_politica.huella_de_la_fotografia`) **y la vuelve a calcular la
base** en un CHECK: una huella que no es la de su fotografía no se guarda. La
de la política de fábrica es `dc91b8ba…`, fija en una prueba.

**No se duplica lo aceptado.** Las condiciones de contratación siguen en
`service_booking_acceptances` (su identificador, versión y huella); la
fotografía no copia su texto ni las referencia. Son dos cosas: lo que la
persona **aceptó** y los valores con los que el sistema **decide**.

**Por qué columnas y no una tabla aparte.** La reserva ya es la fotografía (el
título, el prestador, la zona) y ya está protegida: `servicios_reserva_inmutable()`
compara la fila entera. Así salen gratis, por construcción, «una por reserva»,
«se crea con la reserva o no se crea», «no se edita» y «una reserva anterior
no la gana después». Una tabla uno a uno habría necesitado tres disparadores
más, RLS, permisos y otra consulta en cada acción.

## 110. La 0095

`0095_servicios_politica_operativa_congelada.sql`. Aditiva, una transacción,
reejecutable. Añade a `service_bookings`:

- las tres columnas, **anulables y sin valor predeterminado**;
- cuatro CHECK: entera o ninguna (`…_politica_completa`); de una versión
  conocida (`…_version`); exactamente sus nueve claves, cada una un entero
  dentro de sus cotas (`…_forma`); y la huella que le corresponde
  (`…_huella`);
- `servicios_reserva_con_politica()` y su disparador `BEFORE INSERT`: **una
  reserva nueva nace con su fotografía, o no nace**.

Antes de tocar nada comprueba la 0086–0094 y se detiene diciendo qué falta;
entre otras cosas exige el disparador `service_bookings_inmutables` activo y
`servicios_reserva_inmutable()` **con el cuerpo exacto de la 0094**, porque de
él depende que la fotografía no se edite. Al final verifica lo que dejó (las
columnas sin predeterminado, los cuatro CHECK validados, el disparador, que la
función no se ejecuta desde fuera, RLS, cero políticas y cero permisos) y dice
cuántas reservas quedan sin fotografía. No crea tablas, no concede nada, no
borra y no toca ninguna fila.

## 111. Inmutabilidad

- **En la base.** El disparador de la 0093 (con el cuerpo de la 0094) rechaza
  cualquier `UPDATE` de una reserva que no sea cancelarla o reprogramarla, y
  en los dos exige que el resto de la fila sea idéntico. Probado: sustituir la
  fotografía por otra válida, vaciarla, tocar una sola de las tres columnas,
  hacerlo de paso al cancelar o al reprogramar, y hacerlo sobre una reserva
  cancelada: todo se rechaza. Cancelar y reprogramar siguen funcionando y la
  conservan.
- **En el dominio.** No hay ninguna función que la escriba salvo `confirmar`.
  El cuerpo de la petición no la admite (422). Un reintento con la misma clave
  devuelve la reserva ya hecha, sin volver a leer la configuración.
- **La baja de una cuenta no cambia** (F21 sigue pendiente): la fotografía se
  queda con la reserva cuando se va quien contrató, y se va con ella cuando se
  va quien presta.

## 112. Las reservas anteriores

Las que existan al aplicar la 0095 se quedan **sin fotografía** (las tres
columnas en `NULL`). No se les inventa una: nadie guardó con qué política se
confirmaron, y la migración no conoce la configuración del proceso. **Tampoco
pueden ganarla después** (una reserva no se reescribe), así que nunca se
presentará una política reconstruida como si fuera la original. La API las
trata como lo que son: `PoliticaDeAtencion.de_la_reserva` les aplica la
política **vigente**, como hasta ahora, y lo dice (`congelada` es falso).

**Limitación, dicha tal cual:** una reserva anterior sigue expuesta al cambio
de configuración. En Supabase no hay ninguna (verificado el 01/10/2026:
§102); la migración lo dirá al aplicarse.

## 113. Quién lee la fotografía

Un solo lector: `PoliticaDeAtencion.de_la_reserva` (estructura, claves, tipos,
cotas y huella), y un solo punto de entrada en el dominio,
`atencion.politica_de(reserva)`. Lo usan:

| Dónde | Qué decide con ella |
|---|---|
| `atencion.abrir` (toda transición), con la fila ya bloqueada | reprogramar (antelación y tope), el código y empezar (la llegada), la ausencia (la tolerancia), abrir un caso, apelar, reseñar |
| `atencion.cuidado` | las acciones disponibles y los plazos que enseña el detalle |
| `atencion._cerrar_sola` y el filtro del barrido | el cierre automático, y cuántas quedan sin verificar |
| `ExpedienteRead` | hasta cuándo se apela |

`PoliticaDeAtencion.vigente()` (la de ahora) solo la llama quien **confirma**
una reserva, para congelarla, y el lector para una reserva anterior a la 0095.
Si la fotografía guardada no es de fiar (no puede pasar en una base con la
0095), **no se sustituye por la vigente**: con esa reserva no se hace nada
(409 `service_booking_action_not_available`) y el barrido la salta.

El barrido necesita saber, en SQL, qué atenciones vencieron «con el plazo de
su reserva». No hace aritmética de fechas con JSON (no es portable): lee los
plazos distintos que hay entre las terminadas (uno por cada cambio de
configuración) y compara cada atención con el suyo. Quien cierra vuelve a
comprobarlo con la fotografía verificada.

## 114. La puerta

`hay_reservas` exige ahora la 0093 **tal como la dejan la 0094 y la 0095**:
las tres columnas con su tipo, anulables y sin predeterminado; los 46 CHECK
por su definición; los 17 disparadores (entre ellos el que exige la fotografía
y el que impide reescribir la reserva) y sus funciones por su cuerpo; RLS,
cero políticas y nadie de fuera. `hay_atencion` exige lo mismo y, además, la
0094.

**Sin la 0095, toda la reserva contesta 503 `services_not_ready`**, no solo
lo nuevo: los modelos ya leen esas columnas, y sin ellas cualquier consulta de
una reserva sería un 500. El catálogo sigue, y la agenda privada del prestador
también. **Los horarios públicos no se ofrecen** mientras la contratación esté
encendida: sin poder leer lo ocupado se enseñaría como libre el horario de
otra persona, así que contestan 503 (`agenda._exigir_lo_ocupado`); con la
contratación apagada nadie aparta nada y son los de la agenda. Es el estado de
producción hasta que se aplique (con las banderas apagadas no se llega a
mirar). Un error al inspeccionar es un 503 y **no se recuerda**; el «sí» y el
«no», sí: **al aplicar la 0095 hay que reiniciar la API**.

## 115. Cómo aplicar y verificar la 0095

**Primero la migración, después el código.** Un servidor con este código y
sin la 0095 contesta 503 en toda la reserva. Un servidor anterior que
confirmara reservas con la 0095 ya puesta chocaría con su disparador (no trae
la fotografía): hoy no existe ninguno, porque el código de Servicios no está
desplegado y sus banderas están apagadas.

1. Confirmar que nadie está contratando (las banderas están apagadas).
2. Pegar el fichero entero en el editor SQL de Supabase y ejecutarlo. Es una
   sola transacción: o queda todo o no queda nada. Tiene que terminar con el
   aviso «La 0095: N reserva(s) anteriores, sin fotografía»; hoy, N = 0.
3. **Reiniciar la API** que vaya a usarla (la puerta recuerda el «no»).
4. Verificar en solo lectura, como las anteriores: comparación con una
   referencia local 0001–0095, las tres columnas, los cuatro CHECK, el
   disparador y su función, RLS, políticas y permisos, y las puertas con la
   conexión y el rol reales de la API.
5. Registrar su huella en `APLICADAS` y actualizar esta sección.

**No se deshace en producción** (§104): si algo falla después, se apaga
`FEATURE_SERVICE_BOOKING` y se corrige con otra migración.

## 116. Pruebas, mutaciones y revisión (01/10/2026)

| Qué | Resultado |
|---|---|
| La 0095 (`test_servicios_migracion_0095.py`) | **20**: 7 estáticas y 13 contra PostgreSQL 17. Desde cero (0001–0095); sobre la 0094 vacía y con reservas (no toca ninguna, y dice cuántas quedan sin fotografía); reejecutada dos veces, y la 0094 encima; con un fallo a mitad (tres cortes: no queda nada); incompleta (diez formas: se niega); sin cada dependencia (seis: se niega diciendo cuál); la huella de la API es la que exige la base; fotografías corruptas, sin huella o de otra versión; que no se edita, ni se vacía, ni se sustituye; una reserva anterior; y la baja de una cuenta |
| El modelo, igual a la base **por definición** | la batería de la 0093 con la cadena entera: incluye las tres columnas y los cuatro CHECK (dos solo existen en PostgreSQL) |
| Las migraciones anteriores, intactas | `test_las_aplicadas_no_han_cambiado` (0086–0094, por su huella); las baterías de la 0093 y la 0094 siguen en verde, fijadas a su migración |
| La fotografía y su lector, sin base | **24** (en `test_servicios_atencion_reglas.py`): lo contractual y nada más, la huella canónica, veinte fotografías que no son de fiar, y la reserva anterior |
| Por la API real, con PostgreSQL (`test_servicios_politica_congelada.py`) | **21**: 15 funcionales (política A al reservar y B después: reprogramar, la llegada y la tolerancia, el cierre automático, el caso, la apelación, la reseña; el reintento; el fallo sin reserva a medias; la fotografía manipulada; la reserva anterior), 4 carreras y 2 de la puerta (26 alteraciones) |
| Backend completo con PostgreSQL | **4346 aprobadas, 0 fallidas, 0 omitidas** (23 min) |
| Backend completo sin PostgreSQL | **3107 aprobadas, 1239 omitidas** (las que necesitan PostgreSQL), 0 fallidas |
| Móvil | **no cambió** (ningún fichero): `tsc --noEmit` limpio y paridad i18n (34/34). No se repitieron la batería completa, Expo Doctor ni la exportación web |
| Rutas | 556 operaciones, 134 de Servicios: ninguna nueva ni duplicada |
| `git diff --check` · secretos | limpio · ninguno |

**Dos pruebas del Incremento 6 afirmaban el defecto** y se reescribieron:
«con otra política, sí se reprograma» y «las apelaciones se quitan después».
Una tercera describía una base solo con la 0093 (la reserva seguía); ahora
describe una base sin la 0095 (la reserva espera).

### El recorrido (local, API real)

Seis procesos de la API contra una base local, con la configuración cambiada
**de verdad** (cada política es un proceso arrancado con otras variables de
entorno): **59 de 59 comprobaciones, 587 peticiones, ningún 500**.

1. Con la 0001–0094 y sin la 0095: la reserva y las 33 rutas de la atención
   contestan 503, los horarios no se ofrecen y no se escribe nada. Aplicada la
   0095 (dos veces), el mismo proceso sigue en 503.
2. Reiniciada, con la política A: contratar (la reserva nace con la fotografía
   de A), el recorrido gratuito entero, cancelar y reprogramar.
3. **Reiniciada con la política B**: lo hecho con A sigue con A al reprogramar
   (409 con sus 24 h), en la llegada, la tolerancia, el cierre automático, el
   caso, la apelación y la reseña; lo nuevo recibe B, con otra huella.
4. **Reiniciada con A otra vez**: lo hecho con B sigue con B.
5. Las banderas apagadas, los registros sin trazas ni secretos, y el dinero
   intacto.

### Concurrencia (PostgreSQL)

Confirmar a la vez y con la misma `Idempotency-Key` (una reserva, una
fotografía, y las repeticiones devuelven los mismos plazos); seis personas
confirmando mientras la configuración salta entre A y B (cada reserva queda
con una política **entera**, nunca una mezcla); reprogramar mientras cambia
(la de A no se mueve en ningún instante; la de B, una vez); y cuatro barridos
a la vez mientras cambia (se cierra solo la que toca, una vez). No se repitió
la campaña de concurrencia del Incremento 6: ese código no cambió.

### Mutaciones dirigidas

**27 de 27 muertas**, en un árbol de trabajo desechable: volver a leer la
configuración (en el lector, al actuar, al enseñar, en el barrido, en el
expediente, en la apelación); no guardar la fotografía; no comprobar la
huella (en el lector y en la base); no validar los valores ni la versión;
sustituir por la vigente una que no es de fiar; recalcular en un reintento;
aceptar la que envía quien contrata; permitir una reserva sin ella; que la
0095 no exija el cuerpo que impide reescribir la reserva; claves de más; una
reserva anterior presentada como congelada; la puerta sin mirar el valor
predeterminado o sin exigir la 0095; congelar de más (la moderación, el
recordatorio); un plazo global en la cancelación; y ofrecer horarios sin
poder leer lo ocupado. No se repitieron las 54 del Incremento 6.

### Revisión independiente

Sin hallazgos bloqueantes ni altos.

- **Medio, corregido** (prueba en rojo, corrección, prueba en verde): con la
  puerta de la reserva cerrada y la contratación encendida, el calendario
  público ofrecía los horarios sin descontar lo ocupado. Ahora contestan 503;
  con la contratación apagada son los de la agenda (§114). De la misma
  revisión sale el orden de aplicación: **primero la 0095, después el código**
  (§115).
- **Bajos, no cambiados, y por qué.** Que una reserva anterior se rija por la
  vigente no deja rastro en ninguna respuesta: se identifica en la base
  (`operating_policy is null`) y no se añadió un campo para ello. Una
  fotografía no fiable bloquea también ver y cancelar: a propósito, pero
  obliga a que **una versión 2 de la estructura se despliegue en el lector
  antes de escribirse**. El barrido lee una clave del JSON en SQL: es solo el
  filtro; quien cierra la relee comprobada. La huella es redundante en
  PostgreSQL (la base la recalcula): se mantiene porque identifica la política
  y protege la lectura donde no hay CHECK. La migración no fija `lock_timeout`
  (como las anteriores), y una restauración solo de datos con los disparadores
  activos rechazaría las reservas sin fotografía.

## 117. Lo que sigue pendiente

- ~~Aplicar y verificar la 0095 y registrar su huella~~: hecho el 01/10/2026
  (§118).
- **Los valores**: los nueve siguen siendo los provisionales del alcance.
  Congelarlos no resuelve G2, G3, G4, G7, G8 ni G11.
- **La cancelación con plazos o con coste** (G1): no existe; cuando se decida
  entrará en la fotografía con otra versión.
- **F21** (la baja de quien presta se lleva su historia): sin tocar.
- **El QA físico** de los seis incrementos, y lo de §105.

## 118. Cierre técnico de la corrección G18 (01/10/2026): la 0095, aplicada y verificada

La 0095 se ejecutó a mano en Supabase y se verificó el 01/10/2026 a las
**18:05 UTC** (13:05 en Lima), PostgreSQL 17.6: **sin divergencias**. No se
volvió a ejecutar, no se escribió ningún dato en Supabase y no se creó ninguna
migración más.

### La verificación, en solo lectura

Tres sesiones, las tres demostrablemente de solo lectura (`transaction_read_only
= on`, y una sonda de escritura rechazada con **25006** antes de consultar
nada), terminadas con `ROLLBACK` y sin identificador de transacción de
escritura:

1. **catálogos y recuentos** (`BEGIN READ ONLY`);
2. **la de la API**: el mismo `DATABASE_URL`, con asyncpg y SQLAlchemy, y el
   código real de las puertas;
3. **un error al inspeccionar**, para ver que no se recuerda.

No se imprimió ni se guardó ningún dato de conexión.

### La referencia y el verificador

Referencia: el repositorio (prólogo + 0001–0095) sobre PostgreSQL 17.11 local
desechable. Antes de mirar Supabase, el verificador se ensayó contra esa
referencia: **sin divergencias** con ella intacta, y **14 de 14 alteraciones
detectadas** estropeándola de una forma cada vez (una columna ausente, el JSONB
con otro tipo, la versión con un valor predeterminado, la huella con otra
nulabilidad, sin el CHECK de la versión, sin el de la huella o con uno
aflojado, sin el disparador de inserción, la función con otro cuerpo, la
fotografía modificable —sin el disparador de la reserva o con otro cuerpo—,
RLS apagada, un permiso para un rol de fuera, y datos incoherentes).

### Supabase frente a la 0001–0095

| | |
|---|---|
| **Esquema público entero** | igual a la referencia: 1781 columnas, 1348 restricciones, 552 índices, 104 disparadores, 63 funciones, 169 de 169 tablas con RLS, 149 políticas. Frente a la verificación de la 0094 (§102): **+3 columnas, +4 restricciones, +1 disparador, +1 función**, y nada más |
| **De Servicios** | 28 tablas, 393 columnas |
| **Las tres columnas** | `operating_policy` (jsonb), `operating_policy_version` (integer) y `operating_policy_sha256` (text): las tres últimas de `service_bookings` (posiciones 27, 28 y 29), anulables, **sin valor predeterminado**, sin identidad ni generación |
| **Los cuatro CHECK** | `…_politica_completa`, `…_version`, `…_forma` y `…_huella`: validados e **iguales por definición** a los de la referencia. Con ellos, los 46 CHECK de las seis tablas de la reserva dan la huella que exige la puerta (`b4e7a1ee…`) |
| **El disparador** | `service_bookings_con_politica`: `BEFORE INSERT … FOR EACH ROW`, activo, sin diferir |
| **Su función** | `servicios_reserva_con_politica()`: cuerpo exacto (`53a22da5…`), `SECURITY INVOKER`, `search_path = public, pg_temp`, no ejecutable por `PUBLIC`, `anon` ni `authenticated` |
| **La protección contra cambios** | `service_bookings_inmutables` (`BEFORE UPDATE`, activo) con `servicios_reserva_inmutable()` y **el cuerpo de la 0094** (`fe2816a5…`), que compara la fila entera |
| **Índices** | los siete de `service_bookings`, sin cambios (la 0095 no crea ninguno) |
| **Propietario, RLS y permisos** | el mismo propietario que en la referencia; RLS activa; cero políticas; ningún permiso para `PUBLIC`, `anon` ni `authenticated`: ni declarado, ni por columna, ni en la ACL, ni efectivo. Con permiso, solo `postgres` y `service_role`, como en las demás |
| **Lo que escribió** | **una sola transacción** dejó sus nueve objetos (tres columnas, cuatro CHECK, un disparador y una función) y **ninguna fila** en las 215 tablas revisadas |
| **Las migraciones anteriores** | las diez tablas de la reserva y de la atención (0093 y 0094), definición por definición, iguales a la referencia; las catorce funciones de la reserva y de la atención, con el mismo cuerpo; 366 claves ajenas revisadas, ninguna huérfana ni sin validar |

Es la **versión final** del fichero: su huella git es `9e46e8bf…`, la misma
del commit que lo creó.

**Lo que no se ejecutó en Supabase**, porque sería escribir: insertar una
reserva sin fotografía o intentar editarla. El comportamiento se comprobó en la
referencia local (`test_servicios_migracion_0095.py`), que es igual a Supabase
por definición: función, disparador y CHECK, por su cuerpo y no por su nombre.

### Integridad y legado

| Recuento | Supabase |
|---|---|
| Reservas | **0** |
| …sin fotografía (anteriores a la 0095) | 0 |
| …con la fotografía completa | 0 |
| …con una fotografía parcial, de otra versión, con otra huella, con el JSON incompleto o con un valor no entero | 0 |
| Reservas duplicadas o incoherentes con su retención, su pedido o su estado | 0 |
| Pedidos, retenciones, historial, aceptaciones, atenciones, casos y reseñas | 0 |
| Condiciones de contratación publicadas | 0 |

**No hay ninguna reserva anterior a la 0095** que quede sin fotografía. Y, dicho
tal cual: con las tablas vacías, estos ceros **no prueban** las reglas con
datos reales; solo dicen que no hay nada que las incumpla. Las reglas se
probaron con datos en local.

### Las puertas, con la conexión y el rol de la API

En un proceso nuevo (sin memoria), con el rol real (no es superusuario; es
propietario de las tablas):

- `hay_admision`, `hay_catalogo`, `hay_guardados`, `hay_agenda`,
  `hay_reservas` y `hay_atencion`: **las seis dicen «sí»**;
- la condición de la 0095 (la reserva tal como la dejan la 0094 y la 0095):
  **sí**. Y los dos controles negativos: la forma de la 0093 sola y la que
  dejaba la 0094, **no**. La base está en la 0095 y en ninguna anterior;
- con las banderas **apagadas** (como están), las siete puertas contestan
  `services_disabled` **sin sesión de base**: no la consultan;
- con las dos encendidas solo en ese proceso, las siete pasan;
- **un error al inspeccionar** contesta que no y **no se recuerda**: la
  siguiente consulta vuelve a mirar y dice que sí.

### El reinicio y el recorrido A/B (local, API real)

Ocho procesos de la API contra una base local, cada política en un proceso
arrancado con otras variables de entorno: **75 de 75 comprobaciones, 706
peticiones, ningún 500**.

1. **Con la 0001–0094 y la contratación apagada**: los horarios son los de la
   agenda (`booking_available: false`) y apartar contesta
   `service_booking_disabled`.
2. **Con la contratación encendida y sin la 0095**: la reserva, las 33 rutas
   de la atención y **los horarios públicos** contestan 503
   `services_not_ready` —un error, no un calendario vacío— y no se escribe
   nada. Aplicada la 0095 (dos veces), **el mismo proceso sigue en 503**.
3. **Reiniciada** (política A): la puerta la reconoce, los horarios vuelven y
   se contrata; la reserva nace con la fotografía de A (`dc91b8ba…`).
   Manipular la petición es un 422; el recorrido gratuito entero pasa.
4. **Reiniciada con la política B**: lo hecho con A sigue con A, y lo nuevo
   recibe B, con otra huella. Comportamiento, no solo el JSON:

   | | Reserva hecha con A | Reserva hecha con B |
   |---|---|---|
   | Reprogramar a 23 h | 409, con sus 24 h | 200 (2 h) |
   | Tope de cambios | 409 al segundo (1) | cambia tres veces; 409 al cuarto (3) |
   | Pedir el código a 30 min | 409 (abre a 15) | 200 (abre a 120) |
   | Empezar a 30 min | 409 | 200 |
   | Declarar la ausencia a los 20 min | 200 (tolerancia 15) | 409 (60) |
   | Cierre automático a las 2 h | espera (24 h) | se cierra (1 h) |
   | Caso a las 3 h de terminar | 201 (48 h) | 409, solo seguridad (1 h) |
   | Apelar a los 2 días | se ofrece y 200 (5 días, 1) | no se ofrece (ninguna) |
   | Reseñar a los 2 días | 201 (30 días) | 409 (1 día) |

   El reintento de una confirmación hecha con A, ya con B: 200, la misma
   reserva y **la misma fotografía**.
5. **Reiniciada con A otra vez**: lo hecho con B sigue con B.
6. **Una fotografía manipulada** (quitando, solo en esa base local, lo que lo
   impide): 409 controlado en el detalle, al reprogramar y al cancelar; nada
   cambia; restaurada y reejecutada la 0095 con reservas, vuelve a funcionar.
7. Las banderas apagadas, los registros sin trazas ni secretos, y el dinero
   intacto.

### Cancelar

Sigue con la regla del dominio: **hasta la hora de inicio, sin coste y sin
ningún plazo configurable**. No lee ninguna clave de la fotografía, porque no
existe ninguna de cancelación (probado con una reserva de A y otra de B, a dos
minutos de empezar y con la configuración cambiada). **No se inventó una
política.** Cambiar esa regla exigirá una decisión de la empresa (G1), otra
versión de la fotografía y su migración.

### Lo que no se congela, y por qué no toca a una reserva hecha

| Regla | Por qué no cambia un derecho ya adquirido |
|---|---|
| El recordatorio previo | es un aviso: no da ni quita nada que alguien pueda hacer |
| La moderación previa de una reseña | es de la moderación de Z; decide cuándo se **ve** una reseña nueva, no si se puede escribir (eso es la ventana, que sí se congela) |
| Cuánto dura una retención y cuántas activas | valen antes de que exista la reserva |
| Qué modalidades se confirman solas | decide si la reserva nace; una vez confirmada no vuelve a mirarse |
| La antelación y el horizonte de la agenda | son la disponibilidad del horario **nuevo** al reprogramar, de la agenda de hoy; el derecho a reprogramar (cuántas veces y hasta cuándo) sí está congelado |
| Los intentos y las cifras del código | constantes del código, impuestas también por la 0094; cambiarlas es desplegar, no configurar |
| Los largos de los textos y las evidencias por parte | límites técnicos de lo que se escribe, no plazos |
| Los lotes de los barridos y la espera de un cerrojo | operación interna |
| Las banderas y la pasarela de cobro | estado del sistema: si hay o no cobro, no un plazo de la reserva |
| Los minutos de un enlace firmado | cuánto vive una URL; se pide otra |

No se amplió la fotografía «por si acaso».

### Concurrencia (PostgreSQL, acotada)

Las cuatro carreras de `test_servicios_politica_congelada.py`, repetidas en
esta ronda: dos confirmaciones a la vez y con la misma `Idempotency-Key`
(una reserva, una fotografía); seis confirmaciones mientras la configuración
salta entre A y B (cada reserva con una política **entera**: A o B, nunca una
mezcla); reprogramar mientras cambia; y el barrido mientras cambia. No se
repitió la campaña del Incremento 6: ese código no cambió.

### Pruebas ejecutadas en el cierre

| Qué | Resultado |
|---|---|
| La 0095 (`test_servicios_migracion_0095.py`) | 20, en verde: desde cero, sobre la 0094 vacía y con reservas, reejecutada, a medias, incompleta, sin dependencias, la inserción sin fotografía y la edición rechazadas |
| El lector de la política, la reserva, la atención, la posventa y las puertas | dentro de las baterías de Servicios |
| **Servicios con PostgreSQL** (todas sus baterías, la 0089 y las migraciones reales) | **791 aprobadas, 0 fallidas, 0 omitidas** |
| **Servicios sin PostgreSQL** | **362 aprobadas, 429 omitidas** (las que necesitan PostgreSQL), 0 fallidas |
| El recorrido A/B con procesos reales | 75 de 75 |
| `tsc --noEmit` · paridad i18n | limpio · 34 de 34 |
| Operaciones de la API | 556 (134 de Servicios), ninguna duplicada |
| `git diff --check` · secretos | limpio · ninguno |

No se corrigió código funcional en esta ronda, así que no se repitieron el
backend completo, la batería completa del móvil, Expo Doctor, la exportación
web ni las 27 mutaciones.

### La huella

`0095_servicios_politica_operativa_congelada.sql` consta en `APLICADAS`
(`test_servicios_migracion_0090.py`) con su huella git
`9e46e8bfdc5e2e55034bad6a76bbcdb4cbc2dd1b`: desde ahora, editar el fichero
pone rojas `test_las_aplicadas_no_han_cambiado` y
`test_consta_como_aplicada_y_ya_no_se_edita` (comprobado añadiéndole una
línea: 2 fallan; restaurado, pasan). Su cabecera sigue diciendo «SIN APLICAR»,
como las anteriores: cambiarla sería editar lo aplicado.

### Veredicto

**G18, resuelta en lo técnico.** Sus nueve valores siguen siendo los
provisionales del alcance.

## 119. Cierre consolidado de los seis incrementos (01/10/2026)

No es una auditoría nueva: reúne lo que cada cierre dejó documentado.

| # | Incremento y alcance | Migraciones | Estado técnico | QA físico | Decisiones de la empresa | Dependencias externas | Bandera |
|---|---|---|---|---|---|---|---|
| 1 | **Admisión de prestadores**: condiciones versionadas, postulación, documentos privados, credenciales, revisión, correcciones, aprobación, rechazo, suspensión y retirada | 0086, 0087, 0088 (y la 0089 de plataforma: la baja de cuenta) | **cerrado** el 29/09 (§9, §16) | pendiente | S1–S14 (S7, decidida) | Supabase Storage (documentos privados); push con destino | `FEATURE_SERVICES` |
| 2 | **Catálogo y publicación**: categorías, servicio versionado, imágenes, envío, revisión y publicación | 0090 | **cerrado** el 29/09 (§32) | pendiente | C1–C16 | Supabase Storage (imágenes) | `FEATURE_SERVICES` |
| 3 | **Descubrimiento y guardados**: catálogo público, búsqueda, filtros, perfil del prestador, señales de confianza, guardados y sugerencias | 0091 | **cerrado** el 29/09 (§49) | pendiente | D1–D15 | — | `FEATURE_SERVICES` |
| 4 | **Disponibilidad y agenda**: semana, excepciones, bloqueos y horarios calculados por el servidor | 0092 | **cerrado** el 30/09 (§61) | pendiente | E1–E12 | calendarios externos (no construidos) | `FEATURE_SERVICES` |
| 5 | **Reserva y contratación**: retener, resumen, condiciones versionadas, confirmar lo gratuito, mis reservas y la bandeja del prestador | 0093 | **cerrado** el 01/10 (§80) | pendiente | F1–F21 (**F21, la primera**) | pasarela de pago (no existe para Servicios) | `FEATURE_SERVICE_BOOKING` (y `FEATURE_SERVICE_PAYMENTS`, sin adaptador) |
| 6 | **Atención, posventa y cierre**: cancelar, reprogramar, asistencia, inasistencia, caso con expediente y evidencias, resolución y apelación, reseña verificada, avisos y barridos; y **la política operativa congelada en cada reserva (G18)** | 0094 y 0095 | **cerrado** el 01/10 (§102 y §118) | pendiente | G1–G17 (G18, resuelta en lo técnico) | planificador de los barridos; sala de 100ms; push con destino; Storage (evidencias) | `FEATURE_SERVICE_BOOKING` |

Las diez migraciones (0086–0095) están aplicadas en Supabase, verificadas en
solo lectura sin divergencias y registradas en `APLICADAS`. Las tres banderas
están **apagadas** y la pasarela es `none`. El código está en `Edson`, **sin
desplegar**.

**Los Incrementos 1–6 de Z Servicios están técnicamente cerrados; únicamente
quedan pendientes el QA físico, las decisiones empresariales y las
integraciones externas documentadas.**

## 120. Lo que queda, por quién

**A. Código técnicamente cerrado.** Los Incrementos 1–6 y la corrección G18.
No queda ningún hallazgo bloqueante ni alto abierto.

**B. QA físico** (`Z_QA_FISICO_PENDIENTE.md`). Nada se probó en un teléfono:
los recorridos de los seis incrementos con personas distintas (quien contrata,
quien presta, administración), los archivos reales (documentos del prestador,
imágenes, evidencias de un caso y su enlace firmado), las notificaciones, la
accesibilidad y los idiomas.

**C. De la empresa.** Ninguna se dio por resuelta:

- **S1–S14** (S7 decidida), **C1–C16**, **D1–D15**, **E1–E12**, **F1–F21** y
  **G1–G17**. (Los resúmenes anteriores decían «C1–C15»: la tabla tiene C16, y
  la serie S del Incremento 1.)
- **F21, la primera**: qué se conserva cuando quien presta borra su cuenta.
  Hoy se va su historia entera (§105).
- **Publicar las condiciones de contratación** (`booking_terms`, F9): no hay
  ninguna, y sin ellas no se confirma nada.
- **Los valores definitivos** de la política operativa: los nueve congelados
  y el resto son los provisionales del alcance.
- **Quién ejecuta los barridos** (F13, G12): sin planificador no hay
  recordatorios ni cierre automático.
- **Cómo se encuentran las partes en un servicio virtual** (G17): Z no ofrece
  sala.
- **El proveedor de pagos** y lo que cuelga de él (comisión, comprobantes,
  devoluciones).

> *Al 02/10/2026:* esta lista se depuró (§121). Lo que sigue siendo de la empresa
> está en `Z_REQUISITOS_Y_DECISIONES.md`, apartado IV.

**D. Integración y operación.** No se hizo nada de esto:

- el push que lleve a la reserva o al caso (hoy abre la aplicación);
- la cuenta y la conexión de 100ms;
- la conexión de Stripe o de otra pasarela;
- la programación de los barridos (cron, Lambda o EventBridge);
- **desplegar `Edson`**: sin push, sin PR y sin merge; al desplegar, la API
  arranca y la puerta mira la base entonces;
- el CI remoto de esa rama, la revisión del PR y la integración a `main`.

## 121. Las políticas de la primera versión y el registro depurado (02/10/2026)

Solo documentación: **no se cambió código, no se creó ninguna migración** y
las 0086–0095 siguen como estaban. El detalle, para leer sin ser técnico, está
al comienzo de `Z_REQUISITOS_Y_DECISIONES.md`.

**Qué se hizo.** Se adoptaron 105 políticas iniciales («Políticas iniciales
v1», P1–P105) y se clasificó cada una de las 96 decisiones anotadas en los
seis incrementos (S1–S14, C1–C16, D1–D15, E1–E12, F1–F21 y G1–G18):

| Estado | Cuántas | Identificadores |
|---|---|---|
| `DECIDIDA_PRIMERA_VERSION` | 42 | S7, C2, C4, C5, C9, C10, C11, C13, C15, D1, D3, D4, D6, D7, D8, D9, D10, D11, D13, D14, D15, E3, E4, E5, E6, E7, E11, E12, F3, F4, F5, F6, F8, F10, F11, F15, F19, G1, G5, G9, G10, G18 |
| `PROVISIONAL_CONFIGURABLE` | 14 | C6, C7, C8, E1, E2, F1, F2, F7, G2, G3, G4, G7, G8, G11 |
| `REQUIERE_EMPRESA` | 25 | S1, S2, S3, S6, S8, S9, S10, S11, S13, C1, C3, C12, C14, D5, D12, F9, F16, F17, F18, F20, F21, G6, G13, G15, G16 |
| `INTEGRACION_EXTERNA` | 3 | F13, G12, G17 |
| `MEJORA_FUTURA` | 6 | S4, S5, C16, D2, E8, F12 |
| `NO_APLICA_PRIMERA_VERSION` | 6 | S12, S14, E9, E10, F14, G14 |

**Qué manda.** Las partes I–VII de este documento son un registro
cronológico: cada cierre dice lo que era verdad ese día, y muchas frases
(«C15 sigue pendiente», «E1–E12 siguen siendo de la empresa», «ninguna se dio
por resuelta») son anteriores a esta consolidación. Donde haya diferencia,
**manda el consolidado del 02/10/2026**.

**«Decidida para la primera versión» no es «aprobada por la empresa».** Son
reglas iniciales técnicas, adoptadas por indicación de Edson. No son textos
legales ni se publican como condiciones.

### Lo decidido que el código o la base todavía no imponen

| Política | Qué pasa hoy | Qué falta | Cuándo |
|---|---|---|---|
| P5 · A domicilio | El catálogo admite de fábrica las tres modalidades: un servicio a domicilio se podría publicar, aunque no contratar | Fijar `SERVICES_CATALOG_MODALITIES=virtual,in_person` en el entorno. Es configuración, no código | Antes de encender |
| P29 · Ruta opaca | La ruta de una imagen empieza por el identificador del perfil y la 0090, ya aplicada, exige ese comienzo | Un bloque aparte: la ruta en `catalogo_imagenes.py`, una migración nueva que relaje el disparador y el barrido de la baja de cuenta. Hoy hay 0 archivos: no hay nada que mover | Antes de encender |
| P2 · PEN | El formulario de la app ofrece también USD y EUR; el servidor los rechaza al guardar (C16) | Ajuste menor de la app | Antes de encender |
| P1 · Perú | El código no bloquea países: una categoría puede limitarse a un país, y las condiciones son por país | Publicar condiciones solo para Perú. Es operación, no código | Al publicar las condiciones |
| P7 y P8 · Reguladas y prohibidas | No hay bloqueo automático de categorías ni de actividades | Se cumple en la creación de categorías y en la aprobación manual de cada servicio; la lista debe ir en las condiciones | Al redactar las condiciones |
| P15 · Credencial vencida | La señal pública ya se retira. No existe la relación entre credenciales y categorías que impediría publicar en una regulada | Se construye al abrir la primera categoría regulada | Antes de abrir una regulada |
| P42 · Otra zona horaria | Se avisa de que el teléfono está en otra zona; no se calcula la equivalencia | Mejora opcional de la app | Al ampliar países |
| P51 · Capacidad | La app no la enseña, pero la API pública devuelve la capacidad teórica | Quitarla de la respuesta pública: ajuste menor de código | Antes de abrir al público |
| P101 · Piloto por etapas | Las banderas son globales: encender Servicios lo abre a todas las cuentas | Un entorno de piloto, o un mecanismo de acceso por lista que hoy no existe | Antes del piloto |

**La ruta opaca (P29, C15 y D6) contradice a la 0090 ya aplicada.** El
disparador de la 0090 rechaza una imagen cuya ruta no empiece por
`<perfil>/<servicio>/`, y `catalogo_imagenes.py` la arma así. Cumplir la
política exige, en un bloque aparte: cambiar cómo se arma la ruta, una
**migración nueva** que sustituya esa comprobación (la 0090 no se edita) y
revisar el barrido de la baja de cuenta, que hoy encuentra las imágenes por
ese prefijo. Hay **0 archivos** en el depósito, así que no hay contenido que
mover. Mientras no se haga, **no conviene encender Servicios**: cada tarjeta
del catálogo lleva esa ruta en su URL firmada, también sin sesión.

**A domicilio (P5).** `services_catalog_modalities` conserva de fábrica las
tres modalidades, que son los límites de la 0090. La política se cumple
fijando `SERVICES_CATALOG_MODALITIES=virtual,in_person` en el entorno; el
valor de fábrica no se cambió, porque es código. Contratar a domicilio ya era
imposible (`services_booking_instant_modalities`).

### Lo que sigue pendiente

- **De la empresa**: 48 asuntos en cinco grupos, y seis integraciones
  externas (`Z_REQUISITOS_Y_DECISIONES.md`, apartados IV y V). **F21 sigue
  siendo la primera** y no se resolvió con código.
- **Los nueve valores de la política operativa** siguen siendo provisionales.
- **QA físico**: los seis incrementos, y cuatro comprobaciones nuevas de estas
  políticas (`Z_QA_FISICO_PENDIENTE.md`).
- Las banderas siguen **apagadas**, la pasarela es `none` y el código, **sin
  desplegar**.

# Parte VIII · Cinco políticas, cerradas en el código (02/10/2026)

## 122. Estado

**Las cinco brechas entre las políticas consolidadas (§121) y el
comportamiento real están cerradas en el código y probadas.** No es un
incremento nuevo: no añade funciones, pantallas ni rutas. La migración 0096
se aplicó y se verificó después, el mismo día (§131); queda el QA físico.

| | |
|---|---|
| **Código** | en `Edson`, **sin desplegar** (sin push, PR ni merge) |
| **Migración 0096** | **APLICADA** a mano en Supabase y verificada el 02/10/2026 (19:51 UTC) en solo lectura: **sin divergencias** (§131). Consta en `APLICADAS` |
| **Migraciones 0086–0095** | intactas: sus huellas siguen siendo las de `APLICADAS` |
| **Banderas** | `FEATURE_SERVICES`, `FEATURE_SERVICE_BOOKING` y `FEATURE_SERVICE_PAYMENTS`, **apagadas**; la pasarela, `none`; `SERVICES_PUBLIC_ACCESS`, apagada; `SERVICES_PILOT_PROFILE_IDS`, vacía |
| **AWS** | la plantilla, los perfiles y el guion **preparados**; no se ejecutó ningún Change Set ni ningún despliegue |
| **Supabase** | desde aquí no se escribió nada. La 0096 la ejecutó Edson a mano; después solo se leyó, para verificarla |

| Política | Qué faltaba | Qué se hizo | Dónde |
|---|---|---|---|
| **P29** rutas opacas | la ruta de una imagen llevaba el perfil del prestador, y la 0090 lo exigía | ruta al azar bajo la carpeta del servicio; migración 0096; la baja barre esa carpeta | §123, §124 |
| **P5** sin «a domicilio» | el catálogo admitía de fábrica las tres modalidades | de fábrica, dos; el borrador y el filtro rechazan otra; la app no la ofrece | §125 |
| **P2** solo PEN | el formulario ofrecía también USD y EUR | la app ofrece solo soles; otra moneda es un error del dominio | §125 |
| **P51** la capacidad | la ficha pública y cada horario traían el número | retirado de los contratos públicos | §126 |
| **P101** piloto | las banderas abrían Servicios a todas las cuentas | una lista de perfiles y una apertura general explícita | §127 |

## 123. P29: la ruta opaca de las imágenes

**Qué había.** `catalogo_imagenes.subir` armaba la ruta
`<perfil>/<servicio>/<versión>/<id>.<ext>`, y el disparador
`service_version_images_solo_en_borrador` de la 0090 rechazaba cualquier otra.
Esa ruta va dentro de la URL firmada de cada tarjeta del catálogo, que se ve
sin sesión: delataba el perfil de quien presta.

**La ruta nueva** es `<servicio>/<32 hexadecimales>.<jpg|png|webp>`:

- la pone **solo el servidor** (`catalogo_imagenes.ruta_nueva`): 128 bits de
  `secrets.token_hex`, distintos en cada subida. El teléfono no manda una
  ruta, ni la elige con el nombre de su archivo ni con un campo de más;
- la **extensión** sale del tipo que dijeron los bytes (`_medir`), no del
  nombre ni del tipo declarado;
- **no lleva el perfil**, ni el prestador, ni nada derivado del título, el
  correo, el teléfono o el nombre;
- lleva el **identificador del servicio**, que no delata a nadie —es el mismo
  de la dirección de su ficha— y sirve para dos cosas: la base comprueba que
  la ruta es de ESE servicio, y la baja de una cuenta barre la carpeta entera.

**Lo que se conserva, igual que antes:**

| | |
|---|---|
| Depósito | `service-media`, privado, sin políticas de `storage.objects` |
| Enlaces | firmados al leer, 3600 s; la ruta nunca sale en una respuesta |
| Validación | por los bytes reales, 5 MB, JPEG/PNG/WebP |
| Copia entre versiones | abrir un borrador copia las filas con su misma ruta: un archivo, varias filas |
| Recuento de referencias | quitar una imagen borra el archivo solo si ninguna otra fila lo nombra |
| Orden del borrado | la fila primero; el archivo, después de confirmar la base |
| Idempotencia | el id de la FILA sigue saliendo de la clave: un reintento devuelve la imagen que ya está, sin subir otra |

**Una diferencia, a propósito.** Antes, con clave de idempotencia, la ruta
salía de la clave y un reintento pisaba el archivo de un intento cortado.
Ahora la ruta es siempre nueva y nunca pisa nada: si un intento escribe su
archivo y se corta antes de guardar la fila, ese archivo queda sin fila bajo la
carpeta del servicio, y lo barre la baja de la cuenta. **Un límite:** si un
perfil se borrara por fuera de la API (desde el panel de Supabase), la baja no
corre, y esos archivos quedan en la carpeta de un servicio que ya no existe.
Su ruta ya no dice de quién eran: hay que retirarlos a mano.

**La baja de la cuenta.** Las imágenes ya no cuelgan de `<perfil>/`, así que
`identity/baja.py` apunta ANTES de borrar los servicios que la persona ofrecía
(`_servicios`) y `storage.delete_user_files` barre, además de `<perfil>/` en
cada depósito, `service-media/<servicio>/` de cada uno. Es el mismo patrón que
los adjuntos de chat. Lo ajeno no se toca: la carpeta es del servicio.

Si esa lista no se puede leer, la baja **se detiene** (500, y se reintenta):
seguir borraría los servicios en cascada y dejaría sus imágenes sin nada que
diga de quién eran. La única excepción es una base que todavía no tiene las
tablas de Servicios (`42P01`): ahí no hay nada que barrer.

**Las rutas anteriores conviven.** Una fila con la ruta de la 0090 se sigue
firmando, copiando y borrando igual, y la baja la sigue barriendo por la
carpeta del perfil (`service-media` sigue en `USER_BUCKETS`). Lo que ya no se
puede es registrar una ruta nueva con esa forma: lo impide la base (§124). No
hay ninguna migración de objetos de Storage, ni hace falta: el 29/09/2026 el
depósito tenía 0 objetos y la tabla 0 filas.

## 124. La 0096: qué hace, cómo aplicarla y cómo verificarla

> **Hecho el 02/10/2026.** La 0096 está aplicada, verificada sin divergencias y
> registrada en `APLICADAS` (§131). Lo que sigue es lo que hace y el
> procedimiento que se siguió.

`supabase/migrations/0096_servicios_rutas_opacas.sql`. **Sustituye el cuerpo
de una función** —`service_version_images_solo_en_borrador()`, la de la
0090— y nada más: ni tablas, ni columnas, ni índices, ni disparadores, ni
permisos, ni políticas, ni el depósito, ni un solo archivo. La 0090 no se
edita.

**Qué admite el disparador desde la 0096**, al insertar una imagen o al
cambiarle la ruta:

1. la ruta nueva: `^<service_id>/[0-9a-f]{32}[.](jpg|png|webp)$`;
2. una ruta anterior, **solo si es una copia**: tiene la forma de la 0090
   (`<perfil>/<servicio>/…`) Y otra fila del mismo servicio ya la nombra. Es
   lo que hace la API al abrir una versión nueva; sin esto, un servicio con
   imágenes anteriores no se podría volver a editar.

Todo lo demás se rechaza con `check_violation`. Lo que el disparador ya hacía
(las imágenes solo cambian en un borrador; fuera de él solo se van en cascada)
queda igual.

**Sus garantías:** una sola transacción; comprueba antes de cambiar nada que
están las tablas, la 0095 (su función, su disparador activo y su columna), el
disparador de la 0090 activo y sobre esta función, que el cuerpo es el de la
0090 (`b8aa892a…`) o el suyo (una reejecución), y que el depósito es privado;
después verifica que dejó su cuerpo (`222bdbbd…`), `security invoker`, el
`search_path` fijo, el disparador intacto, la función sin ejecución para
`anon` ni `authenticated`, RLS activa, cero políticas, cero permisos sueltos y
el depósito privado. Si algo no cuadra, no confirma. Es reejecutable y dice
cuántas imágenes con ruta anterior hay.

**La puerta.** `esquema.hay_catalogo` exige ahora, además de lo de la 0090,
ese cuerpo por su huella (`CUERPO_DE_LAS_IMAGENES`). El nombre de la función
no cambia, así que mirar solo el nombre daría por buena una base sin la 0096,
y subir una imagen chocaría con ella. **Sin la 0096, todo el catálogo de
Servicios contesta 503 `services_not_ready`** (y con él la agenda, la reserva
y la atención, que dependen del catálogo). Nunca un 500.

### Cómo aplicarla

**EL ORDEN: primero la migración, después el código.** Producción corre hoy
un código anterior a Servicios, así que aplicar la 0096 no le cambia nada.

1. **Antes, en solo lectura** (editor SQL de Supabase). Lo esperado: `0`, `0`
   y `b8aa892aaaf500ceaf19e4ae52a457af`.

   ```sql
   select
     (select count(*) from storage.objects where bucket_id = 'service-media') as objetos,
     (select count(*) from public.service_version_images)                    as filas,
     (select md5(replace(p.prosrc, E'\r', '')) from pg_catalog.pg_proc p
       where p.oid = to_regprocedure('public.service_version_images_solo_en_borrador()')) as cuerpo;
   ```

   Si `objetos` o `filas` no fueran 0, la migración se puede aplicar igual
   (convive con las rutas anteriores), pero conviene saberlo antes: esas
   imágenes conservarán en su URL firmada el perfil del prestador hasta que
   se vuelvan a subir.

   Si `cuerpo` no fuera ese, **la 0096 se negará a aplicarse** y no cambiará
   nada. No hay que forzarla: primero hay que entender por qué la función de
   producción no es la de la 0090 (por ejemplo, si se aplicó con otra
   codificación de caracteres).
2. **Ejecutar el fichero entero**, tal cual, una vez. Debe terminar sin error
   y avisar `La 0096: 0 imagen(es) con ruta anterior`.
3. **Después, en solo lectura.** Lo esperado: `222bdbbd898701ecf458747cd45f6ef9`,
   `31`, `O`, `false`.

   ```sql
   select md5(replace(p.prosrc, E'\r', '')) as cuerpo, t.tgtype, t.tgenabled, p.prosecdef
     from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.service_version_images'::regclass and not t.tgisinternal;
   ```
4. **Registrar su huella en `APLICADAS`** (en el repositorio, en el bloque
   siguiente) y, cuando el código esté desplegado, **reiniciar la API**: la
   puerta recuerda el «no».

**No se deshace en producción** (§104). Y una advertencia: **la 0090 es
reejecutable y define esta misma función**. Si alguien la vuelve a ejecutar
después de la 0096, vuelve el cuerpo anterior. No es silencioso —la puerta lo
nota y el catálogo contesta 503— y se arregla reaplicando la 0096.

## 125. P5 y P2: dos modalidades y una moneda

**El servidor manda**, con la configuración de siempre (`catalogo_requisitos.Reglas`):

| Variable | De fábrica | Antes |
|---|---|---|
| `SERVICES_CATALOG_MODALITIES` | `virtual,in_person` | `virtual,in_person,at_home` |
| `SERVICES_CATALOG_CURRENCIES` | `PEN` | `PEN` |

«A domicilio» **sigue en el modelo**: en `MODALIDADES`, en el CHECK de la
0090, en la agenda y en la reserva. No se reescribió nada. Volver a ofrecerla
es añadirla a esa variable (y a `MODALIDADES_OFRECIDAS` en la app), después de
construir la aceptación del prestador, que sigue sin existir.

**Dónde se rechaza lo que Z no ofrece**, siempre con un error del dominio y
nunca con un 500:

| Dónde | Qué pasa |
|---|---|
| `PATCH …/draft` con `modality: "at_home"` | 422 `service_modality_not_allowed`, con las permitidas en `details`. **No se guarda nada** de esa petición |
| `PATCH …/draft` con `currency: "USD"` | 422 `service_currency_not_allowed` |
| Un borrador que ya la tenía | se conserva; al enviarlo, `missing` trae `modality_not_allowed` o `currency_not_allowed`, como antes |
| `GET /services/catalog?modality=at_home` o `?currency=USD` | 422 `service_catalog_filter_invalid`, con el campo |
| Contratar a domicilio | sigue sin poderse (`SERVICES_BOOKING_INSTANT_MODALITIES`), como antes |

Antes, un valor no ofrecido se guardaba en el borrador y solo se avisaba al
enviar. Ahora no entra: la app ya no lo enseña, así que solo llega una
petición escrita a mano.

**Lo que no cambia:** no se convierte ninguna moneda, el importe sigue en
unidades menores, y «gratis» y «a consultar» siguen sin moneda ni importe.

**En la app** (`lib/serviciosCatalogo.ts`): `MODALIDADES_OFRECIDAS` (las dos)
alimenta el formulario del prestador, el filtro público y el de la bandeja de
administración; `MODALIDADES` (las tres) se queda para nombrar lo que ya
existiera. `MONEDAS` es `['PEN']`, propia de Servicios: ya no es la lista de
Productos. Una prueba compara las dos con los valores de fábrica del
servidor. No hay textos nuevos: los dos códigos reutilizan los que ya
existían en los tres idiomas.

## 126. P51: la capacidad no es pública

El número de personas que caben es de la gestión del prestador y de
administración. Salía en dos contratos públicos, y de los dos se retiró:

| Contrato | Antes | Ahora |
|---|---|---|
| Ficha pública (`ServicioPublicoRead`, `FichaPublicaRead`) | `capacity` | no lo trae |
| Un horario (`HorarioRead`: calendario, horarios de un día, «próximo») | `capacity` | no lo trae |

`capacity` salió de `_Contenido`, que compartían lo público y lo privado, y
vive solo en `VersionRead` (lo que leen el prestador y administración). La
agenda privada conserva `service.capacity` y la capacidad de cada regla y de
cada excepción. **La reserva sigue respetando la capacidad por dentro**: lo ya
ocupado quita el horario entero cuando se llena, como antes.

Al público se le enseña solo lo que es cierto y útil: si hay horarios, cuáles,
o que no hay. No se inventó ningún «quedan pocos». `DiaRead.count` (cuántos
horarios posibles tiene un día) no es una capacidad y se queda.

En la app, `Contenido.capacity` pasa a opcional y `Horario` ya no lo declara;
`ContenidoDelServicio` lo pinta solo si llega, es decir, solo a quien gestiona.

## 127. P101: el piloto

**Dos variables**, y ninguna tabla, panel ni motor de cohortes:

| Variable | De fábrica | Qué hace |
|---|---|---|
| `SERVICES_PILOT_PROFILE_IDS` | vacía | los perfiles que entran durante el piloto: UUID separados por comas |
| `SERVICES_PUBLIC_ACCESS` | `false` | la apertura general. Solo con `true` deja de mirarse la lista |

**La regla** (`services/acceso.py`, `abierto_para`), sin consultar la base:

| `FEATURE_SERVICES` | `SERVICES_PUBLIC_ACCESS` | Lista | Quién entra |
|---|---|---|---|
| `false` | — | — | nadie |
| `true` | `false` | vacía | **nadie** |
| `true` | `false` | mal escrita | **nadie**, y se registra un error |
| `true` | `false` | con perfiles | solo esos perfiles, con sesión |
| `true` | `true` | — | todos, también sin sesión |

- **La lista vacía no abre nada.** Desplegar con la bandera encendida y sin
  lista deja Servicios cerrado. La apertura general no se deduce: se escribe.
- **Una lista mal escrita cierra el piloto entero**, también a los perfiles
  bien escritos. Se registra **cuántas** entradas fallan, una vez por valor, y
  **nunca cuáles**: ni un identificador ni un trozo de la variable van al
  registro.
- **Se normaliza**: mayúsculas, espacios, llaves o sin guiones son el mismo
  perfil.
- **A quien no entra se le contesta lo mismo que con Servicios apagado**: 503
  `services_disabled`. Es una respuesta estable que la app ya sabe pintar, y
  no dice a nadie que hay un piloto ni quién participa.
- **El catálogo público también se cierra.** Durante el piloto, la búsqueda,
  la ficha, los horarios, las reseñas y el perfil de un prestador son de los
  participantes con sesión. Una visita sin sesión recibe el mismo 503.
- **Administración entra por su rol**, esté o no en la lista: las rutas de
  `/admin/services` no pasan por esta puerta, y en ellas el rol se comprueba
  primero, como siempre. **Estar en la lista no da ningún rol**: quien
  participa y no es de administración sigue recibiendo 403. Y una persona de
  administración que no está en la lista no usa Servicios como cliente.
- **`FEATURE_SERVICE_BOOKING`** sigue siendo su propia bandera, y solo vale
  para quien ya entra. **Los pagos siguen apagados**, sin excepción.

**Una sola comprobación.** `exigir_participante` cuelga de los seis routers de
`/services` en `main.py`, una vez, y va antes que cualquier otra puerta.
Ninguna ruta repite la condición. Se comprueba por HTTP en todas las rutas de
Servicios, sacadas de la propia aplicación.

**Lo que sabe la app.** `GET /platform/config` contesta dos cosas **para
quien pregunta**, y la lista nunca sale del servidor:

| Campo | Vale `true` | Lo usa |
|---|---|---|
| `feature_services` | si esa persona entra: está en la lista, o hay apertura general | las entradas de Servicios del perfil y de los accesos (`useServiciosEncendido`) |
| `feature_services_admin` | si a esa persona le toca administrar Servicios, por su **rol** (`permissions.funcion_de`), con Servicios encendido | la sección de Servicios del panel de administración (`useServiciosDeAdministracion`) |

Son dos porque administración no entra por la lista. Con una sola respuesta,
a una administradora de fuera del piloto la app le escondía su bandeja aunque
el servidor la dejara pasar, y nadie podía revisar la primera postulación. La
segunda es la única que mira la base, y solo con Servicios encendido y con
sesión; si no puede mirarla, es que no, y la app recibe igualmente su
configuración.

En el móvil (`services/plataforma.ts`) la pregunta va con la sesión y se
repite al cambiar de cuenta, también cuando hay sesión y el perfil todavía no
cargó (`quienPregunta`). Ocultar un botón no es la protección: lo es el
servidor.

**Un token que viene y no vale es un 401**, no un «no participas»
(`acceso.quien_pregunta`, sobre `security.get_user_if_token`). A un
participante con la sesión caducada hay que decirle que la renueve;
contestarle que Servicios no está disponible lo dejaría fuera sin saber por
qué. Contesta igual con Servicios apagado que en el piloto, así que un token
roto no dice a nadie si hay un piloto. **Con la apertura general la puerta ya
no mira el token**: no necesita saber quién pregunta, y cada ruta decide como
siempre. `/platform/config` no cambia: con un token que no vale contesta como
a una visita sin sesión.

**Tres cambios de comportamiento que conviene conocer.** La puerta de quién
entra va antes que la sesión, en todas las rutas de `/services`:

- **sin token**, con Servicios apagado, una ruta privada contestaba 401;
  ahora contesta 503 `services_disabled`, como cualquier otra;
- **con un token que no vale**, apagado o en el piloto, una ruta pública (el
  catálogo, la ficha) lo trataba como una visita sin sesión; ahora contesta
  401. Con la apertura general sigue como antes: una visita sin sesión;
- **un token fabricado cuyo `alg` no es texto** era un 500 en cualquier ruta
  de la API, no solo en Servicios (PyJWT no comprueba el tipo); ahora es un
  401 `invalid_token`.

En `/admin/services` nada cambia: sin sesión, 401.

## 128. AWS: la configuración, preparada y sin desplegar

**No se ejecutó nada en AWS.** Solo cambian ficheros de `infra/aws/`.

Lo que la plantilla (`02-plataforma.yaml`) escribe ahora en el entorno de la API:

| Variable | Parámetro | Valor inicial |
|---|---|---|
| `FEATURE_SERVICES` | `FeatureServices` | `false` |
| `FEATURE_SERVICE_BOOKING` | `FeatureServiceBooking` | `false` |
| `SERVICES_PUBLIC_ACCESS` | `ServicesPublicAccess` | `false` |
| `SERVICES_CATALOG_MODALITIES` | `ServicesCatalogModalities` | `virtual,in_person` |
| `SERVICES_CATALOG_CURRENCIES` | `ServicesCatalogCurrencies` | `PEN` |
| `FEATURE_SERVICE_PAYMENTS` | *(ninguno: va fijo)* | `false` |
| `SERVICE_PAYMENTS_PROVIDER` | *(ninguno: va fijo)* | `none` |
| `SERVICES_PILOT_PROFILE_IDS` | *(va en el secreto)* | vacía |

- **El cobro no tiene parámetro.** `FEATURE_SERVICE_PAYMENTS=false` y
  `SERVICE_PAYMENTS_PROVIDER=none` se escriben fijos: no se pueden encender
  en un despliegue.
- **La lista del piloto va en el secreto**, no en un parámetro: son
  identificadores de personas, y un parámetro acabaría en los perfiles
  versionados (`parametros/*.json`), en las evidencias y en la consola de
  CloudFormation. El guion comprueba su **forma** antes de escribir el secreto
  y nunca imprime su valor. `secretos.ejemplo.json` la trae vacía.
- Los dos perfiles (`alta-disponibilidad`, `costo-controlado`) fijan los cinco
  parámetros con sus valores iniciales, y el guion avisa si alguno de los tres
  interruptores viene encendido.
- Los patrones de la plantilla rechazan una lista de modalidades o de monedas
  mal escrita antes de que llegue a la API.

**Para encender un piloto, en este orden** (nada de esto se hizo):

1. aplicar y verificar la 0096 en Supabase (§124): **hecho el 02/10/2026** (§131);
2. desplegar `Edson` con todo apagado, que es lo que traen los perfiles;
3. poner los perfiles del piloto en el secreto (`SERVICES_PILOT_PROFILE_IDS`)
   y renovar las máquinas;
4. encender `FeatureServices` (y, si toca, `FeatureServiceBooking`) con un
   Change Set revisado.

**Para apagarlo**, lo contrario del paso 4: es reversible, no borra nada y no
necesita ninguna migración.

## 129. Pruebas (02/10/2026)

| Qué | Resultado |
|---|---|
| Backend completo con PostgreSQL 17 | 4414 aprobadas, ninguna saltada |
| Backend completo sin PostgreSQL | 3152 aprobadas; 1262 se saltan por no tener PostgreSQL |
| Móvil: batería completa, `tsc --noEmit` y exportación web | 3657 aprobadas, 0 fallidas; `tsc --noEmit` limpio; exportación web correcta |
| Recorrido con la API real (base local, sin Supabase ni AWS) | 66 de 66 comprobaciones, 91 peticiones, cinco procesos de la API |

**El recorrido.** Cada caso es un proceso de la API arrancado con otras
variables de entorno, con sesiones HS256 reales, no un parche en memoria:

1. **Sin la 0096** (base 0001–0095): el catálogo, «mis servicios» y la bandeja
   de administración contestan 503 `services_not_ready`; la admisión sigue.
   Aplicada la 0096 dos veces, el mismo proceso sigue en 503; reiniciado, abre.
2. **El piloto**, con la lista escrita con mayúsculas, espacios y llaves: la
   app recibe «sí» solo para las dos participantes, y la sección de
   administración solo para quien administra, esté o no en la lista; quien no
   participa, una visita sin sesión y administración como cliente reciben 503;
   un token caducado o fabricado, 401. Administración crea la categoría y
   publica por su rol.
   «A domicilio» y dólares, 422. La ruta de cada imagen es opaca y su URL
   firmada no lleva el perfil. La ficha no trae la capacidad; la prestadora y
   administración sí la ven. Abrir un borrador deja cuatro filas y dos archivos.
3. **Una lista mal escrita**: no entra nadie; el registro dice cuántas
   entradas fallan, una vez, y no nombra ningún perfil.
4. **La apertura general**: entra cualquiera, también sin sesión, y el
   catálogo trata un token caducado como una visita; lo privado sigue siendo
   un 401. Ni el calendario ni los horarios de un día traen la capacidad. La prestadora
   borra su cuenta y se va con su servicio y sus imágenes.
5. **Apagado**: nadie, ni el piloto ni con la apertura general escrita.

Ningún proceso dejó una traza ni un 500.

**Mutaciones dirigidas** (en un árbol de trabajo desechable, sobre el código
confirmado): 46 de 46 muertas. Cada una rompe una sola cosa —la lista vacía abre
Servicios, un router sin la puerta, la ruta vuelve a llevar el perfil, la
0096 deja registrar una ruta anterior, un perfil de AWS trae Servicios
encendido…— y la prueba que la vigila se pone roja.

**Una revisión independiente del diff**, en solo lectura, antes de cerrar. No
encontró nada bloqueante. Encontró un defecto del piloto —una administradora
de fuera de la lista no veía su sección en la app— y cuatro menores, y todo
quedó corregido y con su prueba: los dos campos de `/platform/config`, la
puerta que no mira el token con la apertura general, el 401 del token
fabricado, la baja que se detiene si no puede leer los servicios, y la
pregunta de la app cuando hay sesión sin perfil. Una de las mutaciones de
esa tanda sobrevivió la primera vez: la prueba del token fabricado no llegaba
al código que decía probar. Se corrigió la prueba, no el resultado.

Pruebas nuevas:

| Batería | Qué prueba |
|---|---|
| `test_servicios_migracion_0096.py` | la 0096, estática y contra PostgreSQL: lo que admite y lo que rechaza, la copia de una ruta anterior, que no toca ninguna fila, la reejecución, un fallo a mitad, cada dependencia y la 0090 reejecutada encima |
| `test_servicios_piloto.py` | el piloto: la regla, todas las rutas de `/services` por HTTP, administración, las dos respuestas de la app, los tokens que no valen (caducado, mal firmado, fabricado) y los valores de fábrica |
| `test_servicios_catalogo_api.py` (§13) | por la API: la ruta opaca, que el teléfono no la elige, la copia entre versiones, la baja (y que se detiene si no puede leer los servicios), «a domicilio», la moneda, los filtros públicos, la capacidad y la puerta sin la 0096 |
| `test_infraestructura_aws.py` | los perfiles apagados, el entorno que escribe la plantilla, el cobro fijo, la lista del piloto fuera del repositorio y su validación |
| `plataforma.test.mts`, `serviciosCatalogo.test.mts` | en el móvil: la bandera por persona, la de administración aparte, para quién se pregunta, y que lo ofrecido es lo que el servidor trae de fábrica |

## 130. Lo que sigue pendiente

- ~~Aplicar y verificar la 0096~~: **hecho el 02/10/2026** (§131). La ejecutó
  Edson, a mano; se verificó en solo lectura y su huella consta en `APLICADAS`.
- **QA físico** de los seis incrementos y de estas cinco políticas
  (`Z_QA_FISICO_PENDIENTE.md`).
- **Cuatro políticas** siguen dependiendo de la operación o de trabajo futuro
  (P1, P7 y P8, P15 y P42): `Z_REQUISITOS_Y_DECISIONES.md`, apartado II.
- **De la empresa**: los 48 asuntos y las seis integraciones del apartado IV
  y V. **F21 sigue siendo la primera** y no se tocó.
- **Desplegar**: nada se desplegó, ni se hizo push, PR ni merge.

## 131. La 0096, aplicada y verificada (02/10/2026)

**La 0096 se ejecutó a mano en Supabase y se verificó el 02/10/2026 a las
19:51 UTC (14:51 en Lima), en solo lectura: SIN DIVERGENCIAS.** Su huella
consta en `APLICADAS` (`f1abca52f0a48c0d92e346666fff7dfb763661c7`): desde
entonces no se edita, y no se deshace. No se volvió a ejecutar, no se escribió
nada en Supabase y no hizo falta ninguna 0097.

**Cómo se miró.** Cinco sesiones, todas de solo lectura y todas demostradas
antes de consultar nada: `transaction_read_only = on`, una sonda de escritura
(`create temp table`) rechazada con `SQLSTATE 25006`, ningún identificador de
escritura asignado, y `ROLLBACK` al terminar. Una con psycopg, para los
catálogos; cuatro con asyncpg y SQLAlchemy —la conexión y el rol de la API—,
para el código real de las puertas. La cadena de conexión no se imprimió ni se
guardó.

**Contra qué.** Dos referencias sobre PostgreSQL 17 local desechable:

| Referencia | Resultado frente a Supabase (PostgreSQL 17.6) |
|---|---|
| prólogo + 0001–0096 | **ninguna diferencia** |
| prólogo + 0001–0095 | **una sola**: la función de las imágenes (su huella en el esquema y su definición) |

**Qué se comparó**, por definición y no por existencia:

| | |
|---|---|
| Esquema público entero | 1781 columnas, 1348 restricciones, 552 índices, 104 disparadores, 63 funciones, RLS en 169 de 169 tablas, 149 políticas, 0 vistas |
| Las 28 tablas de Servicios | columnas, restricciones, índices, disparadores (también los internos de las claves), propietario, RLS, políticas y permisos: declarados, por columna, en la ACL y efectivos |
| Las 27 funciones de Servicios | argumentos, retorno, lenguaje, propietario, seguridad, configuración, cuerpo (huella exacta y normalizada), ACL y `EXECUTE` efectivo |

**La función** `service_version_images_solo_en_borrador()`: sin argumentos,
devuelve `trigger`, `plpgsql`, `SECURITY INVOKER`, `search_path = public,
pg_temp`, del mismo propietario que en la referencia, sin `EXECUTE` para
`PUBLIC`, `anon` ni `authenticated` (ni en la ACL ni efectivo). Su cuerpo en
Supabase tiene 2002 caracteres y es, **carácter a carácter, el del fichero de
la 0096 y el de la referencia** (`222bdbbd898701ecf458747cd45f6ef9`). El de la
0090 (`b8aa892aaaf500ceaf19e4ae52a457af`) ya no está: la consulta de la puerta
escrita con esa huella da «no».

**El disparador**, intacto: `BEFORE INSERT OR DELETE OR UPDATE ON
service_version_images FOR EACH ROW`, sobre esa función, `tgtype` 31, activo
(`O`), sin argumentos ni columnas.

**La tabla de imágenes:** 14 columnas, 11 restricciones (1 clave primaria, 1
ajena, 1 única y 8 CHECK), 5 índices, 1 disparador, RLS activa, 0 políticas y
ningún permiso para los de fuera. Igual que en la referencia.

**RLS y permisos.** Las 28 tablas de Servicios tienen RLS, ninguna tiene
políticas y ninguna da nada a `PUBLIC`, `anon` ni `authenticated`.

**El depósito `service-media`:** privado, 5 MB, JPEG, PNG y WebP; **0
objetos**. `storage.objects` tiene RLS y sus 11 políticas son las mismas del
29/09/2026 (§32): ninguna nombra este depósito ni deja de filtrar por
depósito. La fila del depósito es la misma versión de fila que aquel día:
nadie la reescribió.

**Los datos** (recuentos, nunca valores): 0 imágenes, 0 servicios, 0
versiones, 0 objetos; 366 claves ajenas de `public` revisadas, ninguna
huérfana y ninguna sin validar. **Que haya cero no demuestra la regla**: la
demuestran el cuerpo —que es el del fichero— y lo que ese cuerpo hace en una
base igual (las 20 pruebas de la 0096 contra PostgreSQL y el recorrido de
§133: admite la ruta opaca del servicio, no pide el perfil, y rechaza con
`23514` la forma anterior que no es una copia, la de otro servicio y la de
otra extensión).

**Lo que escribió su transacción:** una fila de `pg_proc` (la función) y sus
dependencias. Ninguna fila de datos en las 215 tablas revisadas. Las otras
seis funciones de la 0090 conservan la misma versión de fila que el 29/09.

**Las migraciones anteriores:** las huellas de la 0086 a la 0095 en
`APLICADAS` no cambiaron (las pruebas las recalculan), y su esquema en
Supabase es el de la referencia.

### El verificador, probado antes de usarlo

Contra la referencia local correcta dijo «sin divergencias». Después se
estropeó esa base, **de una forma cada vez**, y las detectó las quince:

| Alteración (solo en la base local desechable) | Verificador | Puerta de la API |
|---|---|---|
| el cuerpo anterior, el de la 0090 | detectada | cierra |
| la función ausente | detectada | cierra |
| la función con `SECURITY DEFINER` | detectada | no la mira |
| la función con otro `search_path` | detectada | no la mira |
| el disparador ausente | detectada | cierra |
| el disparador deshabilitado | detectada | cierra |
| el disparador hacia otra función | detectada | cierra |
| el disparador con otra forma | detectada | cierra |
| RLS apagada | detectada | cierra |
| un permiso indebido en la tabla | detectada | no la mira |
| un permiso indebido en la función | detectada | no la mira |
| una política nueva | detectada | no la mira |
| el depósito público | detectada | cierra |
| el depósito sin límite de peso | detectada | no la mira |
| una imagen con una ruta incoherente | detectada | no la mira |

La puerta de la API no es el verificador: mira lo que el código necesita para
no romperse y para que el depósito no sea público. La seguridad de la función,
los permisos y las políticas los comprueba la propia 0096 antes de confirmar,
y esta verificación después.

### La puerta de esquema, con el código real

| Caso | Resultado |
|---|---|
| Base local con 0001–0095, API encendida | 503 `services_not_ready` en el catálogo; la admisión sigue |
| Se aplica la 0096 (dos veces) con la API en marcha | el MISMO proceso sigue en 503: recuerda el «no» |
| Se reinicia la API | abre |
| **Supabase, con un proceso nuevo y la conexión de la API** | las seis puertas dicen que sí; con las banderas como están, 503 `services_disabled` sin mirar la base |
| Un error al inspeccionar (en Supabase, provocado en el proceso; en local, la tabla de depósitos apartada) | 503 `services_not_ready`, nunca un 500, nadie entra y **no se recuerda**: pasado el fallo, el mismo proceso vuelve a mirar y abre |

## 132. La puerta de la admisión: un error al mirar también es un 503

Al repasar las puertas apareció una que no cumplía lo de la tabla anterior.
`hay_admision` —la primera, la de las 0086–0088— no capturaba un error al
inspeccionar: la excepción subía y la ruta contestaba **500**. No concedía
acceso, pero no era el 503 controlado de las otras cinco, y el fallo no venía
de este bloque: estaba así desde el Incremento 1.

Ahora hace lo mismo que las demás: registra el aviso, contesta 503
`services_not_ready` y **no recuerda** el error. `test_servicios_admision_api.py`
lo prueba (se puso roja antes del arreglo): con la inspección rota, la
postulación y el catálogo contestan 503; reparada, la misma aplicación abre.

## 133. El recorrido final de las cinco políticas

La API real en seis procesos locales, cada uno con su configuración, sesiones
HS256 de verdad, PostgreSQL 17 local y el almacén de pruebas —guardado en
disco, con un diario de cada operación—. **92 de 92 comprobaciones, 125
peticiones, ningún 500.** Nada tocó Supabase ni AWS.

| Tramo | Qué se vio |
|---|---|
| **Servicios apagado** (la configuración de fábrica) | 13 rutas de Servicios, 503 `services_disabled`; la app recibe «no» para todos, también administración; apartar un horario y las reservas, apagados; Cursos, Eventos y Productos contestan. PostgreSQL registró 53 sentencias de la API en ese tramo y **ninguna nombra una tabla de Servicios** |
| **Sin la 0096** | lo de la tabla de §131 |
| **Rutas opacas (P29)** | la ruta es `<servicio>/<32 hexadecimales>.<ext>` y no lleva el perfil; la extensión la dicen los bytes (un JPEG llamado `.png` se guarda `.jpg`; un WebP sin extensión, `.webp`); el teléfono no la elige ni con el nombre del archivo ni con campos de más; un PNG que dice ser JPEG y un archivo que no es una imagen, 422 `service_image_invalid` y no llegan al almacén; el mismo contenido subido dos veces recibe dos nombres; cuatro rutas escritas a mano en la base, `23514` |
| **Lo compartido** | abrir una versión nueva deja diez filas y cinco archivos; quitar del borrador una imagen que la publicada sigue usando no borra el archivo; quitar una que solo estaba en el borrador sí, y **después** de que la base confirme (al pedirse el borrado, ninguna fila confirmada la nombraba) |
| **La baja** | la carpeta del servicio queda vacía en el almacén; lo de otro prestador no se toca |
| **Los enlaces** | 113 enlaces en las respuestas, todos firmados; ninguna URL pública |
| **Modalidades y moneda (P5, P2)** | «a domicilio» y dólares, 422 al escribir y al filtrar; virtual y en soles, sí |
| **Capacidad (P51)** | fuera de la ficha, del calendario y de los horarios; su prestador y administración la ven |
| **El piloto (P101)** | solo los perfiles de la lista (normalizada); administración por su rol; lista mal escrita, nadie y sin nombrar a nadie en el registro; apertura general, cualquiera; apagado, nadie |

En la baja, los archivos se borran **antes** de confirmar la base, a propósito
(`Z_BAJA_DE_CUENTA.md`): si no se pueden borrar, la baja se deshace entera.

## 134. Listo para el push; lo que sigue pendiente

| Qué | Resultado |
|---|---|
| Backend completo con PostgreSQL 17 | 4416 aprobadas, ninguna saltada |
| Backend completo sin PostgreSQL | 3154 aprobadas; 1262 se saltan por no tener PostgreSQL |
| Móvil | sin cambios desde §129; las 210 pruebas que vigilan cuándo se enseña Servicios, repetidas, pasan |

**El bloque previo al despliegue está técnicamente cerrado.** Para encender un
piloto (§128), el primer paso ya está hecho; quedan, en este orden:

1. push de `Edson`, CI remoto y PR;
2. desplegar con todo apagado, que es lo que traen los perfiles. Producción
   no corre todavía este código: al desplegarlo arrancan procesos nuevos, que
   miran la base por primera vez;
3. poner los perfiles del piloto en el secreto y renovar las máquinas;
4. encender `FeatureServices` con un Change Set revisado.

Nada de eso se hizo aquí: ni push, ni PR, ni despliegue, ni Change Sets, ni
cambios en AWS, GitHub o Supabase. Las banderas siguen apagadas y no se movió
dinero.

Sigue pendiente lo de §130 menos la 0096: el **QA físico**, las cuatro
políticas que dependen de la operación o de trabajo futuro, y lo de la empresa
(**F21, la primera**).
