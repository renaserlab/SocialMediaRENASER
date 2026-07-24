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
 * Por que esta apagado: no hay ninguna pasarela de pago. La habia simulada, y
 * se elimino —siempre terminaba en «transaccion rechazada» y su boton de
 * reintentar regalaba el curso—, porque las tiendas rechazan los flujos de
 * compra que no completan una transaccion («app incompleta», directriz 2.1 de
 * Apple).
 *
 * Encenderlo NO es solo cambiar esta constante. Vender contenido digital
 * dentro de la app obliga a usar las compras integradas de Apple y la
 * facturacion de Google Play, con su comision: es una decision de negocio, y
 * hay que construir el cobro de cero (la pantalla anterior ya no existe; vive
 * en el historial de git, commit 2a85dad).
 *
 * Mientras tanto la constante SI se usa: mantiene ocultos el precio en la
 * pantalla de curso y el campo de importe del panel de administracion, para que
 * no se pida un dato que hoy no significa nada.
 */
export const FEATURE_PURCHASES = false;
