import { apiRequest, API_V1 } from '@/services/api';
import {
  NotificationDto,
  NotificationItem,
  toNotificationItem,
} from '@/mappers/notificationMapper';

export const NotificationRepository = {
  async list(): Promise<NotificationItem[]> {
    const dtos = await apiRequest<NotificationDto[]>(
      `${API_V1}/notifications?limit=50`,
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

  /**
   * Avisa a alguien de que le han propuesto una sesión.
   *
   * Los fallos se propagan a proposito. Antes se salía sin decir nada cuando no
   * había sesión iniciada o cuando la inserción era rechazada, de modo que la
   * pantalla anunciaba «sesión agendada» y en realidad no se había guardado
   * nada: la otra persona no llegaba a enterarse nunca.
   */
  async notifySessionBooked(input: { targetUserId: string; dateText: string; note?: string }): Promise<void> {
    const { supabase } = await import('@/services/supabase');
    if (!supabase) throw new Error('No hay conexión con el servidor.');

    const { data, error: authError } = await supabase.auth.getUser();
    if (authError || !data.user) {
      throw new Error('Inicia sesión para agendar una sesión.');
    }

    const { error } = await supabase.from('notifications').insert({
      user_id: input.targetUserId,
      actor_id: data.user.id,
      type: 'session_booked',
      entity_type: 'booking',
      payload: {
        dateText: input.dateText,
        note: input.note ?? '',
      },
    });
    if (error) throw new Error(error.message);
  },
};
