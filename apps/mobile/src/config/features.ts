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

/**
 * Transmisiones en vivo.
 *
 * En `false` la pestana "Live" del Inicio existe y explica con claridad que
 * todavia no hay transmisiones, en lugar de inventarse una.
 *
 * Por que esta apagado: NO hay infraestructura de directo en el proyecto. Se
 * comprobo antes de escribir una linea de interfaz. Lo que hay es HLS de
 * VIDEO YA GRABADO —el backend empaqueta cada video subido y firma su playlist
 * en `/media/{id}/hls/...`—, que no tiene nada que ver: no existe punto de
 * ingesta (RTMP/WHIP), ni servidor de reparto en tiempo real, ni entidad de
 * emision, ni permisos, ni moderacion de directo. La pantalla `/live/[id]` que
 * habia reproducia un video de ejemplo con un chat guardado en memoria: eso es
 * una maqueta, y ensenarla como si fuera un directo es exactamente lo que el
 * documento prohibe.
 *
 * Que hace falta para encenderlo (bloqueo externo, no de codigo):
 *   1. Un proveedor de directo (LiveKit, Mux, Cloudflare Stream o similar) con
 *      cuenta, claves y coste asumido.
 *   2. Entidad `live_sessions` (emisor, estado, inicio/fin, grabacion) con RLS.
 *   3. Emision de tokens de publicacion/visionado desde el backend.
 *   4. Moderacion en directo y limites anti-abuso.
 *
 * El contrato de datos ya esta escrito en `src/feed/transmisiones.ts`: cuando
 * exista el proveedor, se implementa esa unica funcion y se enciende esto.
 */
export const FEATURE_LIVE = false;
