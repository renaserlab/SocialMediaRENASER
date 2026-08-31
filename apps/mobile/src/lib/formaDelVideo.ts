/**
 * QUE FORMA TIENE ESTE VIDEO. Una sola respuesta, y con limites.
 *
 * EL FALLO. En el muro, un video grabado en vertical salia con dos franjas
 * negras enormes. No era el reproductor: era la CAJA. La tarjeta pintaba
 * siempre `aspectRatio: 16/9` —un rectangulo apaisado— y le pedia al video que
 * cupiera dentro sin deformarse (`contain`). Un 9:16 dentro de un 16:9 ocupa
 * menos de un tercio del ancho: el resto es fondo. Y el dato para no
 * equivocarse ya estaba ahi: `post_media.width` y `post_media.height` se
 * guardan desde la migracion 0021, pero solo los leian las FOTOS.
 *
 * POR QUE NO SE USA LA PROPORCION TAL CUAL. Dos motivos:
 *
 *  - Un video muy alto (por ejemplo 1:3) ocuparia varias pantallas de muro y
 *    empujaria fuera de la vista el texto, el autor y los botones.
 *  - Un panoramico muy ancho quedaria como una rendija de cuarenta pixeles.
 *
 * Asi que la proporcion real se RESPETA dentro de un rango y se recorta fuera
 * de el. Con `contentFit="contain"` eso significa que un caso extremo vuelve a
 * tener franjas —pero pequeñas, y solo en el caso raro— en vez de que las tenga
 * el caso comun, que es un video de movil en vertical.
 */

/** Lo mas ancho que se pinta: el apaisado de siempre. */
export const MAS_APAISADA = 16 / 9;
/** Lo mas alto que se pinta: el vertical de siempre. */
export const MAS_VERTICAL = 9 / 16;

/**
 * Proporcion (ancho / alto) con la que dibujar la caja de un video.
 *
 * Sin medidas guardadas devuelve el apaisado, que es lo que habia y lo que
 * menos sorprende: una publicacion antigua sin metadatos se sigue viendo como
 * hasta ahora en vez de cambiar de tamaño al azar.
 */
export function relacionDeVideo(ancho?: number | null, alto?: number | null): number {
  if (!ancho || !alto || ancho <= 0 || alto <= 0) return MAS_APAISADA;
  const relacion = ancho / alto;
  if (!Number.isFinite(relacion)) return MAS_APAISADA;
  return Math.min(MAS_APAISADA, Math.max(MAS_VERTICAL, relacion));
}

/**
 * ¿Este video es mas alto que ancho?
 *
 * Sirve para decidir el encuadre: un vertical llena la caja (`cover`) porque
 * ya la ocupa entera, y un apaisado se ensena completo (`contain`).
 */
export function esVertical(ancho?: number | null, alto?: number | null): boolean {
  if (!ancho || !alto) return false;
  return alto > ancho;
}
