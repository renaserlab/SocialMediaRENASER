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

> *Al 21/09/2026:* el Incremento 6 llegó y la decisión sigue entera. Lo que
> saca las unidades es el salto `READY → DISPATCHED` del envío, y nada más;
> ver D94.

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

## 15. Productos, Incremento 6 — preparación, despacho y entrega (21/09/2026)

**D92 · El envío tiene su propia máquina de estados, y `product_orders.status`
no gana ni un valor.**

Un pedido tiene cinco cosas que cambian por su cuenta —pedido, pago, envío,
incidencia y dinero—. Juntarlas en un enum obliga a inventar valores como
`PAID_PREPARING_WITH_INCIDENT`: el número crece multiplicando en vez de sumando,
y al escribir uno se pierde el otro. Un pedido que pasa a «despachado» no deja
de estar pagado. Lo vigilan la verificación de la 0079 y una prueba.

**D93 · La fila del envío nace con la primera acción, no al cobrar.**

Un pedido pagado sin fila se lee como «pendiente de preparación», que es
exactamente lo que es. Crearla en el webhook metería una escritura más en el
camino del cobro para no ganar nada, y `exists: false` distingue «nadie lo ha
tocado» de «falta algo».

**D94 · La reserva se consume al salir del almacén, no al cobrar.**

Al cobrar, las unidades siguen en la caja. El único salto que las saca es
`READY → DISPATCHED`, y baja las dos cuentas. Sacarlas al cobrar dejaría el
inventario mintiendo durante todo el tiempo que tarde en prepararse el paquete.

**D95 · Tres capas impiden el doble despacho, y cada una para en un sitio.**

Arriba el estado bajo el cerrojo de la fila, que hace que un reintento sea un
éxito tranquilo y no un error. En medio la clave de idempotencia del movimiento,
que es la que para cuando el mismo SKU tiene unidades apartadas por **otro**
pedido: ahí las cuentas cuadran solas y sin la clave saldrían cuatro donde se
vendieron dos. Abajo la aritmética del inventario. Se comprobaron quitándolas de
una en una.

`dispatch_settled_at` **no es ninguna de las tres**: es la marca que sostiene el
CHECK de la base. Quitarla no puso roja ninguna prueba, y eso enseñó que el
comentario que decía «dos capas» estaba mal.

**D96 · Un paquete sale entero o no sale, y se comprueba en el paso.**

Cerrarlo a medias obliga a decidir qué pasa con lo que se quedó fuera —segundo
envío, devolución parcial, quién paga el porte— y ninguna política lo dice. La
comprobación vive en `mover` y no en la función de cerrar: estaba ahí y la
revisión independiente encontró que se podía rodear por la ruta de
administración. *Una invariante comprobada en la puerta y no en el paso se rodea
el día que alguien añade una puerta nueva.*

**D97 · Despachar es solo del proveedor.**

Es el único que puede afirmar que la caja salió de su almacén. Administración no
puede, ni con motivo.

**D98 · Administración no fabrica una entrega.**

No tiene cómo saber que algo llegó, y escribirlo arrancaría plazos de posventa
que nadie ha cumplido. Puede registrar que la entrega **falló** —eso se lo
cuenta el transportista— y reabrir un paquete que no ha salido.

**D99 · Moderación no interviene un envío.**

Un envío mueve inventario, y mover inventario no es moderar: la puerta es
`FINANCE_ROLES`, la misma que ya guarda el ajuste de existencias. Leer la cola
de envíos sin cerrar sí, porque no lleva ningún dato personal.

**D100 · Confirmar que llegó NO es dar la conformidad.**

Confirmar que llegó es un hecho de logística; dar la conformidad es decir que el
producto está bien, y en el blueprint eso **libera el dinero** al proveedor. Lo
segundo no existe. La pantalla lo dice con palabras bajo el botón, para que
nadie confirme creyendo que renuncia a algo o que ha pagado a alguien.

**D101 · Se guarda quién afirma la entrega.**

`seller` o `buyer`, nunca administración. El blueprint contempla que el
transportista marque la entrega y quien compró la niegue, y esa discusión —del
Incremento 7— no se puede tener sin saber quién lo dijo.

**D102 · El motivo de una entrega fallida no sale del pedido.**

Es texto libre que escribe quien vende, y lo primero que escribe cualquiera es
dónde fue y a quién buscaba. Viaja **solo** en `product_shipment_events`, que es
de ese pedido y lo leen quien compró y quien vende. Ni a la cola de
administración —que la lee curaduría— ni a `audit_events`, que la leen otros
módulos y otras personas: ahí queda anotado que **hubo** un motivo, sin decir
cuál. Lo encontró la revisión independiente en los dos sitios.

**D103 · Cancelar un pedido ya pagado no se puede, y se dice qué falta.**

El salto está declarado en la máquina y la liberación del inventario escrita con
su marca y su clave; el servicio lo para con su propio código y la lista de las
tres decisiones que faltan. Devolver el dinero no lo decide el código.

**D104 · No hay transportista, ni fecha de llegada, ni enlace de seguimiento.**

El nombre del transportista y la referencia son texto libre **opcional**, y
cuando no se escriben quedan nulos: nulo es «no lo dijeron», nunca «N/A». No hay
fecha prevista —exige plazos que nadie fijó— ni enlace de seguimiento
—construirlo exige saber el transportista, y uno inventado sería un enlace roto
dentro de un pedido pagado—.

**D105 · Nada se marca como «atrasado».**

Ninguna política publicada fija un plazo de despacho, así que no hay contra qué
comparar: llamarle tarde a algo sin plazo es inventarse el plazo, y quien lo lea
actuaría sobre un incumplimiento que nadie definió. Se da el **tiempo
transcurrido**, que es un hecho, y quien mira decide.

**D106 · Una entrega fallida no repone nada.**

Dónde está esa unidad y qué se hace con ella es inspección de posventa, no un
automatismo. Reponerla la pondría a la venta estando dentro de un camión.

**D107 · La ruta de intervención de administración no tiene pantalla, a
propósito.**

Lo único que permite también lo hace quien vende desde la suya, y cuándo escala
una cosa a la otra es una decisión operativa que nadie ha tomado. Un método de
cliente sin pantalla detrás es código muerto que parece una función.

**D108 · Un segundo intento de entrega fallido no vuelve a avisar.**

La barrera anti-repetición deduplica por `(persona, tipo, pedido)`. Aflojarla
haría que un webhook reintentado avisara dos veces del mismo hecho y rompería el
enlace del aviso al pedido. Entre callar una repetición y gritar dos veces lo
mismo, se calla. Es una limitación conocida, no un olvido.
## 16. Productos, Incremento 7 — reclamaciones posventa (21/09/2026)

**D109 · La incidencia tiene su propia máquina, y ni el pedido ni el envío ganan
un valor.**

Es la misma regla de [D92] una tabla más abajo, y aquí importa más: un caso vivo
tiene que poder bloquear acciones del envío sin que escribir el estado del caso
pueda perder el del paquete. El bloque de verificación de la 0080 falla si algún
estado de incidencia aparece en los CHECK de `product_orders` o
`product_shipments`.

**D110 · Abrir no es aprobar, y resolver no es pagar.**

Son dos frases distintas y las dos están escritas en las pantallas, no solo en
los comentarios. Abrir un caso solo anota que alguien dice que algo llegó mal.
Resolverlo dice **qué se decidió**, y deja `financial_effect` en `PENDING`:
nadie lo ejecuta. No hay ninguna línea que llame a un adaptador de reembolsos,
porque ese adaptador es del Incremento 9 y no existe. Una prueba comprueba que
ninguna de las seis pantallas escriba un importe, y otra que el molde del
servidor tampoco lo traiga: si alguien lo añade, se pone roja y hace falta una
decisión, en vez de que el número aparezca solo.

**D111 · Este módulo no importa `inventory`, y se ejecuta.**

Dónde está una unidad dañada lo decide una persona. Reponerla al resolver la
pondría a la venta estando en casa de alguien, y descontarla al abrir el caso
castigaría a quien todavía no ha hecho nada mal. Una prueba recorre el árbol de
sintaxis de `incidencias.py` y falla si aparece el import; otra lo comprueba
desde el lado del móvil.

**D112 · El proveedor propone; resolver es solo de Z, y de `admin`, no de
`is_admin`.**

Las cinco salidas del blueprint §10.1 mueven dinero, mueven mercancía o niegan
la reclamación, y ninguna de las tres la decide en solitario quien tiene el
conflicto. No hay ninguna ruta de proveedor que escriba `resolution` —hay una
prueba que recorre las rutas y comprueba que ninguna termine en `/resolve`— ni
ningún método en su repositorio del móvil. Y quien resuelve es `FINANCE_ROLES`,
el mismo conjunto estrecho que ya ajusta existencias: moderación cura contenido
y recibe 403, comprobado por HTTP.

**D113 · Pedir más pruebas no es una resolución: es un paso.**

Un expediente al que se le piden más pruebas no está resuelto, y contarlo como
resuelto daría un número falso de casos cerrados. `REQUEST_MORE_EVIDENCE` está
en lo que el proveedor puede **proponer** y fuera de `RESOLUCIONES`; el servidor
lo rechaza con su propio código si alguien lo manda como decisión.

**D114 · El caso nace sin pruebas y sin plazo corriendo.**

El blueprint pide 2–6 fotografías. Exigirlas al abrir obligaría a subirlas antes
de que exista el caso del que cuelgan. Así que se abre, se le añaden y **se
envía**: ahí se comprueba el mínimo y ahí empiezan a correr las 48 horas del
proveedor, que el blueprint cuenta «desde la notificación».

**D115 · La entrega negada no puede pedir fotografías ni línea del pedido.**

A quien dice que no le llegó nada no se le puede pedir la foto de lo que no
tiene: exigírselas cerraría el único caso que solo él puede abrir. Y habla del
pedido entero, no de un artículo, porque no hay una línea concreta de la que
quejarse. Lo impone también un CHECK de la base.

**D116 · El reloj del proveedor corre solo mientras la pelota es suya.**

Si pidió más pruebas, `seller_response_due_at` viaja nulo. Eso **no** es «sin
plazo» ni «vencido»: es «ahora no le toca a él». Cobrarle el tiempo que pasa
esperando lo que él mismo pidió sería cobrarle el tiempo de la otra parte. El
móvil lo pinta como un hecho —lo que queda, o que pasó— y **nunca** como un
incumplimiento: lo que ocurre pasado el plazo es que el caso va a revisión.

**D117 · El silencio no cierra nada: escala a mediación.**

Un caso que el proveedor deja sin responder pasa a revisión de Z, no a
rechazado. Cerrarlo en contra de quien reclama por el silencio de la otra parte
sería castigarle por algo que no hizo.

**D118 · La escalada por silencio no es un temporizador dentro de FastAPI.**

La API puede correr con varias réplicas y un temporizador se ejecutaría una vez
por cada una. Hay una ruta de administración **idempotente** —llamarla dos veces
seguidas devuelve cero la segunda—, igual que el vencimiento de reservas, y
hasta que exista un planificador externo se lanza desde la pantalla de
administración. Queda pendiente para una persona: ver §5.

**D119 · No hay fecha límite para la decisión de Z, y se dice por qué.**

El blueprint habla de «tres días hábiles». «Hábil» depende de un calendario de
festivos y de jornada que nadie ha definido, y calcularlo a ojo sería inventarse
el plazo. El caso se enseña «en revisión» y la pantalla explica que no damos
fecha. Ninguna columna `decision_due_at` existe, y el bloque de verificación de
la 0080 la rechaza si alguien la añade.

**D120 · Una sola apelación, en plazo y con pruebas NUEVAS.**

«Nueva» es posterior a la resolución, comprobado contra la fecha. Sin esa
condición, apelar sería repetir la misma frase más alto. El móvil tampoco ofrece
el botón cuando `appeals_used` ya es 1, aunque el servidor lo ofreciera: es
defensa en profundidad, no una decisión del cliente.

**D121 · El plazo para reclamar es el de la política congelada en el pedido.**

`incident_report_hours` es obligatorio en toda política publicada —lo impone
`product_policies_publicada_esta_completa`, de la 0077—, y el pedido apunta a su
versión exacta. Se cuenta desde la entrega, o desde que se supo que el paquete
no iba a llegar, que son los dos únicos momentos en que quien compró puede saber
que tiene algo que reclamar. **No es un plazo inventado: es el que la empresa
publicó.** Se lee la política del pedido y no la vigente hoy: acortársela
después con una política nueva le quitaría un derecho que ya tenía.

Y si la fila no trae horas —solo una **sin publicar** puede—, no se cierra la
puerta: negar el derecho a reclamar por un dato que falta sería inventarse el
plazo al revés.

**D122 · Un caso vivo bloquea confirmar la recepción.**

Quien dice que no le llegó el paquete no puede a la vez confirmar que lo
recibió. Lo comprueba el envío antes de escribir la entrega, con su propio
código.

