/**
 * EL ALTO DE LÍNEA QUE NECESITA UN EMOJI PARA NO SALIR CORTADO.
 *
 * EL FALLO (teléfono, 06–07/10/2026): en el directo las reacciones salían
 * recortadas por arriba y por abajo. Se pintaban con `<Text style={{ fontSize:
 * 30 }}>`, y el `Text` de la aplicación trae de fábrica el alto de línea del
 * cuerpo (21,7): un emoji de 30 en una línea de 21,7. Android recorta el texto a
 * su línea; iOS no, y por eso no se había visto.
 *
 * LA CUENTA. El dibujo de un emoji es más alto que su tamaño de letra —sube y
 * baja más que una letra—: en la tipografía de emojis de Android ocupa del
 * orden de 1,2 veces. Se deja 1,35 para que tampoco lo roce el ligero aumento
 * de las burbujas al subir.
 *
 * Quien pinte un emoji más grande que el texto de alrededor pide aquí su línea.
 */
const PROPORCION = 1.35;

export function lineaDeEmoji(tamano: number): number {
  return Math.ceil(tamano * PROPORCION);
}

/** El estilo completo: tamaño y la línea que le corresponde. */
export function estiloDeEmoji(tamano: number): { fontSize: number; lineHeight: number } {
  return { fontSize: tamano, lineHeight: lineaDeEmoji(tamano) };
}
