# Borrar una cuenta: datos, historia y archivos

Qué pasa cuando alguien borra su cuenta, qué se conserva y por qué, qué sigue
impidiendo la baja, y cómo aplicar y verificar la **0089**. Escrito el
29/09/2026 al cerrar técnicamente el Incremento 1 de Z Servicios en la rama
`Edson`.

## Estado

| | |
|---|---|
| **0086, 0087 y 0088** | **Aplicadas** en Supabase. La 0088 se verificó el 29/09/2026 en una sesión de solo lectura, **sin divergencias** (§9) |
| **0089** | **Escrita y probada solo en PostgreSQL local, SIN APLICAR.** Hay que aplicarla a mano (§10) y verificarla en solo lectura (§11) |
| **`DELETE /auth/me`** | Corregido en el código. **Sin la 0089 sigue fallando** para quien figura en un historial |
| **`FEATURE_SERVICES`** | **Apagada**, en local y en producción |
| **QA físico** | Pendiente (`docs/Z_QA_FISICO_PENDIENTE.md`) |
| **Push, PR, merge, despliegue** | **Ninguno** |

## 1. La regla

Decidida el 29/09/2026:

> Cuando una persona elimina su cuenta, Z debe eliminar sus datos personales y
> sus archivos privados, pero puede conservar registros históricos necesarios
> para seguridad, trazabilidad, operaciones, resolución de disputas y
> auditoría. Los registros conservados no deben seguir identificando
> directamente a la persona.

En la práctica:

- **El hecho histórico se queda**: fecha, acción, recurso, resultado, estados,
  motivo y demás información no personal.
- **Quien actuó pasa de su identificador a `NULL`**, y solo como consecuencia
  de que se borre su perfil.
- **Nada más cambia.** No se reasigna a otra persona, no se recupera un actor
  anonimizado, no se toca ninguna otra columna y no se borra la fila.

## 2. Qué fallaba

### 2.1 La causa raíz

Reproducido el 29/09/2026 por el endpoint real
(`tests/test_baja_de_cuenta_postgres.py::test_borrar_la_cuenta_de_quien_figura_en_la_auditoria`),
antes de la corrección:

| | |
|---|---|
| **Operación de la persona** | `DELETE /api/v1/auth/me` |
| **Sentencia de la API** | `DELETE FROM profiles WHERE profiles.id = $1` |
| **Tabla involucrada** | `audit_events` |
| **Clave ajena** | `audit_events.actor_id → profiles(id)`, **`on delete set null`** (0050) |
| **Operación que intenta PostgreSQL** | `UPDATE ONLY "public"."audit_events" SET "actor_id" = NULL WHERE $1 OPERATOR(pg_catalog.=) "actor_id"` (la acción de la clave ajena) |
| **Disparador que lo impide** | `audit_events_solo_anadir`, `before update or delete`, función `impedir_reescritura()` línea 3 (`raise`) |
| **Código de error** | **23001** `restrict_violation`: «La tabla audit_events es de solo anadir: no admite UPDATE» |
| **Efecto sobre la transacción** | Abortada entera: el perfil, el usuario de Auth, la postulación y la auditoría siguen como estaban. La API contestaba **500** |
| **Efecto sobre los archivos** | **Ya se habían borrado**: la API borraba Storage antes que la base. La persona se quedaba con la cuenta viva y **sin sus documentos ni sus fotos** |

La clave dice «conserva la historia y deja de nombrar a la persona», y el
disparador dice «no se toca ninguna fila». Las dos reglas se escribieron en la
misma migración, la 0050, y se contradicen.

### 2.2 El mismo patrón en otros sitios

Se sacó del catálogo de PostgreSQL (§3) y se confirmó escenario a escenario
contra una base con 0001–0088. **Trece columnas de persona** tienen
`on delete set null` y un disparador que rechaza el `UPDATE`:

- `audit_events.actor_id`
- `course_versions.published_by`
- `event_versions.created_by`
- `event_policies.created_by`
- `event_policies.published_by`
- `event_review_moderation.actor_id`
- `product_review_moderation.actor_id`
- `product_refund_events.actor_id`
- `product_dispute_events.actor_id`
- `event_dispute_events.actor_id`
- `event_aftersale_case_events.actor_id`
- `event_order_policy_acceptances.accepted_by`
- y `consent_records.subject_id`, que era **`restrict`**. Quien hubiera
  aceptado un texto no podía irse nunca.

Y **cuatro borrados en cascada** chocaban con un disparador de «no se borra»:

- las versiones del curso de un autor que se va;
- las políticas del evento de un organizador que se va;
- la moderación de la reseña de quien se va (la reseña es suya y se borra);
- las aceptaciones de política de la orden de un comprador que se va.

### 2.3 A quién afectaba hoy en producción

Lo cuenta la verificación del 29/09/2026 (§9), solo con números:

| | |
|---|---|
| Perfiles | 40 |
| Filas en `audit_events` | 0 |
| Filas en `consent_records` | 0 |
| Filas en `course_versions` | 4, del *backfill* de la 0050, sin `published_by` |
| Todas las demás tablas de la lista | 0 |