**D123 · Ni el historial ni las pruebas se pueden reescribir, y lo imponen
disparadores.**

Aquí pesa más que en ningún otro sitio, porque esto es lo que se mira cuando dos
personas cuentan lo mismo de dos maneras. **Ni siquiera quien subió una
fotografía puede quitarla después**: retirarla cuando la otra parte ya la vio es
reescribir lo que se discutió. Por eso no hay método `borrarPrueba()` en el
móvil y por eso el disparador cubre `update` y `delete`.

**D124 · Un solo caso vivo por línea y por pedido, con dos índices únicos
parciales.**

En PostgreSQL los nulos no chocan entre sí, así que un único índice sobre
`(order_id, order_item_id)` no habría impedido dos entregas negadas sobre el
mismo pedido. Son dos índices: uno para las líneas y otro para los casos sin
línea. Lo impone la base y no un `if` nuestro: dos toques a la vez se pasarían
por delante de cualquier comprobación previa.

**D125 · El texto libre no sale del expediente.**

La descripción la escribe quien reclama y suele llevar dentro dónde vive y qué
le pasó. Viaja en el expediente —que leen las tres personas que ya conocen el
caso— y **no** en ninguna lista: ni en la del comprador, ni en la del proveedor,
ni en la cola de Z. Es la misma corrección que la revisión independiente del
Incremento 6 encontró en el motivo de una entrega fallida, aplicada antes de que
volviera a pasar.

**D126 · Las pruebas viven en su propio depósito privado.**

`product-incidents`, separado de `product-media`: aquel se firma para cualquiera
que mire un producto, y esto son las fotos del salón de quien compró. Lista de
tipos cerrada, sin `image/*` —que dejaría pasar SVG, que es un documento con
scripts—, el servidor decide el nombre y mira los bytes de verdad, y las URL se
firman al pintar y no se guardan.

**D127 · Deshacer la 0080 no borra las pruebas.**

El rollback documentado falla a propósito si el depósito tiene archivos dentro:
son las pruebas de una disputa y no se tiran sin que alguien lo decida.
### Lo que cambió la revisión independiente del Incremento 7

Siete defectos reales, todos reproducidos con una prueba que se puso roja antes
de tocar el código. No se aceptó ninguno sin ejecutarlo.

**D128 · Un caso no sale de `OPEN` sin sus fotografías, y la puerta está en
`mover`.**  ·  *era ALTO*

El mínimo de 2–6 del blueprint vivía **solo** dentro de `enviar`, así que se
esquivaba entero pidiendo mediación: la pantalla pintaba deshabilitado el botón
de enviar y **habilitado** el de «que lo mire Z», porque el servidor ofrecía ese
salto desde `OPEN`. Quien no quisiera subir fotos tenía un botón activo para
saltárselas, y la persona de Z acababa decidiendo sobre un expediente vacío.
Había un segundo camino por el mismo agujero: el proveedor pidiendo más
evidencia sobre un caso sin fotos le arrancaba su propio plazo.

La comprobación está ahora en `mover`, que es la única puerta —repartirla entre
las rutas es como se vuelve a abrir el día que alguien añade un camino—. Se
exceptúa **retirar**: obligar a documentar una reclamación que ya no se quiere
hacer no protege a nadie. Y la entrega negada sigue exigiendo cero, porque lo
que se cuenta es `fotos_exigidas(motivo)` y no un dos fijo.

**D129 · El proveedor no ve un borrador que todavía no le han enviado.**  ·
*era MEDIO*

Un caso recién abierto aparecía en su lista **con la descripción entera dentro**,
y podía además sacarlo de `OPEN` antes de que existiera de verdad. [D125] dice
que ese texto no sale del expediente y §13.5 dice que el proveedor se entera al
enviarse el caso; lo leía desde que se abría.

Se deduce, y se puede deducir: `enviar` es lo único que pone el plazo, y desde
[D128] un caso no sale de `OPEN` sin sus fotografías. Así que con plazo puesto
se envió, y cualquier estado que no sea `OPEN` ni `WITHDRAWN` solo se alcanza
pasando esa puerta. **404 y no 403**, por lo de siempre.

**D130 · Apelar comprueba que hay sitio antes de escribir, y no se lo deja al
índice.**  ·  *era MEDIO*

`RESOLVED` no está entre los estados vivos, así que sobre una línea con un caso
resuelto se puede abrir otro —y eso es correcto—. Pero `APPEALED` **sí** lo
está: apelar el resuelto metía una segunda fila viva en la misma clave del
índice único parcial y salía un `IntegrityError` sin envolver, es decir un 500
sin texto en el móvil, que además **gastaba la única apelación** de quien
reclama por un choque que no era suyo.

Se pregunta antes de escribir. No se envolvió el `flush` en un punto de guardado
porque un fallo de `flush` deja la sesión entera inservible aunque el savepoint
se deshaga, y con ella se perdería el renglón del historial. El índice sigue de
último recurso.

**D131 · No se anuncia un salto que el servidor va a rechazar siempre.**  ·
*era MEDIO*  ·  **y deja una decisión pendiente**

Dos reglas del blueprint chocan en el borde: el tope de **seis** fotografías y
la exigencia de evidencia **posterior a la resolución** para apelar. Quien aportó
las seis que el blueprint permite antes de que se resolviera su caso no puede
subir una séptima ni puede apelar sin ella. Y el servidor seguía ofreciendo
`APPEALED` en `available_transitions`, que promete justamente que lo que sale
ahí se puede pulsar.

**Si el tope de seis cuenta el expediente entero o solo la reclamación inicial
es una decisión que nadie ha tomado, y no se inventa aquí.** Lo que sí se
arregla sin inventar nada es la mentira: en ese caso concreto el salto deja de
anunciarse. Con sitio para otra prueba se sigue ofreciendo, y hay una prueba de
cada lado para que la corrección no apague la apelación de todo el mundo.

**D132 · La explicación que la pantalla exige escribir llega al expediente.**  ·
*era MEDIO*

Ni `/escalate` ni `/reply` declaraban cuerpo, así que FastAPI **descartaba** el
`note` que el móvil sí obligaba a rellenar —bloquea el botón por debajo de tres
caracteres— y el renglón del historial quedaba con la nota en nulo. Quien lo
escribía creía que lo había mandado. El motivo por el que quien compró rechaza
la propuesta del proveedor es precisamente lo primero que lee quien media.

**D133 · Pasar a mediación se avisa, y a las dos partes.**  ·  *era MEDIO*

`product_incident_mediation` tenía sus textos en los tres idiomas y era **código
muerto**: ni el barrido ni la ruta avisaban. El escalado por silencio es el
único paso que ocurre **sin que nadie lo pida**, y era justo el que no se
comunicaba: quien reclama no sabía que su caso había cambiado de manos y el
proveedor no sabía que había perdido el turno.

Sigue en pie «a quien no lo hizo»: cuando lo pide quien compra, el aviso es solo
para el proveedor.

**D134 · Tres arreglos pequeños del mismo repaso.**  ·  *eran BAJO*

* **La fila del envío se bloquea antes de preguntar si hay un caso vivo.**
  Preguntar antes dejaba una ventana en la que confirmar la recepción y abrir un
  «no me llegó» pasaban las dos comprobaciones, y el pedido acababa con
  `buyer_confirmed_at` **y** un caso vivo encima: justo la contradicción que ese
  bloque existe para impedir.
* **El tope de seis fotografías se cuenta con la fila del caso bloqueada.** Era
  un preconteo sin cerrojo: dos subidas a la vez veían cinco y metían siete. La
  huella única solo impide repetir el **mismo** archivo.
* **`_dentro_del_plazo` compara por `pedidos.comparable`**, como el resto del
  módulo. Era la única comparación de fechas que no lo hacía, y es el sitio
  donde una fecha ingenua cerraría el derecho a reclamar de alguien.

**D135 · Y una prueba que no podía fallar.**

Una barra sola dentro de una plantilla de JavaScript —`` `\bpalabra` ``— **no**
es el límite de palabra de las expresiones regulares: `\b` ahí es el carácter
de retroceso,
U+0008, y el patrón no coincide con nada. Dos centinelas del móvil —el que
vigila que ninguna pantalla diga «incumplió» y el que vigila que «Mis productos»
no hable de reclamaciones— eran ciertos siempre. Corregidos, y cada uno probado
con una mutación que ahora sí los pone rojos.

Es la misma clase de defecto que costó una prueba tautológica en el Incremento
6. También salió de aquí una tercera: al esconder los borradores al proveedor,
la prueba de «la lista no lleva la descripción» pasó a comprobarlo sobre una
lista **vacía**, que es cierto sin demostrar nada; ahora envía el caso primero.
## 17. Cierre del Incremento 6: la 0079 verificada y lo que la revision encontro (21/09/2026)

La 0079 y la 0080 **ya estan aplicadas** en la base gestionada. Esta seccion
recoge la verificacion de la primera y los ocho defectos que salieron al
auditar el incremento contra el esquema real.

**D136 · La 0079 esta aplicada y coincide con el ORM, verificado en solo
lectura DEMOSTRADA.**

Cero divergencias: las tres tablas, 32 columnas con su nulabilidad, la clave
primaria en `order_id` —una sola fila de envio por pedido—, 19 CHECK con los
seis semanticos que exige el incremento, los dos indices parciales, el
disparador que congela el historial cubriendo `update` **y** `delete`, RLS
activa en las tres, cero politicas, y `anon` y `authenticated` sin un solo
permiso ni de tabla ni de columna. Solo `postgres` y `service_role` conservan
acceso. `product_orders.status` no admite ningun estado logistico.

Y esta vez **el guardia se demostro**, corrigiendo el fallo que la propia
verificacion de las 0051/0052 dejo anotado: alli se paso por `connect_args` y
nunca llego a aplicarse. Aqui se puso con una sentencia explicita, se comprobo
con `show`, y se lanzo una escritura de prueba —`update ... where false`,
inofensiva aunque el guardia fallara— que fue rechazada con
`ReadOnlySqlTransaction`.

**LO QUE ESTA VERIFICACION NO DEMUESTRA:** las tres tablas tienen **cero
filas**, asi que las comprobaciones de huerfanos e incoherencias son ciertas
por vacio. No dicen nada sobre la integridad de datos reales; dicen que no hay
nada roto porque no hay nada. La venta sigue apagada.

**D137 · La 0080 no altero nada de la 0079.** Ninguna clave ajena de las tablas
de incidencias apunta a las de envios, y las 32 columnas siguen intactas. La
bateria completa pasa con las ochenta migraciones aplicadas desde cero.

**D138 · `available_transitions` promete «esto el servidor te lo va a aceptar»,
y ahora lo cumple en los dos sentidos.**

Tres defectos de la misma familia, y los tres importan porque el movil pinta
exactamente lo que esa lista dice:

* **Faltaba lo que el servidor SI acepta.** Confirmar que llego no es un salto
  —`DELIVERED -> DELIVERED` no existe y no se inventa—, asi que en cuanto quien
  vende registraba la entrega, la lista venia vacia y el boton de «Confirmo que
  lo recibi» no aparecia nunca. `registrar_entrega` tiene un camino explicito
  para esa confirmacion. En el camino normal, `buyer_confirmed_at` era
  inalcanzable desde la aplicacion.
* **Sobraba lo que el servidor rechaza siempre.** A administracion se le
  anunciaba `CANCELLED` desde los tres estados de antes de salir, y `cancelar`
  se para siempre. Ahora lo dice una constante, `HAY_POLITICA_DE_CANCELACION`,
  que leen el servicio y el serializador.
* **Y la pantalla tampoco lo consultaba.** El boton de registrar la entrega
  miraba el estado en vez de la lista, asi que desde una entrega fallida no
  aparecia aunque el servidor la acepta —el caso de quien la lleva en mano al
  dia siguiente—. Quien vende tenia que inventarse un reintento para poder
  marcarla: dos renglones falsos en un historial inmutable.

**D139 · Dos nombres del Incremento 6 pisaban a otros, y uno rompia una ruta de
moderacion.**

`MotivoRequest` se definio por segunda vez al final de `schemas.py`, donde ya
existia. Python rebindea el nombre sin avisar, asi que
`/admin/products/{id}/suspend` —que lee `cuerpo.motivo`— paso a exigir `reason`:
el movil recibia 422 y quien mandara `reason` provocaba un 500. **Retirar del
catalogo un producto reportado no funcionaba por ninguna via**, y no lo veia
nadie porque ninguna prueba tocaba esa ruta por HTTP.

Buscando la causa aparecio el segundo: `_del_proveedor` tambien estaba dos veces
en `router.py`. Se renombran los dos del Incremento 6 y no los anteriores.

**El centinela nuevo comprueba la causa y no el sintoma:** ningun nombre de
nivel superior puede estar definido dos veces en `schemas.py` ni en `router.py`.

**D140 · La lista del proveedor ordena por lo que necesita atencion.**

