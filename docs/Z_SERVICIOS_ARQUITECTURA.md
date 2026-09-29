# Z Servicios · Incremento 1: dominio base y admisión de prestadores

Qué se construyó, qué impone la base, qué se decidió en cerrado y qué sigue
esperando a una persona. Escrito el 29/09/2026 al cerrar el Incremento 1 en la
rama `Edson`.

## Estado, en siete líneas

| | |
|---|---|
| **Incremento 1** | **implementado e integrable.** Admisión completa del prestador: condiciones versionadas, borrador, documentos privados, credenciales, envío, revisión, correcciones, reenvío, aprobación, rechazo, suspensión y retirada |
| **Migraciones 0086 y 0087** | **APLICADAS** en Supabase y verificadas en sesión de solo lectura con **cero divergencias**. Son históricas: no se editan |
| **Migración 0088** | **escrita y probada en PostgreSQL local, SIN APLICAR.** Hay que aplicarla a mano (§9) |
| **`FEATURE_SERVICES`** | **apagada.** Todas las rutas contestan 503 `services_disabled` sin mirar la base |
| **Pagos, reservas, catálogo** | **no existen** en este incremento, y ninguna tabla los anticipa |
| **Bloqueo para encender** | `DELETE /me` falla para quien figura como actor en `audit_events` (fallo de plataforma de la 0050, §12). Con Servicios afectaría a cada prestador |
| **QA físico** | pendiente: `docs/Z_QA_FISICO_PENDIENTE.md`, sección de Servicios |

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

## 9. Migraciones: cómo aplicar la 0088

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

## 12. Hallazgo de plataforma: `DELETE /me` y la auditoría

`audit_events` (0050) es de solo añadir, pero su `actor_id` es
`on delete set null`. Borrar el perfil de alguien que figura como actor pide
un `UPDATE` que el disparador rechaza, y `DELETE /me` falla. **Es previo a
Servicios** y ya afecta a Eventos, Catálogo y Comercio. Con Servicios, cada
prestador figura como actor. La misma 0050 tiene otros choques del borrado de
cuenta con tablas inmutables (`consent_records.subject_id` es
`on delete restrict`, y `course_versions.published_by` choca con su
disparador): **es una decisión de retención frente a borrado de toda la
plataforma**, y tocar la inmutabilidad aplicada en producción no se decidió
aquí. Lo demuestra
`test_servicios_flujo_postgres.py::test_borrar_la_cuenta_se_lleva_lo_que_creo_la_api`
(xfail estricta). **No encender Servicios en producción antes de resolverlo.**

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
| Backend completo con PostgreSQL real (docker `postgres:16`) | **3631 pasan, 1 xfail estricta (§12), 0 fallan, 0 omitidas**. Línea base antes de Servicios: 3449 |
| Servicios sobre SQLite | API: 43 · estados y saltos: 40 |
| Servicios sobre PostgreSQL | 0086: 29 · 0087: 30 · 0088: 30 · flujo y concurrencia: 4 + 1 xfail |
| Móvil completo | **3270/3270** en copia LF (en la copia CRLF de Windows fallan las 3 de siempre, ajenas a Servicios). Línea base: 3178 |
| Móvil de Servicios | 92: lógica contra el código del servidor (32) y vistas, contratos, bandera y avisos (60) |
| TypeScript (`tsc --noEmit`) | limpio |
| Expo Doctor | 18/18 |
| Exportación web | correcta, con las rutas de Servicios en el paquete |

**Mutaciones: 21/21 cazadas.** Cada una se aplicó en una copia aparte, se
corrieron las pruebas que la deben detectar y se restauró. Son:

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
- en el móvil:
  - Servicios encendido si el servidor calla;
  - la entrada del perfil sin bandera;
  - el doble toque en el envío;
  - un código de error sin texto.

La carrera de dos decisiones simultáneas no es determinista por sí sola. La
mutación del bloqueo la cazan también los envíos simultáneos.
