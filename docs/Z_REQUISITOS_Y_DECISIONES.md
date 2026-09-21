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

Son dos productos distintos. **D6 resuelta: entidad propia.** La reseña de
curso es `course_reviews` (0056, SIN APLICAR), no un endurecimiento de la de
perfil: `profile_reviews` valora personas, no lleva puntuación, y cambiar la
entidad valorada habría sido rehacer esa tabla, no reutilizarla.

**Lo que sigue faltando del blueprint §7: el consumo mínimo** (≥20 % o ≥30
minutos únicos). Se apoya en **segundos únicos**, que hoy no se miden (R11), así
que exigirlo sería inventarse el dato. Hoy la condición es haber comprado y
conservar el curso; `review_purchase_required` y `review_access_required` ocupan
el lugar de `REVIEW_NOT_ELIGIBLE`.

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

---

## 7. Decisiones tomadas al verificar las migraciones (8/09/2026)

Ver [`Z_VERIFICACION_0051_0052.md`](Z_VERIFICACION_0051_0052.md) para la
evidencia. Aquí solo lo que se decidió y por qué.

**D8 · Moderar y mover dinero son permisos distintos también en la base.**
`is_admin()` es `role in ('moderator','admin')` y se usa en veinte políticas de
moderación; estrecharla habría dejado sin trabajar a quien modera. Se declara
`puede_mover_dinero()` aparte —solo `admin`— y se pasan a ella las políticas de
las catorce tablas que guardan dinero o rastro de una persona. `is_admin()` se
queda donde toca: contenido y textos.

**D9 · La lista de tablas de dinero se deduce del esquema, no se escribe.**
Escribirla a mano fue lo que dejó cinco políticas del comercio abiertas después
de creer el problema cerrado. Ahora toda tabla que declare `amount_minor`,
`currency`, `external_*_id` o `balance` entra sola en la comprobación, y cada
excepción tiene que declararse con su motivo.

**D10 · El dinero no se sirve por PostgREST.** Se retira la concesión de tabla
que Supabase da por defecto a `anon` y `authenticated` sobre esas tablas. La RLS
seguía siendo la única barrera, y `truncate` ni siquiera pasa por ella. Se puede
hacer porque el móvil no lee ninguna: habla con FastAPI.

**D11 · `course_enrollments` se reparte como si guardara dinero**, aunque no
guarde importes: dice quién tiene acceso a qué curso, y cruzada con el precio
dice quién compró qué y por cuánto. Es el mismo dato con otra forma.

**D12 · Una tabla nueva ya no nace concedida.** Se cambian los privilegios por
defecto del esquema. A partir de ahí hay que conceder a propósito, y si alguien
olvida hacerlo la pantalla falla durante el desarrollo. Es preferible a que una
tabla de dinero se sirva sola. Va en una sección aparte de la 0053 porque cambia
el comportamiento futuro y se puede aplicar en otro momento.

**D13 · La huella de IP se queda nula antes que ser falsa.** Sin sal —o con una
de menos de 32 caracteres— no se guarda ninguna, porque el espacio de IPv4 se
recorre en minutos. Y una dirección de red interna no se guarda como origen:
detrás de un proxy es la misma para todo el mundo, así que llenaría la columna
con un valor idéntico en todas las filas. Un dato falso en la tabla que alguien
mirará para investigar un abuso es peor que no tener dato.

## 8. Decisiones al cerrar las valoraciones (8/09/2026)

**D14 · «Compra verificada» habla de haber PAGADO, no de poder entrar.** El
sello salía de `resolver_acceso_al_curso`, que responde a otra pregunta y
empieza cortocircuitando en `price_minor <= 0`, en el autor y en quien
administra. Con eso, bajar un curso a gratis sellaba de golpe todas sus
valoraciones —incluidas las de quien ya había devuelto—. Ahora se resuelve
contra la compra: `Purchase` pagada, o `Entitlement` activo y vigente del
producto de ese curso. Sigue sin guardarse: se deriva en cada lectura, así que
una devolución apaga el sello sin borrar la opinión.

**D15 · Moderar no se deshace desde el cliente.** Una valoración oculta se
podía retirar, y con la fila fuera la unicidad dejaba de dar 409: se volvía a
publicar el mismo texto, visible. El `DELETE` sobre una oculta ahora responde
409 `course_review_moderated`. A cambio, la propia se lista SIEMPRE aunque esté
oculta —como ya decía la política de la 0056— y se dice que está en revisión:
sin eso, quien la escribió no podía verla, ni editarla, ni entender por qué la
media no se movía.

**D16 · La constancia de compra lleva el código de la moneda.** `MXN` y `USD`
comparten el símbolo `$`, y una moneda que no está en la tabla salía sin
ninguno. En el catálogo el contexto basta; en el documento que prueba cuánto se
pagó, no. Solo cambia ahí: `deCentavos` se queda como estaba.