Hoy el fallo alcanzaba sobre todo a **los autores de esos cuatro cursos
publicados**: su baja arrastra el curso, y la versión «no se borra». Con
Servicios encendido habría alcanzado a cada prestador y a cada persona del
equipo que decidiera algo.

## 3. Inventario de lo que toca borrar un perfil

Se sacó del catálogo de PostgreSQL con 0001–0088
(`pg_constraint`/`pg_trigger`), no leyendo migraciones. Se recorren las claves
ajenas desde `profiles` y `auth.users` hacia abajo, siguiendo las cascadas:

| | |
|---|---|
| Relaciones alcanzadas | 380 (233 `cascade`, 100 `set null`, 47 `restrict`) |
| Tablas alcanzadas | 128 |
| Relaciones directas con el perfil | 123 |

En Supabase el inventario es **idéntico**. Se leyeron:

- 348 claves ajenas, de las que 24 son internas de Supabase en el esquema `auth`
  (sesiones, identidades, MFA…): se van en cascada con `auth.users`;
- 61 disparadores;
- 31 funciones de disparador, comparadas por huella.

**Las 123 relaciones directas, clasificadas:**

| Clase | Cuántas | Relaciones |
|---|---|---|
| Dato personal: se borra | 58 | `audios.author_id`, `behavior_events.user_id`, `bookings.provider_id`, `bookings.requester_id`, `circle_members.user_id`, `circles.owner_id`, `comment_likes.user_id`, `comments.author_id`, `conversation_labels.owner_id`, `conversation_members.user_id`, `conversations.created_by`, `course_certificates.user_id`, `course_completions.user_id`, `course_enrollments.user_id`, `course_refund_windows.user_id`, `course_reviews.user_id`, `device_tokens.user_id`, `direct_conversation_pairs.user_high`, `direct_conversation_pairs.user_low`, `entitlements.user_id`, `event_registrations.user_id`, `event_review_replies.author_id`, `event_reviews.author_id`, `follows.follower_id`, `follows.following_id`, `lesson_notes.user_id`, `lesson_progress.user_id`, `live_messages.user_id`, `live_sessions.host_id`, `message_story_context.story_owner_id`, `messages.sender_id`, `notification_deliveries.user_id`, `notifications.user_id`, `podcast_categories.owner_id`, `post_likes.user_id`, `post_mentions.mentioned_user_id`, `post_reposts.author_id`, `posts.author_id`, `product_carts.user_id`, `product_review_replies.author_id`, `product_reviews.author_id`, `profile_reviews.reviewed_user_id`, `profile_reviews.reviewer_id`, `profiles.id` (desde `auth.users`), `quiz_attempts.user_id`, `recommendation_preferences.user_id`, `reports.reporter_id`, `saved_courses.user_id`, `saved_posts.user_id`, `saved_products.user_id`, `seller_applications.profile_id`, `service_providers.profile_id`, `stories.author_id`, `story_views.viewer_id`, `testimonials.author_id`, `user_blocks.blocked_id`, `user_blocks.blocker_id`, `user_topic_relations.user_id` |
| Dato operativo propio: se borra | 11 | `courses.author_id`, `event_orders.buyer_id`, `event_ticket_holds.user_id`, `event_tickets.owner_id`, `events.organizer_id`, `orders.user_id`, `owner_payout_accounts.owner_id`, `product_sellers.profile_id`, `purchases.user_id`, `refund_policy_acceptances.user_id`, `refund_requests.user_id` |
| Registro histórico conservado y anonimizado (**0089**) | 13 | los trece de §2.2 |
| Registro histórico o dato ajeno: se queda, sin la persona (ya funcionaba) | 32 | `courses.reviewed_by`, `event_admission_decisions.decided_by`, `event_admission_reviews.reviewer_id`, `event_aftersale_case_tickets.effect_by`, `event_aftersale_cases.assignee_id`, `event_changes.changed_by`, `event_changes.classified_by`, `event_checkins.operator_id`, `event_disputes.assignee_id`, `event_review_replies.moderated_by`, `event_reviews.moderated_by`, `event_tickets.checked_in_by`, `live_messages.hidden_by`, `notifications.actor_id`, `owner_sale_reserves.created_by`, `owner_sale_reserves.released_by`, `policy_versions.published_by`, `product_approval_reasons.created_by`, `product_evaluation_evidence.created_by`, `product_media.created_by`, `product_media.reviewed_by`, `product_review_replies.moderated_by`, `product_reviews.moderated_by`, `product_sellers.activated_by`, `product_versions.created_by`, `product_versions.published_by`, `products.created_by`, `refund_request_events.actor_id`, `refund_requests.reviewer_id`, `reports.reported_user_id`, `seller_application_documents.created_by`, `seller_applications.decided_by` |
| **Impide la baja**: obligación que se conserva | 9 | `event_aftersale_cases.buyer_id`, `event_aftersale_cases.organizer_id`, `event_disputes.organizer_id`, `owner_sale_balances.owner_id`, `owner_transfers.owner_id`, `product_evaluations.evaluator_id`, `product_incidents.buyer_id`, `product_orders.buyer_id`, `product_refunds.decided_by` |

**Más abajo en las cascadas**, estas `restrict` también frenan la baja, y
también a propósito: son ventas, saldos o disputas de otras personas.

