/**
 * Reacciones y citas del chat: lo que se decide sin pantalla y sin red.
 *
 * Leer lo que manda el servidor sin romperse, pintar una reacción en el acto
 * —antes de que el servidor conteste— y decir qué se enseña en una cita.
 *
 * LA VERDAD ES LA DEL SERVIDOR. `alReaccionar` adelanta en pantalla lo que va
 * a pasar para que el toque se note; en cuanto llega la respuesta, se pinta lo
 * que dice el servidor, que es quien sabe cuántos han reaccionado.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

/** Una reacción a un mensaje, agrupada: «❤ 3». */
export type ReaccionDeMensaje = {
  emoji: string;
  cuantos: number;
  /** Una de ellas es de quien mira. */
  mia: boolean;
};

/** La cita de un mensaje que responde a otro. */
export type CitaDeMensaje = {
  id: string;
  autorId: string;
  autor: string;
  /** Vacío si el original no tenía texto o se borró. */
  extracto: string;
  /** El tipo de su primer adjunto, si tenía alguno. */
  tipo: 'image' | 'video' | 'document' | 'audio' | null;
  eliminado: boolean;
  /**
   * Solo en un audio y solo si el servidor lo dice (audios y temas,
   * 30/10/2026): nota de voz o archivo de audio. Sin el campo (una API
   * anterior) la cita dice «Audio», como siempre.
   */
  notaDeVoz?: boolean;
};

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function leerReacciones(bruto: unknown): ReaccionDeMensaje[] {
  if (!Array.isArray(bruto)) return [];
  const salida: ReaccionDeMensaje[] = [];
  for (const fila of bruto) {
    if (!esObjeto(fila) || typeof fila.emoji !== 'string' || !fila.emoji) continue;
    const cuantos = typeof fila.count === 'number' && fila.count > 0 ? Math.floor(fila.count) : 0;
    // Una reacción que nadie ha puesto no se pinta.
    if (cuantos === 0) continue;
    salida.push({ emoji: fila.emoji, cuantos, mia: fila.mine === true });
  }
  return salida;
}

const TIPOS: readonly string[] = ['image', 'video', 'document', 'audio'];

export function leerCita(bruto: unknown): CitaDeMensaje | undefined {
  if (!esObjeto(bruto) || typeof bruto.id !== 'string' || !bruto.id) return undefined;
  const eliminado = bruto.deleted === true;
  return {
    id: bruto.id,
    autorId: typeof bruto.sender_id === 'string' ? bruto.sender_id : '',
    autor: typeof bruto.sender_name === 'string' ? bruto.sender_name.trim() : '',
    // El texto de un mensaje borrado no se enseña, aunque llegara.
    extracto: !eliminado && typeof bruto.excerpt === 'string' ? bruto.excerpt : '',
    tipo:
      !eliminado && typeof bruto.kind === 'string' && TIPOS.includes(bruto.kind)
        ? (bruto.kind as CitaDeMensaje['tipo'])
        : null,
    eliminado,
    ...(!eliminado && bruto.kind === 'audio' && typeof bruto.voice_note === 'boolean'
      ? { notaDeVoz: bruto.voice_note }
      : {}),
  };
}

/**
 * Lo que se pinta en una cita: su texto, o qué era si no tenía.
 *
 * Devuelve el texto tal cual o la CLAVE de traducción que toca. Quien pinta
 * traduce las claves; así esta función no depende del idioma.
 */
export function textoDeCita(cita: CitaDeMensaje): { texto: string } | { clave: string } {
  if (cita.eliminado) return { clave: 'chat.deletedMessage' };
  if (cita.extracto) return { texto: cita.extracto };
  switch (cita.tipo) {
    case 'image':
      return { clave: 'chat.replyPhoto' };
    case 'video':
      return { clave: 'chat.replyVideo' };
    case 'audio':
      // «Nota de voz» o «Audio»: el nombre, si lo tiene, ya viene en el extracto.
      return cita.notaDeVoz === true ? { clave: 'chat.replyVoiceNote' } : { clave: 'chat.replyAudio' };
    case 'document':
      return { clave: 'chat.replyFile' };
    default:
      return { clave: 'chat.replyMessage' };
  }
}

/**
 * Cómo quedan las reacciones de un mensaje tras el toque de quien mira.
 *
 * `emoji` es la que pone; `null`, que quita la suya. Solo puede tener UNA:
 * poner otra quita la anterior. Tocar la que ya tenía la deja como estaba (el
 * que llama decide entonces mandar `null` para quitarla).
 */
export function alReaccionar(
  reacciones: readonly ReaccionDeMensaje[],
  emoji: string | null,
): ReaccionDeMensaje[] {
  // Primero se retira la que tuviera.
  const sinLaMia = reacciones
    .map((r) => (r.mia ? { ...r, cuantos: r.cuantos - 1, mia: false } : r))
    .filter((r) => r.cuantos > 0);
  if (!emoji) return sinLaMia;
  const existe = sinLaMia.some((r) => r.emoji === emoji);
  return existe
    ? sinLaMia.map((r) => (r.emoji === emoji ? { ...r, cuantos: r.cuantos + 1, mia: true } : r))
    : [...sinLaMia, { emoji, cuantos: 1, mia: true }];
}

/** La reacción que tiene puesta quien mira, si tiene alguna. */
export function miReaccion(reacciones: readonly ReaccionDeMensaje[] | undefined): string | null {
  return reacciones?.find((r) => r.mia)?.emoji ?? null;
}

/**
 * Pone en una lista de mensajes las reacciones recién consultadas.
 *
 * `consultados` son los mensajes por los que se preguntó: los que NO vienen en
 * la respuesta se han quedado sin reacciones, y hay que quitárselas. Los que
 * no se consultaron no se tocan. Devuelve la MISMA lista si nada cambió, para
 * no repintar el chat entero por una consulta que no trae novedades.
 */
export function aplicarReacciones<T extends { id: string; reacciones?: ReaccionDeMensaje[] }>(
  mensajes: T[],
  consultados: readonly string[],
  porMensaje: Record<string, ReaccionDeMensaje[]>,
): T[] {
  const preguntados = new Set(consultados);
  let cambio = false;
  const salida = mensajes.map((mensaje) => {
    if (!preguntados.has(mensaje.id)) return mensaje;
    const nuevas = porMensaje[mensaje.id] ?? [];
    if (iguales(mensaje.reacciones ?? [], nuevas)) return mensaje;
    cambio = true;
    return { ...mensaje, reacciones: nuevas };
  });
  return cambio ? salida : mensajes;
}

function iguales(a: readonly ReaccionDeMensaje[], b: readonly ReaccionDeMensaje[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.emoji === b[i]?.emoji && r.cuantos === b[i]?.cuantos && r.mia === b[i]?.mia)
  );
}

/** Lo que manda `POST …/reactions/lookup`, leído sin fiarse de nada. */
export function leerConsultaDeReacciones(bruto: unknown): Record<string, ReaccionDeMensaje[]> {
  const mapa = esObjeto(bruto) && esObjeto(bruto.reactions) ? bruto.reactions : {};
  const salida: Record<string, ReaccionDeMensaje[]> = {};
  for (const [mensaje, lista] of Object.entries(mapa)) {
    const leidas = leerReacciones(lista);
    if (leidas.length > 0) salida[mensaje] = leidas;
  }
  return salida;
}

/** Cuántos mensajes se consultan de una vez (el tope del servidor). */
export const MAX_CONSULTA_DE_REACCIONES = 100;