**D17 · Un `PATCH` cambia lo que trae.** Con el esquema de creación, subir la
puntuación sin reenviar el texto lo borraba en silencio. Mandar `comment: null`
sí lo borra; lo que no vale es borrarlo sin pedirlo.

**D18 · Valorar se ofrece solo donde el servidor podría decir que sí.** En un
curso gratis nadie compró, así que el botón contestaba siempre 422
`review_purchase_required`. Sigue siendo una pista, no un permiso: quien decide
es el servidor en cada escritura.

## 9. Decisiones del aprendizaje: notas, evaluación y certificado (8/09/2026)

**D19 · Una nota privada no la lee nadie más, y no hay matiz.** Ni el autor del
curso, ni moderación, ni administración por rutas ordinarias. La consecuencia
de diseño es que NINGUNA función del módulo acepta un identificador de usuario:
quien pregunta sale del token. Editar o borrar la ajena responde 404 y no 403,
porque «existe pero no es tuya» ya cuenta algo de lo que otra persona escribió.

**D20 · La respuesta correcta no sale de la API mientras se responde**, y la
garantía no es acordarse de excluirla: son dos familias de esquemas y el del
alumno no declara el campo. Añadirlo por descuido a `OpcionRead` es la única
forma de romperlo, y hay una prueba que se pone roja si ocurre.

**D21 · La nota la calcula el servidor sobre el TOTAL de preguntas.** Contar
solo lo respondido premiaría dejar preguntas en blanco. Un intento enviado no se
vuelve a enviar: reenviarlo sería ir probando respuestas hasta acertar.

**D22 · Un curso está terminado cuando están todas sus lecciones y, si hay
evaluación publicada, hay un intento aprobado.** Nada de porcentajes declarados
por el cliente ni de tiempo reproducido deducido. Un curso sin lecciones NO está
terminado: cero de cero es el 100 % en aritmética y una afirmación falsa en
producto.

**D23 · La fecha de finalización se guarda una vez y no se mueve.** Se guarda
—en vez de recalcularla— porque el certificado dice una fecha, y recalcularla
mañana con las lecciones de mañana daría otra: añadir una lección movería el día
en que alguien terminó.

**D24 · El código público de un certificado son 128 bits de `secrets`.** No es
correlativo y no lleva año: un «ZC-2025-034892» se recorre entero en una tarde y
deja listar el nombre y el curso de todo el que se haya certificado. La
verificación pública no lleva correo, ni identificador de usuario, ni orden, ni
importe.

**D25 · Revocar no borra.** Una devolución total confirmada revoca el acceso y
deja el certificado marcado como no vigente, con su motivo y su fecha. Borrarlo
dejaría a quien lo compartió sin ninguna explicación de por qué desapareció el
enlace. Es la política MVP que pidió el encargo, implementada como enganche en
el paso 5 del reembolso; el motor de devoluciones no cambia.

**D26 · El certificado no se llama título ni acreditación.** Es un certificado
de finalización de un curso. Y no se genera PDF: pediría una dependencia nueva y
un servicio que lo firme, y la verificación pública ya cubre lo que el PDF
prometía —que alguien de fuera pueda comprobarlo—.

**D27 · La ayuda del curso no es un sistema de soporte nuevo.** Los cuatro tipos
de problema llevan a lo que ya los resuelve. Una bandeja de tickets era un
dominio entero para repartir a mano lo que ya está repartido.

## 10. Cierre técnico de Cursos (9/09/2026)

**D28 · Moderación no toca las respuestas correctas.** `_puede_gestionar` —la
regla del resto del temario— incluye a `moderator`, que existe para ocultar
contenido y resolver reportes. Quien cambia la alternativa correcta cambia quién
aprueba, y con ello quién obtiene un certificado verificable. Pasa a ser el
autor, o administración con poder real (`puede_mover_dinero`), y cuando no es el
autor QUEDA ANOTADO. Editar lo propio no deja rastro: no es un hecho que
investigar. Esto cierra la decisión que quedó abierta en el incremento anterior.

**D29 · La lectura del borrador es un hecho auditable, y por eso ese GET
escribe.** `GET /quiz/draft` es la única puerta de toda la API por la que sale
`is_correct`. `auditoria.anotar` solo hace `flush` y nadie confirma por una
lectura, así que la nota se deshacía sola: el `commit` va en el propio endpoint.

**D30 · Un borrador se puede guardar a medias, pero nunca con texto vacío.** La
base exige `length(trim(...)) >= 1` en enunciados y alternativas. Las preguntas
completamente en blanco no se mandan; una a medio escribir se señala. Guardar
admite lo que publicar no —sin correcta marcada sigue siendo un borrador—.

