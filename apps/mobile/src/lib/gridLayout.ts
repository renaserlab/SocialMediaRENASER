/**
 * Reparto del ancho de una cuadricula entre sus columnas.
 *
 * Vive aparte y en pixeles a proposito. La cuadricula se definia con anchos en
 * porcentaje y la altura deducida de la proporcion, y eso NO se resuelve igual
 * en el navegador que en el movil: en el navegador salia bien y en la
 * aplicacion instalada las celdas se quedaban sin altura, asi que un perfil
 * anunciaba sus publicaciones y debajo no habia nada.
 *
 * Midiendo el contenedor y repartiendo el ancho a mano, el resultado es el
 * mismo en las dos plataformas y ademas se puede comprobar sin montar la
 * pantalla.
 */

/** Separacion entre celdas, en pixeles. */
export const GRID_GAP = 3;

/** Columnas de la cuadricula de publicaciones. */
export const GRID_COLUMNS = 3;

/**
 * Lado de cada celda cuadrada dentro de un contenedor de `ancho` pixeles.
 *
 * Devuelve 0 mientras no se conoce el ancho —el primer render ocurre antes de
 * medir—, para que quien llame sepa que todavia no puede dibujar.
 */
export function gridItemSize(
  ancho: number,
  columnas: number = GRID_COLUMNS,
  separacion: number = GRID_GAP,
): number {
  if (!Number.isFinite(ancho) || ancho <= 0 || columnas < 1) return 0;
  const disponible = ancho - separacion * (columnas - 1);
  if (disponible <= 0) return 0;
  // Hacia abajo: si se redondea hacia arriba, la suma de las columnas se pasa
  // del ancho y la ultima cae a la fila siguiente.
  return Math.floor(disponible / columnas);
}
