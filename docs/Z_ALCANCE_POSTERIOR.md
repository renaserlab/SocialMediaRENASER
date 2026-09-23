# Eventos, Servicios y Productos: preparados, no construidos

Estas tres verticales **no se implementan todavía**. Este documento existe para
que cuando les toque no se empiece desde cero, y para dejar por escrito qué se
puede reutilizar y qué no.

**No hay código especulativo para ninguna.** No se han creado tablas, endpoints
ni modelos «por si acaso»: una abstracción sin un caso real que la use es una
abstracción que se diseñará mal.

Fuentes: `Z_Eventos_Blueprint_Producto.docx`,
`Z_Servicios_Excelencia_Blueprint_Final.docx`,
`Z_Productos_Excelencia_Blueprint.docx`, y el orden de
`Plan_Spec_Driven_Z_Excelencia.docx`.

---

## Qué hay hoy, de verdad

| Vertical | Lo que existe | Lo que falta |
|---|---|---|
| **Eventos** | `catalog`: crear, editar, listar y reservar plaza. `bookings`: la reserva | Admisión del organizador, curaduría, tipos de entrada, inventario transaccional, ticket, QR, check-in, transferencia, cambios esenciales, incidencias, devoluciones |
| **Servicios** | `bookings`: una reserva simple entre dos personas, con `completed_at` | Catálogo, credenciales del prestador, agenda, zonas horarias, huecos, recursos, retención temporal, cotización, reprogramación, asistencia, no-show, incidencias |
| **Productos** | Nada | Toda la vertical |

La reserva actual de `bookings` **es un puente, no el modelo final** de
Servicios. Sirve hoy y no debe estirarse: la agenda, la capacidad y la
concurrencia de un prestador no caben ahí.

---

## Qué se puede reutilizar

Estable y probado; se comparte sin discusión:

- identidad, perfiles, roles y autorización en servidor;
- notificaciones, mensajería, búsqueda, moderación;
- almacenamiento de medios con URL firmada;
- **las primitivas comerciales**: orden, cobro, derecho, reembolso, saldo,
  transferencia, y sus patrones de idempotencia y conciliación;
- el patrón de webhook: guardar en crudo antes de interpretar, índice único como
  barrera anti-repetición, savepoint para aislar lo que puede fallar;
- las banderas y la costumbre de que nazcan apagadas;
- componentes visuales, i18n, navegación y el botón Atrás de Android.

## Qué no se puede compartir

**Una sola máquina de estados comercial para las cuatro verticales sería un
error.** Cada dominio tiene su ciclo, sus obligaciones legales y sus riesgos:

| Dominio | Su ciclo |
|---|---|
| Curso | compra → acceso → progreso → garantía → revocación |
| Evento | inventario → entrada → ticket → transferencia → check-in |
| Servicio | disponibilidad → retención → reserva → reprogramación → asistencia |
| Producto | variante → existencias → despacho → entrega → devolución → garantía |

Los blueprints de Servicios (§21.1) y Productos (§8) lo dicen explícitamente:
los estados de reserva, pago, transferencia, incidencia y reseña van **separados**.

### La prueba que hay que pasar antes de crear una abstracción nueva

Cinco preguntas, y hay que contestar que sí a las cinco:

1. ¿Existe una necesidad **actual**, no prevista?
2. ¿No está ya cubierta por algo del proyecto?
3. ¿Reduce duplicación real, medible?
4. ¿No acopla estados que son incompatibles entre sí?
5. ¿Se puede probar por separado?

---

## Eventos v2 · el siguiente incremento

Es el que va primero: aprovecha el catálogo y tiene límites más claros que los
otros dos.

**Modelos propios que hará falta crear:** solicitud de admisión, versión del
evento, tipo de entrada, inventario, ticket, evento de check-in, incidencia.

**Estados propios:** `DRAFT`, `SUBMITTED`, `CONDITIONAL`, `APPROVED`,
`PUBLISHED`, `SOLD_OUT`, `SUSPENDED`, `MODIFIED`, `CANCELLED`, `IN_PROGRESS`,
`COMPLETED_PENDING`, `SETTLED`.

**Las reglas que no se pueden relajar:**

