import { apiRequest, API_V1 } from '@/services/api';

/**
 * La posventa de eventos, desde el lado del comprador.
 *
 * SOLO LO DEL COMPRADOR. La bandeja, las decisiones y las políticas viven bajo
 * `/admin/events` y no tienen método aquí: un repositorio que expone lo que la
 * aplicación no debe llamar es una invitación a llamarlo.
 *
 * EL IMPORTE NO VIAJA HACIA EL SERVIDOR. Abrir un expediente manda el pedido,
 * el tipo y el motivo; cuánto se devuelve lo decide la política publicada y lo
 * escribe administración. El tipo de TypeScript no tiene dónde poner una cifra.
 *
 * ABRIR NO ES OBTENER. `abrir` registra una solicitud y nada más: no revoca la
 * entrada, no mueve dinero y no promete un resultado. Quien lea estos tipos no
 * debería poder confundirse.
 */

/** Lo que la elegibilidad contesta sobre una compra. */
export type VeredictoDePosventa = {
  /** `eligible`, `not_eligible`, `needs_review` o `policy_not_configured`. */
  resultado: string;
  /** CÓDIGOS, no frases: la aplicación los traduce. */
  motivos: string[];
  /** Si tiene sentido ofrecer el botón. `needs_review` cuenta. */
  puede_pedir: boolean;
  /** Con qué reglas se decidió. `null` cuando no hay ninguna publicada. */
  politica_version: string | null;
  /** Lo que la política permite devolver, en puntos básicos.
   * **`null` NO es cero**: es que nadie ha decidido el número. */
  porcentaje_bps: number | null;
};

export type Expediente = {
  id: string;
  event_id: string;
  order_id: string;
  /** `buyer_cancellation`, `refund_request`, `essential_change`, `exception`… */
  kind: string;
  /** `submitted`, `under_review`, `awaiting_information`, `approved`,
   * `rejected`, `refund_pending`, `refund_processing`, `resolved`,
   * `cancelled` o `failed`. */
  status: string;
  /** Lo que dijo quien lo abrió. Es suyo, así que lo ve. */
  reason: string | null;
  /** El resultado con el que se cerró, o `null` mientras no hay decisión. */
  outcome: string | null;
  /** `null` mientras no haya decisión. NUNCA cero por defecto. */
  refund_amount_minor: number | null;
  currency: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  /** Lo que ESTE actor puede hacer ahora, según el servidor. Para pintar
   * botones, no para decidir: la máquina de estados vive allí. */
  acciones: string[];
};

export type PaginaDeExpedientes = {
  items: Expediente[];
  next_cursor: string | null;
};

/** Un paso del expediente. SIN las notas internas: no salen del backend. */
export type LineaDeHistorial = {
  from_status: string | null;
  to_status: string;
  /** `buyer`, `organizer`, `support`, `admin` o `system`. */
  actor_role: string;
  reason: string | null;
  created_at: string;
};

/** Una entrada del expediente. SIN credencial y SIN código: los dos admiten. */
export type EntradaAfectada = {
  ticket_id: string;
  name: string;
  /** `VALID`, `USED` o `REVOKED`, ahora mismo. */
  status: string;
  /** Cómo estaba al abrirse el expediente. Congelado. */
  status_at_open: string;
  /** `none`, `under_review`, `blocked`, `cancelled`, `revoked` o `restored`. */
  effect: string;
};

/** Con qué reglas se resolvió. SIN los números, que son de administración. */
export type PoliticaAplicada = {
  policy_type: string;
  version: string;
  published_at: string | null;
  body: string | null;
};

export const EventAftersaleRepository = {
  /** ¿Qué se puede pedir con esta compra? NO ESCRIBE NADA Y NO PROMETE NADA. */
  async elegibilidad(orderId: string): Promise<VeredictoDePosventa> {
    return apiRequest<VeredictoDePosventa>(
      `${API_V1}/events/orders/${orderId}/aftersale-eligibility`,
    );
  },

  /** Abre una solicitud. No revoca la entrada ni mueve dinero. */
  async abrir(orderId: string, tipo: string, motivo: string): Promise<Expediente> {
    return apiRequest<Expediente>(`${API_V1}/events/aftersale-cases`, {
      method: 'POST',
      body: JSON.stringify({ order_id: orderId, kind: tipo, reason: motivo }),
    });
  },

  async mios(limit = 20, cursor?: string | null): Promise<PaginaDeExpedientes> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return apiRequest<PaginaDeExpedientes>(
      `${API_V1}/events/me/aftersale-cases?${q.toString()}`,
    );
  },

  async leer(caseId: string): Promise<Expediente> {
    return apiRequest<Expediente>(`${API_V1}/events/aftersale-cases/${caseId}`);
  },

  async historial(caseId: string): Promise<LineaDeHistorial[]> {
    return apiRequest<LineaDeHistorial[]>(
      `${API_V1}/events/aftersale-cases/${caseId}/history`,
    );
  },

  async entradas(caseId: string): Promise<EntradaAfectada[]> {
    return apiRequest<EntradaAfectada[]>(
      `${API_V1}/events/aftersale-cases/${caseId}/tickets`,
    );
  },

  /**
   * Con qué reglas se resolvió.
   *
   * CONTESTA 404 MIENTRAS NO HAY DECISIÓN, y eso no es un error: es que nadie
   * ha decidido todavía. Quien llame a esto tiene que tratarlo como «aún no»,
   * no como un fallo de carga.
   */
  async politica(caseId: string): Promise<PoliticaAplicada> {
    return apiRequest<PoliticaAplicada>(
      `${API_V1}/events/aftersale-cases/${caseId}/policy`,
    );
  },

  /** El comprador contesta a lo que se le pidió. Vuelve a revisión. */
  async responder(caseId: string, motivo: string): Promise<Expediente> {
    return apiRequest<Expediente>(
      `${API_V1}/events/aftersale-cases/${caseId}/respond`,
      { method: 'POST', body: JSON.stringify({ reason: motivo }) },
    );
  },

  /** El comprador retira su solicitud mientras nadie ha decidido. */
  async retirar(caseId: string, motivo?: string | null): Promise<Expediente> {
    return apiRequest<Expediente>(
      `${API_V1}/events/aftersale-cases/${caseId}/withdraw`,
      { method: 'POST', body: JSON.stringify({ reason: motivo ?? null }) },
    );
  },
};
