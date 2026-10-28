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

/* ------------------------------------------------------------------------- */
/* EN LA BANDEJA                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Cuántas conversaciones de la bandeja se atienden a la vez.
 *
 * Lo pedido (12/10/2026, con capturas de WhatsApp): que «escribiendo…» se vea
 * también FUERA del chat, en la fila de la conversación.
 *
 * Atender una conversación es estar suscrito a su canal, y los canales no son
 * gratis: el proveedor limita cuántos tiene abiertos un teléfono (cien) y
 * cuántas altas por segundo admite entre TODOS los teléfonos. Así que no se
 * atiende la bandeja entera sino su principio, que es lo que se ve y donde
 * está la actividad reciente: la bandeja llega ordenada por el último mensaje.
 * Veinte son más de dos pantallas de filas.
 *
 * Si Z crece hasta que esto pese, el paso siguiente es que el servidor reparta
 * los avisos por un canal de cada persona, en vez de que cada teléfono se
 * suscriba a los de sus conversaciones.
 */
export const CONVERSACIONES_ATENDIDAS = 20;

/** Las que la bandeja atiende: las primeras, sin repetir. */
export function lasQueSeAtienden(
  ids: readonly string[],
  cuantas: number = CONVERSACIONES_ATENDIDAS,
): string[] {
  const vistas = new Set<string>();
  for (const id of ids) {
    if (!id || vistas.has(id)) continue;
    vistas.add(id);
    if (vistas.size >= cuantas) break;
  }
  return [...vistas];
}

/**
 * El grupo más grande cuyo «escribiendo…» se atiende DESDE LA BANDEJA.
 *
 * CAMBIO VISIBLE (28/10/2026): en un grupo de más de veinticinco personas, la
 * fila de la bandeja deja de decir «Katy está escribiendo…». Dentro del chat
 * abierto no cambia nada: ahí se sigue viendo siempre.
 *
 * POR QUÉ (auditoría del 28/10, §10). El aviso viaja por un canal de difusión
 * y Supabase cuenta cada entrega: un aviso cuesta 1 + quienes lo reciben. Quien
 * teclea manda uno cada dos segundos y medio (`CADA_CUANTO_AVISAR_MS`). Si la
 * bandeja atendiera todos sus grupos, en uno de trescientos que todos tienen
 * arriba cada persona tecleando costaría (1 + 299) / 2,5 = 120 mensajes por
 * segundo, y CUATRO a la vez llegan al tope de 500/s del plan Pro: Supabase
 * desconecta a todo el mundo, no solo a ese grupo.
 *
 * CON VEINTICINCO, quien teclea en un grupo atendido cuesta como mucho
 * (1 + 24) / 2,5 = 10 mensajes por segundo: harían falta cincuenta personas
 * tecleando a la vez en grupos pequeños para llegar al tope. Y es donde el
 * aviso sirve: en un grupo pequeño «Ana está escribiendo» dice algo; en uno de
 * trescientos casi siempre hay alguien escribiendo y la fila solo parpadea.
 */
export const MIEMBROS_PARA_ESCRIBIENDO_EN_BANDEJA = 25;

/**
 * Si la bandeja atiende el «escribiendo» de esa conversación.
 *
 * Un chat de dos, siempre. Un grupo, solo si se sabe que es pequeño: el
 * tamaño llega en la propia fila (`members_count`), sin pedir nada. Si no
 * llega —un servidor anterior—, se trata como grande: un «escribiendo» de
 * menos en una fila es mucho más barato que tumbar el tiempo real de todos.
 */
export function seAtiendeEnBandeja(conversacion: {
  esGrupo?: boolean;
  miembros?: number;
}): boolean {
  if (conversacion.esGrupo !== true) return true;
  const miembros = conversacion.miembros;
  return (
    typeof miembros === 'number' &&
    miembros > 0 &&
    miembros <= MIEMBROS_PARA_ESCRIBIENDO_EN_BANDEJA
  );
}

/**
 * Las conversaciones cuyo «escribiendo» abre canal en la bandeja.
 *
 * De las PRIMERAS (`lasQueSeAtienden`), las que no son un grupo grande. No se
 * baja a buscar más para completar veinte: la bandeja atiende lo que se ve, y
 * lo que hay por debajo no se está mirando.
 */
