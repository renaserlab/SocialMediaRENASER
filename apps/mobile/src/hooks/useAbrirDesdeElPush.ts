/**
 * En el navegador no hay push nativo que tocar: no se hace nada.
 *
 * El de verdad es `useAbrirDesdeElPush.native.ts`; este fichero, sin sufijo, es
 * el que usa la web y el que resuelve TypeScript. Separados por la extension
 * —como `live/registro100ms`— para que el navegador no tenga que cargar la
 * escucha de respuestas de `expo-notifications`.
 */
export function useAbrirDesdeElPush(_navegadorMontado: boolean): void {
  // Nada que escuchar.
}
