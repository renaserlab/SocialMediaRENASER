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

  /**
   * Lo que hay sin leer y cuántos de esos son POSTERIORES a `desdeIso`.
   *
   * `nuevos` es `null` cuando el servidor no lo dice: una API anterior a este
   * cambio ignora `since` y responde solo la cuenta. Quien llama no puede
   * tomar ese silencio por un cero.
   */
  async novedades(desdeIso: string | null): Promise<{ cuenta: number; nuevos: number | null }> {
    const consulta = desdeIso ? `?since=${encodeURIComponent(desdeIso)}` : '';
    const res = await apiRequest<{ count: number; new_count?: number }>(
      `${API_V1}/notifications/unread-count${consulta}`,
    );
    return {
      cuenta: res.count,
      nuevos: desdeIso && typeof res.new_count === 'number' ? res.new_count : null,
    };
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
