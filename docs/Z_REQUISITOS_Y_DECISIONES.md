# Cursos: qué está hecho, qué falta y qué espera una decisión

Este documento existe para que nadie tenga que adivinar en qué punto está el
dominio de Cursos. **No repite los blueprints**: los blueprints dicen qué debe
existir; aquí se dice qué existe hoy, dónde, y qué lo bloquea.

- Fuente funcional: `Z_Cursos_Blueprint_Producto_Legal-1.docx` (v1.0, 6/9/2026).
- Orden y alcance: `Plan_Spec_Driven_Z_Excelencia.docx`.
- Detalle técnico del dinero: [`Z_DEVOLUCIONES_Y_LIQUIDACIONES.md`](Z_DEVOLUCIONES_Y_LIQUIDACIONES.md).

Estados que se usan abajo:

| | |
|---|---|
| **Hecho** | Implementado y con pruebas que lo protegen. |
| **Parcial** | Funciona, pero le falta parte de lo que pide el blueprint. |
| **Ausente** | No existe. |
| **Bloqueado** | No se puede hacer sin una decisión de la empresa o una credencial. |

---

## 1. Decisiones pendientes

Ninguna de estas la puede tomar quien programa. Mientras no haya respuesta
escrita, el sistema **falla en cerrado**: no inventa el valor que se espera.

### D1 · Cuándo empieza la garantía  ·  **contradicción abierta**

| | |
|---|---|
| Lo implementado | Empieza en el **primer acceso al contenido protegido**. Ni con la compra, ni al abrir la ficha, ni con una lección de muestra. Solo cuenta para quien pagó. |
| Lo que dice el blueprint | §9.2: «empieza en la fecha y hora de confirmación del pago». |
| Decisión provisional | **Se mantiene el primer acceso protegido.** |
| Por qué | Es lo que está escrito, probado y ya explicado en la aplicación. Cambiarlo altera plazos de garantías vivas, que son una promesa hecha a alguien. |
| Dónde vive | `learning/router.py` (`get_lesson_detail` → `_arrancar_garantia`) y `refunds/service.py` (`asegurar_ventana`). |
| Qué haría falta para cambiarlo | Una decisión escrita, una migración que decida qué pasa con las ventanas ya abiertas, y aviso a quien tenga una en curso. |

**Consecuencia aceptada:** quien compra y no entra nunca deja su garantía sin
arrancar, y el saldo del propietario se queda `pending` sin fecha. Es
deliberado —no se puede vencer un plazo que no ha empezado— y se vigila con la
señal «pendientes sin fecha» de `GET /admin/owner-balances/health`.

### D2 · Cuánto dura la garantía

Hoy son **168 horas (7 días)**, fijas para todos los cursos
(`refunds/models.py`, `HORAS_DE_GARANTIA`). El blueprint contempla G0, G7, G14,
G30 y una garantía condicionada por aplicación (§8.2), elegidas **por oferta**.

**Para el MVP se conservan los 7 días.** Hacerlo configurable exige una entidad
de política por oferta, una fotografía de esa política dentro de la orden y una
migración; y sin eso el texto «este curso no ofrece garantía» no se puede
mostrar sin mentir, porque hoy no hay forma de que un curso no la tenga.

La constante está en el código y no en variables de entorno **a propósito**:
cambiarla por entorno alteraría plazos ya empezados. Por eso `expires_at` se
guarda en la fila y no se calcula al leer.

### D3 · El segundo reembolso  ·  **cerrada**

- Un único reembolso voluntario por persona y curso, para siempre.
- Al recomprar hay que aceptar expresamente que esa compra no tendrá otro.
- La aceptación se guarda con versión y huella del texto exacto que se mostró
  (`refunds/politica.py`, tabla `refund_policy_acceptances`).
- La ventana es única por `(usuario, curso)` de por vida: recomprar no la
  reinicia.

