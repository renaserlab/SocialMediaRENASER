/**
 * Espera a que una hoja inferior termine de cerrarse antes de seguir.
 *
 * ## Por que hace falta
 *
 * Los `BottomSheet` son `Modal` de React Native. En iOS **no se puede presentar
 * nada encima de un Modal que sigue en pantalla**, y cerrarlo no es inmediato:
 * tiene una animacion de salida. Cualquier cosa lanzada durante ese cierre
 * —un dialogo, el selector de fotos, la camara— no llega a mostrarse, y encima
 * falla EN SILENCIO: no hay error, simplemente no ocurre nada.
 *
 * Es la causa de que los botones de subir historia y de cambiar la foto de
 * perfil no hicieran nada en el telefono.
 *
 * ## Como se usa
 *
 * ```ts
 * setSheetOpen(false);
 * await afterSheetClose();
 * const foto = await pickImage();
 * ```
 *
 * O con la variante de callback, cuando no hay nada que esperar despues:
 *
 * ```ts
 * closeThen(() => setSheetOpen(false), () => router.push('/otra'));
 * ```
 *
 * ## Sobre el retardo
 *
 * La animacion de un Modal ronda los 250-300 ms. Se usa 300 para ir holgados:
 * quedarse corto reproduce el fallo, y pasarse solo anade una pausa que no se
 * percibe porque coincide con la animacion que el usuario ya esta viendo.
 */

/** Milisegundos que tarda un Modal en desaparecer del todo. */
const CIERRE_DE_HOJA_MS = 300;

/** Espera a que la hoja se haya cerrado. Usar con `await` tras cerrarla. */
export function afterSheetClose(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CIERRE_DE_HOJA_MS));
}

/**
 * Cierra una hoja y ejecuta la accion cuando ya no esta en pantalla.
 *
 * @param close  Lo que cierra la hoja (normalmente un `setState(false)`).
 * @param action Lo que se ejecuta despues.
 */
export function closeThen(close: () => void, action: () => void): void {
  close();
  setTimeout(action, CIERRE_DE_HOJA_MS);
}
