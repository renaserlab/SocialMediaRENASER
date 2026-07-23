/**
 * Interruptores de funcionalidad.
 *
 * Sirven para dejar en el codigo cosas que todavia no se pueden mostrar, en vez
 * de borrarlas y tener que rehacerlas. Un flag se cambia en un sitio y afecta a
 * toda la app.
 */

/**
 * Compras dentro de la aplicacion.
 *
 * En `false` RENASER se comporta como una app de MIEMBROS: los cursos forman
 * parte del acceso y no se muestra precio ni ningun boton de compra.
 *
 * Por que esta apagado: hoy no hay ninguna pasarela de pago real. La pantalla
 * de compra simula el cobro (`purchaseCourse` solo guarda el id en memoria), y
 * Apple rechaza las apps con flujos de compra que no completan una transaccion
 * («app incompleta», directriz 2.1). Ademas, en cuanto se venda contenido
 * digital dentro de la app, Apple obliga a usar SUS compras integradas y se
 * queda con su comision: no es un detalle de implementacion, es una decision de
 * negocio que hay que tomar antes de encenderlo.
 *
 * Para reactivarlo hay que, ademas de poner esto en `true`, sustituir el cobro
 * simulado de `CheckoutScreen` por compras integradas reales en iOS.
 */
export const FEATURE_PURCHASES = false;
