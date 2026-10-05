/**
 * Si el navegador DE LA APLICACIÓN ya está montado: el `<Stack>` que pinta el
 * layout raíz, no el envoltorio interno del enrutador.
 *
 * EL FALLO QUE ESTO CIERRA (05/10/2026). La aplicación dejaba de abrirse
 * —«Maximum update depth exceeded»— después de tocar una notificación. Dos
 * ganchos del layout raíz esperaban a «la navegación» antes de navegar, y la
 * señal que usaban (`useRootNavigationState()?.key`) no decía eso: es la clave
 * del navegador INTERNO del enrutador, que existe desde el primer instante,
 * también mientras el layout raíz devuelve `null` porque aún no ha hidratado.
 * La guarda no guardaba nada.
 *
 * Y navegar en ese hueco no se pierde, que sería lo de menos: el enrutador
 * busca el navegador más profundo donde aplicar la orden y, como el `<Stack>`
 * todavía no existe, la aplica al interno. Eso añade OTRA raíz y vuelve a
 * montar el layout entero; el layout nuevo lee el mismo toque —la biblioteca
 * de avisos lo sigue teniendo—, vuelve a navegar, y así hasta que React corta
 * el bucle. Pasaba en cada arranque en frío mientras el sistema siguiera
 * entregando aquel toque, o sea, siempre.
 *
 * La señal buena se lee del estado de navegación: la ruta raíz tiene estado
 * anidado solo cuando el `<Stack>` del layout se ha montado y registrado.
 */

/** Lo mínimo que se mira de un estado de navegación. */
export type EstadoDeNavegacion = {
  index?: number;
  routes?: readonly { state?: EstadoDeNavegacion | null }[];
};

export function navegadorDeLaAppMontado(raiz: EstadoDeNavegacion | null | undefined): boolean {
  const rutas = raiz?.routes;
  if (!Array.isArray(rutas) || rutas.length === 0) return false;
  // La ruta enfocada del navegador interno es el layout raíz.
  const actual = rutas[raiz?.index ?? rutas.length - 1] ?? rutas[rutas.length - 1];
  const anidado = actual?.state?.routes;
  return Array.isArray(anidado) && anidado.length > 0;
}

/** Cada cuánto se vuelve a mirar mientras no esté. */
export const ESPERA_ENTRE_MIRADAS_MS = 50;
/**
 * Cuántas veces se mira antes de dejarlo. Cinco segundos: si en ese tiempo no
 * hay navegador, no se navega —que es el lado seguro— y lo pendiente se queda
 * sin abrir en vez de romper el arranque.
 */
export const MIRADAS_MAXIMAS = 100;
