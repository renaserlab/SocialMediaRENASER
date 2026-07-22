import type { EventItem } from '@/types';

export type EventDto = {
  id: string;
  organizer_id: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  cover_path: string | null;
  event_type: string;
  status: string;
  capacity: number | null;
  registrations_count: number;
  reserved_by_me: boolean;
};

const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
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
    startsAtDate: new Date(dto.starts_at),
    title: dto.title,
    description: dto.description,
    date: formatEventDate(dto.starts_at),
    location: dto.location ?? 'Online',
    type: mapType(dto.event_type),
  };
}
