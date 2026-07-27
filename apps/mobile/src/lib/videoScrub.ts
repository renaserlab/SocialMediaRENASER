/**
 * Cuentas de la barra de progreso arrastrable de los videos.
 *
 * Viven aparte del componente porque son la parte que se equivoca sin que se
 * note a simple vista: un arrastre que se pasa del final del video, una
 * division entre cero mientras aun no se conoce la duracion, o un `NaN` que
 * llega del reproductor antes de cargar y deja la barra sin pintar.
 *
 * Al ser funciones puras se pueden comprobar sin montar la pantalla.
 */

/** Encierra un valor entre 0 y 1. Un valor no numerico cuenta como 0. */
export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Posicion (0-1) del punto tocado dentro de una barra de `width` pixeles. */
export function ratioAtTouch(x: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return clampRatio(x / width);
}

/**
 * Posicion (0-1) tras arrastrar `dx` pixeles desde donde empezo el gesto.
 *
 * Se parte de la posicion inicial y se suma el desplazamiento en vez de leer
 * la coordenada absoluta del dedo: asi el calculo no depende de donde este
 * colocada la barra en la pantalla.
 */
export function ratioAfterDrag(startRatio: number, dx: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return clampRatio(startRatio);
  return clampRatio(startRatio + dx / width);
}

/** Segundo del video al que corresponde una posicion de la barra. */
export function secondsAt(ratio: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return clampRatio(ratio) * duration;
}

/** Avance (0-1) del video, para pintar la parte ya reproducida. */
export function progressRatio(currentTime: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return clampRatio(currentTime / duration);
}

/**
 * Salto relativo, en segundos, para los botones de accesibilidad.
 *
 * Quien navega con lector de pantalla no puede arrastrar: recorre la barra a
 * saltos. Se mueve en pasos del 5 % para que un video largo no exija decenas
 * de toques y uno corto no se salte entero de una vez.
 */
export function stepSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(1, duration * 0.05);
}
