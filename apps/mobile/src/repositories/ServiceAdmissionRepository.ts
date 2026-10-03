import { apiRequest, API_V1 } from '@/services/api';
import {
  consultaDeLaBandeja,
  type EnlaceTemporal,
  type EstadoDePostulacion,
  type EventoAdmin,
  type PaginaDeSolicitudes,
  type Politica,
  type TipoDePolitica,
  type SolicitudAdmin,
  type Terminos,
  type TipoDePrestador,
} from '@/lib/serviciosAdmision';

/**
 * Z Servicios: la revisión de postulaciones de prestadores, para el equipo de Z.
 *
 * EL PERMISO LO DECIDE EL SERVIDOR en cada llamada: revisar es de moderación y
 * administración; aprobar, rechazar, suspender y publicar condiciones, solo de
 * administración; y nadie decide su propia admisión. La pantalla solo enseña
 * los botones que el expediente dice (`available_actions`).
 *
 * Cada decisión devuelve el expediente recién leído, y lleva
 * `Idempotency-Key`: dos toques no deciden dos veces.
 */
const BASE = `${API_V1}/admin/services`;
const SOLICITUDES = `${BASE}/applications`;

function json(body: unknown, clave?: string, method = 'POST'): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    ...(clave ? { headers: { 'Idempotency-Key': clave } } : {}),
  };
}

function limpio(valor: string | null | undefined): string | undefined {
  const t = (valor ?? '').trim();
  return t === '' ? undefined : t;
}

const una = (id: string) => `${SOLICITUDES}/${encodeURIComponent(id)}`;

export const ServiceAdmissionRepository = {
  /** La bandeja, por cursor. Sin estado: lo que espera a Z. */
  async bandeja(opciones: {
    estado: EstadoDePostulacion | null;
    tipo: TipoDePrestador | null;
    cursor: string | null;
  }): Promise<PaginaDeSolicitudes> {
    return apiRequest<PaginaDeSolicitudes>(`${SOLICITUDES}?${consultaDeLaBandeja(opciones)}`);
  },

  async expediente(id: string): Promise<SolicitudAdmin> {
    return apiRequest<SolicitudAdmin>(una(id));
  },

  async historial(id: string): Promise<EventoAdmin[]> {
    return apiRequest<EventoAdmin[]>(`${una(id)}/history`);
  },

  /** Un enlace de dos minutos. Queda en la auditoría quién lo pidió. */
  async verDocumento(id: string, documentoId: string): Promise<EnlaceTemporal> {
    return apiRequest<EnlaceTemporal>(`${una(id)}/documents/${encodeURIComponent(documentoId)}/view`, {
      method: 'POST',
    });
  },

  async aceptarDocumento(id: string, documentoId: string): Promise<SolicitudAdmin> {
    return apiRequest<SolicitudAdmin>(`${una(id)}/documents/${encodeURIComponent(documentoId)}/accept`, {
      method: 'POST',
    });
  },

  async observarDocumento(id: string, documentoId: string, nota: string): Promise<SolicitudAdmin> {
    return apiRequest<SolicitudAdmin>(
      `${una(id)}/documents/${encodeURIComponent(documentoId)}/observe`,
      json({ note: nota.trim() }),
    );
  },

  async verificarCredencial(id: string, credencialId: string): Promise<SolicitudAdmin> {
    return apiRequest<SolicitudAdmin>(
      `${una(id)}/credentials/${encodeURIComponent(credencialId)}/verify`,
      { method: 'POST' },
    );
  },

  async observarCredencial(id: string, credencialId: string, nota: string): Promise<SolicitudAdmin> {
    return apiRequest<SolicitudAdmin>(
      `${una(id)}/credentials/${encodeURIComponent(credencialId)}/observe`,
      json({ note: nota.trim() }),
    );
  },

  async rechazarCredencial(id: string, credencialId: string, nota: string): Promise<SolicitudAdmin> {
    return apiRequest<SolicitudAdmin>(
      `${una(id)}/credentials/${encodeURIComponent(credencialId)}/reject`,
      json({ note: nota.trim() }),
    );
  },

  /**
   * Una decisión sobre el expediente: `start-review`, `request-changes`,
   * `approve`, `reject` o `suspend`. El motivo va donde el servidor lo pide.
   */
  async decidir(
    id: string,
    accion: string,
    datos: { mensaje?: string | null; notaInterna?: string | null; campos?: string[] },
    clave: string,
  ): Promise<SolicitudAdmin> {
    const ruta: Record<string, string> = {
      start_review: 'start-review',
      request_changes: 'request-changes',
      approve: 'approve',
      reject: 'reject',
      suspend: 'suspend',
    };
    const destino = ruta[accion];
    if (!destino) throw new Error(`acción desconocida: ${accion}`);
    const cuerpo: Record<string, unknown> = {};
    const nota = limpio(datos.notaInterna);
    if (nota) cuerpo.internal_note = nota;
    const mensaje = limpio(datos.mensaje);
    if (accion !== 'start_review' && mensaje) cuerpo.message = mensaje;
    if (accion === 'request_changes' && datos.campos && datos.campos.length > 0) {
      cuerpo.fields = datos.campos;
    }
    return apiRequest<SolicitudAdmin>(`${una(id)}/${destino}`, json(cuerpo, clave));
  },

  // --- Condiciones: del prestador y de contratación (Incremento 5) ----------
  async condiciones(pais?: string | null, tipo: TipoDePolitica = 'provider_terms'): Promise<Politica[]> {
    const q = new URLSearchParams({ kind: tipo });
    const p = limpio(pais);
    if (p) q.set('country', p);
    return apiRequest<Politica[]>(`${BASE}/policies?${q.toString()}`);
  },

  /** Crea el borrador de un país, o devuelve el que ya hay (sin tocarlo). */
  async crearBorrador(
    peticion: {
      country_code: string;
      title: string;
      body: string;
      parameters: Record<string, unknown>;
    },
    tipo: TipoDePolitica = 'provider_terms',
  ): Promise<Politica> {
    const ruta = tipo === 'booking_terms' ? 'booking-terms' : 'provider-terms';
    return apiRequest<Politica>(`${BASE}/policies/${ruta}/draft`, json(peticion));
  },

  async editarBorrador(
    id: string,
    cambios: { title?: string; body?: string; parameters?: Record<string, unknown> },
  ): Promise<Politica> {
    return apiRequest<Politica>(`${BASE}/policies/${encodeURIComponent(id)}`, json(cambios, undefined, 'PATCH'));
  },

  async vistaPrevia(id: string): Promise<Terminos> {
    return apiRequest<Terminos>(`${BASE}/policies/${encodeURIComponent(id)}/preview`);
  },

  async publicar(id: string): Promise<Politica> {
    return apiRequest<Politica>(`${BASE}/policies/${encodeURIComponent(id)}/publish`, { method: 'POST' });
  },
};
