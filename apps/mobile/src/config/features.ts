import { comprasHabilitadas } from '@/services/comprasConfig';

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
 * YA NO ES UNA CONSTANTE: sale de `EXPO_PUBLIC_PURCHASES_MODE`, que vale
 * `off` (por defecto), `test` o `stores`. En `off` la aplicacion se comporta
 * como hasta ahora —no se muestra precio ni ningun boton de compra— y en los
 * otros dos si se vende.
 *
 * QUE CAMBIO DESDE QUE ESTO ERA `false` A SECAS. Habia dos motivos para
 * tenerlo apagado y los dos se han resuelto:
 *
 * 1. «No hay pasarela de pago». Ahora si: RevenueCat sobre Google Play y
 *    StoreKit en movil, y Stripe Checkout alojado en web.
 * 2. «Vender dentro de la app obliga a usar las compras integradas, con su
 *    comision». Cierto, y esa es justamente la decision que se ha tomado: se
 *    usan. La alternativa —cobrar fuera y enlazar desde la app— es lo que
 *    prohibe la directriz 3.1.1 de Apple, asi que no era una opcion.
 *
 * LO QUE SIGUE VALIENDO, Y NO SE REPITE: no hay compras SIMULADAS. La pantalla
 * que hubo aqui terminaba siempre en «transaccion rechazada» y su boton de
 * reintentar regalaba el curso; las tiendas rechazan los flujos de compra que
 * no completan una transaccion (directriz 2.1). El modo `test` no es una
 * simulacion local: es el Test Store de RevenueCat, que entrega `CustomerInfo`
 * de verdad y concede entitlements de verdad, asi que el codigo que se prueba
 * es el mismo que se publica.
 *
 * La comprobacion de que una release no lleve la clave del Test Store vive en
 * `services/comprasConfig.ts`.
 */
export const FEATURE_PURCHASES = comprasHabilitadas();

/**
 * Transmisiones en vivo.
 *
 * En `false` la pestana "Live" del Inicio existe y explica con claridad que
 * todavia no hay transmisiones, en lugar de inventarse una.
 *
 * Por que esta apagado: FALTA EL VIDEO. La sala si existe ya —`live_sessions`
 * y `live_messages` con RLS, chat y reacciones en tiempo real, moderacion y
 * limites anti-abuso, todo en el backend—, pero no hay proveedor de directo
 * contratado, asi que no hay ni punto de ingesta (RTMP/WHIP) ni reparto en
 * tiempo real. Lo unico parecido que hay es HLS de VIDEO YA GRABADO —el backend
 * empaqueta cada video subido y firma su playlist en `/media/{id}/hls/...`—,
 * que no tiene nada que ver.
 *
 * Y LO QUE NUNCA SE VUELVE A HACER: la pantalla `/live/[id]` que hubo aqui
 * reproducia un video de ejemplo con un chat guardado en memoria y un contador
 * de espectadores inventado. Eso es una maqueta, y ensenarla como si fuera un
 * directo es exactamente lo que el documento prohibe. Se borro a proposito.
 *
 * Que falta para encenderlo (bloqueo externo, no de codigo):
 *   1. Un proveedor de directo (LiveKit, Mux, Cloudflare Stream o similar) con
 *      cuenta, claves y coste asumido.
 *   2. Que `POST /live/sessions/{id}/credential` devuelva credencial de
 *      publicacion/visionado en vez del 503 `live_provider_not_configured` de
 *      hoy, y que la respuesta traiga `playback_available` en true.
 *
 * El resto ya esta escrito: `repositories/LiveRepository.ts` habla con el
 * dominio entero, `services/directoEnVivo.ts` lleva el tiempo real y
 * `screens/LiveScreen.tsx` pinta la sala. Mientras `playback_available` sea
 * false, esa pantalla dice que no hay video en lugar de fingir uno.
 */
export const FEATURE_LIVE = false;
