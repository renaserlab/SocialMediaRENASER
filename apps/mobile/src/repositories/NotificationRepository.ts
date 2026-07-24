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

  async notifySessionBooked(input: { targetUserId: string; dateText: string; note?: string }): Promise<void> {
    const { supabase } = await import('@/services/supabase');
    if (!supabase) return;
    const { data } = await supabase.auth.getUser();
    if (!data.user) return;
    await supabase.from('notifications').insert({
      user_id: input.targetUserId,
      actor_id: data.user.id,
      type: 'session_booked',
      entity_type: 'booking',
      payload: {
        dateText: input.dateText,
        note: input.note ?? '',
      },
    });
  },
};