Es la UNICA puerta a la pantalla de preparacion, trae los veinte mas recientes
por fecha —entregados incluidos— y al detalle solo se llega pulsando una
tarjeta. Un pedido que alguien deje sin preparar dejaba de existir para quien
tenia que prepararlo en cuanto entraran veinte mas nuevos: justamente el que
aparece en la cola de administracion como «lleva trescientas horas esperando»,
y esa cola es de solo lectura. Ahora lo que espera va primero y los entregados
salen detras. No se pagina ni se esconde nada, y el orden nuevo solo se aplica
si la 0079 esta puesta.

**D141 · Los codigos que despachar hereda del almacen tienen texto.**

`POST /shipment/dispatch` es lo unico de esa pantalla que llama a `inventory`,
asi que hereda codigos que no estan en `envios.py`. Las traducciones ya existian
en `inventario.ts`; la pantalla no le preguntaba, y quien vende leia el mensaje
crudo del servidor en castellano fuera cual fuera su idioma.

**D142 · La pantalla de preparar no ofrece contar la caja cuando el servidor no
lo acepta.**

Escondia los controles solo cuando el paquete YA HABIA SALIDO, asi que con el
paquete cerrado seguia pintando —activo— el boton de quitar una unidad, sobre
una llamada que devuelve 409. El camino correcto, reabrir con motivo, estaba en
la misma pantalla.

### Y dos pruebas que no demostraban lo que decian

Las dos salieron de esta misma ronda y las dos son del mismo tipo que ya costo
una en el Incremento 6 y otra en el 7:

* Dos pruebas anadidas en esta sesion contaban los movimientos de salida **sin
  filtrar por producto**, sobre una base que comparten los cuarenta y cinco
  casos del fichero. Ademas de dejar la bateria roja, el `== 0` solo habria
  pasado si fueran las primeras en despachar: «corregir la cuenta no movio el
  almacen» nunca se habia comprobado.
* La primera version de la prueba de `CANCELLED` leia por descuido las
  transiciones del **proveedor**, que nunca lo llevaron. Pasaba sin demostrar
  nada, y la mutacion que tenia que ponerla roja la dejaba verde.

### La pantalla de intervencion administrativa sigue sin existir, y es deliberado

El blueprint y el mazo de capturas **no estan en el arbol de trabajo**, asi que
no se pudo comprobar si la exigen. Lo que si consta: las tres cosas que esa ruta
permite —reabrir un paquete que no ha salido, registrar un fallo de entrega,
registrar un reintento— las hace ya quien vende desde su pantalla, y cuando
escala una cosa a la otra es una decision operativa que nadie ha tomado. Se
mantiene [D107]: no se inventa una pantalla redundante.

## Incremento 8 de Productos · las valoraciones verificadas (22/09/2026)

Trece decisiones nuevas. Cuatro de ellas **no las toma el código**: quedan
abiertas y escritas, y la que más pesa es la primera.

**D143 · PENDIENTE DE LA EMPRESA: cómo se identifica públicamente a quien
opina.**

El blueprint no lo dice. Hoy viaja **el identificador del perfil y nada más**,
que es exactamente lo que ya hacen las reseñas de evento: ningún nombre, ninguna
foto, ninguna inicial. Deducir un nombre completo a partir del perfil sería
publicarlo sin que nadie lo haya decidido, y **no se puede deshacer**: una vez
publicado junto a una opinión sobre un producto, quien opinó ya quedó
identificado. La aplicación resuelve ese identificador contra el perfil público
igual que en cualquier otra lista, así que la decisión se puede tomar después sin
migración; lo que no se puede es tomarla por descuido.

**D144 · La unidad de la valoración es la LÍNEA DE PEDIDO.**

No el producto, ni la variante, ni el pedido. Lo dice el blueprint §6 con todas
las letras —«una compra genera como máximo una reseña por línea de pedido»— y de
ahí sale la restricción única sobre `order_item_id`. Consecuencia buscada: quien
compró lo mismo dos veces, en dos pedidos, opina dos veces, porque le llegaron
dos cajas en dos momentos y pueden no parecerse.

**D145 · «Compra verificada» no es una columna: son tres claves ajenas
compuestas.**

No existe ningún booleano `verified` que alguien pueda escribir. Las cuatro
condiciones del blueprint —quien compró, pedido pagado, línea de ese pedido,
paquete entregado— las imponen tres claves ajenas de la 0081:

    (order_id, author_id, order_paid_at) -> product_orders (id, buyer_id, paid_at)
    (order_item_id, order_id, product_id)
        -> product_order_items (id, order_id, product_id)
    (order_id, delivered_at) -> product_shipments (order_id, delivered_at)

Las columnas del lado hijo son NOT NULL, así que la clave **tiene** que casar: un
pedido sin `paid_at` o un envío sin `delivered_at` no pueden emparejar con
ninguna reseña. Tres pruebas escriben el INSERT a mano, saltándose el servicio
entero, y PostgreSQL las rechaza igual.

**Y hay un efecto de vuelta que es el que más importa:** mientras exista la
reseña, esas columnas quedan CONGELADAS. Nadie puede poner `paid_at` a nulo ni
borrar la fecha de entrega de un pedido ya valorado. Una reseña es evidencia, y
la evidencia ata también lo que la respalda.

**D146 · Tres índices únicos redundantes sobre tablas que ya existían, y se paga
a propósito.**

`product_orders (id, buyer_id, paid_at)`, `product_order_items (id, order_id,
product_id)` y `product_shipments (order_id, delivered_at)`. Son redundantes de
verdad —`id` ya es clave primaria en las tres— y existen solo porque una clave
ajena compuesta exige que el lado padre sea único. Es el precio de que la
verificación viva en la base y no en un `if`, y es barato: tres índices sobre
tablas que se escriben una vez por compra.

**D147 · La puntuación general NO es la media de los cuatro ejes.**

Responde a otra pregunta —«¿entregó lo que anunció?»— y promediarlas exigiría
decidir cuánto pesa cada eje, que no lo ha decidido nadie. No hay ninguna
función, ni en el servidor ni en el móvil, que calcule `overall`, y hay una
prueba que lo comprueba sobre el código fuente.

Las cinco puntuaciones y la pregunta de si lo recomendaría son **obligatorias**,
que es lo que dice la tabla del blueprint §6. A diferencia de las reseñas de
evento, donde los ejes son opcionales.

**D148 · PENDIENTE DE LA EMPRESA: de dónde sale el promedio de categoría.**

La fórmula del blueprint §6.1 mezcla el promedio real con un promedio de
categoría, con peso diez. «Si no existe promedio de categoría, categoryAverage =
4.2», dice el propio blueprint, y eso es lo que se usa: **no se calcula uno por
nuestra cuenta**, porque elegir la fuente —las reseñas de la plataforma, una
referencia externa, un valor por categoría que escriba alguien— es la decisión
que falta y hacerlo en silencio sería tomarla.

Lo que sí se hace es **decirlo**: el resumen viaja con `category_configured:
false` y la pantalla escribe que la puntuación se ajusta con una referencia
general. Enseñar la ajustada a secas daría a entender que Z calculó algo que
todavía no calcula nadie.

**D149 · Con cero reseñas NO se publica la puntuación ajustada.**

Con `v = 0` la fórmula devuelve el promedio de categoría entero: una cifra sobre
la categoría, no sobre este producto. El servidor la manda nula, el móvil no la
rellena y la pantalla escribe que todavía no lo ha valorado nadie. Nulo tampoco
es cero en el promedio real, ni en el porcentaje que recomienda, ni en cada eje
por separado, ni en el histograma —que sale vacío en vez de cinco barras a cero—.

**Y las dos guardias viven en una función pura y probada.** Dentro de la
consulta `total` sale de un `count()` sobre un `group_by` y nunca vale cero, así
que eran código defensivo que ninguna prueba podía alcanzar; lo encontró la
batería de mutaciones. Ahora el resumen se arma en `resenas.armar()`, que se
puede llamar con cero y comprobar.

**D150 · La respuesta del proveedor nace VISIBLE, y en Eventos nace apagada.**

No es una incoherencia: en Eventos publicar la respuesta del organizador exige
una política `organizer_reply` que nadie ha aprobado, y **en Productos esa
política no existe ni hay dónde ponerla**. Inventar una puerta de configuración
que ningún documento pide sería inventar la decisión. Lo que sí se conserva de
Eventos es la protección que de verdad importa: **una sola respuesta visible por
valoración**, por índice único parcial, porque varias serían una forma de
insistirle a quien opinó. Y moderación puede esconderla.

**D151 · Una valoración oculta se sigue viendo entera, y no se edita.**

Moderar es esconder: la fila se queda con su puntuación, su texto y su autor
intactos, y quien la escribió la sigue leyendo con un aviso de que está oculta.
Borrarla la dejaría sin saber qué pasó con lo que escribió.

Pero **no se edita**: reescribirla y dejarla oculta no sirve de nada, y dejarla
visible sería saltarse la moderación escribiendo. Quien quiera que se revise otra
vez tiene que pedirlo.

**D152 · El motivo de moderación NO viaja a la auditoría compartida.**

`audit_events` la leen más personas que la cola de moderación, y un motivo puede
llevar dentro una cita de lo que escribió quien opinó. Se anota **qué** pasó
—entidad, actor y estado nuevo— y el motivo se queda en
`product_review_moderation`, que es de quien modera. Es la misma corrección que
el Incremento 7 aplicó al texto de una disputa.

**D153 · El resumen de la ficha NO exige la 0081; las otras once rutas sí.**

Es la única excepción, y es la misma que ya tenía la portada: un bloque de la
ficha no puede tumbar la ficha. Sin la migración contesta un resumen vacío —que
la pantalla lee como «todavía nadie ha valorado»— en vez de un 503 que dejaría
la ficha del producto sin poder pintarse. Las once restantes contestan **503
`product_reviews_not_available`**.

**D154 · El índice de permanencia (blueprint §7) queda FUERA del Incremento 8.**

Sus siete componentes incluyen devoluciones atribuibles al producto, reclamos
válidos y garantías atendidas: **tres de siete no existen** hasta que el
Incremento 9 ejecute devoluciones y cierre reclamaciones con efecto. Calcularlo
con cuatro de siete daría un número que parece el del blueprint y no lo es, y ese
número mueve ventas: de él dependen suspender y retirar un producto.

**D155 · PENDIENTE: valorar no avisa a nadie.**

Ni a quien vende cuando le valoran, ni a quien opinó cuando le responden. El
blueprint §9 lista notificaciones obligatorias para el dinero y los plazos, y
**ninguna para las valoraciones**. Se ve al recargar la pantalla. Añadir un aviso
es una decisión de producto —cuántos, con qué texto, y si se puede apagar— y está
escrita en el checklist de QA físico como limitación conocida.

### Lo que encontró la revisión independiente del Incremento 8

**Un bloqueante, dos altos, cuatro medios, siete centinelas vacíos y nueve
bajos.** Los diez primeros se reprodujeron antes de tocar nada; de los dos que
no se pudieron reproducir, uno se arregló igual porque el código no lo defendía
y el otro queda escrito como sospecha.

**D156 · EL BLOQUEANTE: nadie modera lo suyo, y faltaba.**

`profiles.role` incluye `moderator`, así que a un proveedor al que se le diera
rol de curaduría le bastaba la ruta de moderación para esconder todas las
valoraciones malas de su catálogo. **Reproducido:** con una valoración de una
estrella publicada, el proveedor con rol de moderación la escondía y el resumen
del producto pasaba a cero.

Lo doloroso es que la regla ya existía y estaba escrita en la cabecera de
`permissions.py` desde el Incremento 2 —«nadie evalúa ni publica su propio
producto, ni siendo administrador; se comprueba ANTES que el rol»— y se aplicaba
a evaluar y a publicar. Moderar una valoración es exactamente el mismo tipo de
acto y no se le aplicó.

Se cierra en **dos capas, cada una con su prueba y su mutación**: la ruta lo
comprueba antes del rol, y un disparador de la 0081 lo impone en la base. Un
CHECK no servía —el dueño está a dos saltos y un CHECK no cruza tablas— y un
`if` solo se esquiva desde cualquier otro sitio que escriba la fila.

**D157 · Esconder no puede ser una decisión de un solo sentido.**

La cola de moderación traía solo las visibles, y el índice era parcial a juego
con el comentario «las escondidas no vuelven a ella». La consecuencia no estaba
prevista: **una valoración escondida por error no se podía volver a encontrar**
sin haber apuntado su identificador a mano, y el botón de «volver a mostrar» de
la pantalla era código muerto, porque el estado que leía era siempre `visible`.

Hay dos colas, dos índices y un botón que cambia de lado.

**D158 · Las cuatro listas usan el mismo cursor.**

Solo la lista pública lo tenía. Las otras tres topaban en veinte sin forma de
pedir más: un proveedor con más de veinte valoraciones no podía responder las
demás, y quien moderara no podía trabajar más allá de las veinte más nuevas. El
docstring de `listar` ya explicaba por qué un desplazamiento numérico está mal, y
esas tres no tenían ni eso.

