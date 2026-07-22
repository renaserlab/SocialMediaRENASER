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

  /**
   * Publica un evento. Reservado a administradores: el backend lo verifica
   * contra `profiles.role`, ocultar el boton en la app no es la proteccion.
   */
  async createEvent(input: {
    title: string;
    description: string;
    startsAt: Date;
    location: string;
    coverPath?: string | null;
  }): Promise<EventItem> {
    const dto = await apiRequest<EventDto>(`${API_V1}/catalog/events`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        starts_at: input.startsAt.toISOString(),
        location: input.location || null,
        cover_path: input.coverPath ?? null,
        // Valor tal y como lo admite la base ('presential', no 'presencial').
        event_type: 'presential',
      }),
    });
    return toEventItem(dto);
  },

  /** Edita un evento. Solo administradores (lo verifica el backend). */
  async updateEvent(
    eventId: string,
    changes: {
      title?: string;
      description?: string;
      startsAt?: Date;
      location?: string;
      coverPath?: string | null;
    },
  ): Promise<EventItem> {
    const payload: Record<string, unknown> = {};
    if (changes.title !== undefined) payload.title = changes.title;
    if (changes.description !== undefined) payload.description = changes.description;
    if (changes.startsAt !== undefined) payload.starts_at = changes.startsAt.toISOString();
    if (changes.location !== undefined) payload.location = changes.location || null;
    if (changes.coverPath !== undefined) payload.cover_path = changes.coverPath;
    const dto = await apiRequest<EventDto>(`${API_V1}/catalog/events/${eventId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return toEventItem(dto);
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
