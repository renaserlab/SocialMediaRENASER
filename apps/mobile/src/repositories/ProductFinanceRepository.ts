import { apiRequest, API_V1 } from '@/services/api';
import type {
  CuentaDeCobro,
  DevolucionDeProducto,
  ResumenFinanciero,
  SaldoDeProducto,
  SaludFinanciera,
} from '@/lib/finanzasDeProductos';

/**
 * El dinero de una venta de producto.
 *
 * NO HAY NINGÚN MÉTODO QUE EJECUTE UNA TRANSFERENCIA, y no es un olvido:
 * ejecutar una necesita Stripe Connect confirmado para el país y el rubro de la
 * empresa, y esa confirmación no existe. No hay ruta en el servidor tampoco. Un
 * método aquí llamado `transferir()` sería ofrecer algo que no ocurre.
 *
 * NO HAY `darDeAltaLaCuenta()`. Darse de alta exige una cuenta de la empresa
 * verificada, la confirmación de Connect y una decisión de quién cobra:
 * ninguna de las tres existe. Lo que sí hay es leer el estado y qué falta.
 *
 * NO HAY NINGÚN MÉTODO QUE CALCULE UNA COMISIÓN NI UN IMPORTE A DEVOLVER. El
 * porcentaje vive en el servidor y en la versión de reglas que congeló cada
 * venta; cuánto se devuelve lo teclea una persona con permiso financiero.
 */
export type Retencion = {
  id: string;
  balance_id: string;
  amount_minor: number;
  currency: string;
  reason: string;
  status: string;
  incident_id?: string | null;
  created_at: string;
  released_at?: string | null;
};

export type Disputa = {
  id: string;
  order_id: string;
  balance_id?: string | null;
  provider: string;
  external_dispute_id: string;
  amount_minor: number;
  currency: string;
  reason?: string | null;
  status: string;
  opened_at: string;
  due_at?: string | null;
  closed_at?: string | null;
};

export type MovimientoDeDevolucion = {
  id: string;
  from_status?: string | null;
  to_status: string;
  actor_id?: string | null;
  actor_role: string;
  reason?: string | null;
  provider_reference?: string | null;
  created_at: string;
};

export type Pagina = { before?: string; beforeId?: string; limit?: number };

/** La cola de la URL, con el cursor ENTERO O NINGUNO. */
function _cola(opciones?: Pagina): string {
  const parametros = new URLSearchParams();
  if (opciones?.before && opciones?.beforeId) {
    parametros.set('before', opciones.before);
    parametros.set('before_id', opciones.beforeId);
  }
  if (opciones?.limit) parametros.set('limit', String(opciones.limit));
  const cola = parametros.toString();
  return cola ? `?${cola}` : '';
}

/** Lo que ve y puede hacer quien vende. */
export const ProductFinanceRepository = {
  /** Su resumen. SIN COMISIÓN CONFIGURADA VIAJA LA BANDERA, no un cero. */
  async resumen(): Promise<ResumenFinanciero> {
    return apiRequest<ResumenFinanciero>(`${API_V1}/products/seller/finance`);
  },

  /** Venta a venta, con el motivo de cada bloqueo. */
  async movimientos(opciones?: Pagina): Promise<SaldoDeProducto[]> {
    return apiRequest<SaldoDeProducto[]>(
      `${API_V1}/products/seller/finance/balances${_cola(opciones)}`,
    );
  },

  /** Lo que está apartado y por qué. */
  async retenciones(): Promise<Retencion[]> {
    return apiRequest<Retencion[]>(`${API_V1}/products/seller/finance/reserves`);
  },

  /** Dónde se le pagaría, y qué falta para que se pueda. */
  async cuentaDeCobro(): Promise<CuentaDeCobro> {
    return apiRequest<CuentaDeCobro>(`${API_V1}/products/seller/payout-account`);
  },
};