**D159 · La puntuación ajustada se enseña; las estrellas redondeadas, no.**

El blueprint manda enseñar la ajustada y se enseña. Lo que añadía la primera
versión era **dibujar estrellas redondeándola**, y con pocas valoraciones eso
miente a lo grande: una sola de UNA estrella daba 3,9 y encendía **cuatro**,
porque el 91 % de esa cifra es la referencia general de la que habla [D148].

Fuera las estrellas del resumen —la captura pide un número y un recuento— y
dentro la **puntuación real al lado**. Las estrellas de cada persona siguen en su
valoración, donde son suyas.

**D160 · Tres funciones leen la fila con candado.**

`editar`, `moderar` y `moderar_respuesta`. Sin él se reprodujeron dos carreras:
editar mientras se modera —el moderador escondía un texto distinto del que
juzgó— y dos moderaciones a la vez, que dejaban dos filas en un historial que un
disparador protege para que solo se añada, contando dos veces un paso que ocurrió
una. Las dos pruebas usan barrera y comprueban que la segunda tarea **se queda
esperando**.

**D161 · El motivo de moderación es de cada fila.**

Había un solo recuadro para toda la cola, y el botón de ocultar la respuesta
vivía fuera del bloque abierto: un motivo escrito en una valoración y no enviado
se pegaba a la siguiente que se tocara. Y esa tabla es **inmutable por
disparador**, así que un motivo equivocado no se podía corregir nunca.

**D162 · Un centinela que no puede ponerse rojo es peor que no tenerlo.**

Siete lo estaban, y es el hallazgo más incómodo de la revisión porque los siete
los escribí yo creyendo que protegían algo:

| Qué decía medir | Por qué no medía nada |
|---|---|
| «ninguna ruta de proveedor escribe la reseña» | recorría el **router** buscando asignaciones a atributo, y no hay ninguna: todo pasa por el servicio. Cero funciones inspeccionadas con cero escrituras. Y excluía la única ruta que sí cambia el estado |
| «el servicio no sabe de dinero» | solo leía `nodo.module` de un `ImportFrom`, así que no veía `from app.modules.products import pagos` —el idioma que usa todo el módulo— ni ningún `import` a secas |
| «sin la 0081 contestan 503» | llamaba a la puerta y a nada más: probaba el `if` de `exigir_resenas`, no que ninguna entrada contestara 503 |
| «dos envíos a la vez dejan una sola» | aceptaba cualquier `Exception`, así que un 500 crudo la dejaba verde |
| la fixture HTTP | devolvía siempre un usuario, así que **las dos rutas públicas del incremento nunca se probaron anónimas** |
| dos asertos del centinela de rutas | prohibían URL que nadie escribiría (`/reviews/verify`) |
| dos regex del móvil | no habrían visto `cuantas / (cuantas + PESO)` ni `* PREVIO` |

Los siete se arreglaron para que **puedan fallar**, y cuatro llevan ahora
**control positivo**: inyectan el fallo que dicen detectar y exigen verlo. El del
servicio además falla si no encuentra ni una escritura, porque entonces no
estaría midiendo nada.

**D163 · Y nueve bajos, todos cerrados.**

El rastro de moderación decía que la escondió «el sistema» —faltaba el rol y el
estado anterior—; la cola de moderación se llevaba la línea de pedido, que es
justamente el campo que la 0081 saca de la lista pública; el dueño de los
productos se preguntaba uno a uno aunque el docstring prometía una sola consulta;
`moderar_respuesta` no protegía su `flush`; `crear` deshacía la transacción
entera de quien llama en vez de un punto de guardado; la 0081 tenía una
verificación decorativa que contaba filas y ejecutaba `null`; y en las pantallas,
las barras del histograma y las filas de ejes eran `View`s desnudas que un lector
de pantalla leía como «5», «1», «4», «0», y la fila de una valoración ya hecha se
quedaba por debajo del área táctil mínima.

**Lo que la revisión confirmó, y era lo que había que confirmar:** las tres claves
ajenas compuestas existen y PostgreSQL las impone; no hay ninguna forma de crear
una valoración sin compra pagada y entregada; y **las tres restricciones únicas
nuevas sobre tablas que ya existían no pueden romper nada**, porque cada conjunto
de columnas contiene ya la clave primaria de su tabla —`product_shipments.order_id`
lo es desde la 0079, «una por pedido»— y porque ni `paid_at` ni `delivered_at`
tienen hoy ningún camino de escritura que no sea el primero.

**Y una fragilidad que no era un fallo, arreglada igual:** `puede_resenar` miraba
solo `delivered_at` y no el estado del envío. Es correcto **únicamente** porque
`DELIVERED` es terminal; el día que alguien añada una transición que salga de ahí
sin limpiar la fecha, tanto el `if` como la clave ajena dejarían de significar
«entregado» sin que ninguna prueba se pusiera roja. Ahora se miran las dos cosas.

**Lo que queda escrito como sospecha, sin reproducir:** si la pre-comprobación de
`moderar_respuesta` y su índice parcial se interleasen, podría salir un 500 en vez
del 409. La revisión no consiguió provocarlo; se envolvió el `flush` igual, que
es lo que hacen las otras dos.


## Incremento 9 de Productos · el dinero y el cierre operativo (22/09/2026)

**D164 · NO se construye un segundo sistema financiero.**

Cursos y Eventos ya tenían uno, y la 0068 ya lo había generalizado: cada venta se
guarda en `owner_sale_balances` con bruto, comisión, neto, moneda, versión de la
regla y estado. Productos es **un tercer origen** de esa misma tabla, no otro
aparato: una columna `product_order_id`, una clave ajena RESTRICT, y el CHECK
`owner_sale_balances_un_origen` ampliado de dos ramas a tres.

Lo mismo con `owner_sale_reserves`, que solo necesitó dos referencias nuevas, y
con el adaptador de devoluciones (`RefundProvider`, `NoConfigurado`), que se usa
**tal cual**, sin una línea nueva.

**D165 · Y dónde SÍ hizo falta tabla nueva, con su razón.**

`product_refunds` y `product_disputes` son nuevas porque `refund_requests` y
`event_disputes` están **nombradas y referenciadas contra otros dominios**: sus
claves ajenas apuntan a matrículas y a entradas de evento. Meterles un pedido de
producto habría exigido aflojar precisamente las restricciones que las hacen
fiables. Generalizar una tabla que ya ata bien es empeorarla, así que no se hizo.

**D166 · Sin comisión configurada no se escribe NI UN SALDO.**

Ni cero, ni pendiente, ni provisional. `registrar_venta` mira si hay regla de
comisión y, si no la hay, no escribe nada.

No es una pantalla que oculte un número: **es que la fila no existe**, porque una
fila con importes sin regla detrás es una fila inventada que mañana habría que
recalcular —y recalcular ventas históricas es exactamente lo que no se puede
hacer—. La pantalla del proveedor dice «pendiente de configuración»; un `0,00` se
leería como «vendiste y no cobraste», que es lo contrario de la verdad.

**D167 · `registrar_venta` no lanza NUNCA, y usa un punto de guardado.**

La llama el webhook de pago inmediatamente después de marcar el pedido como
pagado, **dentro de la misma transacción**. Dos consecuencias, y las dos costaron
un fallo real:

* **No lanza.** Devuelve `None` y escribe en el registro. Una excepción ahí
  desharía el cobro de quien ya pagó.
* **No hace `db.rollback()`.** La primera versión lo hacía, y eso destruía la
  confirmación del pago de quien llama. Ahora abre `begin_nested()`: si falla al
  escribir el saldo, se deshace el saldo y **el pedido sigue pagado**.

**D168 · La comisión se congela con la venta, y nunca se recalcula.**

Cada saldo guarda `fee_rules_version` junto al bruto, la comisión y el neto ya
calculados. Cambiar el porcentaje mañana no toca ninguna venta de ayer: no hay
ninguna consulta que multiplique un importe histórico por el porcentaje actual.

El móvil tampoco lo calcula, y no es una promesa: hay una prueba que **lee el
fichero del cliente** y falla si aparece la base de puntos básicos o una lectura
del porcentaje desde un dato.

**D169 · El reloj de la protección sale de la política congelada del pedido.**

`incident_report_hours` de la política que aceptó quien compró **en el momento de
comprar**, no un 72 escrito en el código. El blueprint §13 manda sobre el §9 en
esto: si la empresa cambia el plazo, los pedidos viejos conservan el suyo.

Sin política no hay fecha, y **sin fecha no es «ya»**: es
`protection_policy_not_configured`, y la pantalla lo dice.

**D170 · La conformidad es una columna propia, no `buyer_confirmed_at`.**

`conformity_at` es nueva. `buyer_confirmed_at` sigue significando lo que
significaba desde el Incremento 6: «confirmo que me llegó».

Son dos afirmaciones distintas, y tratarlas como una sola le quitaría el plazo de
protección a quien solo acusó recibo. La conformidad **adelanta** la liberación;
acusar recibo, no.

Y no se ofrece dar la conformidad con una reclamación viva: quien dice que algo
llegó mal no puede a la vez decir que está bien. Lo comprueban el servidor y la
pantalla.

**D171 · Ninguna fecha libera sola, y el orden de los bloqueos es deliberado.**

`liberar_vencidos` recorre los saldos vencidos y vuelve a preguntar **los doce
bloqueos** por cada uno. Un plazo cumplido con una reclamación abierta no paga.

Y `por_que_no_se_libera` contesta el primero que aplica, en este orden: venta →
entrega → reloj → cuenta de cobro → reservas, reclamaciones, devoluciones y
disputas. **Venta, entrega y reloj van antes que la cuenta** a propósito: decirle
«te falta la cuenta de cobro» a quien todavía no ha entregado el paquete le manda
a resolver algo que no es lo que le frena. Una prueba fijó el orden después de
que la primera versión contestara `payout_account_missing` a un pedido sin
entregar.

**D172 · Aprobar no es pagar, y solo `confirmed` dice que el dinero volvió.**

`approved` es una decisión, `requested` una petición y `processing` una espera.
Solo `confirmed` consume la reserva, cancela el saldo si se devolvió todo y marca
el expediente con `EFECTO_EJECUTADO`, que es lo que suelta `bloquea_el_dinero`
del Incremento 7.

**Y un aviso de fallo posterior no deshace una confirmación.** La pasarela puede
avisar tarde y desordenado.

**D173 · El adaptador apagado falla cerrado, y eso ES la funcionalidad.**

Con Stripe sin configurar, pedir una devolución contesta error y la deja en
`failed` con su motivo —reintentable—, **nunca en `confirmed`**. Ninguna prueba
sustituye el adaptador por un doble que diga que sí: una devolución marcada como
confirmada sin que el dinero haya salido es la peor fila que puede existir en
esta base.

**D174 · Moderación no mueve dinero, y no existe ninguna ruta que transfiera.**

Las rutas financieras exigen administración, no el rol de evaluador. Y no hay
ruta de transferencia ni de alta de cuenta de cobro: hay un centinela que lista
las rutas del módulo y falla si aparece `transfer`, y otro que lee el repositorio
del móvil y falla si aparece `transferir()` o `darDeAltaLaCuenta()`.

Las pantallas lo dicen con palabras en vez de enseñar un botón que fallaría.

**D175 · El tope de una devolución lo calcula el servidor, y viaja en el 409.**

Bruto menos lo ya devuelto. Restarlo en el cliente exigiría saber qué
devoluciones hay vivas, que es justo lo que el cliente no sabe. Cuando rechaza,
el 409 lleva `max_minor` en el detalle para que la pantalla enseñe el tope de
verdad en lugar de uno estimado.

**D176 · `amount_minor` no tiene valor por defecto, y ninguna columna decide por
la empresa.**

El bloque de verificación de la 0082 **falla** si aparece una columna de
porcentaje de devolución, de días de retención, de quién paga el porte de vuelta
o de comisión de plataforma, y si `amount_minor` tiene defecto. Las cuatro
primeras son decisiones que no están tomadas, y una columna con valor por defecto
las daría por tomadas en silencio. La quinta, porque un importe con defecto es un
importe que se puede escribir sin decidirlo.

**D177 · PENDIENTE DE LA EMPRESA: las nueve que mueven dinero, derechos o
responsabilidad.**

Ninguna se ha inventado, y ninguna bloquea el resto del Incremento 9:

| Qué falta | Qué hace hoy el sistema |
|---|---|
| Porcentaje de comisión | no se escribe ningún saldo |
| Quién absorbe la comisión de la pasarela | el panel lo dice con palabras |
| Plazo de retención por defecto | sin política, `protection_policy_not_configured` |
| Reglas de devolución (cuánto, en qué salida) | cada aprobación se decide a mano, con su motivo |
| Portes de retorno y reposición | no se descuenta nada del neto |
| Cuenta o entidad que cobra | no hay ruta de transferencia |
| Frecuencia de transferencias y mínimo | igual |
| Saldos negativos | `negative_balance` bloquea, y no se compensa solo |
| Si el alta de Connect se abre desde la aplicación | la pantalla explica que hoy no |