| Área | Relación | Cuándo frena |
|---|---|---|
| Cursos | `orders.course_version_id`, `purchases.course_id`, `commerce_products.course_id`, `owner_sale_balances.course_id` | Un autor con ventas o con el curso en la tienda |
| Comercio | `owner_sale_balances.order_id`, `refund_requests.order_id` | Un comprador cuya compra generó un saldo o una devolución |
| Eventos | `event_order_items`, `event_ticket_hold_items` y `event_tickets` sobre `event_ticket_types` | Un organizador con entradas vendidas o apartadas por otra persona |
| Eventos | `event_aftersale_cases`, `event_disputes` y `owner_sale_balances.event_*` sobre eventos y órdenes; `event_order_policy_acceptances.policy_id` y otras sobre `event_policies` | Expedientes, disputas, saldos o aceptaciones de otras personas |
| Productos | `products.seller_id`, `product_orders.seller_id`, `product_incidents.seller_id` | Un vendedor con productos, pedidos o incidencias |

**Archivos privados que se retiran**: ver §6.

## 4. La política de anonimización (0089)

Hay **una sola excepción** a la inmutabilidad:
`public.es_anonimizacion_por_baja(viejo, nuevo, columnas)`. Todos los
disparadores de historial la consultan antes de rechazar, y devuelve verdad
**solo si se cumplen a la vez**:

1. **Viene de dentro de la cascada de una clave ajena.** La puesta a `NULL` la
   ejecuta PostgreSQL desde su disparador interno, así que el de la tabla
   corre con profundidad 2 o más. Un `UPDATE` escrito a mano, desde una sesión
   o desde PostgREST, corre con profundidad 1.
2. **Cada columna que cambia es de persona, pasa de un identificador a `NULL`
   y ese perfil ya no existe**: es el que se está borrando.
3. **Nada más cambia en la fila**, y algo se anuló.

Cómo está hecha la función:

- **Volátil a propósito.** Una `stable` consultaría con la foto de la
  sentencia que la llamó, donde el perfil todavía existe, y la excepción no
  se abriría nunca.
- **`security invoker` y `search_path` vacío**, con todo cualificado.
- **Sin permiso de ejecución** para `public`, `anon` ni `authenticated`.
- **Solo devuelve un booleano.** Llamada a mano responde `false`, porque ahí la
  profundidad es 0.
- Dentro de la cascada, PostgreSQL ejecuta como dueño de la tabla, así que ve
  `profiles` entera sin elevar ningún privilegio.

Las cascadas de §2.2 se admiten **solo si la fila madre ya no existe**, como ya
hacían la 0060 con las versiones de evento y la 0086 con Servicios. Una fila
suelta, con su madre viva, sigue sin poder borrarse.

**Lo que sigue prohibido**, cada punto con su prueba en
`tests/test_migracion_0089.py`:

- editar cualquier columna de una fila de auditoría;
- borrarla, también después de que su actor se haya ido;
- cambiar un actor por otro;
- anular un actor a mano;
- anularlo desde otro disparador mientras el perfil existe;
- anularlo con el perfil ausente pero fuera de la cascada;
- anularlo y tocar otra columna a la vez;
- devolver un actor a una fila anónima;
- usar la excepción desde una sesión normal;
- tocar el historial y los envíos de Servicios.

**Una orden en la que se movió dinero no se borra** (0089, sección 8,
añadida tras la revisión independiente). `event_orders` y `orders` caen en
cascada con la cuenta de quien compró. Lo único que lo frenaba era el saldo
del vendedor, que **no se crea sin comisión configurada** (el valor por
defecto). Sin este freno, una compra pagada desaparecía con la cuenta, y con
ella la referencia del cobro que hace falta ante un contracargo.

Ahora, antes del borrado, un disparador por fila lo rechaza con la tabla en
el error, y la API responde 409 con su área. Solo mira **dinero de verdad**
(`environment = 'production'`):

- en `event_orders`, si hubo pasarela y la orden se pagó, tiene referencia de
  cobro, está en `PAID`, o está en `PAYMENT_PROCESSING` desde hace menos de
  25 horas (la sesión de cobro de Stripe caduca a las 24);
- en `orders`, si tiene `paid_at` o está en `paid` o `refunded`.

Una orden gratuita, caducada, que nunca empezó a pagarse, de pruebas
(`sandbox`) o un checkout abandonado hace más de 25 horas sí se van con la
cuenta.

La 0089 **no cambia** ninguna tabla salvo `consent_records.subject_id` (admite
`NULL` y su clave pasa a `on delete set null`). Tampoco cambia la RLS, las
políticas, los privilegios ni los índices, y no borra ni reescribe ninguna
fila.

## 5. El recorrido de `DELETE /auth/me`

Está en `apps/api/app/modules/identity/baja.py`, en este orden:

1. **Se apuntan sus conversaciones.** Sus adjuntos de chat no van bajo su
   carpeta (§6), y después de borrar ya no se podría saber cuáles eran.
2. **Se borra en la base SIN CONFIRMAR** (`profiles` y `auth.users`), y se
   fuerzan ya las comprobaciones diferidas (`SET CONSTRAINTS ALL IMMEDIATE`).
