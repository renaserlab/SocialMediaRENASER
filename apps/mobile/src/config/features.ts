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
 * Transmisiones en vivo: el INTERRUPTOR DE LA BUILD.
 *
 * Sale de `EXPO_PUBLIC_FEATURE_LIVE` (`on` para encender), que se fija por
 * perfil en `eas.json`. La web no la lleva: en un navegador no hay SDK nativo
 * de 100ms, asi que ni se emite ni se ve.
 *
 * ENCENDIDO NO QUIERE DECIR «HAY DIRECTOS». Quiere decir que esta build sabe
 * hacerlos (lleva el SDK y los permisos nativos, version 1.1.0 en adelante).
 * Si hay video de verdad lo decide EL SERVIDOR: «Vivo» pregunta
 * `GET /live/availability`, que solo dice que si con 100ms configurado. Asi
 * encender o apagar los directos es cambiar la configuracion del servidor, sin
 * publicar otra app.
 *
 * Hasta el 23/09/2026 esto era `false` escrito a fuego, con el comentario de
 * que faltaba contratar proveedor. Ya no falta: el adaptador es
 * `live/salaDeVideo100ms.ts` y el backend firma las credenciales de 100ms.
 *
 * LO QUE NUNCA SE VUELVE A HACER: la pantalla `/live/[id]` que hubo aqui
 * reproducia un video de ejemplo con un chat guardado en memoria y un contador
 * de espectadores inventado. Eso es una maqueta, y se borro a proposito.
 */
export const FEATURE_LIVE = process.env.EXPO_PUBLIC_FEATURE_LIVE === 'on';