**D178 · El tope de una devolución lo sostiene un cerrojo, NO un CHECK.**

La cabecera de la 0082 decía que un CHECK impedía pasar del bruto. **No
existía**, y afirmarlo era peor que no tenerlo: quien lea la migración creería
que la base lo protege y no añadiría el cerrojo que falta.

Acotar `sum(amount_minor)` contra el total del pedido exige un disparador de
restricción o una columna materializada, y eso es una decisión de esquema que no
estaba tomada. Lo que hay hoy es un **cerrojo de fila sobre el pedido** en
`aprobar`, que serializa las aprobaciones concurrentes, y la cabecera lo dice
así. Queda anotado como pendiente si alguna vez se quiere en la base.

**D179 · Tres partes del ciclo de devolución no tenían camino de ejecución, y
se dijeron. CERRADAS el 22/09/2026; ver [D184].**

Ninguna devolución parcial llega a la pasarela; los avisos asíncronos de
reembolso no se encaminan a `devoluciones.atender_aviso`; y nadie inserta nunca
una disputa. Las tres son **condiciones para encender los pagos**, no defectos
que se arreglen hoy: la primera exige escribir `create_partial_refund` contra
Stripe, la segunda decidir el encaminamiento del webhook compartido, y la
tercera decidir si Z ingiere contracargos.

Mientras tanto **no se disimulan**: están en esta documentación, en el informe y
marcadas en la batería de mutaciones, y ninguna prueba finge cubrirlas.

**D180 · Quien compró no lee el motivo interno de una decisión.**

`decision_reason` es el texto libre que teclea administración para justificarse,
y puede llevar dentro lo que se pensó de quien reclama. Tampoco es suyo el
identificador del saldo del proveedor, ni el proveedor de pago, ni el código con
el que falló la pasarela. La ruta de quien compra devuelve una proyección con lo
que sí es suyo: cuánto, en qué moneda, en qué estado y cuándo se confirmó.

**D181 · La fecha de liberación se contesta aunque la columna esté nula.**

`available_at` se escribe nula al registrar la venta —sin entrega no hay reloj—
y después **no la actualiza nadie**. Pero con la protección en curso el servidor
sí sabe la fecha: la calcula y la manda en el detalle del bloqueo. Sin usarla, la
pantalla escribía «todavía no se sabe» sobre un pedido entregado cuya ventana se
puede datar al segundo, que es la misma clase de mentira que un `0,00`.

**D182 · 92 de 100 pruebas de Productos se saltaban en la integración continua.**

El trabajo principal no define `MIGRACIONES_DATABASE_URL` **a propósito**, y el
trabajo `migraciones` —que sí tiene PostgreSQL y un guardia que falla si algo se
omite— llevaba una lista explícita de seis ficheros. Los de los Incrementos 8 y
9 no estaban en ella, así que la verificación de compra y todo el dinero corrían
en el trabajo equivocado y se omitían en silencio.

Ahora están los tres dentro, y el suelo del guardia se subió de 100 a **266,
medido ejecutándolo**, no supuesto. Una prueba omitida no es una prueba
aprobada, y el propio fichero ya lo decía.

**Y VOLVIÓ A PASAR con la lista arreglada**, en la misma sesión: ver [D185]. La
corrección de aquí era la lista; la de allí es que no haya lista.


## 18. Cierre de Z Productos: Stripe, la integración continua y la revisión del dinero (22/09/2026)

Esta sección recoge el cierre técnico de la vertical. Lo que la ordena no son
los incrementos —están todos implementados— sino tres cosas que parecían hechas
y no lo estaban: la preparación de Stripe, lo que la integración continua
ejecutaba de verdad, y lo que la revisión independiente encontró en el dinero y
en los permisos.

**D183 · Las 0079, 0080, 0081 y 0082 están aplicadas, y no hace falta una
0083.**

Las cuatro se aplicaron a mano y se verificaron después contra la base
gestionada en una sesión de **solo lectura demostrada**: doce tablas, las cuatro
columnas añadidas, las restricciones, los índices con su parcialidad, los
disparadores, RLS activa en todas y **cero permisos** para `anon` y
`authenticated`. Los cinco invariantes de datos, a cero violaciones.

Toda la documentación que decía «sin aplicar» estaba desfasada y se ha
corregido. Las cabeceras de los `.sql` siguen diciéndolo a propósito: una
migración aplicada no se reescribe, porque cambiarla haría que la comprobación
de re-ejecución dejara de valer sobre lo que de verdad se pegó en el editor.

**D184 · Los tres huecos de [D179] están cerrados, y ninguno era una decisión
pendiente.**

[D179] los declaró «condiciones para encender los pagos». Dos de las tres no lo
eran: eran código escrito, comentado y con pruebas alrededor que **no se
ejecutaba nunca**.

* **La devolución parcial** no llegaba a la pasarela porque ningún adaptador
  definía `create_partial_refund`. Ahora es abstracto: un adaptador que se
  olvide no arranca. Con una implementación por defecto que cayera en la total,
  se olvidaría en silencio y devolvería el cobro entero cuando alguien decidió
  devolver una parte.
* **Una devolución pendiente** no llegaba nunca a confirmada, porque el único
  camino era la respuesta síncrona de `pedir`. Ahora la confirma el aviso
  verificado.
* **`ProductDispute` no tenía escritor**, así que la puerta de disputa de
  `por_que_no_se_libera` —escrita, comentada y con su índice— no podía
  dispararse jamás.

**D185 · La lista de ficheros de la integración continua se quedó vieja dos
veces, así que ya no hay lista.**

[D182] contó la primera: 92 de 100 pruebas de Productos no se ejecutaban. Se
corrigió añadiendo los ficheros que faltaban, y **la lista volvió a quedarse
vieja en la misma sesión**: veinte ficheros fuera, entre ellos los Incrementos 1
a 7 de Productos enteros y `test_productos_disputas.py`, que protege la única
puerta por la que se registra un contracargo. Sus once pruebas se saltaban en el
trabajo sin base y no se recogían en el que la tiene: no se ejecutaban en
ninguna parte.

Una lista escrita a mano se queda vieja sola, porque un fichero nuevo no falla y
no se salta con un aviso: sencillamente **no se recoge**. Ahora el trabajo con
PostgreSQL ejecuta **la batería entera**, que es lo único que no se puede
olvidar de nada, y el suelo del guardia se midió ejecutándolo.

Y lo que se vigila desde `tests/test_integracion_continua.py` **es la causa**:
que no vuelva a aparecer una selección incompleta.

**D186 · Las ciento trece baterías del móvil no se ejecutaban en ningún
trabajo.**

El trabajo `mobile` ejecutaba `tsc --noEmit`, que comprueba **tipos** y no
comportamiento. Los contratos con la API, las reglas de cada pantalla y la
paridad de los tres diccionarios no corrían en ninguna parte: un cambio que
rompiera una pantalla o dejara una clave sin traducir pasaba la integración en
verde. Tardan cuatro segundos.

**D187 · Encender Stripe exigía leerse `config.py`, y eso no es configuración.**

La entrega tiene que poder hacerse sin desarrollo: llegan las credenciales, se
registra el webhook, se marcan los eventos y se encienden las banderas. Eso solo
es cierto si los nombres exactos están escritos fuera del código fuente.

`.env.example` documentaba la clave secreta y el secreto del webhook. No estaban
la bandera que ejecuta las devoluciones contra la pasarela, la de cuentas
conectadas, la de transferencias, **la comisión** —que nace en `-1`, sin
configurar, y sin la cual no se escribe ni un saldo—, la que habilita vender un
producto físico ni los minutos que aparta un pedido.

La puerta canónica no es una lista de nombres sino **una regla**: cualquier
ajuste cuyo nombre hable de dinero tiene que aparecer en `.env.example`,
apagado, y los eventos que el documento manda marcar tienen que ser los que el
código traduce. Así queda cubierta la bandera que alguien añada mañana.
Los pasos concretos están en `docs/Z_STRIPE_PUESTA_EN_MARCHA.md`.

**D188 · El adaptador de Stripe y su puerto se necesitaban en círculo.**

`providers.py` define el contrato y `stripe_provider.py` lo implementa, y el
registro estaba al final del primero con un `import` del segundo. El **orden de
importación** decidía si la aplicación arrancaba: entrando por `providers`
funcionaba, y entrando por `stripe_provider` Python encontraba `providers` a
medio ejecutar y levantaba `ImportError` hablando de un ciclo, no de pagos.

No se notaba porque en todos los caminos reales `providers` entra primero, pero
bastaba un módulo nuevo que importara el adaptador directamente para que no
arrancara la API entera. El registro pasa al `__init__` del paquete, que Python
ejecuta antes que cualquier submódulo, y **sigue siendo ansioso**.

### Lo que encontró la revisión independiente del dinero

**D189 · Una devolución EN CURSO no es una devolución FALLIDA.**

`atender_aviso` recibía un booleano —salió o no salió— y `refund_procesando`
caía en el «no salió», que es marcar el expediente como fallido. Un reembolso de
tarjeta **nace pendiente** en la pasarela, así que el `refund.created` que llega
a los segundos lo tumbaba.

Desde ahí desaparecía de la cola de trabajo, dejaba de contar en el tope de lo
ya devuelto y `anular` lo aceptaba: quien opera ve «fallida», la anula, aprueba
otra por el mismo importe **con otra clave de idempotencia**, y quien compró
cobra dos veces un pedido que pagó una. El aviso tiene ahora tres respuestas, y
estar en curso no toca nada.

**D190 · Una disputa cerrada DEVOLVIENDO el cobro no es una disputa RETIRADA.**

Retirada es la que retira quien la abrió, y ahí el dinero **se queda**; cerrada
devolviendo significa que **salió**. Se traducían igual, así que se soltaba la
retención sin consumirla y el saldo volvía a la cola de pago después de haberle
reembolsado el cobro entero a quien compró. Y no lo tapaba nada más, porque ese
reembolso se hizo desde el panel de la pasarela y no tiene expediente aquí.

No se inventa ningún estado: el CHECK de `product_disputes` admite seis y no hay
migración pendiente. **La fila carga el hecho financiero** porque cada aviso
repetido vuelve a aplicar el dinero leyéndola a ella y no al cuerpo del aviso.

**D191 · Reponer devuelve mercancía y no dinero, y hacía falta un camino para
saldarla.**

Un solo conjunto de resoluciones contestaba a dos preguntas distintas. Con la
reposición dentro, `aprobar` dejaba abrir una devolución **de dinero** sobre un
expediente que se resolvió mandando una unidad nueva: quien compró se quedaba
con las dos cosas.

Y al cerrar esa puerta, el dinero se quedaba dentro: un caso resuelto retiene el
saldo mientras su efecto no esté saldado, y lo único que escribía `EXECUTED` era
confirmar una devolución de dinero. Una reposición nunca tiene una, así que ese
saldo **no salía de la cola nunca**; el único desatasco era precisamente el error
de arriba.

Se separan las dos preguntas y se añade el camino que faltaba: registrar que la
unidad de repuesto llegó, con motivo, renglón en el historial solo-añadir y
rastro de auditoría. **No decide quién absorbe el coste**: deja constancia de un
hecho físico. Lo pide finanzas y no moderación, porque lo que se escribe es el
efecto financiero y desbloquear un cobro es mover dinero.

**D192 · La clave que impide pagar dos veces salía de un flotante del reloj, y
no cambiaba nunca.**

Se componía con `momento.timestamp()`: la cadena que protege dinero real
dependía de su representación binaria, y dos aprobaciones sobre el mismo pedido
con el mismo instante chocaban contra el único y salía un `IntegrityError`
crudo, un 500 sin código.

Y con una clave fija el primer «no» de la pasarela queda grabado: el reintento
reenvía la misma y la pasarela devuelve **la misma respuesta fallida, para
siempre**. La regla correcta ya estaba escrita y probada en
`payments/reembolsos.py` —cambiar solo tras un fallo **concluyente**, porque un
tiempo de espera agotado no significa que no se haya hecho— y Productos no la
usaba.

**D193 · Una parcial CONFIRMADA no es una devolución EN MARCHA.**

El bloqueo se decidía por la existencia de una fila en un conjunto que incluye
`confirmed`. Para una total da igual —el saldo se cancela y el primer bloqueo
salta antes— pero una parcial deja el saldo vivo, y el resto quedaba bloqueado
diciendo «hay una devolución en marcha». No la hay: está cerrada, su retención se
consumió, y `confirmed` es terminal, así que ese bloqueo **no se levantaba
nunca**.