**D31 · Las invariantes de 0057-0059 solo significan algo en PostgreSQL.**
Índices únicos parciales, claves foráneas compuestas y RLS no existen en SQLite:
allí esas pruebas pasan sin que la base sostenga nada. Se escribieron 24 pruebas
que intentan escribir lo prohibido; se omiten sin `MIGRACIONES_DATABASE_URL` y
las corre CI contra un PostgreSQL 16 desechable.

**D32 · El aforo lo arbitra la base, no un conteo.**

La reserva contaba, comparaba e insertaba, con nada en medio. Dos peticiones
simultáneas leían el mismo número y las dos entraban; la clave única
`(event_id, user_id)` solo impedía que **una persona** se duplicara, así que el
fallo no se veía probando a mano. Ahora se bloquea la fila del evento con
`select ... for update` y todo ocurre dentro de esa transacción. Un `asyncio.Lock`
no valía —ordena un proceso, no varias réplicas— y un índice único tampoco:
«como mucho N» no es una propiedad de una fila. Detalle en
`Z_EVENTOS_ARQUITECTURA.md`.

**D33 · Un evento nuevo nace borrador, y la ruta antigua también.**

`POST /catalog/events` creaba con `status = 'published'`. Eso era
autopublicación: cualquier cuenta ponía un evento en el catálogo sin que nadie
lo mirara. La ruta se mantiene por compatibilidad con los binarios instalados,
pero lo que crea es un borrador. Publicar exige aprobación.

**D34 · Curaduría puntúa; administración decide.**

`is_admin` incluye `moderator`, y con esa comprobación un moderador podía
aprobar y publicar un evento. Aprobar es autorizar que se venda algo, y no es lo
mismo que revisar si está bien escrito. Es el mismo patrón que ya separó moderar
contenido de mover dinero. Y nadie aprueba ni publica su propio evento, ni
siendo administrador: se comprueba **antes** que el rol.

**D35 · Los estados derivados no son columnas.**

El contrato nombra doce estados; solo siete se guardan. `SOLD_OUT` se deriva del
aforo —guardado, miente en cuanto alguien cancela—, `IN_PROGRESS` y
`COMPLETED_PENDING` de las fechas, y `SETTLED` de una liquidación que este
incremento no implementa: escribirlo sería afirmar que se transfirió un dinero
que nadie movió. El CHECK de la 0060 acepta exactamente los siete guardables.

**D36 · Un CHECK que evalúa a NULL se cumple.**

El umbral de aprobación decía `total >= 85`. Con `total` nulo eso no da FALSO:
da NULL, y la restricción entera pasa. Quedaba aprobado un evento sin ninguna
puntuación, que es justo lo que esa línea existe para impedir. Lo encontró una
prueba escrita **antes** de aplicar la migración; corregido en la 0060, que
sigue sin aplicar. Es la misma lógica de tres valores que ya mordió en
`catalog/eventos.py` con los `is_not(None)`.

**D37 · Una migración histórica no tiene que ser reejecutable.**

La prueba de idempotencia aplicaba las 60 migraciones una segunda vez y exigía
que ninguna fallara. Estaba imponiendo retroactivamente un contrato que la 0001
nunca prometió: crea `type app_role` y una veintena de tablas sin `if not
exists`, porque se escribió para correr **una vez** sobre una base vacía.
Arreglar solo el `create type` no arregla nada: detrás aparecen las tablas.

Se separan tres garantías —instalación limpia, reejecución de las que prometen
serlo, y las que ya constan aplicadas— y la frontera no se adivinó: se aplicaron
las 60 y después se intentó cada una otra vez. Fallan tres, y no son «las
antiguas»: 0001, 0003 y la 0058, de hace dos semanas. La lista es de
**exclusiones**, así que una migración nueva entra por defecto.

**D38 · El cerrojo del aforo tiene tiempo límite.**

Sin él, dos peticiones por el mismo evento esperan indefinidamente y cada una
ocupa una conexión del pool: un evento popular con gente reintentando lo agota,
y entonces se para la API entera y no ese evento. `SET LOCAL lock_timeout`, que
vale para esa transacción y no cambia nada en la base.

Y el fallo **no se cuenta como aforo lleno**: «no queda sitio» es definitivo y
«vuelve a intentarlo» no. Tiene su propio código, `inventory_lock_timeout`.

**D39 · Sin fila de configuración, el evento es gratuito.**

La 0061 no escribe una fila por evento. La ausencia no es un hueco: es la
respuesta, y es la correcta para los ocho eventos que existen. Escribirles una
fila que dijera eso mismo haría creer que alguien decidió algo sobre ellos.

**D40 · Una reserva temporal no es una compra, y el contrato no lo insinúa.**

No hay botón de pagar, ni siquiera apagado —uno deshabilitado sugiere que llega
en un minuto—. Se dice «subtotal de entradas» y no «total», porque faltan
comisión e impuestos que la empresa no ha definido. Y no se muestra una comisión
de cero como si estuviera decidida.

