import { traduceEnElIdiomaActual } from '@/i18n';
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

/**
 * Texto que ve el usuario cuando el evento aun no tiene fecha.
 *
 * Es una FUNCION y no una constante porque el idioma se elige mientras la
 * aplicacion corre: una constante se congelaria con el idioma que hubiera al
 * cargar el modulo, que es antes de que nadie haya elegido nada.
 */
export function dateTbd(): string {
  return traduceEnElIdiomaActual('event.dateTbd');
}

function formatEventDate(iso: string | null | undefined): string {
  if (!iso) return dateTbd();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dateTbd();
  const day = d.getDate();
  const month = traduceEnElIdiomaActual('date.monthsShortUpper').split(',')[d.getMonth()] ?? '';
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
