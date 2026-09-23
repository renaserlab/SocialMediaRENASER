import { apiRequest, API_V1 } from '@/services/api';
import type { ResumenFinanciero, SaldoDeVenta } from '@/lib/finanzasDeEventos';

/**
 * Las ventas y el saldo de un evento, para quien lo organiza.
 *
 * SOLO LEE. No hay aquí —ni puede haber— ningún método que suelte una reserva,
 * concilie, ni ejecute una transferencia: eso vive en
 * `EventFinanceAdminRepository` y exige el permiso de mover dinero. Separarlos
 * es lo que impide que un campo nuevo arrastre una acción de administración a
 * la pantalla de quien organiza.
 *
 * EL SERVIDOR DECIDE DE QUIÉN ES CADA SALDO, por `owner_id`, congelado al
 * vender. Un evento ajeno contesta 404, no 403: aquí no se confirma que el
 * evento de otra persona exista.
 *
 * 503 `event_finance_not_available` CUANDO LA MIGRACIÓN NO ESTÁ. No es un
 * fallo: es que todavía no hay dónde guardar nada. La pantalla lo dice así.
 */
export const EventFinanceRepository = {
  /** El resumen. Sin comisión configurada llegan `null` la comisión y el neto. */
  async resumen(eventoId: string): Promise<ResumenFinanciero> {
    return apiRequest<ResumenFinanciero>(
      `${API_V1}/events/${eventoId}/finance`,
    );
  },

  /**
   * El detalle por pedido, hasta el tope pedido.
   *
   * `limite` es explícito y sin cursor porque el servidor no manda ninguno: lo
   * que vuelve es «los más recientes hasta aquí», y la pantalla lo dice.
   */
  async saldos(eventoId: string, limite = 50): Promise<SaldoDeVenta[]> {
    const q = new URLSearchParams({ limit: String(limite) });
    return apiRequest<SaldoDeVenta[]>(
      `${API_V1}/events/${eventoId}/finance/balances?${q.toString()}`,
    );
  },
};