El bloqueo es correcto y se queda: el neto se calculó sobre el bruto entero y
quién absorbe la parte devuelta es una decisión que la empresa no ha tomado. Lo
que se arregla es la mentira. Ahora tiene código propio y sale como decisión
pendiente en vez de parecer una espera.

**D194 · Una devolución que salió sin referencia no tenía ninguna salida.**

Cuando la pasarela no contesta a tiempo o su respuesta no se puede leer, el
adaptador devuelve «pendiente» sin identificador, y con razón: la petición salió
con su clave, así que el reembolso **puede existir**. Pero `atender_aviso`
localiza la fila solo por esa columna, así que el aviso posterior no la encuentra
jamás; y `anular` la rechazaba por estar en curso y `pedir` por no estar
aprobada ni fallida. Dinero fuera, retención viva, saldo bloqueado para siempre
y la reclamación de origen sin ejecutar.

Ahora se puede volver a pedir, **y solo en ese caso**. Es seguro porque se manda
la misma clave: la pasarela devuelve el reembolso que ya creó —con su
identificador— en vez de crear un segundo.

**D195 · Un contracargo abría dos filas y una se quedaba abierta para siempre.**

Cuando el primer aviso no trae el identificador de la disputa se deriva una
clave del cobro, que es lo correcto. Pero el siguiente aviso del mismo
contracargo sí lo trae, y con otra clave se abría una **segunda** fila. El cierre
llega con el identificador de verdad y solo cierra la segunda; la primera se
queda abierta, y el bloqueo mira también por pedido, así que ese saldo no se
liberaba nunca por una disputa fantasma ya resuelta.

La fila derivada se **asciende** a su identificador propio. No es «toda disputa
de este cobro es la misma»: dos contracargos reales del mismo cobro siguen
siendo dos filas, que es el motivo por el que la clave es la de la disputa.

**D196 · El disponible se restaba de dos conjuntos distintos.**

`disponible` suma el neto de los saldos que **ya se podrían pagar**, y se le
restaba todo lo apartado del proveedor, incluidas las retenciones sobre saldos
que todavía no están para pagar. Esas no estaban dentro del disponible, así que
restarlas le bajaba la cifra a quien vende por una venta que no entraba en ella.

**D197 · Una disputa sin importe se anotaba como un céntimo.**

El CHECK exige mayor que cero y se escribía el mínimo, con la moneda del pedido
al lado: la fila afirmaba que el banco reclamaba 0,01 y eso era lo que se
apartaba. Ahora se aparta **lo cobrado**, que es el tope de lo que el banco puede
llevarse y no una cifra inventada. Pasarse al apartar es el lado seguro.

### Lo que encontró la revisión independiente de permisos

**D198 · Nadie puntúa, documenta ni redacta la evaluación de lo suyo, y tampoco
la lee.**

Abrirla y decidirla comprobaban que el producto fuera ajeno; **las tres
operaciones de en medio** —puntuar, registrar evidencia y elegir las tres razones
que leerá quien compre— pasan por un único punto que solo miraba el rol. Bastaba
con que la evaluación la abriera otra persona.

Y no es cosmético: la decisión **no la toma quien pulsa**, la deriva
`decidir_por_puntuacion` del total, así que quien evalúa de verdad solo
ratificaba las cifras del dueño. La base tampoco lo paraba: el disparador de la
0071 compara `evaluator_id`, que sigue siendo el del otro, y las tablas de
puntuaciones, evidencias y razones no tienen disparador.

Leerla tenía el mismo hueco: dentro van las **notas internas** de quien evaluó,
que el informe público excluye a propósito.

**D199 · Moderar no contesta con la línea de pedido, y nadie lee el rastro de
moderación de lo suyo.**

El molde de salida tiene dos interruptores a propósito y las dos rutas de moderar
usaban el que trae `order_item_id`, que es justo el campo que la 0081 saca de lo
público por atar una persona con una compra concreta. La corrección anterior se
aplicó a la cola y no a las acciones.

Y la regla «nadie modera lo suyo» se había aplicado a **escribir** y no a
**leer**: un proveedor con curaduría pedía el rastro de una valoración de una
estrella de su propio producto y leía el motivo —que el propio código declara
demasiado sensible hasta para la auditoría compartida, porque puede llevar dentro
una cita de lo que contó quien opinó— y quién moderó.

**D200 · Tres rutas de administración eran un oráculo de existencia.**

Miraban la fila y contestaban 404 **antes** de comprobar el rol, así que
cualquier cuenta autenticada podía probar identificadores y distinguir «no
existe» de «existe y no es tuyo» sobre productos en borrador, rechazados o
retirados, que no están en el catálogo y cuyos identificadores no se publican.
Sigue siendo «lo propio primero» para quien es su dueño; lo que espera ahora es
el 404.

### Lo que la revisión señaló y NO era un defecto

**D201 · El resumen suma importes de monedas distintas, y está decidido.**

La revisión lo marcó como cifra sin sentido. Se comprobó y **la protección ya
existe, en el otro lado**: con más de una moneda el servidor manda la moneda
nula a propósito, y el móvil se niega a pintar cualquier importe sin su moneda.
Ninguna de esas cifras llega a una pantalla. No se toca.

### Lo que queda anotado y NO se ha arreglado

**D202 · Solo cabe una retención viva por saldo y motivo.**

Lo impone un índice único parcial de la 0068. Con dos devoluciones parciales
sobre el mismo pedido, la segunda no crea su retención y el error se traga: el
bloqueo del pago **no se pierde** —lo sostiene la fila de la devolución— pero las
cifras de apartado y disponible del panel se quedan cortas.

**No se arregla hoy y es deliberado:** la corrección de verdad es cambiar el
índice para que admita una retención por expediente, y eso es una migración
nueva. Este cierre no escribe ninguna sin demostrar antes una divergencia real,
y aquí no la hay: el esquema hace exactamente lo que dice.

**D203 · `devoluciones.pedir` confirma la transacción de quien la llama.**

Es deliberado y está documentado —la llamada a la pasarela no puede ocurrir con
filas bloqueadas— pero deja una trampa preparada: cualquier escritura que se
añada antes de esa llamada quedará confirmada aunque el resto de la petición
falle. Hoy no sangra, porque su único llamador no escribe nada antes. Queda
anotado para quien toque esa ruta.


### Lo que salió al ejecutar por fin el móvil y la puerta del despliegue (23/09/2026)

**D204 · La puerta del despliegue a producción llevaba semanas en rojo, y sin
base.**

Dos defectos en el mismo trabajo. El primero: no instalaba el arnés de las
pruebas, así que desde el Incremento 4 la recolección reventaba y **el
despliegue estaba bloqueado** sin que nadie lo supiera, porque no se ha
fusionado nada a `main` desde entonces. El segundo, que encontró la revisión:
corría **sin PostgreSQL**, así que 416 pruebas —claves ajenas compuestas,
índices parciales, disparadores, RLS— se omitían y se publicaba la imagen.

Ahora levanta su base y pasa por **el mismo guardia** que la integración
continua, que vive en un único guion (`apps/api/scripts/exigir_bateria_completa.py`)
para que no pueda quedarse viejo en un flujo y no en el otro.

**D205 · Lo que salió en cuanto las pruebas del móvil corrieron en CI.**

* El flujo fijaba Node 22.13 y cuatro baterías usan `module.registerHooks`, que
  llegó en 22.15: esos ficheros no se importaban. Se sube el flujo, `engines` y
  el README.
* Una prueba leía `.env`, que no está versionado y en CI no existe.
* Y el guion podía pasar en verde **sin ejecutar nada**: un patrón que no casa
  es «cero pruebas, todo bien» para Node. El patrón y su suelo viven ahora
  juntos en `apps/mobile/scripts/pruebas.mjs`.

**D206 · Quien acababa de pagar no podía volver a su pedido.**

El único enlace a «mis pedidos» estaba en el pie de la bolsa, dentro de la rama
con líneas; y el servidor retira de la bolsa lo que se acaba de comprar. Con un
solo proveedor, la bolsa queda vacía y no quedaba ninguna puerta hacia el
detalle, del que cuelgan pagar, confirmar, reclamar, valorar y dar la
conformidad. El acceso va ahora en la portada de Productos.

**D207 · El dinero devuelto se escondía justo cuando más importaba.**

Los bloques de conformidad y de devoluciones estaban dentro de la tarjeta de
valorar, que solo sale con el paquete entregado: a quien negó la entrega y cobró
el reembolso no se le enseñaba nunca.

**D208 · El panel financiero decía cero cuando no sabía.**

Sin las finanzas desplegadas pintaba seis cuentas en `0` en vez de decir que no
estaban disponibles, y ofrecía «liberar», que el servidor rechazaría siempre.

**D209 · Los formularios de una reclamación compartían la caja de texto.**

Lo escrito para una acción viajaba como motivo de otra, a un expediente que no
se reescribe. Cada formulario tiene ahora la suya, y apelar —una vez en la vida
del caso— pregunta antes.

**D210 · Marcar como entregado pregunta antes, en los dos lados.**

No se deshace y arranca el plazo para reclamar y el de protección del pago. El
comentario de quien compra decía lo contrario.

**D211 · La ficha no se enteraba de que se puede comprar.**

`purchasable` estaba en `false` escrito a fuego; encender las ventas habría
exigido tocar código. Ahora usa las mismas cinco condiciones que la ruta de pago.

**D212 · Una clave de traducción que no existía se pintaba cruda.**

La paridad de diccionarios comprobaba que los tres dijeran lo mismo; ninguna
prueba comprobaba que lo que el código **pide** esté en ellos. La nueva recorre
todas las claves literales y encontró esa y ninguna otra.

### Lo que la revisión de vistas y CI señaló y queda ANOTADO sin arreglar

* **La clave del historial del pago se construye sin validar** (`envios.ts`,
  `lineaDeTiempo`). Hoy no tiene efecto —los siete estados coinciden en los dos
  lados— y el día que el servidor añada un octavo se pintaría crudo. Arreglarlo
  bien exige mover la lista de estados entre módulos que se prueban sin
  resolver alias; se deja para quien añada ese estado.
* **`pytest.ini` no lleva `--strict-markers`.** En el trabajo con base lo tapa
  el guardia de omisiones; en el otro, un marcador mal escrito sería un aviso.
* **La puerta del despliegue acepta `skipped` como «no es fallo»** para permitir
  la vuelta atrás manual. Distinguir los dos casos es trabajo del flujo de
  despliegue, no de Productos.
* **Dos baterías SQL de RLS** (`supabase/tests/stories_rls_test.sql` y
  `testimonials_rls_test.sql`) no las ejecuta ningún trabajo. Son de otras
  verticales.
* **Tres hallazgos BAJOS de la revisión de permisos**, que no filtran nada fuera
  de su rol: la cola de conciliación de administración arrastra el texto libre
  del historial del envío —la revisión lo marcó como sospecha y solo aparece si
  un pedido en revisión ya tiene envío—; quien vende ve el identificador del
  administrador que ajustó su inventario; y la lista pública de valoraciones
  lleva el `author_id` de quien opinó junto al sello de compra verificada. El
  último puede ser una decisión de producto y la justificación escrita no la
  cubre: queda para quien decida qué se enseña de quien opina.

---

## Z Servicios, Incremento 1 — admisión de prestadores (29/09/2026)

El detalle técnico está en [`Z_SERVICIOS_ARQUITECTURA.md`](Z_SERVICIOS_ARQUITECTURA.md).
Aquí va lo que es decisión: la tomada, la derivada de reglas ya dadas y la que
sigue esperando a la empresa.

### Requisitos cumplidos

| Requisito | Cómo |
|---|---|
| Una persona o empresa postula, acepta las condiciones vigentes y entrega datos, documentos y credenciales | Rutas `/services/provider/*` y diez pantallas del prestador |
| Envía, recibe observaciones, corrige, reenvía, se retira y conoce el resultado | Saltos explícitos con historial visible y avisos |
| Z revisa, verifica evidencia, pide correcciones, aprueba, rechaza o suspende | Rutas `/admin/services/*` y cuatro pantallas de administración |
| Historial, permisos y auditoría | Historial que solo se añade (lo impone la base), auditoría en `audit_events` y permisos en el servidor |
| Documentos privados | Depósito sin políticas; ruta puesta por el servidor; enlaces de 120 s |
| `FEATURE_SERVICES` apagada no cambia nada | 503 sin tocar la base; ninguna entrada en la app |

### Decisiones derivadas (no se inventó ninguna regla)

1. **Retirarse es antes de la decisión, también después de una suspensión.**
   Una aprobada que se suspende vuelve a `under_review`, pero ya se decidió.
   Deriva de «solo antes de la decisión» y de «no desde suspended». Lo imponen
   el código (`service_application_already_decided`) y la 0088
   (`retirada_antes_de_decidir`).
2. **Suspender se levanta pasando por revisión**, nunca de golpe.
3. **Sin condiciones publicadas no se envía**, y la pantalla lo dice. No se
   siembra ningún texto.