`CONSUMED` existe como estado porque lo pide el contrato y ningún camino lo
escribe: no hay orden que lo justifique.

**D41 · La disponibilidad se calcula; la limpieza es comodidad.**

Un hold vencido deja de ocupar aunque su fila siga diciendo `ACTIVE`. Si la
limpieza fuera la única forma de liberar inventario, un fallo del programador
externo dejaría el evento agotado con la sala vacía.

### Pendiente de decisión de negocio

- **Las subnotas y la evidencia de la captura 19.** La referencia enseña tres
  puntuaciones —contenido, claridad, aplicación— y un adjunto. La 0056 guarda un
  solo `rating`, y aceptar archivos de alumnos abre una superficie de moderación
  que hoy no tiene política. Hace falta decidir si el producto las quiere antes
  de crear columnas.
- **Los módulos con requisito previo de la captura 15.** Nada en el modelo dice
  que un módulo dependa de otro; pintar el candado sería inventarse la regla de
  desbloqueo.
- **La aceptación de recompra en las tiendas.** `native/sync` concede acceso sin
  comprobarla. Rechazar no vale: cuando ese endpoint corre, el dinero ya se
  movió. Hoy se concede y se anota `repurchase.sin_aceptacion` en auditoría. Hay
  que decidir si eso basta o si la aceptación se exige antes de lanzar la compra
  en la tienda.
- **Qué se hace con quien vuelve a comprar y ya tenía valoración.** Hoy conserva
  la que escribió: una recompra no da un segundo voto. Nadie ha dicho si debería
  poder rehacerla.

### Cerrado desde que se escribió esta lista

- **La ruta de vuelta de Stripe** (`/pago`, `/pago/cancelado`) ya existe, con
  reintento y lectura del estado de la orden. Sigue inerte mientras las compras
  estén apagadas.
- **El móvil ya no edita el contenido del curso por PostgREST.** Las doce
  escrituras directas pasan por la API, que versiona y audita.

## 11. La cancelación total de un evento (12/09/2026)

**D42 · Si el organizador cancela, Z devuelve el 100 %.**

Confirmado por la empresa:

> Si el organizador cancela totalmente un evento que no se realizará,
> corresponde devolver al comprador el 100 % de lo pagado por la entrada, aunque
> su política particular diga otra cosa.

Es una **regla obligatoria de Z** y prevalece sobre condiciones contradictorias
del organizador. Vive en `cancelacion.DEVOLUCION_TOTAL_OBLIGATORIA = True`, un
solo valor en un solo fichero, con una prueba que recorre el árbol para
comprobar que ningún otro lo nombra.

**D43 · Decidir que procede la devolución no es haber pagado.**

La cancelación deja el expediente en `refund_pending` con el importe: eso
significa «Z debe este dinero». Que el dinero volvió solo lo dice
`refund_processing → resolved`, un salto reservado a un aviso verificado del
proveedor. Ni el sistema ni quien administra pueden declararlo, y por eso el
resultado de cancelar tiene un contador de `devoluciones_decididas` y ninguno de
«devuelto».

Consecuencias que se sostienen aunque incomoden:

- **No se revoca ninguna entrada** al cancelar. Revocar no es reversible y no
  hace falta: el evento ya no existe.
- **No se libera ni se transfiere ningún saldo.** Se retiene el neto entero,
  porque Z debe el importe completo.
- **Lo ya devuelto no se debe dos veces.** El importe es el total menos lo que
  volvió de verdad, contando solo expedientes `resolved`.
- **Una devolución en curso no se pisa.** En `refund_processing` el dinero va de
  camino; rearmarlo abriría la puerta a ejecutarlo dos veces. En `failed` hace
  falta una persona.

**D44 · Una política histórica no se reescribe; se muestra la excepción.**

Una condición publicada antes de esta decisión puede decir «sin devolución». Su
versión aceptada es intocable: es lo que esa persona leyó, y cambiarla
falsificaría su consentimiento. Lo que se hace:

- **Hacia adelante**, `cancelled_event_bps` por debajo de 10 000 no se publica
  —ni por el organizador ni por la plataforma— con el código
  `event_policy_contradicts_mandatory_refund`.
- **Hacia atrás**, `GET /events/{id}/policies/terms` manda un bloque `mandato`
  con la regla, el 100 % y qué parámetros publicados quedan sin efecto. La
  pantalla los tacha; esconderlos haría imposible entender qué se prometió.
- **Al resolver**, manda la regla de Z.

**D45 · Sin política configurada la regla rige igual.**

El mandato se evalúa antes de buscar la política aceptada. Si fuera después, una
compra que no aceptó ninguna contestaría `policy_not_configured` y quien pagó por
un evento que no se hará se quedaría sin nada porque nadie publicó un plazo. La
regla es de Z, no del organizador.

## 12. Productos, Incrementos 1–3 (12/09/2026)

