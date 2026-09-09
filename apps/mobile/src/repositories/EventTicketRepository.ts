import { apiRequest, API_V1 } from '@/services/api';
import type { TipoDeEntrada } from '@/lib/entradasDeEvento';

/**
 * Entradas: lo que se ofrece, lo que queda y lo que se aparta.
 *
 * EL PRECIO NO VIAJA HACIA EL SERVIDOR. `apartar` manda tipo y cantidad, y el
 * tipo de TypeScript no tiene dónde poner un importe: no es que se ignore, es
 * que no cabe. Lo que cuesta cada entrada lo decide el servidor leyéndolo de la
 * base, y vuelve congelado dentro de la reserva.
 *
 * SEPARADO DEL REPOSITORIO DEL ORGANIZADOR, igual que se separó la evaluación
 * de cursos: aquí no hay `quota` ni `status`, que son inventario.
 */

export type Disponibilidad = {
  /** `null` cuando el evento no tiene aforo: mandan solo los cupos. */
  general: number | null;
  por_tipo: Record<string, number>;
};

export type LineaDeReserva = {
  ticket_type_id: string;
  /** El nombre CONGELADO. Si el organizador lo cambia, esto no cambia. */
  name: string;
  quantity: number;
  unit_price_minor: number;
  subtotal_minor: number;
};

export type ReservaTemporal = {
  id: string;
  event_id: string;
  status: 'ACTIVE' | 'EXPIRED' | 'RELEASED' | 'CONSUMED';
  currency: string;
  /** SOLO LAS ENTRADAS. No es el total a pagar. */
  subtotal_minor: number;
  items: LineaDeReserva[];
  expires_at: string;
  /** Segundos según el SERVIDOR. El contador del cliente es informativo. */
  segundos_restantes: number;
};

export const EventTicketRepository = {
  /** Los tipos a la venta. Sin sesión: un evento publicado es público. */
  async tipos(eventId: string): Promise<TipoDeEntrada[]> {
    return apiRequest<TipoDeEntrada[]>(
      `${API_V1}/events/${eventId}/ticket-types`,
      { auth: false },
    );
  },

  async disponibilidad(eventId: string): Promise<Disponibilidad> {
    return apiRequest<Disponibilidad>(`${API_V1}/events/${eventId}/availability`, {
      auth: false,
    });
  },

  /**
   * Aparta entradas durante diez minutos. NO ES UNA COMPRA.
   *
   * La clave de idempotencia es obligatoria: sin ella, un reintento de la red
   * aparta el doble y quien lo pidió no se entera hasta ver el resumen.
   */
  async apartar(
    eventId: string,
    seleccion: Record<string, number>,
    clave: string,
  ): Promise<ReservaTemporal> {
    const items = Object.entries(seleccion)
      .filter(([, cantidad]) => cantidad > 0)
      .map(([ticket_type_id, quantity]) => ({ ticket_type_id, quantity }));
    return apiRequest<ReservaTemporal>(
      `${API_V1}/events/${eventId}/ticket-holds`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': clave },
        body: JSON.stringify({ items }),
      },
    );
  },

  async leerReserva(holdId: string): Promise<ReservaTemporal> {
    return apiRequest<ReservaTemporal>(`${API_V1}/events/ticket-holds/${holdId}`);
  },

  /** Devuelve las entradas apartadas. Hacerlo dos veces no es un error. */
  async liberar(holdId: string): Promise<ReservaTemporal> {
    return apiRequest<ReservaTemporal>(`${API_V1}/events/ticket-holds/${holdId}`, {
      method: 'DELETE',
    });
  },
};

// --------------------------------------------------------------------------- #
// El organizador
// --------------------------------------------------------------------------- #

export type ConfiguracionDeVenta = {
  access_mode: string;
  currency: string;
  max_per_order: number | null;
  sales_open_at: string | null;
  sales_close_at: string | null;
};

/** El mismo tipo, con lo que solo le importa a quien lo administra. */
export type TipoDelOrganizador = TipoDeEntrada & {
  quota: number;
  status: 'draft' | 'on_sale' | 'paused' | 'retired';
};

export type TipoNuevo = {
  name: string;
  description?: string;
  price_minor: number;
  quota: number;
  min_per_order?: number;
  max_per_order?: number;
  inclusions?: string[];
  restrictions?: string[];
  status?: string;
  sort_order?: number;
};

export const EventTicketAdminRepository = {
  async configuracion(eventId: string): Promise<ConfiguracionDeVenta> {
    return apiRequest<ConfiguracionDeVenta>(`${API_V1}/events/${eventId}/ticketing`);
  },

  async guardarConfiguracion(
    eventId: string,
    datos: {
      access_mode: string;
      currency: string;
      max_per_order?: number | null;
      sales_open_at?: string | null;
      sales_close_at?: string | null;
    },
  ): Promise<ConfiguracionDeVenta> {
    return apiRequest<ConfiguracionDeVenta>(`${API_V1}/events/${eventId}/ticketing`, {
      method: 'PUT',
      body: JSON.stringify(datos),
    });
  },

  /** Todos los tipos, incluidos borradores y retirados. */
  async tipos(eventId: string): Promise<TipoDelOrganizador[]> {
    return apiRequest<TipoDelOrganizador[]>(
      `${API_V1}/events/${eventId}/ticket-types/manage`,
    );
  },

  async crearTipo(eventId: string, datos: TipoNuevo): Promise<TipoDelOrganizador> {
    return apiRequest<TipoDelOrganizador>(`${API_V1}/events/${eventId}/ticket-types`, {
      method: 'POST',
      body: JSON.stringify(datos),
    });
  },

  async editarTipo(
    eventId: string,
    tipoId: string,
    datos: Partial<TipoNuevo>,
  ): Promise<TipoDelOrganizador> {
    return apiRequest<TipoDelOrganizador>(
      `${API_V1}/events/${eventId}/ticket-types/${tipoId}`,
      { method: 'PATCH', body: JSON.stringify(datos) },
    );
  },

  /** RETIRA, no borra: una reserva puede estar apuntando a este tipo. */
  async retirarTipo(eventId: string, tipoId: string): Promise<TipoDelOrganizador> {
    return apiRequest<TipoDelOrganizador>(
      `${API_V1}/events/${eventId}/ticket-types/${tipoId}`,
      { method: 'DELETE' },
    );
  },
};
