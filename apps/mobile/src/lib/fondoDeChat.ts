/**
 * El fondo de un chat, que cada persona elige en su teléfono.
 *
 * ES DE CADA CONVERSACIÓN Y DE ESTE APARATO. Cambiar el fondo de un grupo
 * cambia ese grupo y ninguno más: quien pone una foto del equipo en el chat
 * del equipo no la quiere detrás de la conversación con su jefe. No viaja al
 * servidor y nadie más lo ve.
 *
 * LOS COLORES VAN POR PAREJAS, uno para el tema claro y otro para el oscuro.
 * Sobre el fondo se pinta texto que no lleva burbuja —la hora de un sticker,
 * las reacciones, el nombre de quien escribe—, así que cada color se queda
 * cerca del fondo de su tema: claro con claro, oscuro con oscuro. Un fondo
 * elegido en claro no deja ilegible el chat al pasar a oscuro.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

export type FondoDeChat =
  | { tipo: 'defecto' }
  | { tipo: 'color'; id: string }
  | { tipo: 'foto'; uri: string };

export const FONDO_POR_DEFECTO: FondoDeChat = { tipo: 'defecto' };

/** El fondo de cada conversación que tiene uno. Las demás no aparecen. */
export type FondosPorChat = Readonly<Record<string, FondoDeChat>>;

/** Dónde se guardan en el teléfono. */
export const CLAVE_DE_FONDOS = 'z.chat.fondos.v2';

/**
 * Donde se guardaba el fondo cuando era UNO SOLO para todos los chats
 * (11/10/2026). Ya no se lee como fondo: no se sabe en qué chat se eligió, y
 * ponérselo a todos es justo lo que se corrigió. Solo se usa para retirarlo.
 */
export const CLAVE_DEL_FONDO_COMUN = 'z.chat.fondo.v1';

export type ColorDeFondo = { id: string; claro: string; oscuro: string };

/** Los colores que se ofrecen, en el orden en que se enseñan. */
export const COLORES_DE_FONDO: readonly ColorDeFondo[] = [
  { id: 'arena', claro: '#F4EFE6', oscuro: '#17140F' },
  { id: 'menta', claro: '#E6F4EC', oscuro: '#0E1712' },
  { id: 'cielo', claro: '#E6F0FA', oscuro: '#0E141B' },
  { id: 'lavanda', claro: '#EEE9F8', oscuro: '#14111B' },
  { id: 'rosa', claro: '#FAE9EE', oscuro: '#1A1014' },
  { id: 'durazno', claro: '#FBEDE3', oscuro: '#1A130E' },
  { id: 'oliva', claro: '#EEF2E2', oscuro: '#14170E' },
  { id: 'gris', claro: '#ECEEF1', oscuro: '#121416' },
];

/**
 * Un fondo guardado, leído sin fiarse de nada.
 *
 * Cualquier cosa que no se entienda —un color que ya no existe, un texto
 * estropeado— es «por defecto»: el chat se ve como siempre, nunca en blanco.
 */
export function leerFondo(crudo: unknown): FondoDeChat {
  let valor: unknown = crudo;
  if (typeof crudo === 'string') {
    try {
      valor = JSON.parse(crudo);
    } catch {
      return FONDO_POR_DEFECTO;
    }
  }
  if (typeof valor !== 'object' || valor === null) return FONDO_POR_DEFECTO;
  const { tipo, id, uri } = valor as Record<string, unknown>;
  if (tipo === 'color' && typeof id === 'string' && COLORES_DE_FONDO.some((c) => c.id === id)) {
    return { tipo: 'color', id };
  }
  if (tipo === 'foto' && typeof uri === 'string' && uri.trim()) {
    return { tipo: 'foto', uri };
  }
  return FONDO_POR_DEFECTO;
}

/**
 * Los fondos guardados, leídos igual: sin fiarse de nada.
 *
 * Lo que no sea un fondo de verdad no entra en la lista, así que ese chat se
 * ve con el de siempre. Un guardado estropeado entero es una lista vacía.
 */
export function leerFondos(crudo: unknown): FondosPorChat {
  let valor: unknown = crudo;
  if (typeof crudo === 'string') {
    try {
      valor = JSON.parse(crudo);
    } catch {
      return {};
    }
  }
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return {};
  const fondos: Record<string, FondoDeChat> = {};
  for (const [conversacionId, guardado] of Object.entries(valor)) {
    if (!conversacionId.trim()) continue;
    const fondo = leerFondo(guardado);
    if (fondo.tipo !== 'defecto') fondos[conversacionId] = fondo;
  }
  return fondos;
}

/** Lo que se guarda. */
export function escribirFondos(fondos: FondosPorChat): string {
  return JSON.stringify(fondos);
}

/** El fondo de ESTA conversación. Si no eligió ninguno, el de siempre. */
export function fondoDe(fondos: FondosPorChat, conversacionId: string): FondoDeChat {
  // `hasOwn`, no `fondos[id]`: un identificador raro no puede sacar algo
  // heredado del objeto y hacerlo pasar por un fondo.
  return Object.prototype.hasOwnProperty.call(fondos, conversacionId)
    ? (fondos[conversacionId] ?? FONDO_POR_DEFECTO)
    : FONDO_POR_DEFECTO;
}

/**
 * La lista con el fondo de UNA conversación cambiado. Las demás, intactas.
 *
 * Volver al de siempre quita la conversación de la lista en vez de apuntar
 * «por defecto»: la lista solo crece con los chats que de verdad tienen fondo.
 */
export function conFondo(
  fondos: FondosPorChat,
  conversacionId: string,
  fondo: FondoDeChat,
): FondosPorChat {
  if (!conversacionId.trim()) return fondos;
  const resultado: Record<string, FondoDeChat> = {};
  for (const [id, suFondo] of Object.entries(fondos)) {
    if (id !== conversacionId) resultado[id] = suFondo;
  }
  if (fondo.tipo !== 'defecto') resultado[conversacionId] = fondo;
  return resultado;
}

/**
 * El color que se pinta detrás de los mensajes.
 *
 * Con una foto también hace falta: es lo que se ve mientras carga, y si el
 * archivo ya no existe.
 */
export function colorDeFondo(fondo: FondoDeChat, oscuro: boolean, porDefecto: string): string {
  if (fondo.tipo !== 'color') return porDefecto;
  const color = COLORES_DE_FONDO.find((c) => c.id === fondo.id);
  if (!color) return porDefecto;
  return oscuro ? color.oscuro : color.claro;
}

/**
 * El velo que se pone sobre una foto de fondo para que el texto se lea.
 *
 * Una foto puede ser cualquier cosa; lo que no puede es dejar sin leer la hora
 * de un mensaje. El velo la acerca al fondo del tema sin taparla.
 */
export function veloSobreLaFoto(oscuro: boolean): string {
  return oscuro ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
}

/** Si dos fondos son el mismo: para marcar el elegido en la lista. */
export function mismoFondo(a: FondoDeChat, b: FondoDeChat): boolean {
  if (a.tipo !== b.tipo) return false;
  if (a.tipo === 'color' && b.tipo === 'color') return a.id === b.id;
  if (a.tipo === 'foto' && b.tipo === 'foto') return a.uri === b.uri;
  return true;
}
