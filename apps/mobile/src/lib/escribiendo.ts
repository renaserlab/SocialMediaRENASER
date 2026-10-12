/**
 * «Está escribiendo»: quién avisa, cada cuánto y cuánto dura el aviso.
 *
 * LO PEDIDO (12/10/2026): ver, con una animación y un sonido, que una persona
 * está escribiendo, en un chat de dos y en un grupo.
 *
 * NO SE GUARDA EN NINGÚN SITIO. Es un aviso por difusión entre los teléfonos
 * que tienen la conversación abierta: quien escribe lo manda cada pocos
 * segundos mientras teclea, y quien lo recibe lo da por bueno un rato corto.
 * Si deja de llegar —porque paró, porque envió o porque perdió la conexión—
 * caduca solo. Nadie tiene que acordarse de apagarlo.
 *
 * EL AVISO LLEVA SOLO QUIÉN. Un canal de difusión lo puede escribir cualquiera
 * con la aplicación, así que no se le cree el nombre: llega un identificador y
 * el nombre se saca de los miembros que ya se conocen. Un identificador que no
 * es de esta conversación se descarta.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

/** Mientras se teclea, se avisa como mucho así de seguido. */
export const CADA_CUANTO_AVISAR_MS = 2500;

/** Un aviso vale esto. Más del doble del ritmo: aguanta uno que se pierda. */
export const CADUCA_A_LOS_MS = 6000;

/** Entre dos tonos de «está escribiendo» pasa al menos esto. */
export const PAUSA_DEL_TONO_MS = 8000;

/** Quién está escribiendo → hasta cuándo se le cree. */
export type Escribiendo = Readonly<Record<string, number>>;

export const NADIE: Escribiendo = Object.freeze({});

/** Lo que viaja por el canal. `e`: 1 está escribiendo, 0 ya paró. */
export type AvisoDeEscritura = { u: string; e: 0 | 1 };

export function avisoDe(usuarioId: string, escribe: boolean): AvisoDeEscritura {
  return { u: usuarioId, e: escribe ? 1 : 0 };
}

/** Lo que llega por el canal, leído sin fiarse de nada. */
export function leerAviso(bruto: unknown): { usuarioId: string; escribe: boolean } | null {
  if (typeof bruto !== 'object' || bruto === null) return null;
  const { u, e } = bruto as Record<string, unknown>;
  if (typeof u !== 'string' || !u.trim() || u.length > 64) return null;
  if (e !== 0 && e !== 1) return null;
  return { usuarioId: u, escribe: e === 1 };
}

/**
 * Si a ese aviso se le hace caso.
 *
 * Nunca al propio —uno ya sabe que escribe— y, cuando se conoce quién está en
 * la conversación, solo a quien está. Mientras no se sabe (la ficha del chat
 * todavía no llegó) se acepta: lo peor es un «alguien está escribiendo» de más.
 */
export function esDeFiar(
  usuarioId: string,
  yo: string | null | undefined,
  conocidos: readonly string[] | null,
): boolean {
  if (!usuarioId || usuarioId === yo) return false;
  return conocidos === null || conocidos.includes(usuarioId);
}

/** Si toca mandar el aviso ahora: hay texto y el último ya es viejo. */
export function tocaAvisar(texto: string, ahora: number, ultimoAviso: number | undefined): boolean {
  if (!texto.trim()) return false;
  return ultimoAviso === undefined || ahora - ultimoAviso >= CADA_CUANTO_AVISAR_MS;
}

/** Si toca avisar de que se paró: se había avisado y el cuadro quedó vacío. */
export function tocaAvisarQueParo(texto: string, ultimoAviso: number | undefined): boolean {
  return ultimoAviso !== undefined && !texto.trim();
}

/** Anota que esa persona escribe. Devuelve una lista NUEVA. */
export function anotar(lista: Escribiendo, usuarioId: string, ahora: number): Escribiendo {
  return { ...lista, [usuarioId]: ahora + CADUCA_A_LOS_MS };
}

/** Quita a esa persona. La misma lista si no estaba. */
export function quitar(lista: Escribiendo, usuarioId: string): Escribiendo {
  if (!Object.prototype.hasOwnProperty.call(lista, usuarioId)) return lista;
  const resto: Record<string, number> = {};
  for (const [id, hasta] of Object.entries(lista)) if (id !== usuarioId) resto[id] = hasta;
  return resto;
}

/** Retira los avisos caducados. La MISMA lista si no caducó ninguno. */
export function limpiar(lista: Escribiendo, ahora: number): Escribiendo {
  const vivos = Object.entries(lista).filter(([, hasta]) => hasta > ahora);
  if (vivos.length === Object.keys(lista).length) return lista;
  return Object.fromEntries(vivos);
}

/** Quiénes escriben ahora, en un orden que no baila. */
export function quienesEscriben(lista: Escribiendo, ahora: number): string[] {
  return Object.entries(lista)
    .filter(([, hasta]) => hasta > ahora)
    .map(([id]) => id)
    .sort();
}

/** Cuánto falta para que caduque el primero. `null` si no hay ninguno. */
export function faltaParaCaducar(lista: Escribiendo, ahora: number): number | null {
  const plazos = Object.values(lista).map((hasta) => hasta - ahora);
  if (plazos.length === 0) return null;
  return Math.max(0, Math.min(...plazos));
}

/**
 * Qué frase toca. La pantalla la traduce.
 *
 * En un chat de dos no hace falta el nombre: solo puede ser la otra persona.
 * En un grupo sí, y con más de dos se cuenta en vez de enumerar.
 */
export type FraseDeEscritura =
  | { clave: 'solo' }
  | { clave: 'uno'; nombre: string }
  | { clave: 'dos'; primero: string; segundo: string }
  | { clave: 'varios'; cuantos: number };

export function fraseDeEscritura(nombres: readonly string[], esGrupo: boolean): FraseDeEscritura | null {
  if (nombres.length === 0) return null;
  if (!esGrupo) return { clave: 'solo' };
  const conNombre = nombres.map((nombre) => nombre.trim()).filter(Boolean);
  // Alguien cuyo nombre no se conoce cuenta, pero no se le inventa uno.
  if (conNombre.length !== nombres.length) {
    return nombres.length === 1 ? { clave: 'solo' } : { clave: 'varios', cuantos: nombres.length };
  }
  if (conNombre.length === 1) return { clave: 'uno', nombre: conNombre[0] as string };
  if (conNombre.length === 2) {
    return { clave: 'dos', primero: conNombre[0] as string, segundo: conNombre[1] as string };
  }
  return { clave: 'varios', cuantos: conNombre.length };
}

/**
 * Si suena el tono: cuando ALGUIEN empieza y antes no escribía nadie.
 *
 * No en cada aviso —llegan cada dos segundos y medio—, no si se suma una
 * segunda persona, no con el chat detrás de otra pantalla y no con la
 * conversación silenciada. Y con una pausa mínima, para que quien escribe a
 * trompicones no lo haga sonar una y otra vez.
 */
export function suenaElTono(caso: {
  antes: number;
  ahora: number;
  seEstaMirando: boolean;
  silenciada: boolean;
  momento: number;
  ultimoTono: number | undefined;
}): boolean {
  if (caso.antes > 0 || caso.ahora === 0) return false;
  if (!caso.seEstaMirando || caso.silenciada) return false;
  return caso.ultimoTono === undefined || caso.momento - caso.ultimoTono >= PAUSA_DEL_TONO_MS;
}
