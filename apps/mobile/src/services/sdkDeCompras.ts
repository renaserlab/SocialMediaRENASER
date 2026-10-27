/**
 * En el navegador no hay SDK de compras de las tiendas: la web cobra con Stripe.
 *
 * POR QUÉ ESTE FICHERO EXISTE. `revenueCat.ts` ya devolvía `null` en web antes
 * de cargar `react-native-purchases`, pero Metro resuelve las
 * rutas de forma estática y no descarta código por una condición que solo se
 * conoce al ejecutar: el SDK entraba igual en el paquete de web. Medido el
 * 27/10/2026: 1,02 MB de los 8,25 MB del JavaScript de la web, para no usarse
 * nunca.
 *
 * Es el mismo patrón que `live/registro100ms.ts`: este fichero, sin sufijo, es
 * el que usan el navegador y TypeScript; en un teléfono Metro prefiere
 * `sdkDeCompras.native.ts`, que sí lo carga.
 */
export function requerirSdkDeCompras(): unknown {
  return null;
}
