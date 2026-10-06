/**
 * Cuánto hay que apartar un marco para que el teclado no lo tape.
 *
 * Los dos números van en las mismas coordenadas (la ventana, en puntos): el
 * borde INFERIOR del marco y el borde SUPERIOR del teclado. Lo que el marco
 * baja por debajo de ese borde es lo que queda tapado, y es lo que se aparta.
 *
 * Nunca negativo: un teclado que queda por debajo del marco no tapa nada. Y
 * sin decimales, para no pedir un repintado por medio punto.
 *
 * Es una función aparte, sin React, para poder probarla: ver
 * `components/SinTecladoDelante.tsx`.
 */
export function huecoParaElTeclado(bordeInferiorDelMarco: number, bordeSuperiorDelTeclado: number): number {
  if (!Number.isFinite(bordeInferiorDelMarco) || !Number.isFinite(bordeSuperiorDelTeclado)) return 0;
  return Math.max(0, Math.round(bordeInferiorDelMarco - bordeSuperiorDelTeclado));
}
