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

/**
 * Separacion entre celdas, en pixeles: una linea fina, la de Instagram.
 *
 * Eran 3. Instagram separa las celdas de su perfil con 1 px (en su web cada
 * celda lleva `margin-inline-end: 1px` y cada fila `margin-bottom: 1px`), y
 * con celdas verticales tres pixeles se leian como un marco alrededor de cada
 * foto en vez de como un mosaico.
 */
export const GRID_GAP = 1;

/** Columnas de la cuadricula de publicaciones. */
export const GRID_COLUMNS = 3;

/**
 * Proporcion de cada celda, ANCHO entre ALTO: 3:4, vertical.
 *
 * Es la de la cuadricula del perfil de Instagram desde enero de 2025, cuando
 * cambio los cuadrados por rectangulos «altos» (Adam Mosseri, Threads,
 * 19/01/2025). Su propia web lo confirma: cada celda se dibuja con
 * `padding-bottom: 133.33%`, es decir, 4 de alto por cada 3 de ancho, y la
 * foto la llena recortada desde el centro (`object-fit: cover`).
 *
 * El cuadrado recortaba sin piedad lo que casi todo el mundo sube, que son
 * fotos y videos verticales hechos con el movil: a una foto 3:4 le quitaba un
 * cuarto de la altura y a un video 9:16 casi la mitad.
 *
 * Ojo: es la proporcion de la CELDA, no la de la publicacion. Al abrirla, la
 * publicacion se ve con la suya; y lo que hay guardado en Storage no cambia.
 */
export const GRID_TILE_ASPECT_RATIO = 3 / 4;

/**
 * Ancho de cada celda dentro de un contenedor de `ancho` pixeles.
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

/**
 * Alto de una celda de `anchoDeCelda` pixeles (lo que da `gridItemSize`).
 *
 * Entero, igual que el ancho: media unidad deja una linea suelta al pintar.
 * Devuelve 0 si no hay ancho todavia, asi quien llama no dibuja nada.
 */
export function gridItemHeight(
  anchoDeCelda: number,
  proporcion: number = GRID_TILE_ASPECT_RATIO,
): number {
  if (!Number.isFinite(anchoDeCelda) || anchoDeCelda <= 0) return 0;
  if (!Number.isFinite(proporcion) || proporcion <= 0) return 0;
  return Math.round(anchoDeCelda / proporcion);
}
