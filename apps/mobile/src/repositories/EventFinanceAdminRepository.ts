import { apiRequest, API_V1 } from '@/services/api';
import type {
  Disputa,
  Hallazgo,
  ResultadoDeTransferencias,
} from '@/lib/finanzasDeEventos';

/**
 * Las finanzas de eventos, desde administración.
 *
 * TODAS EXIGEN MOVER DINERO —`puede_mover_dinero`, no `is_admin`—. Moderar
 * contenido no es administrar el dinero de nadie, así que quien no lo tenga
 * recibe un 403 y la pantalla lo cuenta como lo que es.
 *
 * NINGUNO DE ESTOS MÉTODOS MUEVE DINERO:
 *
 *   - `conciliar` compara y REPORTA. Una diferencia no se arregla escribiendo
 *     el número que falta: eso no concilia, tapa.
 *   - `soltarReserva` levanta una retención y anota por qué. El dinero no se
 *     transfiere ni se devuelve por soltarla.
 *   - `ejecutarTransferencias` es la ruta que algún día pagaría. HOY devuelve
 *     cero ejecutadas y la lista de banderas apagadas, y eso es exactamente lo
 *     que se enseña. No existe ningún método que declare pagado a nadie.
 */
export type ResultadoDeConciliacion = {
  total: number;
  hallazgos: Hallazgo[];
};

export const EventFinanceAdminRepository = {
  /** Los contadores de operación. `{"disponible": 0}` si no hay esquema. */
  async salud(): Promise<Record<string, unknown>> {
    return apiRequest<Record<string, unknown>>(
      `${API_V1}/admin/events/finance/health`,
    );
  },

  /** Compara y REPORTA. No corrige nada, y no hay ninguna ruta que lo haga. */
  async conciliar(limite = 200): Promise<ResultadoDeConciliacion> {
    const q = new URLSearchParams({ limit: String(limite) });
    return apiRequest<ResultadoDeConciliacion>(
      `${API_V1}/admin/events/finance/reconcile?${q.toString()}`,
      { method: 'POST' },
    );
  },

  /** Las disputas. Sin `liability` mientras no haya política publicada. */
  async disputas(opciones?: {
    estado?: string | null;
    limite?: number;
  }): Promise<Disputa[]> {
    const q = new URLSearchParams({ limit: String(opciones?.limite ?? 50) });
    if (opciones?.estado) q.set('estado', opciones.estado);
    return apiRequest<Disputa[]>(
      `${API_V1}/admin/events/finance/disputes?${q.toString()}`,
    );
  },

  /**
   * Levanta una retención sobre un saldo. **NO MUEVE DINERO.**
   *
   * `consumida` es `true` solo cuando el dinero ya se fue de verdad —una
   * disputa perdida—: deja de retener y anota que no vuelve. Tampoco entonces
   * se transfiere nada desde aquí.
   *
   * El motivo es obligatorio (3 a 500 caracteres): una retención levantada sin
   * motivo escrito no se puede auditar después.
   */
  async soltarReserva(
    reservaId: string,
    motivo: string,
    consumida: boolean,
  ): Promise<{ soltada: boolean; id: string }> {
    return apiRequest<{ soltada: boolean; id: string }>(
      `${API_V1}/admin/events/finance/reserves/${reservaId}/release`,
      { method: 'POST', body: JSON.stringify({ motivo, consumida }) },
    );
  },

  /**
   * La ruta que algún día pagaría a los organizadores. HOY NO PAGA.
   *
   * Devuelve `{ejecutadas: 0, bloqueos: [...]}` y ninguna pantalla puede
   * convertir eso en una promesa de cobro.
   */
  async ejecutarTransferencias(): Promise<ResultadoDeTransferencias> {
    return apiRequest<ResultadoDeTransferencias>(
      `${API_V1}/admin/events/finance/transfers/run`,
      { method: 'POST' },
    );
  },
};