- Cero sobreventa: `vendidas + reservadas` nunca supera el aforo aprobado. En el
  servidor, con reserva atómica; jamás con un contador del cliente.
- Retención temporal de 10 minutos desde que empieza el pago, liberada al
  vencer.
- La entrada se emite **solo** tras el webhook de pago confirmado.
- **Solo un asistente verificado puede reseñar.** Comprar no basta: hace falta
  validación de acceso ligada a la cuenta que opina. Si la entrada se
  transfirió, la reseña la escribe quien entró.
- Un cambio esencial —fecha, ciudad, recinto, ponente principal, reducción de
  contenido— versiona el evento y abre la opción de devolución.

**Bloqueos:** entidad que cobra, impuestos, política de devolución por país,
permisos y aforo, comisión, y el modelo de liquidación por perfil de riesgo del
organizador (§10.4 del blueprint).

**Criterios de aceptación de la fase:** último cupo con dos compras
simultáneas; webhook duplicado; QR reutilizado; transferencia de entrada;
permiso vencido que suspende ventas automáticamente.

---

## Servicios v1

Es el más caro de los tres: la agenda es un problema de concurrencia y de husos
horarios, no de pantallas.

**Modelos propios:** prestador, credencial, servicio, variante, regla de
disponibilidad, excepción de disponibilidad, retención de hueco, reserva,
participante, evento de validación, incidencia.

**Estados separados, y esto es obligatorio:** `booking.status`,
`payment.status`, `transfer.status` y `review.status` son cuatro máquinas
distintas. Mezclarlas es el error que el blueprint señala por su nombre.

**Reglas duras:** disponibilidad calculada en el servidor y nunca en el cliente;
zona horaria IANA guardada con la reserva; retención de hueco con caducidad;
reprogramación **atómica** —o se mueve o no se mueve—; el no-show se determina,
no se declara.

**Límite ético explícito del blueprint:** la IA puede ayudar a describir una
necesidad, pero **no emite diagnósticos** y la persona tiene que poder corregir
lo que la IA escribió.

**Bloqueos (D01–D10 del blueprint):** países iniciales, entidad que cobra,
procesador y pagos a Perú, comisión, plazo de confirmación, duración de la
retención, política base de cancelación por categoría, categorías reguladas,
canales de soporte y emergencia, y retención de datos.

---

## Productos v1

Vertical nueva entera, y la que más depende de terceros: inventario, logística,
devoluciones físicas y garantía.

**Modelos propios:** producto, variante, evaluación, vendedor, lote de
inventario, carrito, pedido, línea de pedido, envío, evento de entrega,
incidencia, evidencia, resolución, devolución, reclamación de garantía, política
por jurisdicción.

**Las dos reglas que definen el producto:**

1. **Las 72 horas.** El evento `DELIVERED` del transportista fija `deliveredAt`;
   el **servidor** calcula `deliveredAt + 72 h`. Conformidad libera de
   inmediato; el silencio libera al vencer; una incidencia congela. El plazo
   operativo **no extingue la garantía legal**.
2. **Sin política no se vende.** Si no existe una `JurisdictionPolicy` aprobada
   para el país, la venta se bloquea. La orden conserva la versión de política y
   una copia inmutable de los términos aceptados.

**Bloqueos:** logística y transportistas, política por jurisdicción, garantía
legal por país, quién paga la devolución en cada caso, y evaluación de
vendedores.

---

## Orden y dependencias

| Fase | Depende de |
|---|---|
| Cerrar Cursos | D1–D5, y las seis cosas de la §6 de [`Z_REQUISITOS_Y_DECISIONES.md`](Z_REQUISITOS_Y_DECISIONES.md) |
| Eventos v2 | Cursos cerrado + decisiones de eventos |
| Servicios v1 | D01–D10 de su blueprint |
| Productos v1 | Logística, legal y políticas por país |
| Dinero real | Cuenta empresarial y decisiones financieras (D4) |

Las estimaciones del plan (10–15 días para Eventos, 15–25 para Servicios y para
Productos) son de implementación y verificación. **No incluyen** esperas por
decisiones, credenciales, revisión legal, pilotos ni publicación en tiendas.
