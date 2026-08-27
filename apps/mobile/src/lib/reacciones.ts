/**
 * Cómo se mezcla lo que dice el servidor con lo que ya sabíamos.
 *
 * EL FALLO QUE ARREGLA. Inicio y Explorar enseñan LAS MISMAS publicaciones,
 * pero cada pantalla las pide por su lado y recibe tandas distintas. Al cargar
 * el muro se hacía `likedPostIds = respuesta.likedIds`, que sustituye la lista
 * entera: los me gusta de todo lo que no viniera en ESA página se borraban. Como
 * los vídeos de Inicio no vienen en la página del muro, sus corazones se
 * apagaban solos al pasar por Explorar.
 *
 * Y lo contrario tampoco vale: quedarse con la unión de las dos listas dejaría
 * pegado para siempre un me gusta que se quitó desde otro dispositivo.
 *
 * La respuesta correcta necesita saber QUÉ PUBLICACIONES VENÍAN en la tanda,
 * no solo cuáles llevaban me gusta. Con eso se distingue «esta no le gusta» de
 * «de esta no me han dicho nada», que era justo lo que faltaba.
 */
export function mezclarReacciones(
  actuales: readonly string[],
  idsDeLaTanda: readonly string[],
  idsConMeGusta: readonly string[],
): string[] {
  // Sin tanda no hay nada que corregir: el servidor no ha hablado de nada.
  if (idsDeLaTanda.length === 0) return [...actuales];

  const deLaTanda = new Set(idsDeLaTanda);
  const conMeGusta = new Set(idsConMeGusta);

  // Lo que el servidor no ha mencionado se queda como estaba.
  const conservados = actuales.filter((id) => !deLaTanda.has(id));
  // Y de lo que sí ha mencionado, manda él.
  const confirmados = idsDeLaTanda.filter((id) => conMeGusta.has(id));

  // `Set` al final porque una tanda puede repetir un id (dos páginas que se
  // solapan) y la lista se usa con `includes`: un duplicado no rompe nada
  // visible, pero hace que quitar el me gusta deje una copia dentro.
  return [...new Set([...conservados, ...confirmados])];
}


/**
 * Cómo se lee un aviso de reacciones cuando hay más de una persona.
 *
 * Antes salía «A Edson le gustó tu publicación» una vez POR CADA persona: con
 * cien reacciones, cien avisos idénticos y la pantalla de notificaciones
 * inservible. El servidor ya los agrupa y manda cuánta gente hay en total;
 * aquí solo se escribe la frase.
 *
 * `total` puede faltar (un backend anterior a este cambio) o venir a 0 —nadie
 * reaccionó, pero el aviso sigue guardado porque quitar un me gusta no borra
 * la notificación—. En los dos casos se cae al texto de siempre, que sigue
 * siendo correcto: hubo una reacción y la hizo esta persona.
 */
export function textoDeReacciones(actor: string, total?: number | null): string {
  const otros = (total ?? 0) - 1;
  if (otros <= 0) return `A ${actor} le gustó tu publicación`;
  if (otros === 1) return `${actor} y 1 persona más reaccionaron a tu publicación`;
  return `${actor} y ${otros} personas más reaccionaron a tu publicación`;
}