La IP y el agente de usuario ya se registran, normalizados y nunca en claro,
desde la 0050 (`consent_records`). `refund_policy_acceptances` sigue siendo la
autoridad del circuito: lo nuevo se guarda **además**, no en su lugar.

### D4 · Dinero real  ·  **bloqueado por la empresa**

Nada de esto se puede decidir desde el código, y ninguno tiene valor inventado:

cuenta de Stripe y país · verificación de la empresa · elegibilidad de Stripe
Connect · tipo de cuenta conectada · **comisión (`PLATFORM_FEE_BPS`, hoy `-1` =
sin configurar)** · impuestos · quién es la entidad vendedora (modelo A o B del
blueprint §2.1) · calendario de liquidación · webhooks reales.

Mientras tanto: todas las banderas apagadas y adaptadores dobles en las pruebas.

### D5 · Políticas por país

El blueprint es explícito en que la entidad vendedora, la jurisdicción y los
plazos legales deben fijarse antes de publicar. No hay ninguna entidad de
política versionada por jurisdicción en el sistema. Bloquea publicar términos
de compra reales.

---

## 2. Matriz de requisitos

| # | Requisito | Estado | Dónde | Qué falta |
|---|---|---|---|---|
| R01 | Crear y editar curso | Hecho | `catalog/router.py` | La oferta (precio, garantía) no está separada del contenido |
| R02 | Revisión y publicación | Parcial | `catalog/router.py` (`submit`, `review-queue`, `review`, `publish`) | Sin puntuación de 100 puntos, sin acta, sin estados PAUSADO / RETIRADO / ARCHIVADO |
| R03 | Versiones del curso | Hecho | `catalog/versiones.py`, migración 0050 | Snapshot inmutable al publicar; una sola vigente por índice. Ver [`Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md`](Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md) |
| R04 | Versiones de la oferta | Hecho | `orders` (0050) | Congela versión, importe, moneda y horas de garantía. `terms_version` sigue nula: no hay términos aprobados (D4/D5) |
| R05 | Precio y moneda | Hecho | `catalog/models.py` | Enteros en unidad menor e ISO-3, nunca coma flotante |
| R06 | Compra | Hecho | `payments/router.py` | Tres vías: Stripe web, tienda nativa, beta gratuita. Todas tras bandera |
| R07 | Webhook de pago | Hecho | `payments/router.py` | Firma verificada, anti-repetición por índice único, importe y moneda comprobados |
| R08 | Estados de la orden | Parcial | `0035_comercio.sql` | Faltan `disputed`, `partially_refunded`, `chargeback_lost` |
| R09 | Acceso (derecho) | Hecho | `commerce` | `entitlements` + matrícula, con origen trazable |
| R10 | Primer acceso protegido | Hecho | `learning/router.py` | — |
| R11 | Progreso | Parcial | `learning/progreso.py` | Cuenta segundos acotados, **no segundos únicos**: repetir un tramo suma |
| R12 | Garantía | Hecho | `refunds/` | Plazo único; ver D2 |
| R13 | Solicitud de devolución | Hecho | `refunds/router.py` | Sin número de caso legible ni canal alternativo |
| R14 | Revisión administrativa | Hecho | `refunds/router.py` | Sin reembolso parcial excepcional, sin SLA ni asignación |
| R15 | Ejecución del reembolso | Hecho | `refunds/reembolso.py` | Tras `stripe_refunds_enabled`. Solo total |
| R16 | Conciliación | Hecho | `refunds/router.py` | Individual y en lote (`/admin/refund-requests/reconcile-stale`). **Falta programarla desde fuera** |
| R17 | Revocación de acceso | Hecho | `refunds/reembolso.py` | Solo con reembolso total y confirmado, en una transacción |
| R18 | Saldos del creador | Hecho | `commerce/liquidacion.py` | Liberación y transferencia por `/admin/owner-balances/settle`. **Falta programarlo desde fuera** |
| R19 | Recompra y aceptación | Hecho | `refunds/` | Falta IP y agente de usuario |
| R20 | Alumnos inscritos | Hecho | `learning/router.py` | Filtros antes de paginar, en el servidor |
| R21 | Ventas del curso | Hecho | `commerce/router.py` | Sin impuestos ni reserva |
| R22 | Notificaciones | Parcial | `notifications/` | **Solo dentro de la aplicación. No hay envío de correo en todo el backend** |
| R23 | Mensajería creador–alumno | Parcial | `messaging/` | Hay chat, no hay vínculo curso↔conversación ni soporte con SLA |
| R24 | Reseñas verificadas de curso | Parcial | `reviews/` | Son reseñas **de persona** con el curso como enlace. Ver §3 |
| R25 | Términos y consentimientos | Parcial | `gobernanza/`, migración 0050 | `policy_versions` y `consent_records` existen, con IP y agente normalizados. **Bloqueado** para los Términos de compra: no hay texto aprobado (D4/D5) |
| R26 | Certificados | **Ausente** | — | Nada. Decidir si entran en el alcance |
| R27 | Accesibilidad | Parcial | — | Etiquetas y áreas de toque revisadas en las ocho pantallas de curso. Sin subtítulos ni transcripción |
| R28 | i18n es/en/pt | Hecho | `src/i18n/` | Diccionarios sincronizados por prueba automática |
| R29 | Monitoreo | Parcial | `main.py`, `core/logging.py`, `gobernanza/` | Ahora hay auditoría consultable e identificador de petición en cada línea de registro. Sin métricas, trazas ni alertas |
| R30 | Rollback por bandera | Hecho | `core/config.py` | Siete banderas independientes; la comisión en `-1` bloquea por sí sola |

