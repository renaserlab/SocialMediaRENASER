/**
 * «Llévame a este mensaje», de una pantalla a la del chat.
 *
 * Desde «Contenido» se toca un resultado y se vuelve al chat que ya estaba
 * abierto debajo. A esa pantalla no se le puede pasar un parámetro nuevo al
 * volver atrás, así que el encargo se deja aquí y el chat lo recoge al
 * recuperar el foco —o al montarse, si hubo que abrirlo de nuevo—.
 *
 * UNO POR CONVERSACIÓN, Y SE GASTA AL RECOGERLO: volver al chat más tarde por
 * otro camino no puede saltar otra vez a un mensaje que ya se fue a ver.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */
const PENDIENTES = new Map<string, string>();

/** Deja el encargo. El siguiente chat de esa conversación que tenga el foco lo cumple. */
export function pedirSalto(conversationId: string, mensajeId: string): void {
  if (!conversationId || !mensajeId) return;
  PENDIENTES.set(conversationId, mensajeId);
}

/** Recoge el encargo de esa conversación, si lo hay, y lo da por cumplido. */
export function tomarSalto(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  const mensajeId = PENDIENTES.get(conversationId) ?? null;
  PENDIENTES.delete(conversationId);
  return mensajeId;
}

/** Cuántas páginas de historial se suben, como mucho, buscando el mensaje. */
export const PAGINAS_PARA_IR_A_UN_MENSAJE = 10;
/** Cuántos mensajes trae cada una de esas páginas (el tope del servidor). */
export const MENSAJES_POR_PAGINA_AL_BUSCAR = 100;
/** Cuánto dura el resalte del mensaje al que se llegó. */
export const RESALTE_MS = 2500;
