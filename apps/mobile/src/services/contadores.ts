import { MessageRepository } from '@/repositories/MessageRepository';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import { setBadgeCount } from '@/services/notifications';
import { useContadoresStore } from '@/store/useContadoresStore';
import type { Conversation } from '@/types';

/**
 * Pregunta al servidor lo que hay sin leer y lo deja en el contador común.
 *
 * NINGUNA DE ESTAS FUNCIONES LANZA. Un contador que no se pudo refrescar se
 * queda con el último valor conocido: es un adorno informativo, y un fallo de
 * red aquí no puede convertirse en un error en pantalla.
 */

/** La insignia del icono de la aplicación: la suma de lo que hay sin leer. */
function ponerInsignia(): void {
  const { notificaciones, mensajes } = useContadoresStore.getState();
  void setBadgeCount(notificaciones + mensajes);
}

/**
 * Cuántos avisos hay sin leer y cuántos son posteriores a `desdeIso`.
 *
 * Deja la cuenta en el contador común y devuelve las dos cosas, o `null` si no
 * se pudo. `nuevos` es `null` si el servidor no lo dice (ver el repositorio).
 */
export async function refrescarNotificaciones(
  desdeIso: string | null = null,
): Promise<{ cuenta: number; nuevos: number | null } | null> {
  try {
    const lectura = await NotificationRepository.novedades(desdeIso);
    useContadoresStore.getState().ponerNotificaciones(lectura.cuenta);
    ponerInsignia();
    return lectura;
  } catch {
    return null;
  }
}

/** La bandeja se acaba de abrir y todo quedó leído. */
export function notificacionesLeidas(): void {
  useContadoresStore.getState().ponerNotificaciones(0);
  ponerInsignia();
  for (const oyente of oyentesDeAvisosLeidos) oyente();
}

const oyentesDeAvisosLeidos = new Set<() => void>();

/** Cada vez que se abre la bandeja de notificaciones y queda todo leído. */
export function alLeerLasNotificaciones(oyente: () => void): () => void {
  oyentesDeAvisosLeidos.add(oyente);
  return () => {
    oyentesDeAvisosLeidos.delete(oyente);
  };
}

/**
 * Los mensajes sin leer, sumando la primera página de conversaciones.
 *
 * NO ES UNA CUENTA EXACTA DE TODA LA HISTORIA, y no hace falta que lo sea: las
 * conversaciones llegan ordenadas por actividad, así que lo no leído reciente
 * está siempre en la primera página. Sirve para un globo que dice «tienes
 * mensajes» y cuántos, sin pedir un endpoint nuevo al servidor.
 *
 * Devuelve las conversaciones leídas, para quien quiera usarlas (el aviso
 * flotante necesita el nombre y el resumen), o `null` si no se pudo.
 */
export async function refrescarMensajes(): Promise<Conversation[] | null> {
  try {
    const conversaciones = await MessageRepository.listConversations();
    anotarMensajes(conversaciones);
    // Y se le da a quien tenga la bandeja pintada: ya está pedida, no hace
    // falta que la vuelva a pedir para enterarse.
    for (const oyente of oyentesDeLaBandeja) oyente(conversaciones);
    return conversaciones;
  } catch {
    return null;
  }
}

/** Para la pantalla de mensajes, que ya tiene la lista: no hace falta otra petición. */
export function anotarMensajes(conversaciones: readonly Conversation[]): void {
  const total = conversaciones.reduce((suma, conversacion) => suma + (conversacion.unread || 0), 0);
  useContadoresStore.getState().ponerMensajes(total);
  ponerInsignia();
}

/*
  LA BANDEJA SE ENTERA SIN PREGUNTAR.

  La pantalla de mensajes guarda su propia lista y no la vuelve a pedir en
  treinta segundos (`lib/bandeja.ts`). Dos cosas que pasan fuera de ella la
  dejaban vieja: leer una conversación y la lectura fresca que este mismo
  fichero hace para el contador. Aquí se le avisan las dos.
*/
type OyenteDeLaBandeja = (frescas: readonly Conversation[]) => void;
type OyenteDeLeida = (conversacionId: string) => void;

const oyentesDeLaBandeja = new Set<OyenteDeLaBandeja>();
const oyentesDeLeida = new Set<OyenteDeLeida>();

/** Cada vez que el contador trae la primera página de la bandeja. */
export function alLlegarLaBandeja(oyente: OyenteDeLaBandeja): () => void {
  oyentesDeLaBandeja.add(oyente);
  return () => {
    oyentesDeLaBandeja.delete(oyente);
  };
}

/** Cada vez que se lee una conversación (se abrió su chat, o llegó algo con él delante). */
export function alLeerUnaConversacion(oyente: OyenteDeLeida): () => void {
  oyentesDeLeida.add(oyente);
  return () => {
    oyentesDeLeida.delete(oyente);
  };
}

/*
  EL CHAT ABIERTO SE ENTERA POR MÁS DE UN CAMINO.

  Con una conversación delante, un mensaje nuevo solo podía aparecer por el
  canal de tiempo real de ESA pantalla; el aviso flotante y el push se callan a
  propósito —«ya lo está leyendo»—. Si ese canal estaba caído, el mensaje no
  aparecía por ningún lado hasta salir del chat y volver a entrar (reportado el
  05/10/2026). Ahora el push de un mensaje se lo dice también al chat, que
  pregunta al servidor lo que le falta.
*/
type OyenteDeMensaje = (conversacionId: string) => void;

const oyentesDeMensaje = new Set<OyenteDeMensaje>();

/** Cada vez que se sabe, por un camino que no es el canal del chat, que entró un mensaje. */
export function alSaberDeUnMensaje(oyente: OyenteDeMensaje): () => void {
  oyentesDeMensaje.add(oyente);
  return () => {
    oyentesDeMensaje.delete(oyente);
  };
}

/** Ha entrado un mensaje en esa conversación: que quien la tenga abierta se ponga al día. */
export function hayMensajeNuevoEn(conversacionId: string): void {
  for (const oyente of oyentesDeMensaje) oyente(conversacionId);
}

/**
 * Marca una conversación como leída: en el servidor y, YA, en la bandeja.
 *
 * No lanza. Si el servidor falla, la bandeja se corrige sola en su siguiente
 * lectura, que es lo que pasaba antes con todo.
 */
export function marcarConversacionLeida(conversacionId: string): void {
  MessageRepository.markRead(conversacionId).catch(() => {});
  for (const oyente of oyentesDeLeida) oyente(conversacionId);
}
