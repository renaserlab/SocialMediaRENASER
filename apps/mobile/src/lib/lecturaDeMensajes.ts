/**
 * La confirmación de lectura: la marca de cada burbuja propia y los detalles
 * de un mensaje.
 *
 * LO PEDIDO (12/10/2026), con WhatsApp de referencia: «que haya feedback de
 * ver si leyeron o no mi mensaje», con la doble marca, y que en los detalles
 * del mensaje «aparezcan las personas que leyeron o no».
 *
 * DE DÓNDE SALE. El servidor no guarda una lectura por mensaje: guarda HASTA
 * DÓNDE ha leído cada persona de la conversación (`last_read_at`). Con eso
 * basta, y es lo que aquí se llama «marca de lectura»:
 *
 *     una persona leyó un mensaje  ⇔  su marca es igual o posterior al envío
 *
 * LO QUE SE VE, como se pidió el 12/10/2026 por la noche («deben haber dos
 * aspas para todo, sea el mensaje que sea»):
 *
 *   · una marca        → saliendo: todavía no llegó al servidor (poca señal);
 *   · dos marcas       → enviado: el servidor lo tiene;
 *   · dos, en celeste  → leído: en un chat de dos, por la otra persona; en un
 *                        grupo, por TODOS los demás. Con que falte una, sigue
 *                        en «enviado», y quién falta se ve en «Info. del
 *                        mensaje».
 *
 * Las dos marcas dicen «enviado», no «entregado al teléfono» como en WhatsApp:
 * Z no lo sabe —nadie le avisa de que un mensaje llegó a un aparato— y no se
 * finge.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

/** Hasta dónde ha leído una de las otras personas. `null`: nunca abrió el chat. */
export type MarcaDeLectura = { usuarioId: string; leidoHasta: string | null };

export type EstadoDeEntrega = 'enviando' | 'fallido' | 'enviado' | 'leido';

/** Lo mínimo de un mensaje que hace falta para saber su estado. */
export type MensajeConEnvio = { estado?: 'enviando' | 'error'; createdAtIso?: string };

export type PersonaDeLectura = {
  id: string;
  nombre: string;
  usuario?: string;
  avatarPath?: string;
};

export type DetallesDeMensaje = {
  leyeron: PersonaDeLectura[];
  faltan: PersonaDeLectura[];
};

/**
 * El color de las dos marcas de «leído».
 *
 * La burbuja propia es del color principal del tema: negra en claro, blanca en
 * oscuro. El azul de siempre no se lee igual sobre las dos, así que hay uno
 * para cada fondo. Sobre una foto la franja de la hora es oscura en los dos
 * temas: ahí va el claro.
 */
export const COLOR_DE_LEIDO = { sobreOscuro: '#5CC8FF', sobreClaro: '#0B74D1' } as const;

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const instante = (iso: string | null | undefined): number => {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
};

/** Lo que manda `GET …/read-state`, leído sin fiarse de nada. */
export function leerMarcas(bruto: unknown): MarcaDeLectura[] {
  if (!esObjeto(bruto) || !Array.isArray(bruto.members)) return [];
  const marcas: MarcaDeLectura[] = [];
  for (const fila of bruto.members) {
    if (!esObjeto(fila) || typeof fila.user_id !== 'string' || !fila.user_id) continue;
    const hasta = typeof fila.last_read_at === 'string' && fila.last_read_at ? fila.last_read_at : null;
    marcas.push({ usuarioId: fila.user_id, leidoHasta: hasta });
  }
  return marcas;
}

/** Si quien tiene esa marca ya pasó por un mensaje enviado en ese instante. */
export function loLeyo(leidoHasta: string | null, enviadoIso: string | undefined): boolean {
  const marca = instante(leidoHasta);
  const envio = instante(enviadoIso);
  if (Number.isNaN(marca) || Number.isNaN(envio)) return false;
  return marca >= envio;
}

/** Cuántas de las otras personas lo leyeron. */
export function cuantosLoLeyeron(
  marcas: readonly MarcaDeLectura[],
  enviadoIso: string | undefined,
): number {
  return marcas.filter((marca) => loLeyo(marca.leidoHasta, enviadoIso)).length;
}

/**
 * El estado que se pinta en una burbuja PROPIA.
 *
 * «Leído» exige a todos los demás. Sin nadie más en la conversación —o antes
 * de que el servidor conteste— no hay a quién esperar: se queda en «enviado»,
 * que es lo único que se sabe.
 */