**D46 · `commerce_products` no se convierte en catálogo físico.**

Esa tabla representa el derecho digital que se compra para acceder a un curso.
Mezclarla con productos físicos uniría dos cosas que no comparten ciclo de vida,
ni entrega, ni devolución, y rompería el acceso de quien ya compró un curso.
Productos tiene sus propias tablas —trece en los Incrementos 1–3, veintidós tras
el 5— y reutiliza perfiles, permisos, auditoría, almacenamiento y avisos.

**D47 · Un creador es un perfil con capacidad comercial.**

No hay tabla de «creador». Una tabla aparte crearía una segunda identidad que se
desincroniza del perfil: dos nombres, dos fotos y dos verdades sobre quién es esa
persona. `product_sellers` es la capacidad, y nace `pending`.

**D48 · Las variantes y la galería cuelgan de la versión, no del producto.**

Lo que se publica es una versión inmutable, y «lo publicado» incluye las fotos
aprobadas y las opciones ofrecidas. Colgándolas del producto, cambiar una foto
reescribiría en silencio lo que se evaluó. Una versión nueva copia las filas que
conserva; el archivo no se vuelve a subir.

**D49 · Nulo no es gratis, y vacío no es cero.**

`price_minor` y `currency` nulos significan «sin precio configurado»;
`product_categories` vacía significa que la empresa no ha definido las
categorías; `rating: null` significa que no hay reseñas. Ninguno de los tres se
rellena con un valor razonable, y hay pruebas que lo comprueban.

**D50 · El veredicto de una evaluación lo escribe el sistema.**

Que un producto esté aprobado es consecuencia de una puntuación con evidencia,
no de que alguien pulse «aprobar». La máquina de estados solo admite
`evaluation → approved` al actor `system`, y publicar exige además las tres
razones y una foto.

**D51 · Evaluar es curaduría; publicar es administración.**

Se reutiliza la separación de Eventos (D34) en vez de inventar roles: `is_admin`
evalúa, solo `admin` publica, retira y suspende. Quién puede ser «Evaluador Z»
con un rol propio es una decisión abierta, y añadir valores a `profiles.role`
por esto exigiría una migración sobre una tabla que usa media plataforma.

**D52 · Una aprobación condicionada no publica.**

Qué condiciones exactas se le exigen no está definido, así que no hay salto a
`published` desde ahí. Falla en cerrado: publicarlo «mientras tanto» sería
ponerle el sello de Z a algo que nadie autorizó del todo.

**D53 · Una evaluación rechazada devuelve el producto a borrador.**

La cadena del blueprint no tiene estado «rechazado». Dejarlo parado en
`evaluation` sería un producto atascado para siempre; volver a borrador es lo
único que le permite corregir lo que falló. Retirarlo es una decisión aparte.

**D54 · «Selección Z» se ordena por la evaluación, y «para ti» no está
personalizado.**

La selección sale de la puntuación de la evaluación aprobada, que es un dato
verificado; una lista a dedo sería una decisión que nadie ha tomado. Y no hay
recomendador de productos, así que el contrato manda `personalized: false` para
que la pantalla no ponga un título que miente. El **título editorial** de la
selección que enseña la captura 5 no tiene campo: es un hueco declarado, no un
olvido.

**D55 · El único indicador de confianza es el origen.**

El blueprint §3.1 admite cuatro —recomendación, garantía, origen o compras
verificadas— y solo uno por tarjeta. Hoy solo el origen se puede demostrar: los
otros tres necesitan reseñas, pedidos o condiciones aprobadas.

**D56 · La fotografía no la sube el móvil: la sube la API.**

El depósito `product-media` (0073) es privado y **no tiene ninguna política de
almacenamiento**, al revés que `message-media`, donde la aplicación escribe
directamente y las políticas deciden quién puede. Aquí el archivo viaja a la
API, que comprueba de quién es el borrador, **mira los bytes**, genera el nombre
y solo entonces escribe con la clave de servicio. Sin políticas, `anon` y
`authenticated` no pueden ni leer ni listar: la única puerta es la API, que es
la única que sabe qué fotografías están aprobadas.

Y **ya no se acepta una ruta pegada**. Antes quien vendía mandaba en el borrador
una lista de rutas de almacenamiento, lo que permitía apuntar a un archivo ajeno
—o a ninguno— y la ficha enseñaba lo que dijera esa cadena. `PUT .../draft` ya
no lleva galería.

**D57 · Subir no es publicar: una fotografía nace pendiente.**

`product_media.status` nace `pending`. Quien evalúa la aprueba o la rechaza **con
motivo**, y el catálogo solo firma las aprobadas. Sin ese estado, aprobar un
producto aprobaría también cualquier imagen que le añadieran después.

Publicar exige ahora **al menos una fotografía aprobada**, y «hay fotos y
ninguna aprobada» tiene su propio código —`product_media_not_approved`— porque
no es el mismo problema que no haber subido ninguna: no falta subir nada, falta
que alguien las mire.

