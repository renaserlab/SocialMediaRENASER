/**
 * Qué conversación está abierta ahora mismo en pantalla.
 *
 * Sirve para UNA cosa: no avisar a alguien de lo que ya está leyendo. Si llega
 * un mensaje de la conversación que tiene delante, el mensaje aparece en la
 * conversación —lo pone el chat— y un aviso flotante encima sería anunciarle
 * lo que acaba de ver.
 *
 * Es una variable de módulo y no un estado: nadie se repinta por ella, solo se
 * consulta en el momento de decidir si se avisa. La pantalla de chat la pone
 * al ganar el foco y la quita al perderlo.
 *
 * SIN REACT: se prueba con el runner de Node.
 */
let conversacionALaVista: string | null = null;

export function marcarConversacionALaVista(conversacionId: string | null): void {
  conversacionALaVista = conversacionId;
}

/**
 * La quita SOLO si sigue siendo esa. Al pasar de un chat a otro, el nuevo gana
 * el foco antes de que el viejo termine de perderlo: sin la comprobación, la
 * salida del viejo borraría la marca del nuevo.
 */
export function dejarDeVerConversacion(conversacionId: string): void {
  if (conversacionALaVista === conversacionId) conversacionALaVista = null;
}

export function seEstaViendoLaConversacion(conversacionId: string | null | undefined): boolean {
  return !!conversacionId && conversacionALaVista === conversacionId;
}