### Cerrado en la ronda del versionado

**R03 y R04 ya no son ausencias.** Publicar congela una fotografía inmutable del
contenido y la orden guarda qué versión se compró y con qué promesa de garantía.
Las órdenes históricas se quedan sin versión **a propósito**: el temario nunca
guardó una marca temporal, así que no hay forma de saber qué se vendió, y
rellenarlo sería inventarlo. El detalle está en
[`Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md`](Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md).

**R25 sigue parcial, y el bloqueo no es técnico.** La infraestructura de
políticas versionadas y consentimientos existe y funciona; lo que no hay es
texto de Términos de compra aprobado, porque falta decidir D4 y D5. No se ha
escrito uno provisional.

**Nuevo: existe auditoría compartida.** Publicar y retirar un curso, aprobar y
rechazar devoluciones, liberar saldos y lanzar transferencias dejan rastro
consultable, en la misma transacción que la operación.

### Las ausencias que siguen pesando

**R25 · Consentimiento de los Términos.** El criterio A10 pide un registro con
versión, fecha, IP y huella. Existe la maquinaria —texto versionado en el
servidor, huella SHA-256, tabla de aceptaciones— pero solo se usa para la
recompra. Extenderla a los Términos de compra depende de D4 y D5: no se puede
registrar la aceptación de un texto que todavía no dice quién vende.

**R22 · Correo.** No hay ningún proveedor de correo transaccional. El blueprint
lo exige para compra confirmada, reembolso recibido, reembolso resuelto y acceso
por vencer. Es una decisión de infraestructura, no de código.

---

## 3. Reseñas: lo que hay no es lo que pide el blueprint

Conviene decirlo claro porque las dos cosas se llaman «reseña».

**Lo que existe** son reseñas **de persona a persona** (`profile_reviews`, 0030).
Cualquiera puede opinar sobre cualquiera; el servidor calcula un sello de
«interacción verificada» a partir de una reserva completada o de una compra, y
si no hay constancia la reseña se publica igual, sin sello. El sello **no lo
puede pedir el cliente**: se calcula al publicar y se congela. Desde la 0041 la
reseña puede además señalar un curso de la persona reseñada.

**Lo que pide el blueprint** (§7) son reseñas **del curso**: una por persona y
curso, con compra verificada y consumo mínimo (≥20 % o ≥30 minutos únicos), y un
error `REVIEW_NOT_ELIGIBLE` para quien no cumple.

