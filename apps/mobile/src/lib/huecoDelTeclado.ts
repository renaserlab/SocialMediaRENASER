/**
 * CUÁNTO HAY QUE APARTAR UN MARCO PARA QUE EL TECLADO NO LO TAPE.
 *
 * Lógica pura, sin React ni Android: se ejecuta en las pruebas tal cual.
 *
 * LOS DOS DATOS QUE HAY SOBRE EL TECLADO, Y POR QUÉ HACEN FALTA LOS DOS.
 *
 *   · EL AVISO DE REACT NATIVE (`keyboardDidShow`). Llega en cuanto el teclado
 *     se hace visible y dice dónde empieza. Pero en Android 11 o superior SOLO
 *     llega cuando el teclado aparece o desaparece: si cambia de alto estando
 *     abierto —sale la fila de sugerencias al empezar a escribir, se abre el
 *     panel de emojis, se cambia de idioma— no avisa nadie
 *     (`ReactRootView.checkForKeyboardEvents` compara solo la visibilidad).
 *     Ese era el fallo visto en teléfono el 06/10/2026: en el directo, en los
 *     comentarios y al publicar, el campo quedaba medio tapado por lo que
 *     había crecido el teclado después de abrirse.
 *
 *   · EL ALTO ASENTADO. Lo que mide el teclado de verdad, leído de los
 *     márgenes de la ventana cada vez que cambian. Sigue al teclado aunque
 *     cambie de alto, pero solo se conoce cuando la animación de apertura ha
 *     terminado.
 *
 * LA REGLA. Mientras el teclado se abre manda el aviso, que es el que llega
 * antes: el campo sube sin esperar. En cuanto hay alto asentado manda él, que
 * es el que no se queda viejo.
 */

/** Lo que el teclado tapa de un marco: de su borde inferior al borde superior del teclado. */
export function huecoParaElTeclado(bordeInferiorDelMarco: number, bordeSuperiorDelTeclado: number): number {
  const hueco = bordeInferiorDelMarco - bordeSuperiorDelTeclado;
  if (!Number.isFinite(hueco)) return 0;
  return Math.max(0, Math.round(hueco));
}

export type EstadoDelTeclado = {
  /** React Native dice que el teclado está a la vista. */
  visible: boolean;
  /** Dónde empieza el teclado según el aviso de React Native, o `null`. */
  bordeSegunElAviso: number | null;
  /** Alto real del teclado desde el borde inferior de la ventana; 0 si no se sabe. */
  altoAsentado: number;
  /** Alto de la ventana, en la misma medida que el marco. 0 si aún no se ha medido. */
  altoDeLaVentana: number;
};

export const TECLADO_CERRADO: EstadoDelTeclado = {
  visible: false,
  bordeSegunElAviso: null,
  altoAsentado: 0,
  altoDeLaVentana: 0,
};

/**
 * El hueco de un marco dado lo que se sabe del teclado.
 *
 * @param bordeInferiorDelMarco Dónde acaba el marco en la ventana, o `null` si
 *                              todavía no se ha medido: sin medida no se aparta
 *                              nada, que es mejor que apartar a ciegas.
 */
export function huecoDelMarco(bordeInferiorDelMarco: number | null, teclado: EstadoDelTeclado): number {
  if (bordeInferiorDelMarco === null) return 0;
  if (teclado.altoAsentado > 0 && teclado.altoDeLaVentana > 0) {
    return huecoParaElTeclado(bordeInferiorDelMarco, teclado.altoDeLaVentana - teclado.altoAsentado);
  }
  if (teclado.visible && teclado.bordeSegunElAviso !== null) {
    return huecoParaElTeclado(bordeInferiorDelMarco, teclado.bordeSegunElAviso);
  }
  return 0;
}

/**
 * El relleno inferior del marco.
 *
 * NO SE SUMA AL QUE YA TRAÍA LA PANTALLA: se queda el MAYOR. Una pantalla que
 * reserva sitio abajo para la barra de pestañas no necesita ese sitio ADEMÁS
 * del teclado —el teclado ya tapa la barra—, y sumarlos dejaba el campo
 * flotando a media pantalla. Sin teclado no se toca nada (`null`).
 */
export function rellenoInferior(hueco: number, rellenoDeLaPantalla: number): number | null {
  if (hueco <= 0) return null;
  return Math.max(hueco, rellenoDeLaPantalla);
}

/** Estados del teclado tal y como los numera Reanimated (`KeyboardState`). */
export const TECLADO_ABRIENDOSE = 1;
export const TECLADO_ABIERTO = 2;

/**
 * Lo que se le pasa a JavaScript desde el hilo de la interfaz.
 *
 *   · un número > 0: el teclado está abierto y mide eso;
 *   · 0: está cerrado, cerrándose o no se sabe;
 *   · -1: se está abriendo. No se dice nada todavía: el alto va creciendo
 *     fotograma a fotograma y avisar de cada uno sería repintar la pantalla
 *     sesenta veces por segundo. Hasta que se asiente vale el aviso.
 *
 * Es un `worklet`: la llama la reacción de Reanimated.
 */
export function altoQueSeAvisa(estado: number, alto: number): number {
  'worklet';
  if (estado === TECLADO_ABIERTO) return Math.max(0, Math.round(alto));
  if (estado === TECLADO_ABRIENDOSE) return -1;
  return 0;
}