3. **Se borran SUS archivos**: los de nadie más.
4. **Se confirma.**
5. **Después de confirmar, y en segundo plano cuando ya se ha contestado
   204**, se retira lo de las demás personas en las conversaciones que creó,
   que se han ido enteras con ella. Cada conversación va por su lado y a la
   vez. Antes de confirmar no: si la baja se deshiciera, esas conversaciones
   volverían sin sus adjuntos. En segundo plano porque la respuesta tiene que
   llegar antes de que el CDN (CloudFront) corte a los 60 s.

| Respuesta | Cuándo | Qué queda |
|---|---|---|
| **204** | Borrada; también si ya lo estaba (repetir es seguro) | Nada de la persona; lo histórico, anónimo |
| **409 `account_deletion_blocked`**, `details.reason` = `courses`, `events`, `products`, `earnings` o `records` | La base lo impide: ventas, saldos, pedidos, incidencias, disputas o decisiones del personal | **Todo intacto, archivos incluidos**: no se llega a tocar Storage |
| **503 `account_deletion_storage_failed`** | Storage no contesta o falla, o hay carpetas más hondas que el tope | La cuenta sigue. Si falló al **listar**, no se borró ningún archivo; si falló **borrando**, puede faltar alguno suyo, y repetir termina |
| **503 `account_deletion_unavailable`** | La base todavía no tiene la 0089 y algo lo impidió | La cuenta sigue. Puede ser el choque con la auditoría y no una venta, así que no se dice «tienes ventas» |
| **500** | Cualquier otro fallo de base (conexión) | La cuenta sigue |

**Fallos parciales, con su tratamiento:**

| Fallo | Estado que deja | Cómo se recupera |
|---|---|---|
| La base lo impide | Nada cambió | 409; necesita la decisión de §8 |
| Storage falla al listar | Nada cambió | 503; repetir |
| Storage falla a mitad de borrar | Cuenta viva, algún archivo borrado | 503; repetir borra el resto y la cuenta |
| La confirmación falla después de Storage (se cae la conexión) | Cuenta viva, archivos borrados | Repetir borra la cuenta; Storage ya no tiene nada |
| Falla retirar, después de confirmar, los adjuntos ajenos de las conversaciones borradas (cualquier fallo, no solo de Storage) | Cuenta borrada (204); quedan esos adjuntos, que nadie puede abrir (la política de lectura exige ser miembro) | El registro dice **qué conversaciones fallaron** (identificadores, nunca rutas) para retirar `message-media/<conversación>/` a mano |
| El teléfono deja de esperar (90 s), se queda sin conexión o el CDN contesta 502/504 (la baja tardó más de 60 s) | No se sabe: el servidor pudo terminar | El teléfono **no dice** que la cuenta sigue activa: dice que no se pudo confirmar y que repetir es seguro. Solo los dos 503 de la API garantizan que la cuenta sigue |
| Sin credenciales de Storage **en producción** | Nada cambió | 503; es un error de despliegue |

**Otras garantías:**

- **Solo la cuenta propia.** La identidad sale del token validado, nunca de un
  identificador recibido. Lo prueba `test_solo_se_borra_la_cuenta_propia`.
- **Dos bajas a la vez**: la segunda espera al bloqueo de la fila del perfil y,
  cuando entra, no encuentra nada que borrar.
- **El móvil** sigue esperando 204, con una espera de 90 s: la baja tarda más
  que una petición normal. Según la respuesta dice (es/en/pt):
  - ante el 409, que la cuenta tiene ventas, pedidos o reclamos y que escriba
    a soporte;
  - si se agota la espera, no hay conexión o llega cualquier 5xx que no sea
    uno de los dos 503 de la API (por ejemplo el 504 del CDN), que no se pudo
    confirmar y que reintentar es seguro;
  - ante cualquier otro fallo, que la cuenta sigue activa y que lo intente de
    nuevo.
- **Borrar desde el panel de Supabase** (o desde el administrador de Auth)
  ahora funciona, porque la cascada ya no choca, pero **no borra los archivos
  de Storage**. Soporte no debe cerrar cuentas así: tiene que usar
  `DELETE /auth/me` en nombre de la persona o, si la cuenta está bloqueada, el
  proceso que se decida (§12).

## 6. Archivos privados

`apps/api/app/shared/storage.py::delete_user_files`. El listado de Storage
**no es recursivo**, así que baja a las carpetas. Además:

- lista **todo** antes de borrar nada, con hasta 8 listados a la vez;
- baja hasta 16 niveles de carpetas. Una carpeta más honda **no se salta en
  silencio**: la baja se detiene antes de borrar nada;
- borra en lotes de 100;
- tolera los nombres que ya no existen;
- si algo falla, lanza un error que nombra depósitos, nunca rutas.

