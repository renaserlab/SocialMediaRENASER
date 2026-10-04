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

/** Cuántos avisos hay sin leer. Devuelve la cuenta, o `null` si no se pudo. */
export async function refrescarNotificaciones(): Promise<number | null> {
  try {
    const cuenta = await NotificationRepository.unreadCount();
    useContadoresStore.getState().ponerNotificaciones(cuenta);
    ponerInsignia();
    return cuenta;
  } catch {
    return null;
  }
}

/** La bandeja se acaba de abrir y todo quedó leído. */
export function notificacionesLeidas(): void {
  useContadoresStore.getState().ponerNotificaciones(0);
  ponerInsignia();
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