**D58 · La extensión no decide nada, y el `Content-Type` tampoco.**

El tipo se deduce de los **primeros bytes** y después se **abre la imagen de
verdad**: una cabecera de JPEG se puede pegar delante de cualquier cosa. El
depósito declara tres tipos —`image/jpeg`, `image/png`, `image/webp`— y no
`image/*`, que dejaría pasar SVG: un SVG es un documento con scripts, no una
fotografía. El nombre del archivo **lo genera el servidor**, porque el que trae
quien sube puede llevar `../`.

**D59 · Un archivo que otra fila sigue nombrando no se borra.**

Una versión nueva copia la galería con **la misma ruta**, sin volver a subir los
bytes. Borrar el objeto al quitar una de esas filas dejaría a la otra apuntando
al vacío, y la versión publicada perdería su fotografía.

**D60 · Cuántas fotografías caben lo dice la referencia visual, no el
blueprint.**

El blueprint no fija el número. La captura 6 enseña una galería «1/5», así que
cinco es lo que la referencia sostiene. Se cuenta **en el servidor**, porque un
CHECK no cuenta filas y un disparador que lo hiciera bloquearía la tabla en cada
inserción para defender un número que la empresa todavía puede cambiar.

**D61 · La unidad de almacén es el SKU, no la fila de la variante.**

Una variante cuelga de una **versión inmutable**: publicar la siguiente crea
filas de variante nuevas, con identificadores nuevos, para las mismas cajas del
mismo almacén. Si el inventario colgara de esas filas, cada publicación lo
dejaría huérfano y el producto aparecería agotado sin que nadie hubiera vendido
nada. Y guardar el número en la variante tiene el problema contrario: guardar el
borrador rehace esas filas.

El SKU es, literalmente, la unidad de almacén —*stock keeping unit*—, y es lo
único estable entre una versión y la siguiente. Por eso `product_inventory`
tiene clave `(product_id, sku)` y **ninguna clave ajena a `product_variants`**.

**D62 · Lo disponible se calcula; no se guarda.**

`available = on_hand - reserved`. Guardarlo además crearía dos verdades que
divergen la primera vez que alguien escriba una y olvide la otra. La 0074 no
tiene esa columna, y hay una prueba que lo comprueba. El día que la resta pese,
será una vista o un índice, no una columna.

**D63 · La concurrencia la resuelve PostgreSQL, no el proceso.**

Reservar bloquea la fila con `select ... for update` y decide con el número ya
bloqueado. **No hay ningún `asyncio.Lock`**: hay más de un proceso, y un candado
en la memoria de uno no ordena nada entre ellos. Se prueba con el orden fijado a
mano —A bloquea, B espera, A se lleva la última, B despierta y ve que no
queda— porque una prueba que lance N peticiones y mire el resultado puede
serializarse sola y pasar sin el bloqueo puesto.

**D64 · Sin inventario cargado no es «agotado».**

Un SKU sin fila no tiene cero unidades: tiene un inventario que nadie ha
cargado. Son dos cosas distintas y se contestan distinto
—`product_inventory_not_configured` frente a `product_inventory_insufficient`—
porque decir «agotado» de algo que nunca se inventarió manda a quien vende a
buscar un problema que no existe. La pantalla lo escribe con esas palabras y no
pinta un cero.

**D65 · El historial de inventario solo se añade.**

Un disparador de la 0074 rechaza `update` y `delete` sobre
`inventory_movements`. Una rectificación es un movimiento nuevo con su motivo,
nunca una edición del anterior: si una fila se puede editar, «cuántas había el
martes» deja de tener respuesta. Es lo que el blueprint §14.1 exige para los
registros financieros, aplicado aquí.

El **ajuste** es el único movimiento que exige motivo, porque es el único que
cambia el número sin que haya ocurrido nada fuera del sistema.

**D66 · El carrito no reserva existencias.**

Tener algo en la bolsa no se lo quita a nadie: una reserva sin caducidad
convertiría un carrito olvidado en un producto agotado. Reservar es del
checkout. `carts.py` **lee** el inventario y no lo mueve nunca, y hay una prueba
que cuenta los movimientos para demostrarlo.

`reservar`, `liberar` y `despachar` existen, funcionan y están probadas, pero
**no las llama ninguna ruta**: son del Incremento 5.

> *Al 21/09/2026:* la decisión sigue en pie —el carrito no reserva— pero esa
> última frase ya no. El Incremento 5 llegó: el pedido llama a `reservar` al
> crearse y a `liberar` al cancelarse o al vencer. `despachar` es lo único que
> sigue sin llamar nadie, y es del Incremento 6.

**D67 · El precio de la línea del carrito no es el precio.**