4. **Volver a postular tras un rechazo lo decide la política.** Sin el
   parámetro, el servidor contesta `409 service_reapplication_not_configured`:
   la ausencia no es ni un sí ni un no. La empresa lo decide al publicar sus
   condiciones, desde Administración.
5. **Documentos y credenciales exigidos por país**: mínimo fijo (identidad; en
   empresa, además, representación legal) más lo que exija la política.
6. **Roles**: se reutilizan `moderator` (revisa) y `admin` (decide). No se
   crearon Operaciones ni Cumplimiento.

### Pendiente de la empresa

| # | Decisión | Qué pasa mientras tanto |
|---|---|---|
| S1 | Texto de las condiciones del prestador por país | Nadie puede enviar su postulación |
| S2 | ¿Se puede volver a postular tras un rechazo? | `service_reapplication_not_configured` |
| S3 | Documentos y credenciales adicionales por país o categoría | Solo se pide el mínimo |
| S4 | Personas de una empresa (más de un representante) y teléfono verificado | No existen |
| S5 | Análisis antivirus de los documentos | Solo se valida el formato por firma y el tamaño |
| S6 | Retención de documentos tras un rechazo o una retirada | Se conservan (evidencia) hasta que se borra la cuenta |
| S7 | ~~Borrado de cuenta frente a la auditoría inmutable~~ **Decidida el 29/09/2026** (regla en `Z_BAJA_DE_CUENTA.md` §1): se borran los datos personales y los archivos privados; lo histórico se conserva y deja de nombrar a la persona | **Implementada** en la 0089 y en `DELETE /auth/me`. La 0089 está **aplicada y verificada** en Supabase (29/09/2026, sin divergencias). El código de `DELETE /auth/me` está en `Edson`, **sin desplegar** |
| S8 | Cuentas con ventas, saldos, transferencias, pedidos, incidencias, disputas, decisiones de personal con `restrict` **u órdenes pagadas con dinero de verdad** (0089): plazo de conservación, si se anonimizan (conservar la orden y dejar a quien compró en `NULL`) y el proceso de soporte. **Prioritaria antes de encender los pagos: Google Play exige poder borrar la cuenta desde la app** (se pueden conservar los registros de las transacciones) | `DELETE /me` responde 409 `account_deletion_blocked` sin tocar nada, y el móvil pide escribir a soporte |
| S9 | Cuánto se conservan la huella y el prefijo de IP y la familia de navegador de `audit_events` y `consent_records` | Se conservan con el registro, sin la persona |
| S10 | ¿Se anulan también los identificadores del personal en el historial, los envíos y las condiciones de Servicios? (sin clave ajena por diseño de la 0086) | Quedan como identificadores sin perfil detrás. Anularlos es el mismo mecanismo de la 0089 con una clave ajena nueva |
| S11 | Pauta para que los motivos escritos por el personal al decidir no nombren a nadie (quedan en `audit_events.reason`) | Se conservan tal cual |
| S12 | ¿Se borran con la cuenta la nota y el tema que alguien escribió al reservar una sesión, que están en la notificación de la otra persona? (plataforma, anterior a Servicios) | Se quedan en la bandeja de quien la recibió; el actor pasa a `NULL` |
| S13 | Puentes identificador↔correo que sobreviven a la baja: el cuerpo crudo de los avisos de Stripe (`payment_events.payload`) y el registro de Supabase Auth (`auth.audit_log_entries`). ¿Se depuran, y cuándo? | Hoy los dos tienen 0 filas (29/09/2026). Se llenarán al encender los pagos |
| S14 | Motivos libres del organizador en la auditoría de Eventos (enviar, cambiar, cancelar), que sobreviven a su cuenta | Se conservan; propuesto como tarea aparte. En Servicios ya no se copian textos libres a la auditoría |

### Límites del Incremento 1 y lo reservado para después

Límites:
- no hay catálogo de servicios, precio, agenda, reserva, pago, incidencia ni
  reseña;
- la vista pública del prestador existe en el contrato, pero ninguna ruta la
  sirve;
- tocar el push de un aviso abre la app, sin llevar a la postulación, igual
  que los demás avisos al creador.

Reservado para después: servicios y variantes; disponibilidad calculada en el
servidor; reservas con retención de hueco; pagos y transferencias; incidencias;
valoraciones verificadas.

## Z Servicios, Incremento 2 — catálogo y publicación de servicios (29/09/2026)

El detalle técnico está en [`Z_SERVICIOS_ARQUITECTURA.md`](Z_SERVICIOS_ARQUITECTURA.md),
Parte II. **Técnicamente cerrado el 29/09/2026: la 0090 está aplicada y
verificada sin divergencias (§32); únicamente queda pendiente el QA físico.**
`FEATURE_SERVICES` sigue apagada y el código, sin desplegar. Nada de lo que
sigue se presenta como política definitiva si la empresa no lo confirmó.

### Requisitos cumplidos

| Requisito | Cómo |
|---|---|
| Un prestador aprobado y activo crea servicios; nadie más | `service_provider_not_active` en la API y, además, la base (un servicio nace de un prestador activo) |
| Borradores que se completan a medias | `PATCH …/draft` con solo lo que cambia; `missing` dice qué falta |
| Enviar congela la versión | La base impide editar el contenido fuera del borrador |
| Revisión, observaciones, corrección y reenvío | Pedir cambios con motivo visible y campos; el prestador corrige en una versión nueva (`resubmitted`) |
| Aprobación y publicación | Dos pasos, de administración; una sola publicada por servicio |
| Editar lo publicado no cambia lo visible | Borrador nuevo; lo publicado sigue hasta que Z publique la nueva |
| Suspender saca del público | 404 en la ficha; reactivar y retirar, con motivo |
| Permisos | Prestador, moderación y administración; nadie decide lo propio; lo ajeno es 404 |
| Imágenes protegidas | Depósito privado, ruta del servidor, URL firmada que caduca |
| Vistas conectadas | 13 pantallas, todas alcanzables desde otra vista, detrás de `FEATURE_SERVICES` |

### Decisiones tomadas en el código (provisionales)

Se derivan del pedido o de patrones ya aprobados en Cursos, Eventos y
Productos, y **se pueden cambiar sin migración** salvo donde se indica:

1. **Aprobar y publicar son dos pasos**, ambos de administración.
   Moderación inicia la revisión y pide cambios. No hay publicación
   automática.
2. **Pedir cambios cierra la versión**; corregir es abrir otra que sale de
   ella. El historial conserva las dos (lo impone la 0090).
3. **Publicar no reactiva** un servicio suspendido; levantar la suspensión es
   otra decisión, con motivo.
4. **Retirar es definitivo** (lo impone la 0090).
5. **Una categoría inactiva** no admite servicios nuevos ni envíos; no se
   borra y los servicios que la usan la siguen nombrando (lo impone la 0090).
6. **La ficha pública** enseña del prestador solo su nombre público.
7. **No se exige volver a aceptar condiciones** para publicar servicios: las
   del Incremento 1 son para ser prestador.
8. **Borrar la cuenta del prestador** se lleva sus servicios y sus imágenes.
   Hoy no hay reservas ni pagos que lo impidan; cuando existan, habrá que
   revisarlo (S8).

### Pendiente de la empresa

| # | Decisión | Qué pasa mientras tanto |
|---|---|---|
| C1 | **Categorías iniciales** | No se siembra ninguna. Sin categorías nadie puede crear un servicio, y la app lo dice. Las crea administración desde la app |
| C2 | Categorías **prohibidas o reguladas** (salud, legal, financiera…) y qué exigen | No hay lista ni bloqueo automático; administración puede desactivar una categoría |
| C3 | **Documentos adicionales por categoría** para publicar | No se piden. La admisión exige los del país (S3) |
| C4 | **Modalidades permitidas** | `SERVICES_CATALOG_MODALITIES`: las tres (virtual, presencial, a domicilio) |
| C5 | **Monedas y países** | `SERVICES_CATALOG_CURRENCIES=PEN`. Una categoría puede limitarse a un país; sin país, vale para todos |
| C6 | **Precio «desde»** y precio a consultar | `SERVICES_CATALOG_PRICE_MODELS`: los cuatro (gratis, fijo, desde, a consultar) |
| C7 | **Duración mínima y máxima** | `SERVICES_CATALOG_MIN/MAX_DURATION_MINUTES`: 5 y 1440 (los límites técnicos) |
| C8 | **Límite de imágenes** | `SERVICES_CATALOG_MAX_IMAGES=8`; 5 MB por imagen (límite técnico del depósito) |
| C9 | **Quién publica tras aprobar** | Administración, a mano (decisión 1) |
| C10 | **Motivos de suspensión** (lista cerrada o texto libre) | Texto libre obligatorio que el prestador lee |
| C11 | **Política para volver a publicar** tras una suspensión o una retirada | Tras suspender: administración la levanta con motivo. Tras retirar: no se puede |
| C12 | **Conservación de versiones e imágenes** superadas o retiradas | Se conservan mientras exista la cuenta del prestador; se borran con ella |
| C13 | **Información pública del prestador** en la ficha | Solo el nombre público |
| C14 | Pauta para que los **motivos** escritos por el personal no nombren a nadie | Se guardan tal cual; la auditoría no los copia |
| C15 | ¿Acepta la empresa que la URL firmada de una imagen lleve el **UUID del perfil** del prestador en su ruta, o exige una **ruta opaca**? (igual que Productos, que además publica `seller_profile_id`) | Se acepta provisionalmente. El depósito `service-media` es **privado** (verificado en Supabase el 29/09/2026) y ninguna política de `storage.objects` lo alcanza. Las imágenes solo salen como **URL firmada que caduca en 3600 s**: no hay ruta pública permanente, y ninguna respuesta lleva la ruta como campo. Pero la URL contiene `<perfil>/<servicio>/<versión>/<id>.<ext>`, y así la barre la baja de cuenta. **Hoy no hay ningún archivo** (0 objetos): si se decide una ruta opaca, se cambia **antes de encender Servicios** sin migrar contenido (la ruta en `catalogo_imagenes.py`, el prefijo que la 0090 exige a las filas, con otra migración, y el barrido de la baja). Detalle: `Z_SERVICIOS_ARQUITECTURA.md` §32 |
| C16 | Monedas que ofrece el formulario | Ofrece PEN, USD y EUR (las de Productos); si se elige una no configurada, al guardar aparece «Z no admite esa moneda por ahora» y no se puede enviar |

### Límites del Incremento 2 y lo reservado para después

Límites: no hay búsqueda, recomendaciones, filtros públicos, guardados,
disponibilidad, horarios, reservas, pagos, atención, mensajes,
reprogramaciones, cancelaciones, incidencias, reseñas, saldos ni
transferencias; ninguna tabla los anticipa. La ficha pública no tiene botón de
contratar. Tocar el push de un aviso abre la app sin llevar al servicio, como
los demás avisos al creador (la bandeja sí lleva al servicio o a la revisión,
y si ya no existe o no hay permiso lo dice sin romperse). Revisado el
29/09/2026 (`Z_SERVICIOS_ARQUITECTURA.md` §32): **no bloquea el Incremento 2**.
El blueprint (§23) pide `deepLink` en cada notificación, y hay que resolverlo
**antes de los avisos de reservas**. La tarea es que la cola de entregas mande
el tipo y la entidad y que `rutaDelPush` reutilice `rutaDelAviso`.

Reservado para después: disponibilidad calculada en el servidor; reservas con
retención de hueco; pagos y transferencias; atención e incidencias;
valoraciones verificadas.

## Z Servicios, Incremento 3 — descubrimiento y confianza (29/09/2026)

El detalle técnico está en [`Z_SERVICIOS_ARQUITECTURA.md`](Z_SERVICIOS_ARQUITECTURA.md),
Parte III (§33 en adelante). **Técnicamente cerrado el 29/09/2026: la 0091
aplicada y verificada sin divergencias; únicamente queda pendiente el QA
físico** (§49). Nada de lo que sigue se presenta
como política definitiva si la empresa no lo confirmó.

### Requisitos cumplidos

| Requisito | Cómo |
|---|---|
| Descubrir Servicios desde Explorar | El acceso «Servicios» lleva a `/servicios` con `FEATURE_SERVICES` encendida; apagada, avisa como antes |
| Buscar por lo que se necesita | PostgreSQL con las palabras de la búsqueda global: mayúsculas, tildes (también en palabras cortas: «cafe» encuentra «Café»), espacios, plurales, varias palabras; título primero |
| Filtros comprensibles | Categoría (con hijas), modalidad, gratis, con precio en una moneda (y rango), a consultar, zona y credencial verificada |
| Entender una oferta | La ficha en el orden del blueprint, con lo que declara el prestador separado de lo que comprobó Z |
| Saber que el prestador fue admitido por Z | «Prestador admitido por Z desde mm/aaaa», «Identidad verificada por Z» y «Credencial profesional verificada por Z y vigente», solo si son verdad |
| Credenciales públicas | Solo que existe una verificada y vigente; ni su nombre ni su número (decisión pendiente, D4) |
| Otros servicios del prestador | En la ficha y en su perfil público |
| Guardar sin contratar | Idempotente, privado, sin aviso al prestador y sin contador público |
| Explicar por qué se muestra algo | Un código de razón en cada sugerencia y en cada resultado de búsqueda (dónde coincidió) |
| Sin resultados, datos ni reseñas | Estados vacíos honestos; media de reseñas `null`, nunca «0.0» |