| Depósito | Forma de la ruta | En la baja |
|---|---|---|
| `avatars` (público) | `<perfil>/…` | Se borra todo |
| `post-media` | `<perfil>/…`, derivados en `<perfil>/derived/<media>/…` | Se borra todo, carpetas incluidas |
| `course-media` | `<perfil>/<curso>/…` | Se borra todo, carpetas incluidas |
| `seller-documents` (0085) | `<perfil>/<postulación>/…` | Se borra todo, carpetas incluidas |
| `service-provider-documents` (0088) | `<perfil>/<postulación>/…` | Se borra todo, carpetas incluidas |
| `message-media` (0033) | `<conversación>/<quien sube>/…` | **Nuevo:** antes de confirmar, lo suyo en cada conversación en la que estaba; **después** de confirmar, el resto de las que creó, que se van enteras con sus mensajes |
| `product-media` (0073) | `<vendedor>/<producto>/…` | No se toca: solo existe con productos, y un vendedor con productos no puede darse de baja solo (409) |
| `product-incidents` (0080) | `<incidencia>/…` | No se toca: una incidencia impide la baja (409) |
| `audio-private` (0001) | — | Ningún código escribe en él |

**El procesado de vídeo** (miniaturas, `feed.mp4`, HLS) sube sus derivados
minutos después de publicar. Si la cuenta o la publicación se borran mientras
tanto, el procesado espera al bloqueo de la fila, ve que ya no existe y
retira `<dueño>/derived/<medio>/`. Antes esos derivados se quedaban para
siempre.

Después de la baja no queda ningún enlace que funcione:

- los objetos ya no existen, así que un enlace firmado anterior, que vivía
  120 s en Servicios, deja de servir;
- firmar la ruta de nuevo no devuelve nada (lo prueba
  `test_productos_vendedora_sin_productos_se_va_con_sus_documentos`);
- un avatar público puede seguir un rato en la caché de la CDN de Supabase.

## 7. Datos personales en lo que se conserva

Esto es lo que se revisó y lo que se encontró.

**`audit_events.payload`** pasa por el filtro de
`gobernanza/auditoria.py::_limpio`: descarta claves de credenciales, correo,
teléfono, dirección, IP o firma, y valores con forma de correo o de IP.
Servicios solo anota identificadores y tipos de documento, nunca rutas ni
números. En Supabase la tabla está vacía (0 filas).

**Arreglado aquí (Servicios).** Estos textos libres ya no se copian a
`audit_events.reason`:

- la nota con la que alguien retira su postulación, que escribe esa persona;
- tras la revisión, el mensaje de cada decisión y las notas sobre documentos
  y credenciales, que el equipo escribe **sobre** quien postula (a veces con
  un número de documento).

Se quedan en el historial de la postulación, que se va con la cuenta. La
auditoría solo anota que los hubo (`with_note`, `with_message`).

**Se conserva, y queda anotado como decisión pendiente (§12):**

| Qué | Dónde | Por qué no se tocó |
|---|---|---|
| Motivos que escribe el organizador al enviar, cambiar o cancelar un evento | `audit_events.reason` (Eventos) | Es de otra vertical, y el de la cancelación puede hacer falta en una disputa. Propuesto como tarea aparte (S14) |
| El identificador de la persona como **recurso** de una fila (`entity_id` o `payload`), o en historiales sin clave ajena (Productos, inventario, Servicios) | Varias | La regla prohíbe tocar el recurso de una auditoría. Sin perfil detrás, es un identificador que no lleva a nadie… |
| …salvo por los puentes: `payment_events.payload` (cuerpo del aviso de Stripe, con el correo) y `auth.audit_log_entries` (registro de Supabase Auth, con el correo) | `public`, `auth` | **Hoy los dos tienen 0 filas** (comprobado el 29/09/2026 en solo lectura). Se llenarán al encender los pagos; decisión S13 |
| Huella y prefijo de IP, familia de navegador | `audit_events`, `consent_records` | Son datos de seguridad; su plazo de conservación es una decisión |
| Identificadores del personal | Historial, envíos y condiciones de Servicios | Sin clave ajena por diseño (0086): «quién decidió» sobrevive a la cuenta. Tras la baja es un identificador sin perfil detrás |
| Nota o tema que alguien escribió al reservar una sesión | `notifications.payload` (`session_*`) de la otra persona | Es la bandeja de quien la recibió. El actor sí pasa a `NULL`. En Supabase hay filas de ese tipo; solo se miraron los nombres de las claves |

Los registros de la API guardan el identificador de la cuenta en una baja
bloqueada o fallida, para que soporte la encuentre. Nunca guardan rutas ni
nombres de archivo.

## 8. Lo que sigue impidiendo la baja, y es legítimo

Una cuenta con cualquiera de estas cosas **no puede borrarse sola**. La API
responde 409 y la persona tiene que escribir a soporte:

- **Ventas o saldos**: `owner_sale_balances`, `owner_transfers`, un curso con
  ventas o en la tienda.
- **Pedidos, incidencias o devoluciones de Productos**, como compradora o como
  vendedora, o un vendedor con productos.
- **Expedientes o disputas de Eventos**, o un evento con entradas de otras
  personas.
- **Decisiones del personal** con `restrict`: evaluaciones de productos y
  devoluciones decididas.
- **Una orden pagada** de un evento o de un curso, aunque no haya saldo
  (0089, sección 8).

**No se tocaron** porque son obligaciones con dinero de por medio o con otras
personas. Qué hacer con ellos (plazo de conservación, si se anonimizan los
pedidos, cómo se cierra una cuenta así) es una decisión de la empresa, anotada
en §12.

