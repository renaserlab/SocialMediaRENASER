/**
 * El SDK de compras de las tiendas, solo en un teléfono.
 *
 * Puede lanzar —en Expo Go el módulo nativo no viaja—: quien llama
 * (`revenueCat.ts`) lo envuelve en `try/catch` y comprueba la forma del módulo.
 * Por qué hay una versión para web, en `sdkDeCompras.ts`.
 */
export function requerirSdkDeCompras(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('react-native-purchases');
}