### Decisiones tomadas en el código (provisionales)

1. **Una categoría desactivada saca del público** los servicios que la usan
   (cambia la decisión 5 del Incremento 2, por el requisito de este). No se
   borran, y al reactivarla vuelven.
2. **Las categorías se muestran en su orden**, no como «frecuentes»: no hay
   datos de uso que lo sostengan.
3. **Sin búsqueda, lo más reciente primero.** Con búsqueda, relevancia (título
   > categoría y resumen > descripción, prestador, zona y modalidad), con
   pesos que dominan: cada nivel pesa más que todo el de abajo junto.
4. **Ordenar por precio y el rango exigen una moneda**; no se convierte nada.
5. **Quien está bloqueado** con el prestador, en cualquier sentido, no ve sus
   servicios ni su perfil (la regla de la búsqueda global).
6. **El perfil público** muestra el nombre público, el tipo (profesional o
   empresa) y la fecha de admisión (mes y año). No hay foto ni presentación
   propias: el avatar social no se enlaza sin decisión (D8) y el resumen de la
   postulación es de la admisión.
7. **Un servicio guardado que deja de estar disponible** queda en la lista con
   el título que tenía AL GUARDARSE, sin contenido ni enlace, y se puede
   quitar (D7). Nunca el título vivo de algo que no es público.
8. **Sugerencias**: parecido a lo guardado, y publicado en los últimos 30 días.
   No se usa «prestador seguido» (revelaría su perfil social).
9. **Sin reseñas de servicio** hasta el Incremento 6. Las reseñas de perfil
   (`profile_reviews`) no se mezclan ni se enseñan como del servicio.

### Pendiente de la empresa

| # | Decisión | Qué pasa mientras tanto |
|---|---|---|
| D1 | **Categorías destacadas** en la entrada de Servicios | Las de primer nivel, en su orden (`sort_order`), cuatro y «Ver todas» |
| D2 | **Orden editorial** («seleccionados por Z») | No existe; sin búsqueda, recientes |
| D3 | **Filtros visibles** | Modalidad, precio (gratis / con precio en una moneda y rango / a consultar), zona y credencial verificada. Ninguno sin datos (fecha, calificación, idioma, urgencia) |
| D4 | **Credenciales públicas**: nombre, emisor, número parcial, país, vigencia | Solo «credencial profesional verificada por Z y vigente», sin detalle |
| D5 | **Qué significa comercialmente «verificado por Z»** | Se nombra exactamente lo comprobado (admisión, identidad, credencial vigente, servicio aprobado) y se dice que no garantiza el resultado |
| D6 | **C15**: el UUID del perfil en la ruta firmada de las imágenes | Sigue igual (§32). **Con el catálogo público el riesgo crece**: cada tarjeta, también sin sesión, lo lleva en su URL firmada. Sin archivos todavía, se puede cambiar antes de encender sin migrar nada; es lo recomendable |
| D7 | **Guardados que dejan de estar disponibles** | Se quedan con el título que tenían al guardarse y «ya no está disponible», sin contenido; se pueden quitar |
| D8 | **Información pública de persona frente a empresa** (foto, nombre legal o comercial, ciudad) | Solo el nombre público y el tipo; sin foto ni ciudad |
| D9 | **Criterio de las recomendaciones** | Parecido a lo guardado y publicado en 30 días; cada una con su razón. Sin señal, nada |
| D10 | **Mostrar la fecha de incorporación** | Se muestra el mes y el año de la admisión |
| D11 | **Origen futuro de las calificaciones** | Reseñas verificadas de atenciones (Incremento 6), separadas de las reseñas de perfil |
| D12 | **Texto legal de las señales de confianza** | «Estas comprobaciones no garantizan el resultado del servicio», bajo cada bloque |
| D13 | **Qué pasa al desactivar una categoría con servicios publicados** | Dejan de verse en el catálogo (el requisito del Incremento 3); quien los ofrece los ve «no visibles» y la confirmación de administración lo avisa. Sin aviso a la prestadora ni recuento previo |
| D14 | **Si un rango de precio incluye los precios «desde»** | Sí, por su importe mínimo, y la hoja de filtros lo dice |
| D15 | **La insignia de credencial en las tarjetas** | Es del prestador, no del servicio: «Prestador con credencial verificada». Si la empresa decide relacionar credenciales con categorías, podrá ser del servicio |

### Límites del Incremento 3

No hay disponibilidad, agenda, reservas, contratación, pagos, mensajes por
reserva, cancelaciones, check-in, sesiones, incidencias, devoluciones, reseñas
que crear, finanzas ni transferencias. Ni IA, ni motores externos de
búsqueda, ni un segundo recomendador. La ficha no tiene botón de contratar.
El push de un aviso sigue abriendo solo la aplicación (tarea abierta).

## Z Servicios, Incremento 4 — disponibilidad y agenda del prestador (30/09/2026)

El detalle técnico está en [`Z_SERVICIOS_ARQUITECTURA.md`](Z_SERVICIOS_ARQUITECTURA.md),
Parte IV (§50 en adelante). **Técnicamente cerrado el 30/09/2026 en `Edson`;
únicamente queda pendiente el QA físico** (§61). La 0092 se ejecutó a mano en
Supabase y se verificó ese día en solo lectura, **sin divergencias**, también
con la puerta de esquema y el rol real de la API. El código sigue **sin
desplegar** y `FEATURE_SERVICES`, **apagada**. Nada de lo que sigue se
presenta como política definitiva si la empresa no lo confirmó: E1–E12 siguen
siendo suyas.

### Requisitos cumplidos

| Requisito | Cómo |
|---|---|
| Configurar cuándo se ofrece cada servicio | Una agenda por servicio: zona IANA, activa o en pausa, preparación, descanso e intervalo entre inicios |
| Reglas semanales | Día, franja de 5 en 5 minutos (hasta las 24:00), modalidad, capacidad y activa o no. Dos activas del mismo día no se cruzan: lo impide la base |
| Duración real y separación | La duración es la de la versión publicada (o, sin ella, la que se prepara); cada horario ocupa preparación + duración + descanso, y ese bloque entero cabe en la franja |
| Excepciones por fecha | Cerrar el día, cerrar una franja, añadir una franja o sustituir la semana ese día. Dos excepciones de la misma fecha no se pisan |
| Bloqueos manuales | Un intervalo real con motivo privado (hasta 200 caracteres) que solo ve el prestador |
| Capacidad | Individual: uno. Grupal: hasta la capacidad de la versión. Solo teórica: nada se descuenta |
| Zona horaria | IANA con lugar, elegida (no se toma la del teléfono); instantes en UTC; conversión en un solo sitio del servidor; horario de verano probado |
| Consulta pública | Fechas con horarios (de 31 días en 31) y horarios de una fecha, solo de lo público y dentro de la antelación y el horizonte |
| Historial mínimo | Cada cambio de la agenda deja su línea (sin el motivo de los bloqueos) |
| Terminar al enseñar un horario | Elegir un horario solo lo guarda en la ruta de la app. Ninguna reserva, retención, pedido ni cobro |

### Decisiones tomadas en el código (provisionales)

1. **La agenda es del servicio**, no de una versión ni del prestador: editar la
   descripción no la toca. La duración, la modalidad y la capacidad se leen de
   la versión publicada cada vez.
2. **Precedencia**: lo que cierra (bloqueo, día cerrado, franja cerrada) gana
   siempre; después, las excepciones de la fecha (`replace` sustituye la
   semana; `extra` solo suma lo que el día no tenía); después, la semana; y la
   configuración general (duración, separación, intervalo, antelación y
   horizonte).
3. **Una franja no cruza la medianoche**: termina como tarde a las 24:00. Una
   atención de 23:00 a 01:00 son dos franjas y no genera un horario que las
   junte.
4. **Horario de verano**: una hora local que no existe se lleva al salto; una
   que se repite, a la primera vez. Los horarios se cuentan en tiempo real.
5. **Un borrador puede preparar su agenda**; el público solo la ve cuando el
   servicio es público.
6. **Cambiar la zona se confirma**: la semana y las excepciones pasan a leerse
   en la nueva; los bloqueos no se mueven.
7. **Un prestador suspendido** ve su agenda pero no la cambia; un servicio
   **retirado**, tampoco.
8. **Modalidad**: la de la versión publicada y la de la que se prepara; el
   público solo ve la publicada.
9. **Con un intervalo menor que la duración**, los horarios son inicios
   alternativos que se solapan: elegir uno excluirá a los que se le cruzan
   cuando existan las reservas (Incremento 5).
10. **Sin panel de administración de agendas**: el blueprint lo pide para las
    reservas (A04), que no existen. Moderación y administración reciben el
    mismo 404 que cualquiera que no sea el dueño.
11. **Sin avisos ni auditoría general**: cambiar la agenda propia deja su
    historial, no un aviso ni una línea de `audit_events`.

### Pendiente de la empresa

| # | Decisión | Qué pasa mientras tanto |
|---|---|---|
| E1 | **Antelación mínima** para mostrar un horario | 2 horas (el provisional del documento de reglas, 4.5), configurable con `SERVICES_AGENDA_NOTICE_MINUTES` |
| E2 | **Horizonte**: hasta cuántos días por delante | 60 días (provisional de 4.6), configurable con `SERVICES_AGENDA_HORIZON_DAYS` |
| E3 | **Si el prestador elige su antelación y su horizonte** (el blueprint P03 lo sugiere) | No: son de la plataforma |
| E4 | **Feriados**: si Z carga los del país o los marca cada prestador | Cada prestador los marca como «Cerrar todo el día» |
| E5 | **Enseñar la capacidad al público** («hasta N personas») | La API la devuelve; la app no la enseña. Nunca un «quedan» |
| E6 | **Cómo se enseña la hora a quien está en otra zona** | Horas de la agenda, con su zona, y un aviso si el teléfono está en otra |
| E7 | **Límites de uso** (50 reglas, 200 excepciones y 200 bloqueos por venir, un bloqueo de 31 días como mucho, 366 días de adelanto, 31 días por consulta, 96 horarios por página) | Los técnicos de `agenda_politica.py` |
| E8 | **Recursos y varios profesionales** de una empresa (sala, equipo, `providerMember`) | No existen: la agenda es del servicio |
| E9 | **Calendarios externos** (Google, Outlook) | Fuera de este incremento |
| E10 | **«Avísame cuando haya horarios»** | No existe; se dice que no hay horarios |
| E11 | **Qué pasa con las reservas al cambiar la agenda** | No hay reservas. El Incremento 5 tendrá que decidir (el blueprint pide no alterar las existentes) |
| E12 | **Si cerrar una franja parte la franja o solo quita los horarios que toca** | Solo los quita: la rejilla sigue la del inicio de la franja (09–17 con 45 min y cerrado 12–13 da 11:15 y después 13:30, no 13:00). Con dos reglas (09–12 y 13–17), sí sale 13:00. Cambiarlo es restar lo cerrado de las franjas antes de generar |

### Límites del Incremento 4

No hay reservas, retenciones, contratación, pedidos, aceptación de
condiciones, direcciones, cobros, Stripe, saldos, devoluciones, disputas,
recordatorios, asistencia, reseñas, posventa ni calendarios externos. El
Incremento 5 **no se empezó**. El push de un aviso sigue abriendo solo la
aplicación (tarea abierta).

### Cierre técnico (30/09/2026)

- **0092 aplicada y verificada** en Supabase, en solo lectura y sin
  divergencias: las cinco tablas definición por definición, el ORM, §57 y el
  esquema público entero frente a una referencia 0001–0092. La transacción de
  la 0092 no escribió ninguna fila de datos. Su huella está en `APLICADAS`:
  ya no se edita.
- **La puerta**, con el rol real de la API y en un proceso nuevo, dice «sí» a
  la admisión, el catálogo, los guardados y la agenda.
- **Una corrección técnica, no de negocio**: la puerta no exigía que los
  índices de las claves primarias y de las exclusiones estuvieran válidos y
  listos (una exclusión con su índice a medias no impide los cruces). Ahora
  lo exige, con su prueba y su mutación.
- **Sigue siendo de la empresa**: E1–E12 (arriba), **C15** antes de encender
  Servicios (D6) y el **destino del push** de un aviso.
- **Producción**: cuando se despliegue `Edson`, reiniciar la API (el
  despliegue lo hace): la puerta recuerda el «no».
- **Pendiente**: el QA físico (`Z_QA_FISICO_PENDIENTE.md`, «Incremento 4»).