/** Lo que ve quien compró de su propio pedido. */
export const ProductBuyerMoneyRepository = {
  /** Qué dinero ha vuelto de este pedido. */
  async devolucionesDelPedido(orderId: string): Promise<DevolucionDeProducto[]> {
    return apiRequest<DevolucionDeProducto[]>(
      `${API_V1}/products/orders/${orderId}/refunds`,
    );
  },

  /**
   * «Esto está bien». LIBERA EL DINERO, y por eso es una acción aparte de
   * confirmar que llegó.
   */
  async darLaConformidad(orderId: string): Promise<unknown> {
    return apiRequest<unknown>(`${API_V1}/products/orders/${orderId}/conformity`, {
      method: 'POST',
    });
  },
};

/** Lo que solo puede hacer administración financiera. */
export const ProductFinanceAdminRepository = {
  /** El panel, en cuentas de filas. Ni un importe, ni un porcentaje. */
  async salud(): Promise<SaludFinanciera> {
    return apiRequest<SaludFinanciera>(`${API_V1}/admin/products/finance/health`);
  },

  /** Pasa a elegibles los que ya no tiene nada que impida. IDEMPOTENTE. */
  async liberarVencidos(): Promise<{ looked: number; released: number; blocked: number }> {
    return apiRequest(`${API_V1}/admin/products/finance/release-due`, {
      method: 'POST',
    });
  },

  /** Los saldos que no se liberan, con su motivo. */
  async bloqueos(): Promise<SaldoDeProducto[]> {
    return apiRequest<SaldoDeProducto[]>(`${API_V1}/admin/products/finance/blocks`);
  },

  /** Las devoluciones que esperan algo. */
  async devoluciones(): Promise<DevolucionDeProducto[]> {
    return apiRequest<DevolucionDeProducto[]>(
      `${API_V1}/admin/products/finance/refunds`,
    );
  },

  /** Los contracargos. QUIEN ASUME LA PÉRDIDA NO ESTÁ DECIDIDO. */
  async disputas(): Promise<Disputa[]> {
    return apiRequest<Disputa[]>(`${API_V1}/admin/products/finance/disputes`);
  },

  /**
   * Registra que se decidió devolver un importe. NO MUEVE UN CÉNTIMO.
   *
   * EL IMPORTE LO TECLEA UNA PERSONA: no hay ninguna fórmula, porque cuánto se
   * devuelve en cada salida es una decisión que la empresa no ha tomado.
   */
  async aprobarDevolucion(
    orderId: string,
    datos: { amount_minor: number; reason: string; incident_id?: string | null },
  ): Promise<DevolucionDeProducto> {
    return apiRequest<DevolucionDeProducto>(
      `${API_V1}/admin/products/orders/${orderId}/refunds`,
      {
        method: 'POST',
        body: JSON.stringify({
          amount_minor: datos.amount_minor,
          reason: datos.reason,
          incident_id: datos.incident_id ?? null,
        }),
      },
    );
  },

  /** Se lo pide a la pasarela. APAGADA, FALLA EN CERRADO Y LO DICE. */
  async pedirDevolucion(refundId: string): Promise<DevolucionDeProducto> {
    return apiRequest<DevolucionDeProducto>(
      `${API_V1}/admin/products/refunds/${refundId}/request`,
      { method: 'POST' },
    );
  },

  /** Anula una que todavía no ha salido. UNA CONFIRMADA NO SE ANULA. */
  async anularDevolucion(
    refundId: string,
    reason: string,
  ): Promise<DevolucionDeProducto> {
    return apiRequest<DevolucionDeProducto>(
      `${API_V1}/admin/products/refunds/${refundId}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
  },

  /** Qué se hizo con ese dinero, en orden. SOLO SE AÑADE. */
  async historialDeDevolucion(refundId: string): Promise<MovimientoDeDevolucion[]> {
    return apiRequest<MovimientoDeDevolucion[]>(
      `${API_V1}/admin/products/refunds/${refundId}/history`,
    );
  },

  /** Suelta una retención a mano, con motivo. SOLTAR NO ES CONSUMIR. */
  async soltarRetencion(reserveId: string, reason: string): Promise<Retencion> {
    return apiRequest<Retencion>(
      `${API_V1}/admin/products/finance/reserves/${reserveId}/release`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
  },
};