## 9. Verificación de la 0088 (29/09/2026, solo lectura)

Script local, fuera del repositorio. La URL sale del fichero de secretos
autorizado y nunca se imprime.

- **Una sola sesión** con `BEGIN READ ONLY`. Primero se comprobó
  `transaction_read_only = on`.
- **Una sonda de escritura** (`create temp table`) fue **rechazada con 25006**.
- La transacción **nunca obtuvo un identificador de escritura**.
- Terminó con **`ROLLBACK`**.

Supabase se comparó, definición por definición (no solo si existen), con el
repositorio aplicado sobre PostgreSQL 16 local y con los modelos del backend.

| Aspecto | Resultado |
|---|---|
| Tablas | 7 (incluida `service_provider_application_submissions`) |
| Columnas | 109, con los mismos tipos, nulabilidad y valores por defecto |
| Restricciones | 96: 7 PK, 12 FK, 70 CHECK, 5 UNIQUE y 2 disparadores-restricción |
| Índices | 25, parciales incluidos |
| Disparadores | 17, todos habilitados; 2 diferibles e inicialmente diferidos |
| Funciones | 7, con la misma huella de cuerpo, seguridad y `search_path` |
| RLS | Activa en las 7 tablas, con 0 políticas |
| Privilegios de `anon`/`authenticated` | 0 declarados, 0 por columna, 0 efectivos |
| Depósito `service-provider-documents` | Privado, 10 MB, `application/pdf`, `image/jpeg`, `image/png`, `image/webp` |
| Políticas en `storage.objects` | Ninguna de ese depósito, y ninguna sin filtro de depósito |
| Modelos del backend | Mismas columnas, nulabilidad, CHECK, claves e índices |
| Filas incoherentes | 0 en los 11 recuentos (prestador y postulación, documentos o credenciales de otra postulación, evidencias retiradas, reemplazos cruzados, secuencias con huecos, envíos sin postulación…) |

**Sin divergencias.**

## 10. Cómo aplicar la 0089

1. Comprobar que la 0088 está aplicada. La 0089 también lo comprueba.
2. Pegar **entero** `supabase/migrations/0089_baja_de_cuenta_con_historial_anonimo.sql`
   en el editor SQL de Supabase y ejecutarlo. Es **una única transacción**:
   - Antes de sustituir nada comprueba la 0088, las tablas y columnas, las
     trece claves (y que sobre el sujeto del consentimiento haya **una
     sola**), los catorce disparadores **con su forma exacta** (antes o
     después, eventos, por fila) y la **huella del cuerpo de cada función**
     que va a sustituir.
   - Si una función se cambió a mano en la base, **se detiene y no toca
     nada**.
   - Al final verifica lo que dejó.
   - Se puede ejecutar dos veces.
3. **Reiniciar la API.** No lo necesita (no cambia nada de lo que la API
   guarda en memoria), pero es la costumbre del proyecto.
4. Verificarla en solo lectura (§11).
5. Probar una baja real en QA físico (`Z_QA_FISICO_PENDIENTE.md`).

## 11. Verificar la 0089 (solo lectura)

Todo dentro de **una** transacción de solo lectura, que termina en `ROLLBACK`.

```sql
begin transaction read only;
select current_setting('transaction_read_only');           -- tiene que ser 'on'
savepoint sonda;
create temp table sonda_de_escritura (x int);              -- TIENE que fallar con 25006
rollback to savepoint sonda;

-- 1. El disparador de la auditoría apunta a su función nueva.
select p.proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'public.audit_events'::regclass and t.tgname = 'audit_events_solo_anadir';
-- → auditoria_solo_anadir

-- 2. El consentimiento, anonimizable.
select c.confdeltype, a.attnotnull from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attname = 'subject_id'
 where c.conname = 'consent_records_subject_id_fkey';
-- → n | f

-- 3. La excepción: sin privilegios, sin security definer, search_path fijo.
select prosecdef, provolatile, proconfig from pg_proc
 where oid = 'public.es_anonimizacion_por_baja(jsonb, jsonb, text[])'::regprocedure;
-- → f | v | {search_path=""}
select has_function_privilege('anon', 'public.es_anonimizacion_por_baja(jsonb, jsonb, text[])', 'execute'),
       has_function_privilege('authenticated', 'public.es_anonimizacion_por_baja(jsonb, jsonb, text[])', 'execute');
-- → f | f

-- 4. Los cuerpos, por su huella (tabla de abajo).
select proname, md5(regexp_replace(replace(prosrc, E'\r', ''), '\s+', ' ', 'g'))
  from pg_proc where pronamespace = 'public'::regnamespace
   and proname in ('es_anonimizacion_por_baja', 'auditoria_solo_anadir', 'sellar_consumo_una_vez',
     'impedir_reescritura_de_version', 'impedir_reescritura_de_version_de_evento',
     'event_policies_publicada_es_inmutable', 'event_policies_publicada_no_se_borra',
     'event_review_moderation_solo_anadir', 'product_review_moderation_solo_anadir',
     'product_finanzas_solo_se_anaden', 'event_dispute_events_solo_anadir',
     'event_aftersale_case_events_solo_anadir', 'event_order_policy_acceptances_solo_anadir',
     'event_orders_con_dinero_no_se_borran', 'orders_con_dinero_no_se_borran')
 order by 1;

-- 5. Los frenos de las órdenes con dinero (before delete, por fila: tgtype 11).
select tgrelid::regclass, tgname, tgtype, tgenabled from pg_trigger
 where tgname in ('event_orders_con_dinero_no_se_borran', 'orders_con_dinero_no_se_borran');
-- → 2 filas, tgtype 11, tgenabled 'O'

-- 6. RLS activa en las doce tablas.
select relname, relrowsecurity from pg_class
 where relnamespace = 'public'::regnamespace and relname in (
   'audit_events', 'consent_records', 'course_versions', 'event_versions', 'event_policies',
   'event_review_moderation', 'product_review_moderation', 'product_refund_events',
   'product_dispute_events', 'event_dispute_events', 'event_aftersale_case_events',
   'event_order_policy_acceptances');

rollback;
```

