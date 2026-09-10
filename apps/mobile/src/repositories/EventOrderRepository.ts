import { apiRequest, API_V1 } from '@/services/api';

/**
 * Pedidos, entradas emitidas y check-in.
 *
 * EL IMPORTE NO VIAJA HACIA EL SERVIDOR, en ningún método. `crearPedido` manda
 * la reserva y una clave de idempotencia, y `pagar` no manda nada: el importe
 * sale de la orden, que se escribió con los precios congelados al apartar. El
 * tipo de TypeScript no tiene dónde poner una cifra.
 *
 * LA CREDENCIAL SE PIDE, NO SE GUARDA. `credencial` es `POST` porque escribe:
 * cada llamada genera una nueva y deja la anterior inservible.
 */

export type LineaDePedido = {
  ticket_type_id: string;
  /** CONGELADO al comprar. Si el organizador lo renombra, esto no cambia. */
  name: string;
  quantity: number;
  unit_price_minor: number;
  subtotal_minor: number;
};

export type Pedido = {
  id: string;
  event_id: string;
  /** `PENDING_PAYMENT`, `PAYMENT_PROCESSING`, `PAID`, `PAYMENT_FAILED`,
   * `EXPIRED` o `CANCELLED`. */
  status: string;
  currency: string;
  subtotal_minor: number;
  /** Hoy igual al subtotal. Comisión e impuestos suman por encima cuando los
   * haya; que exista aparte no insinúa que hoy haya cargos ocultos. */
  total_minor: number;
  items: LineaDePedido[];
  created_at: string;
  paid_at: string | null;
  /** Lo que le queda a la reserva que sostiene el pedido, según el SERVIDOR. */
  segundos_restantes: number;
};

export type PaginaDePedidos = {
  items: Pedido[];
  next_cursor: string | null;
};

export type IntentoDePago = {
  order_id: string;
  provider: string;
  checkout_url: string;
};

export type Entrada = {
  id: string;
  event_id: string;
  order_id: string;
  ticket_type_id: string;
  name: string;
  /** `VALID`, `USED` o `REVOKED`. */
  status: string;
  /** El código que se teclea si la cámara falla. Rota con la credencial. */
  code: string;
  issued_at: string;
  checked_in_at: string | null;
};

export type PaginaDeEntradas = {
  items: Entrada[];
  next_cursor: string | null;
};

export type Credencial = {
  ticket_id: string;
  /** Lo que va DENTRO del QR. Opaco: ni nombre, ni correo, ni precio. */
  credential: string;
  code: string;
};

export type Veredicto = {
  /** `OK`, `ALREADY_USED`, `REVOKED`, `NOT_FOUND`, `WRONG_EVENT` o
   * `NOT_ADMITTING`. */
  result: string;
  ticket_id: string | null;
  name: string | null;
  checked_in_at: string | null;
};

export type Asistente = {
  ticket_id: string;
  ticket_type_id: string;
  name: string;
  status: string;
  checked_in_at: string | null;
};

export type PaginaDeAsistentes = {
  items: Asistente[];
  next_cursor: string | null;
};

export type Ventas = {
  entradas_emitidas: number;
  entradas_usadas: number;
  entradas_revocadas: number;
  ordenes_pagadas: number;
  ordenes_pendientes: number;
  /** BRUTO: no es lo que el organizador va a cobrar. La pantalla lo dice. */
  ingresos_brutos_minor: number;
  currency: string | null;
  checkins: number;
};

export const EventOrderRepository = {
  async crearPedido(holdId: string, clave: string): Promise<Pedido> {
    return apiRequest<Pedido>(`${API_V1}/events/ticket-holds/${holdId}/orders`, {
      method: 'POST',
      headers: { 'Idempotency-Key': clave },
    });
  },

  async leerPedido(orderId: string): Promise<Pedido> {
    return apiRequest<Pedido>(`${API_V1}/events/orders/${orderId}`);
  },

  async misPedidos(limit = 20, cursor?: string | null): Promise<PaginaDePedidos> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return apiRequest<PaginaDePedidos>(`${API_V1}/events/me/orders?${q.toString()}`);
  },

  async cancelar(orderId: string): Promise<Pedido> {
    return apiRequest<Pedido>(`${API_V1}/events/orders/${orderId}/cancel`, {
      method: 'POST',
    });
  },

  /** Abre el cobro. NO marca nada como pagado: eso lo decide el aviso. */
  async pagar(orderId: string): Promise<IntentoDePago> {
    return apiRequest<IntentoDePago>(`${API_V1}/events/orders/${orderId}/payment`, {
      method: 'POST',
    });
  },

  async misEntradas(limit = 20, cursor?: string | null): Promise<PaginaDeEntradas> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return apiRequest<PaginaDeEntradas>(`${API_V1}/events/me/tickets?${q.toString()}`);
  },

  async leerEntrada(ticketId: string): Promise<Entrada> {
    return apiRequest<Entrada>(`${API_V1}/events/tickets/${ticketId}`);
  },

  /** El valor del QR. Se entrega una vez y ROTA: por eso es `POST`. */
  async credencial(ticketId: string): Promise<Credencial> {
    return apiRequest<Credencial>(`${API_V1}/events/tickets/${ticketId}/credential`, {
      method: 'POST',
    });
  },
};

export const EventAdmissionRepository = {
  /** ¿Vale? No escribe nada y se puede preguntar mil veces. */
  async verificar(eventId: string, credential: string): Promise<Veredicto> {
    return apiRequest<Veredicto>(`${API_V1}/events/${eventId}/tickets/verify`, {
      method: 'POST',
      body: JSON.stringify({ credential }),
    });
  },

  /** Deja pasar, UNA vez. Un segundo escaneo devuelve «ya utilizada». */
  async checkIn(eventId: string, credential: string): Promise<Veredicto> {
    return apiRequest<Veredicto>(`${API_V1}/events/${eventId}/check-ins`, {
      method: 'POST',
      body: JSON.stringify({ credential }),
    });
  },

  async asistentes(
    eventId: string,
    opciones: { limit?: number; cursor?: string | null; estado?: string | null; q?: string } = {},
  ): Promise<PaginaDeAsistentes> {
    const q = new URLSearchParams({ limit: String(opciones.limit ?? 50) });
    if (opciones.cursor) q.set('cursor', opciones.cursor);
    if (opciones.estado) q.set('estado', opciones.estado);
    if (opciones.q) q.set('q', opciones.q);
    return apiRequest<PaginaDeAsistentes>(
      `${API_V1}/events/${eventId}/attendees?${q.toString()}`,
    );
  },

  async ventas(eventId: string): Promise<Ventas> {
    return apiRequest<Ventas>(`${API_V1}/events/${eventId}/sales`);
  },

  async revocar(ticketId: string, reason: string): Promise<Entrada> {
    return apiRequest<Entrada>(`${API_V1}/events/tickets/${ticketId}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
};
