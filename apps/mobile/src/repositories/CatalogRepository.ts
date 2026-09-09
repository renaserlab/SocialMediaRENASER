import { apiRequest, API_V1 } from '@/services/api';
import { EventDto, toEventItem } from '@/mappers/catalogMapper';
import { signMediaUrls } from '@/services/storage';
import type { EventItem } from '@/types';

export type EventsPage = {
  items: EventItem[];
  reservedIds: string[];
};

/**
 * Qué grupo de eventos se pide.
 *
 * - `upcoming`: los que todavía no han terminado Y tienen fecha.
 * - `past`: los que ya terminaron. Se pueden consultar: son historia útil.
 * - `undated`: los anunciados sin fecha («por confirmar»).
 * - `all`: todos, ordenados por grupo —lo vigente primero—.
 *
 * QUIÉN CLASIFICA. El servidor, contra `starts_at` y `ends_at`. Aquí no se
 * compara ninguna fecha: pedir el grupo es una consulta, no un filtro sobre lo
 * que ya se descargó.
 */
/** Las tres modalidades que acepta el servidor. */
export type ModalidadDeEvento = 'online' | 'presential' | 'live';

export type GrupoDeEventos = 'upcoming' | 'past' | 'undated' | 'all';

/**
 * Firma en lote las portadas del listado.
 *
 * Se suben al mismo bucket privado que el resto de medios, asi que hay que
 * firmarlas para poder mostrarlas; una sola llamada para todas.
 */
async function attachCovers(items: EventItem[]): Promise<void> {
  const paths = items
    .map((e) => e.coverPath)
    .filter((p): p is string => Boolean(p));
  if (paths.length === 0) return;
  const urls = await signMediaUrls(paths);
  items.forEach((item) => {
    if (item.coverPath && urls[item.coverPath]) item.coverUrl = urls[item.coverPath];
  });
}

export const CatalogRepository = {
  /**
   * El catálogo de eventos.
   *
   * `cuando` va SIN valor por defecto en la llamada —se manda `all`— para que
   * quien no dice nada siga recibiendo la lista entera, exactamente como antes.
   * Quien quiera solo lo vigente lo pide, y entonces el filtrado corre en el
   * servidor con paginación, no recortando en el teléfono lo ya descargado.
   */
  /**
   * @param limite cuántos traer. Por omisión 50, que es lo que pedía antes:
   *   quien no lo indique no cambia de comportamiento. Explorar pinta DOS y
   *   pide dos — medido, con la agenda llena el listado de 50 pesa 39 KB para
   *   rellenar dos filas.
   */
  async listEvents(
    cuando: GrupoDeEventos = 'all',
    limite = 50,
    filtros: { texto?: string; modalidad?: ModalidadDeEvento | null } = {},
  ): Promise<EventsPage> {
    // BUSCAR Y FILTRAR EN EL SERVIDOR. Hacerlo sobre la página ya descargada
    // deja fuera todo lo que no cupo en ella, y el resultado depende de cuánto
    // se haya bajado.
    const partes = [`limit=${limite}`, `when=${cuando}`];
    const texto = (filtros.texto ?? '').trim();
    if (texto !== '') partes.push(`q=${encodeURIComponent(texto)}`);
    if (filtros.modalidad) partes.push(`event_type=${filtros.modalidad}`);
    const dtos = await apiRequest<EventDto[]>(
      `${API_V1}/catalog/events?${partes.join('&')}`,
    );
    const items = dtos.map(toEventItem);
    await attachCovers(items);
    return {
      items,
      reservedIds: dtos.filter((d) => d.reserved_by_me).map((d) => d.id),
    };
  },

  /**
   * La ficha de UN evento.
   *
   * NO PIDE SESION: un evento publicado es publico, igual que el catalogo. Lo
   * que cambia con sesion es `reservedByMe`. Un borrador o un evento que no
   * existe responden 404 por igual: distinguirlos contaria que alguien esta
   * preparando algo.
   */
  async getEvent(eventId: string): Promise<EventItem> {
    const dto = await apiRequest<EventDto>(
      `${API_V1}/catalog/events/${eventId}`,
      { auth: false },
    );
    const item = toEventItem(dto);
    await attachCovers([item]);
    return item;
  },

  /**
   * Publica un evento. Reservado a administradores: el backend lo verifica
   * contra `profiles.role`, ocultar el boton en la app no es la proteccion.
   */
  async createEvent(input: {
    title: string;
    description: string;
    startsAt?: Date | null;
    endsAt?: Date | null;
    location: string;
    coverPath?: string | null;
    whatsappUrl?: string | null;
  }): Promise<EventItem> {
    const dto = await apiRequest<EventDto>(`${API_V1}/catalog/events`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        starts_at: input.startsAt ? input.startsAt.toISOString() : null,
        ends_at: input.endsAt ? input.endsAt.toISOString() : null,
        location: input.location || null,
        cover_path: input.coverPath ?? null,
        whatsapp_url: input.whatsappUrl || null,
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
      startsAt?: Date | null;
      endsAt?: Date | null;
      location?: string;
      coverPath?: string | null;
      whatsappUrl?: string | null;
    },
  ): Promise<EventItem> {
    const payload: Record<string, unknown> = {};
    if (changes.title !== undefined) payload.title = changes.title;
    if (changes.description !== undefined) payload.description = changes.description;
    if (changes.startsAt !== undefined)
      payload.starts_at = changes.startsAt ? changes.startsAt.toISOString() : null;
    if (changes.endsAt !== undefined) payload.ends_at = changes.endsAt ? changes.endsAt.toISOString() : null;
    if (changes.whatsappUrl !== undefined) payload.whatsapp_url = changes.whatsappUrl || null;
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