| Función | Huella esperada tras la 0089 |
|---|---|
| `auditoria_solo_anadir` | `3f218e59eb4ce489b1b7bed3dd4647b6` |
| `es_anonimizacion_por_baja` | `d117f46e6330310b7d647f6c0b714e31` |
| `event_aftersale_case_events_solo_anadir` | `8f76ab678cc39f4972cfcff40ff0077c` |
| `event_dispute_events_solo_anadir` | `0f7bd033f231982d1deb8757c6fa8258` |
| `event_order_policy_acceptances_solo_anadir` | `6e8bc5698569b633ef76ec3560d90630` |
| `event_orders_con_dinero_no_se_borran` | `bc85e050525824abbc052dc0a690ed23` |
| `event_policies_publicada_es_inmutable` | `675e87c61eb41f6afd34b67dbd1c1fc3` |
| `event_policies_publicada_no_se_borra` | `432b62dfeb0cb4bf88188e5267730856` |
| `event_review_moderation_solo_anadir` | `d8dab887f89a3c5519f7a8c7cdfbeb45` |
| `impedir_reescritura_de_version` | `dbc2e4cf08face07369f4f020cd24742` |
| `impedir_reescritura_de_version_de_evento` | `64ac6c5b8201b051d87002ffe27a2d6c` |
| `orders_con_dinero_no_se_borran` | `d74b361e4e731d3b3ad4fb98c7e18175` |
| `product_finanzas_solo_se_anaden` | `c0bd49b5e89a6afc316f8e78ce199f09` |
| `product_review_moderation_solo_anadir` | `72d54ab378cccdf3961b64f4d3e79350` |
| `sellar_consumo_una_vez` | `3dab99dea6429ec8f74721a11e1a0480` |

## 12. Decisiones de la empresa que siguen pendientes

Se detallan en `Z_REQUISITOS_Y_DECISIONES.md`, S7–S12. En resumen:

- **Cuentas con obligaciones** (§8): plazo de conservación de ventas, pedidos,
  saldos y disputas; si se anonimizan pasado ese plazo; y el proceso de
  soporte para cerrarlas. **Es prioritaria antes de encender los pagos**:
  Google Play exige que una cuenta se pueda borrar desde la app (se pueden
  conservar los registros de las transacciones). Hoy, quien haya comprado
  algo con dinero de verdad recibe 409 y tiene que escribir a soporte. La
  salida coherente con la regla del 29/09 sería conservar la orden y
  anonimizar a quien compró, en vez de impedir la baja; es una decisión de la
  empresa y de su asesoría (S8).
- **Datos de seguridad** (huella y prefijo de IP, navegador): cuánto tiempo se
  guardan.
- **Identificadores del personal** en el historial de Servicios: si se anulan
  también en la baja. Técnicamente es el mismo mecanismo de la 0089, con una
  clave ajena nueva.
- **Motivos del personal** en la auditoría: una pauta para no nombrar a nadie.
- **Notas de reservas de sesión** en las notificaciones ajenas: si se borran
  con la cuenta de quien las escribió.
- **Puentes identificador↔correo** que sobreviven a la baja (S13): el cuerpo
  crudo de los avisos de Stripe (`payment_events.payload`) y el registro de
  Supabase Auth (`auth.audit_log_entries`). Hoy vacíos.
- **Motivos libres del organizador** en la auditoría de Eventos (S14).

## 13. Pruebas

Ver `Z_SERVICIOS_ARQUITECTURA.md` §16 para las cifras y las mutaciones.

- `tests/test_baja_de_cuenta_postgres.py`: el recorrido real, por el endpoint
  y contra PostgreSQL, con un Storage de Supabase en memoria que respeta sus
  reglas. Cubre la reproducción del fallo y cada vertical (Cursos, Comercio,
  Eventos, Productos, consentimientos, avisos y chat), los nueve estados de
  Servicios con documentos, credenciales, historial y envíos, varias
  verticales a la vez, la cuenta ajena, la repetición, los fallos de Storage y
  los bloqueos legítimos.
- `tests/test_migracion_0089.py`: la inmutabilidad, condición a condición, y
  la migración:
  - desde cero y sobre una base con la 0088 y datos;
  - reejecutada y con un fallo a mitad;
  - sin la 0088, con una función cambiada a mano, sin un disparador o con una
    clave distinta;
  - RLS, privilegios, índices y modelos.