`seen_price_minor` es lo que se veía al añadir y existe para **avisar** de que
cambió. El total lo calcula el servidor con el precio de ahora, porque congelar
el precio ocurre al crear el pedido: congelarlo en la bolsa haría que un carrito
de hace tres semanas pagara un importe que ya no existe. Y un precio que subió
**sigue siendo comprable**: lo que hay que hacer es decirlo, no bloquear la
línea.

**D68 · Un carrito vacío no enseña «0.00».**

`subtotal_minor` viaja nulo cuando no hay ninguna línea comprable. Un cero con
moneda se lee como una compra de cero soles.

**D69 · Monedas incompatibles no se suman.**

El carrito guarda la moneda de su primera línea y rechaza una en otra distinta.
Al vaciarse, la olvida: dejarla puesta impediría meter algo en otra moneda en
una bolsa que ya no tiene nada, y el error diría que hay algo dentro que no hay.

**D70 · La bolsa y los guardados son dos contadores distintos.**

La bolsa cuenta **unidades del carrito**; guardados cuenta **productos
marcados**. Juntarlos haría que el número del encabezado no quisiera decir nada
concreto. Guardar sigue siendo un marcador: no tiene cantidad, no tiene variante
y no lleva a pagar.

**D71 · Sigue sin haber ninguna ruta de compra.**

No hay checkout, ni pedido, ni pago, ni dirección, ni transportista.
`purchasable` viaja siempre en `false` y lo escribe el molde de la respuesta, no
un campo copiado: encender la compra tiene que pasar por ese fichero.
`feature_product_sales` sigue apagada y sin código detrás. La pantalla del
carrito **no tiene botón de pagar**, y lo dice con palabras en el pie.

> *Superada por el Incremento 5 (17/09/2026), salvo en dos cosas que siguen
> siendo verdad.* Ya hay checkout, pedido, dirección y condiciones, y
> `feature_product_sales` **sí tiene código detrás**: apagada, el checkout
> contesta 503 con la lista de lo que falta. Lo que se mantiene: `purchasable`
> de la **ficha** sigue viajando en `false` —comprar se hace desde la bolsa, no
> desde la ficha— y **no hay transportista**, que es del Incremento 6. Y el
> botón de la bolsa dice «continuar», no «pagar», y solo aparece cuando el
> servidor dice que se puede.

## 14. Productos, Incremento 5 — pedido y compra protegida (17/09/2026)

**D72 · Sin política aprobada para la jurisdicción, no se vende.**

Lo dice el blueprint —«Si `withdrawalDays` es null, la venta se bloquea en esa
jurisdicción hasta aprobación legal»— y la 0077 lo convierte en una regla de la
base: el CHECK `product_policies_publicada_esta_completa` impide que exista una
política publicada sin plazo de desistimiento, sin plazo de incidencias, sin
plazo de devolución y sin decir quién paga cada porte. No es una comprobación
del servidor que alguien pueda saltarse: es la tabla.

**D73 · La política se versiona por país, y el pedido congela cuál aceptó.**

Guarda identificador, versión y **huella del texto**. Publicar la versión
siguiente no le cambia las reglas a quien ya compró. Y aceptar un texto que
dejó de regir entre que se leyó y se pulsó comprar no vale como aceptación: el
servidor lo nota y para con `product_policy_changed`.

La huella se calcula sobre el texto **normalizado**: CRLF y LF son el mismo
párrafo, y sin normalizar, pegar el texto desde otro editor cambiaría la huella
sin cambiar una palabra y todos los pedidos anteriores parecerían citar algo
distinto.

**D74 · La duración de la reserva no tiene número de fábrica.**

`PRODUCT_RESERVATION_MINUTES` nace en **0**, y cero significa «sin configurar».
Cuánto tiempo se le guarda a alguien la última unidad mientras paga afecta a
cuántas ventas se pierden y a cuánto stock queda congelado: escribir «15» aquí
sería tomar esa decisión en nombre de la empresa, en silencio y para siempre.
Sin ella no se vende, y la pantalla lo dice.

**D75 · Encender una bandera nunca basta.**

Cinco condiciones a la vez: `feature_product_sales`, `payments_enabled`,
`stripe_payments_enabled`, la duración de la reserva y una clave de Stripe. Más
una política publicada y vigente. Viven juntas en
`venta_de_productos_habilitada` y en `por_que_no_se_puede_vender`, que devuelve
**todas** las que faltan y no la primera: una a una, quien configura enciende
una, prueba, vuelve a fallar y no sabe cuántas quedan.

**D76 · Un pedido, un proveedor.**

El blueprint no define checkout conjunto de varios proveedores, y repartir un
cobro entre varios sin que nadie lo haya decidido es inventarse la liquidación.
Si el carrito mezcla, el servidor **pide elegir**. Es la decisión segura y
explícita que pedía el encargo; cambiarla es una decisión de la empresa.

