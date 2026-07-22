import type { EventItem } from '@/types';

export type EventDto = {
  id: string;
  organizer_id: string;
  title: string;
  description: string;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  cover_path: string | null;
  whatsapp_url?: string | null;
  event_type: string;
  status: string;
  capacity: number | null;
  registrations_count: number;
  reserved_by_me: boolean;
};

const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

/** Texto que ve el usuario cuando el evento aun no tiene fecha. */
export const DATE_TBD = 'Fecha por confirmar';

function formatEventDate(iso: string | null | undefined): string {
  if (!iso) return DATE_TBD;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DATE_TBD;
  const day = d.getDate();
  const month = MONTHS[d.getMonth()] ?? '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day} ${month} ${d.getFullYear()} · ${time}`;
}

function mapType(eventType: string): EventItem['type'] {
  if (eventType === 'live') return 'live';
  if (eventType === 'presential') return 'presencial';
  return 'webinar';
}

export function toEventItem(dto: EventDto): EventItem {
  return {
    id: dto.id,
    organizerId: dto.organizer_id,
    startsAtDate: dto.starts_at ? new Date(dto.starts_at) : undefined,
    endsAtDate: dto.ends_at ? new Date(dto.ends_at) : null,
    whatsappUrl: dto.whatsapp_url ?? null,
    coverPath: dto.cover_path,
    title: dto.title,
    description: dto.description,
    date: formatEventDate(dto.starts_at),
    location: dto.location ?? '',
    type: mapType(dto.event_type),
  };
}
