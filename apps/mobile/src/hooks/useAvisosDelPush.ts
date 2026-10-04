/**
 * En el navegador no llegan push: no hay nada que escuchar.
 *
 * La versión del teléfono está en `useAvisosDelPush.native.ts`. Los avisos con
 * la aplicación abierta siguen saliendo en web por el otro camino
 * (`useAvisosEnVivo`), que no depende del push.
 */
export function useAvisosDelPush(): void {}