export function estadoDeEntrega(
  mensaje: MensajeConEnvio,
  marcas: readonly MarcaDeLectura[],
): EstadoDeEntrega {
  if (mensaje.estado === 'enviando') return 'enviando';
  if (mensaje.estado === 'error') return 'fallido';
  if (marcas.length === 0) return 'enviado';
  return cuantosLoLeyeron(marcas, mensaje.createdAtIso) === marcas.length ? 'leido' : 'enviado';
}

/**
 * Lo que distingue un juego de marcas de otro: para no repintar la lista
 * cuando el servidor contesta lo mismo que ya se tenía.
 */
export function huellaDeMarcas(marcas: readonly MarcaDeLectura[]): string {
  return marcas
    .map((marca) => `${marca.usuarioId}:${marca.leidoHasta ?? ''}`)
    .sort()
    .join('|');
}

function leerPersona(bruto: unknown): PersonaDeLectura | null {
  if (!esObjeto(bruto) || typeof bruto.id !== 'string' || !bruto.id) return null;
  const persona: PersonaDeLectura = {
    id: bruto.id,
    nombre: typeof bruto.full_name === 'string' ? bruto.full_name.trim() : '',
  };
  if (typeof bruto.username === 'string' && bruto.username) persona.usuario = bruto.username;
  if (typeof bruto.avatar_path === 'string' && bruto.avatar_path) {
    persona.avatarPath = bruto.avatar_path;
  }
  return persona;
}

const leerPersonas = (bruto: unknown): PersonaDeLectura[] =>
  Array.isArray(bruto)
    ? bruto.map(leerPersona).filter((p): p is PersonaDeLectura => p !== null)
    : [];

/** Lo que manda `GET …/messages/{id}/receipts`. `null` si no se entiende. */
export function leerDetalles(bruto: unknown): DetallesDeMensaje | null {
  if (!esObjeto(bruto) || !Array.isArray(bruto.read_by) || !Array.isArray(bruto.pending)) {
    return null;
  }
  return { leyeron: leerPersonas(bruto.read_by), faltan: leerPersonas(bruto.pending) };
}

/**
 * Si un mensaje puede enseñar sus detalles: propio, ya en el servidor y sin
 * borrar. De uno que todavía se está enviando no hay nada que contar.
 */
export function tieneDetalles(mensaje: {
  sender: 'me' | 'them';
  estado?: 'enviando' | 'error';
  eliminado?: boolean;
  esSesion?: boolean;
}): boolean {
  return mensaje.sender === 'me' && !mensaje.estado && !mensaje.eliminado && !mensaje.esSesion;
}

/**
 * Si la franja de la hora —que es donde va la marca— se pinta en un mensaje.
 *
 * LO PROPIO LA LLEVA SIEMPRE: texto, foto, emoji o archivo, cada mensaje que
 * uno manda enseña su marca. Hasta el 12/10/2026 dentro de una ráfaga solo la
 * llevaba el último, y un emoji o una foto a mitad de ráfaga se quedaban sin
 * ninguna: «cuando es foto no hay aspa».
 *
 * En lo ajeno no hay marca que enseñar, así que la hora sigue sin repetirse
 * dentro de una ráfaga.
 */
export function llevaFranjaDeHora(caso: {
  agrupado: boolean;
  tieneTexto: boolean;
  tieneEstado: boolean;
  esMio: boolean;
}): boolean {
  if (caso.esMio) return true;
  return !caso.agrupado || !caso.tieneTexto || caso.tieneEstado;
}

/** Cuánto ha avanzado un envío. Un fallo no es un paso adelante. */
const PASO: Record<EstadoDeEntrega, number> = { fallido: -1, enviando: 0, enviado: 1, leido: 2 };

/**
 * Si el cambio de la marca se anima: solo cuando el mensaje AVANZA —sale, o
 * lo leen—. Al fallar, o al volver a intentarlo, la marca cambia sin más: un
 * salto alegre sobre un «no se envió» diría lo contrario de lo que pasa.
 */
export function seAnimaElPaso(antes: EstadoDeEntrega, ahora: EstadoDeEntrega): boolean {
  return PASO[antes] >= 0 && PASO[ahora] > PASO[antes];
}