Son dos productos distintos, y el segundo no está construido. Además, el
consumo mínimo que pide el blueprint se apoya en **segundos únicos**, que hoy no
se miden (R11).

**Decisión pendiente D6:** ¿la reseña de curso es una entidad propia, o el
blueprint se satisface endureciendo el enlace a curso de la reseña de perfil? Es
una decisión de producto, no técnica.

Lo que sí se ha corregido en esta ronda: el sello miraba solo la tabla heredada
`purchases`, así que una compra por Stripe no lo obtenía. Ahora mira también las
órdenes pagadas del comercio nuevo.

---

## 4. Corregido en este incremento

Cada uno con su causa raíz, porque el defecto sin la causa vuelve.

| Defecto | Causa raíz |
|---|---|
| Un webhook que falla al aplicarse borraba su propio registro anti-repetición | La fila de `payment_events` se escribe en la misma transacción sin confirmar, y el manejador de error hacía `rollback` antes de anotar el fallo. Además leía un atributo de un objeto ya caducado, que en asíncrono lanza `MissingGreenlet` y tapaba el error real |
| El aislamiento del savepoint de la compra era falso | `_crear_saldo_del_propietario` y `_avisar_compra_al_propietario` hacían `commit` **dentro** del savepoint. Un commit no deshace un savepoint: lo cierra |
| Un moderador de contenido podía aprobar y ejecutar reembolsos | La comprobación usaba `is_admin`, y `ADMIN_ROLES` incluye `moderator` |
| El motivo interno de rechazo de un curso salía en el catálogo público | `GET /catalog/courses` no pide sesión y copiaba `rejection_reason` al listado. El detalle de `learning` sí lo tapaba |
| El saldo del propietario no salía nunca de `pending` | `liberar_vencidos` y `ejecutar_transferencia` estaban escritas y probadas, y **no las llamaba nadie** |
| Un reembolso cuyo webhook se pierde se quedaba atascado para siempre | Lo mismo con `reconciliar_estancadas` |
| La liberación de saldos podía descongelar una disputa | Leía con `status = 'pending'` y escribía filtrando solo por `id` |
| Una devolución por Google o Apple dejaba la compra como «Pagado» | Revocaba el derecho pero no cerraba la orden, y la pantalla etiqueta cada línea con el estado del pedido |
| El sello de compra verificada ignoraba las compras web | Miraba solo la tabla heredada `purchases` |
| Dos toques rápidos abrían dos expedientes | El cerrojo síncrono se cerraba **después** del diálogo de confirmación, así que los dos toques lo encontraban abierto |
| El Atrás de Android se saltaba «¿guardar antes de salir?» | La despedida colgaba solo del botón de la cabecera |
| Un fallo de red se leía como «este curso no tiene contenido» | El `catch` dejaba la lista vacía sin distinguir «no hay» de «no se pudo leer» |
| Una página que falla dejaba la lista truncada con aspecto de completa | El `catch` apagaba `hayMas` |
| Si fallaba la consulta de recompra se ofrecía comprar sin la advertencia | `null` significaba a la vez «no hace falta» y «no se pudo averiguar» |

### Lo que encontró la revisión independiente

Una segunda pasada sobre estos mismos cambios. **Dos de los defectos los había
introducido yo en esta ronda**; el resto ya estaban.

