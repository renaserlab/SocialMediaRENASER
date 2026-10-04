import { apiRequest, API_V1 } from '@/services/api';
import {
  NotificationDto,
  NotificationItem,
  toNotificationItem,
} from '@/mappers/notificationMapper';

/** Lo que se pide de una vez. El servidor admite hasta 100. */
export const AVISOS_POR_PAGINA = 50;

export const NotificationRepository = {
  /**
   * Una página de avisos. `desde` es cuántos se han pedido ya: la bandeja
   * pide la siguiente al llegar al final en vez de quedarse en los primeros
   * cincuenta para siempre.
   */
  async list(desde = 0): Promise<NotificationItem[]> {
    const dtos = await apiRequest<NotificationDto[]>(
      `${API_V1}/notifications?limit=${AVISOS_POR_PAGINA}&offset=${Math.max(0, desde)}`,
    );
    return dtos.map(toNotificationItem);
  },

  async unreadCount(): Promise<number> {
    const res = await apiRequest<{ count: number }>(
      `${API_V1}/notifications/unread-count`,
    );
    return res.count;
  },

  async markAllRead(): Promise<void> {
    await apiRequest<void>(`${API_V1}/notifications/read-all`, { method: 'POST' });
  },

  /*
    Aqui vivia `notifySessionBooked`, que insertaba el aviso de sesion
    DIRECTAMENTE en la tabla desde el movil. Existia porque no habia backend
    que lo hiciera (ver migracion 0019, que tuvo que abrir esa insercion con
    RLS). Ya lo hay: la agenda crea la reserva y el propio servidor manda el
    aviso, con el id de la sesion dentro, para que quien lo recibe pueda abrir
    la solicitud concreta. Ver `BookingRepository`.
  */

};
