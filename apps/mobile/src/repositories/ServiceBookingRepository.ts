import { apiRequest, API_V1 } from '@/services/api';
import type {
  AmbitoDeReservas,
  PaginaDeReservas,
  ReservaAdmin,
  ReservaDelPrestador,
  ReservaDetalle,
  Resumen,
  Retencion,
  RetencionAdmin,
} from '@/lib/serviciosReserva';

/**
 * Z Servicios, Incremento 5: la reserva.
 *
 * EL SERVIDOR DECIDE: si el horario está libre, cuánto dura la retención, qué
 * se acepta y si se puede contratar. Aquí se piden y se pintan.
 *
 * TODA ALTA O SALTO LLEVA `Idempotency-Key`: un doble toque o un reintento
 * devuelven lo mismo, nunca dos retenciones ni dos reservas. Ninguna llamada
 * cobra: lo que tiene precio contesta `service_booking_payments_not_configured`.
 */
const BASE = `${API_V1}/services`;
const ADMIN = `${API_V1}/admin/services`;

function consulta(partes: Record<string, string | number | null | undefined>): string {
  const lista = Object.entries(partes)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return lista.length ? `?${lista.join('&')}` : '';
}

function post(cuerpo: unknown, clave: string): RequestInit {
  return {
    method: 'POST',
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    headers: { 'Idempotency-Key': clave },
  };
}

export const ServiceBookingRepository = {
  // ------------------------------------------------------------------ //
  // Quien contrata
  // ------------------------------------------------------------------ //
  /** Apartar el horario ELEGIDO. El servidor lo vuelve a calcular. */
  async retener(servicio: string, inicio: string, modalidad: string | null, clave: string): Promise<Retencion> {
    return apiRequest<Retencion>(
      `${BASE}/catalog/${encodeURIComponent(servicio)}/holds`,
      post({ starts_at: inicio, ...(modalidad ? { modality: modalidad } : {}) }, clave),
    );
  },

  async retencion(id: string): Promise<Retencion> {
    return apiRequest<Retencion>(`${BASE}/holds/${encodeURIComponent(id)}`);
  },

  async soltar(id: string, clave: string): Promise<Retencion> {
    return apiRequest<Retencion>(`${BASE}/holds/${encodeURIComponent(id)}/release`, post(undefined, clave));
  },

  /** Lo que se contrata y lo que hay que aceptar hoy. Solo lectura. */
  async resumen(id: string): Promise<Resumen> {
    return apiRequest<Resumen>(`${BASE}/holds/${encodeURIComponent(id)}/checkout`);
  },

  async confirmar(id: string, cuerpo: Record<string, unknown>, clave: string): Promise<ReservaDetalle> {
    return apiRequest<ReservaDetalle>(`${BASE}/holds/${encodeURIComponent(id)}/confirm`, post(cuerpo, clave));
  },

  async misReservas(ambito: AmbitoDeReservas, cursor: string | null): Promise<PaginaDeReservas> {
    return apiRequest<PaginaDeReservas>(`${BASE}/me/bookings${consulta({ scope: ambito, cursor })}`);
  },

  async miReserva(id: string): Promise<ReservaDetalle> {
    return apiRequest<ReservaDetalle>(`${BASE}/me/bookings/${encodeURIComponent(id)}`);
  },

  // ------------------------------------------------------------------ //
  // El prestador
  // ------------------------------------------------------------------ //
  async reservasDelPrestador(ambito: AmbitoDeReservas, cursor: string | null): Promise<PaginaDeReservas> {
    return apiRequest<PaginaDeReservas>(`${BASE}/provider/bookings${consulta({ scope: ambito, cursor })}`);
  },

  async reservaDelPrestador(id: string): Promise<ReservaDelPrestador> {
    return apiRequest<ReservaDelPrestador>(`${BASE}/provider/bookings/${encodeURIComponent(id)}`);
  },

  // ------------------------------------------------------------------ //
  // Administración: lo operativo, sin nada privado
  // ------------------------------------------------------------------ //
  async retencionesParaAdministrar(
    estado: string | null,
    cursor: string | null,
  ): Promise<{ items: RetencionAdmin[]; next_cursor: string | null }> {
    return apiRequest(`${ADMIN}/holds${consulta({ status: estado, cursor })}`);
  },

  async reservasParaAdministrar(
    ambito: AmbitoDeReservas,
    cursor: string | null,
  ): Promise<{ items: ReservaAdmin[]; next_cursor: string | null }> {
    return apiRequest(`${ADMIN}/bookings${consulta({ scope: ambito, cursor })}`);
  },

  /** El barrido de las retenciones vencidas. Idempotente. */
  async barrer(): Promise<{ expired: number }> {
    return apiRequest<{ expired: number }>(`${ADMIN}/holds/expire`, { method: 'POST' });
  },
};