export function lasQueSeAtiendenEnBandeja(
  conversaciones: readonly { id: string; esGrupo?: boolean; miembros?: number }[],
  cuantas: number = CONVERSACIONES_ATENDIDAS,
): string[] {
  const porId = new Map(conversaciones.map((c) => [c.id, c] as const));
  return lasQueSeAtienden(
    conversaciones.map((c) => c.id),
    cuantas,
  ).filter((id) => {
    const conversacion = porId.get(id);
    return conversacion !== undefined && seAtiendeEnBandeja(conversacion);
  });
}

/**
 * Qué cambia al pasar de atender unas conversaciones a atender otras.
 *
 * La bandeja se reordena cada vez que llega un mensaje: cerrar y volver a
 * abrir los veinte canales por eso sería gastar altas para quedar igual.
 */
export function cambioDeAtendidas(
  antes: readonly string[],
  ahora: readonly string[],
): { abrir: string[]; cerrar: string[] } {
  return {
    abrir: ahora.filter((id) => !antes.includes(id)),
    cerrar: antes.filter((id) => !ahora.includes(id)),
  };
}

/** Quién escribe en cada conversación de la bandeja. */
export type EscribiendoEnBandeja = Readonly<Record<string, Escribiendo>>;

export const NADIE_EN_NINGUNA: EscribiendoEnBandeja = Object.freeze({});

export function anotarEn(
  todas: EscribiendoEnBandeja,
  conversacionId: string,
  usuarioId: string,
  ahora: number,
): EscribiendoEnBandeja {
  return { ...todas, [conversacionId]: anotar(todas[conversacionId] ?? NADIE, usuarioId, ahora) };
}

/** Devuelve EL MISMO objeto si no había nada que quitar: nadie se repinta. */
export function quitarDe(
  todas: EscribiendoEnBandeja,
  conversacionId: string,
  usuarioId: string,
): EscribiendoEnBandeja {
  const lista = todas[conversacionId];
  if (!lista || !(usuarioId in lista)) return todas;
  const queda = quitar(lista, usuarioId);
  const { [conversacionId]: _fuera, ...resto } = todas;
  return Object.keys(queda).length === 0 ? resto : { ...resto, [conversacionId]: queda };
}

/** Retira lo caducado de todas. El mismo objeto si no caducó nada. */
export function limpiarTodas(todas: EscribiendoEnBandeja, ahora: number): EscribiendoEnBandeja {
  let cambio = false;
  const siguen: Record<string, Escribiendo> = {};
  for (const [conversacionId, lista] of Object.entries(todas)) {
    const queda = limpiar(lista, ahora);
    if (queda !== lista) cambio = true;
    if (Object.keys(queda).length > 0) siguen[conversacionId] = queda;
    else cambio = true;
  }
  return cambio ? siguen : todas;
}

/** Cuánto falta para que caduque el primero, en cualquier conversación. */
export function faltaParaCaducarAlguna(todas: EscribiendoEnBandeja, ahora: number): number | null {
  let menor: number | null = null;
  for (const lista of Object.values(todas)) {
    const falta = faltaParaCaducar(lista, ahora);
    if (falta !== null && (menor === null || falta < menor)) menor = falta;
  }
  return menor;
}

/** Se queda solo con las conversaciones que se siguen atendiendo. */
export function soloDe(
  todas: EscribiendoEnBandeja,
  atendidas: readonly string[],
): EscribiendoEnBandeja {
  const claves = Object.keys(todas);
  if (claves.every((id) => atendidas.includes(id))) return todas;
  const siguen: Record<string, Escribiendo> = {};
  for (const id of claves) if (atendidas.includes(id)) siguen[id] = todas[id] as Escribiendo;
  return siguen;
}

/**
 * Si en la bandeja se le hace caso a un aviso.
 *
 * En un chat de dos solo puede escribir LA OTRA persona, y la bandeja sabe
 * quién es. En un grupo la bandeja no trae la lista de miembros: mientras no
 * se conoce se acepta —se verá «Alguien está escribiendo…»— y, en cuanto
 * llega, solo vale quien está en ella.
 */
export function esDeFiarEnBandeja(
  usuarioId: string,
  yo: string | null | undefined,
  conversacion: { esGrupo: boolean; otroId?: string | null },
  miembros: readonly string[] | null,
): boolean {
  if (!usuarioId || usuarioId === yo) return false;
  if (!conversacion.esGrupo) return !conversacion.otroId || conversacion.otroId === usuarioId;
  return miembros === null || miembros.includes(usuarioId);
}

/** «Katy», de «Katy Béjar Román»: en una fila de la bandeja no cabe más. */
export function nombreDePila(nombre: string | null | undefined): string {
  return (nombre ?? '').trim().split(/\s+/)[0] ?? '';
}
