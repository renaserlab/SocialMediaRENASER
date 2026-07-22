import { apiRequest, API_V1 } from '@/services/api';
import { EventDto, toEventItem } from '@/mappers/catalogMapper';
import type { EventItem } from '@/types';

export type EventsPage = {
  items: EventItem[];
  reservedIds: string[];
};

export const CatalogRepository = {
  async listEvents(): Promise<EventsPage> {
    const dtos = await apiRequest<EventDto[]>(`${API_V1}/catalog/events?limit=50`);
    return {
      items: dtos.map(toEventItem),
      reservedIds: dtos.filter((d) => d.reserved_by_me).map((d) => d.id),
    };
  },

  async reserve(eventId: string): Promise<void> {
    await apiRequest<EventDto>(`${API_V1}/catalog/events/${eventId}/reserve`, {
      method: 'POST',
    });
  },

  async cancelReservation(eventId: string): Promise<void> {
    await apiRequest<EventDto>(`${API_V1}/catalog/events/${eventId}/reserve`, {
      method: 'DELETE',
    });
  },
};
