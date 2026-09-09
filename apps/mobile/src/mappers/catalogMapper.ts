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
  /**
   * `upcoming` | `past` | `undated`, resuelto por el servidor contra las
   * fechas REALES. Opcional porque una API todavía sin desplegar no lo manda.
   */
  time_state?: string | null;
  organizer_name?: string | null;
  organizer_username?: string | null;
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

/**
 * Si el evento está por llegar, ya pasó o no tiene fecha.
 *
 * LO DECIDE EL SERVIDOR y aquí solo se acepta lo que dice. La alternativa era
 * comparar aquí `dto.starts_at`, y eso repetiría en el móvil una regla que ya
 * vive en `catalog/eventos.py` —con `ends_at`, con el límite en «ahora mismo»,
 * con los dos campos nulos— para que un día las dos digan cosas distintas. Lo
 * que NUNCA se puede hacer es mirar `date`, que es el texto ya formateado.
 *
 * Sin respuesta del servidor se responde `undated`, que es lo único cierto
 * cuando no se sabe: es el valor que NO afirma ni futuro ni pasado.
 */
function mapTimeState(valor: string | null | undefined): EventItem['timeState'] {
  if (valor === 'upcoming' || valor === 'past' || valor === 'undated') return valor;
  return 'undated';
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
    timeState: mapTimeState(dto.time_state),
    // Cadenas vacías si el servidor no las manda: la pantalla decide qué hacer
    // con eso. Poner «Organizador» aquí sería inventarse un nombre.
    organizerName: dto.organizer_name ?? '',
    organizerUsername: dto.organizer_username ?? '',
    registrationsCount: dto.registrations_count ?? 0,
    // `?? null` y no `?? 0`: cero sería «aforo cero», que es otra cosa.
    capacity: dto.capacity ?? null,
    reservedByMe: dto.reserved_by_me === true,
  };
}