**D77 · La reserva empieza con el pedido, no con el carrito.**

Tener algo en la bolsa no se lo quita a nadie. La reserva nace al confirmar el
pedido, aparta con `select ... for update` en **orden estable por (producto,
SKU)** y es **todo o nada**: si falta una unidad no se reserva ninguna.

**D78 · Liberar ocurre exactamente una vez, y en dos capas.**

Arriba, `reservation_settled_at` bajo el cerrojo de la fila del pedido: quien
llega segundo ve que ya se decidió. Abajo, la clave de idempotencia del
movimiento de inventario, que es un índice único de la base y aguanta aunque dos
procesos se colaran a la vez por la primera capa. Una sola capa no bastaría: la
de arriba no protege entre réplicas y la de abajo no sabe cambiar el estado.

**D79 · Pagar consume la reserva; no la suelta ni la despacha.**

Las unidades quedan comprometidas hasta que salgan del almacén, que es del
Incremento 6. El pedido deja de estar sujeto al vencimiento. Despachar ahora
diría que algo salió cuando sigue en la caja.

**D80 · Un cobro fallido no suelta la reserva.**

La tarjeta puede reintentarse mientras la reserva siga viva, y soltar al primer
rechazo le quitaría a quien lo intenta la última unidad que estaba a punto de
pagar. Si no vuelve a intentarlo, el vencimiento la suelta sola.

**D81 · El pago que llega tarde no se cobra en silencio ni se niega en silencio.**

Si el aviso verificado llega cuando la reserva ya venció, el pedido pasa a
`UNDER_REVIEW` con su motivo y lo resuelve una persona. Inventarse unidades para
no dar una mala noticia es prometer un producto que otra persona ya compró; y
darlo por bueno sin entregarlo es quedarse el dinero.

**D82 · El vencimiento no es un temporizador dentro de la aplicación.**

La API puede correr con varias réplicas, y un temporizador por réplica es el
mismo barrido ejecutándose tantas veces como procesos haya. Hay una ruta
administrativa idempotente preparada para un planificador externo.

**D83 · Una devolución se anota y no deshace nada.**

Devolver el importe y deshacer la venta son dos decisiones distintas, y la
segunda no existe: devolución, reembolso y garantía son de los Incrementos 8 y
9, y ninguna política los ha fijado. Soltar el inventario por iniciativa propia
sería inventarse la política.

**D84 · Impuestos y envío no se enseñan como cero.**

No están decididos: no hay entidad fiscal, ni transportista, ni tarifas. «Envío:
0,00» es una promesa de envío gratuito que nadie ha hecho y «Impuestos: 0,00»
es una afirmación fiscal. El checkout lo dice con palabras.

**D85 · No se dice «compra protegida» sin plazo de incidencias.**

Sin él no hay ninguna protección que ofrecer, y decirlo igualmente es lo que
hace que alguien compre creyendo que tiene un recurso que no tiene.

**D86 · La vuelta del navegador no confirma dinero.**

Solo un aviso verificado de la pasarela marca un pedido como pagado. La
pantalla de retorno pregunta el estado al servidor; el parámetro de la URL solo
elige las palabras del aviso, porque un parámetro lo escribe cualquiera.

**D87 · La dirección no guarda ubicación exacta.**

Ni latitud, ni longitud, ni documento de identidad. Para entregar un paquete
basta la dirección escrita; guardar lo que no hace falta es guardar lo que se
puede filtrar. Y el distrito es obligatorio donde la dirección no se entiende
sin él —Perú— y no donde ese nivel no existe, porque exigirlo obligaría a
inventárselo.

**D88 · El proveedor ve sus pedidos pagados y nada más.**

Ni el cobro, ni quién compró, ni las direcciones de otros proveedores. Lo que
hace falta para preparar un paquete es qué mandar y a dónde.

**D89 · Ni el historial ni la auditoría guardan datos personales.**

El historial de estados se lee para auditar un estado, no para recomponer a
quién se le mandó qué. La auditoría del almacén guarda SKU y cantidades.

**D90 · No hay un segundo cliente de Stripe.**

Se reutiliza el adaptador compartido, su verificación de firma, su tolerancia de
reloj y `payment_events` como barrera anti-repetición. Duplicarlo sería duplicar
también el sitio donde se olvida arreglar un fallo. El reparto es por
`metadata.dominio = 'producto'` y, cuando el aviso no la trae —un `refund.*` o
un `charge.dispute.*` llevan metadata propia, vacía—, preguntando a nuestra
propia tabla por la referencia del cobro.

**D91 · Ningún administrador puede escribir «pagado».**

Lo impide el CHECK `product_orders_pagada_con_cobro`: sin fecha de pago, sin
referencia externa y sin pasarela, esa fila no existe. Y las líneas de un pedido
no se pueden editar: lo impone un disparador, porque un importe que se puede
cambiar después de cobrarlo no es un importe.