- `tests/test_storage_cleanup.py`: listar antes de borrar, lotes, adjuntos de
  chat, lo que ya no está, fallos y producción sin credenciales.
- `apps/mobile/src/screens/bajaDeCuenta.test.mts`: el mensaje del 409.
- `tests/test_baja_de_cuenta.py`: el contrato del servicio sin PostgreSQL:
  orden, fallos, 409, 503 y repetición.
- `tests/test_procesado_de_video.py`: los derivados sin dueño.

## 14. Revisión independiente (29/09/2026)

La hizo otra sesión, con otro criterio, sobre `909c90b..416adbb`. Encontró
**1 hallazgo alto, 5 medios y 6 bajos**, y ningún bloqueante. Cada uno se
reprodujo con una prueba que **fallaba con el código revisado**: 15 pruebas
del backend y 4 del móvil en rojo antes de corregir. Tras las correcciones,
la misma sesión volvió a revisar.

| # | Severidad | Hallazgo | Estado |
|---|---|---|---|
| 1 | **ALTA** | Una orden pagada sin saldo (comisión sin configurar, el valor por defecto) se borraba con quien compró | **Corregido**: freno en la base (0089, §8), 409 y nada se toca |
| 2 | MEDIA | Texto libre en `audit_events.reason` que sobrevive a la cuenta | **Corregido en Servicios** (mensajes y notas del equipo). En Eventos, documentado y propuesto como tarea (S14) |
| 3 | MEDIA | El identificador sigue en otras columnas; puentes identificador↔correo | **Documentado** (S10, S13). Comprobado en solo lectura: los puentes tienen hoy 0 filas |
| 4 | MEDIA | Derivados de vídeo subidos tras el barrido quedaban huérfanos | **Corregido**: el procesado bloquea la fila y retira los derivados si ya no está |
| 5 | MEDIA | Un fallo parcial de Storage borraba adjuntos de terceros en conversaciones que volvían con el rollback | **Corregido**: lo ajeno se retira después de confirmar |
| 6 | MEDIA | Muchas llamadas seguidas a Storage frente a los 20 s del teléfono: mensaje falso | **Corregido**: listados a la vez, 90 s en la baja y un mensaje que no afirma lo que no sabe |
| 7 | BAJA | Carpetas más hondas que el tope, saltadas en silencio | **Corregido**: tope de 16 y fallo explícito |
| 8 | BAJA | Desplegar antes de la 0089 daba un 409 falso | **Corregido**: 503 `account_deletion_unavailable` |
| 9 | BAJA | En SQLite la baja siempre daba 500, y no había prueba sin PostgreSQL | **Corregido**, con pruebas nuevas |
| 10 | BAJA | Las precondiciones no miraban la forma de los disparadores ni una segunda clave | **Corregido** |
| 11 | BAJA | Pruebas tautológicas | **Corregido** para los depósitos (se leen de las migraciones). Las del móvil siguen siendo textuales por convención del proyecto (no hay renderizador) |
| 12 | BAJA | Borrar desde el panel de Supabase no limpia Storage | **Documentado** (§5): soporte no debe cerrar cuentas así |

**Segunda pasada**, sobre las correcciones. Confirmó que el hallazgo alto
está cerrado y que **no queda nada alto ni bloqueante**. Encontró además:

| # | Severidad | Hallazgo | Estado |
|---|---|---|---|
| N1 | MEDIA | CloudFront corta a los 60 s con un 504, y el teléfono decía «sigue activa» con la cuenta ya borrada | **Corregido**: lo ajeno se retira tras contestar, y cualquier 5xx que no sea uno de los dos 503 de la API es «no se pudo confirmar» |
| N2 | MEDIA | Quien pagó algo no puede borrar su cuenta desde la app (Google Play lo exige) | **Decisión de la empresa** (S8), prioritaria antes de encender los pagos |
| N3 | BAJA | Un checkout abandonado frenaba la baja para siempre | **Corregido**: el pago en curso frena solo 25 h |
| N4 | BAJA | Las órdenes de pruebas (`sandbox`) frenaban la baja | **Corregido**: solo `production` |
| N5 | BAJA | Un pago tardío después de vencer la orden no queda protegido | **Documentado**: el aviso de Stripe se conserva en `payment_events` para conciliar |
| N6 | BAJA | Un fallo no previsto después de confirmar daba 500 con la cuenta ya borrada | **Corregido**: se captura cualquiera y se registra |
| N7 | BAJA | Una carpeta demasiado honda de otro miembro cortaba la retirada de las demás conversaciones | **Corregido**: cada conversación por su lado; en la carpeta propia, la baja se detiene (solo puede crearla la propia persona) |
| N8 | BAJA | Un listado que falla dejaba tareas colgando | **Corregido** |

Siguen abiertos, como riesgos bajos documentados:

- el borrado desde el panel de Supabase (§5);
- una subida directa del teléfono con un token todavía válido **después** del
  barrido: los permisos de Storage solo miran la primera carpeta, no que la
  cuenta exista. El teléfono cierra la sesión justo después de la baja.