| Defecto | Causa raíz |
|---|---|
| El `rollback` de una anotación fallida borraba el registro anti-repetición, **en silencio** | `commit` y `rollback` suben hasta la raíz aunque se llamen dentro de un savepoint. No lanzan nada, así que la petición respondía con normalidad y el reenvío de Stripe se procesaba como nuevo |
| La ruta de disputa por webhook cerraba el savepoint del aviso | Terminaba con `commit`, que no confirma un savepoint sino que lo cierra. **No tenía ni una prueba** |
| Una devolución por tienda podía anular el saldo de una compra por tarjeta | `orden_pagada_de` no filtraba por pasarela ni por entorno, y un mismo producto se vende por varias vías |
| Sin la 0049, un `native/sync` perdía las concesiones de toda la pasada | Se consultaba `owner_sale_balances` sin el guardián de esquema que usa el resto del módulo |
| Un saldo que falla se llevaba por delante a los demás | El bucle recorría objetos del ORM y hacía `rollback` dentro: eso caduca **todo** el mapa de identidad, y la vuelta siguiente reventaba con `MissingGreenlet` |
| Una compra de pruebas daba un sello de «compra verificada» real | Faltaba filtrar por entorno, cosa que hace todo el resto del comercio |
| Bucle de peticiones contra un servidor caído | El pie de error cambia el alto del contenido, y eso vuelve a disparar `onEndReached` |
| El Atrás de una sección ejecutaba la despedida de otra pantalla | El interceptor se ataba al montaje, y estas pantallas siguen montadas al cambiar de sección |
| Dos pulsaciones de Atrás apilaban dos diálogos en el asistente | `salir()` era la única acción de escritura fuera del cerrojo, y es justo la que dispara la tecla |
| Una prueba tautológica y once frágiles | La de la disputa congelaba el saldo *antes* de llamar, así que el `SELECT` ya lo descartaba y la condición nueva no se ejercitaba. Las de navegación miraban el texto del `.tsx`: se rompían al reformatear y pasaban aunque el registro no estuviera conectado |

Las tres correcciones de más peso se verificaron **revirtiéndolas**: la prueba
correspondiente falla sin el cambio y pasa con él. Sin esa comprobación, una
prueba nueva solo demuestra que el código actual hace lo que hace.

---

## 5. QA que no se ha hecho

**No se ha probado en un dispositivo físico.** Nada de lo que sigue está
verificado y no debe darse por bueno:

- botón Atrás en un Android real, incluido tras arranque en frío y con
  *predictive back*;
- permisos y grabación de micrófono; notas de voz;
- cámara, adjuntos y recorte de imagen;
- fuente del sistema ampliada y modo claro/oscuro;
- lector de pantalla recorriendo la ficha del curso y la bandeja de
  administración;
- un directo con dos teléfonos.

Riesgo conocido y sin resolver: `@100mslive/react-native-hms` usa un
`SimpleViewManager` heredado sin `codegenConfig`, así que **la superficie de
vídeo puede compilar y no pintar nada** bajo la nueva arquitectura. Solo se
sabrá en un aparato.

Tampoco se ha comprobado nada contra Stripe, Google Play ni Apple reales: no hay
credenciales y las banderas están apagadas.

---

## 6. Qué falta antes de encender cobros

En orden, y ninguno es opcional:

1. **Aplicar la 0049 y la 0050** donde toque. Que la 0049 no esté en la base de
   desarrollo local no dice nada sobre la de producción: son bases distintas y
   no se ha comprobado ninguna externa. Lo que sí ha cambiado es que ahora
   existe una validación real de migraciones —ver
   [`Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md` §8](Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md).
   Tras aplicar la 0050 hay que **sembrar la política de recompra** una vez.
2. Decidir **D4** entero, y en particular `PLATFORM_FEE_BPS`.
3. Cerrar **R03** (versionado de la oferta) y **R25** (consentimiento de los
   Términos). Sin lo primero, la orden no es inmutable; sin lo segundo, no hay
   prueba de qué aceptó quien pagó.
4. Programar desde fuera —cron, tarea, lo que sea— las dos pasadas que ahora
   existen como endpoint: `/admin/owner-balances/settle` y
   `/admin/refund-requests/reconcile-stale`. **No se han puesto dentro de la
   API a propósito**: corre en varias réplicas y un temporizador en el proceso
   son tantas pasadas simultáneas como réplicas haya.
5. Correo transaccional (R22).
6. QA en dispositivo físico.
