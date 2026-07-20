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
};
