import { apiRequest, API_V1 } from '@/services/api';
import {
  ESPERA_DE_SUBIDA_MS,
  type EnlaceTemporal,
  type EventoVisible,
  type SolicitudPrivada,
  type Terminos,
  type TipoDePrestador,
} from '@/lib/serviciosAdmision';

/**
 * Z Servicios: la postulación de quien quiere ofrecer servicios.
 *
 * TODAS LAS RUTAS HABLAN DE LA POSTULACIÓN PROPIA: ninguna recibe el
 * identificador de la postulación, así que no hay forma de pedir la de otra
 * persona. Y cada respuesta es el EXPEDIENTE ENTERO recién leído: la pantalla
 * pinta lo que dice el servidor, nunca lo que cree que pasó.
 *
 * Los saltos (enviar, reenviar, retirar) y las credenciales llevan
 * `Idempotency-Key`: un segundo toque, o un reintento tras perder la conexión,
 * no envía dos veces.
 */
const BASE = `${API_V1}/services/provider`;
const MIA = `${BASE}/application`;

function json(body: unknown, method = 'POST', clave?: string): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    ...(clave ? { headers: { 'Idempotency-Key': clave } } : {}),
  };
}

export const ServiceProviderRepository = {
  /** La postulación viva, o la última. 404 `service_application_not_found` si no hay. */
  async postulacion(): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(MIA);
  },

  /** Empezar (o recuperar la viva: es idempotente). */
  async iniciar(peticion: { provider_type: TipoDePrestador; display_name: string }): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(MIA, json(peticion));
  },

  /** Solo lo que cambió. Nunca el estado. */
  async actualizar(cambios: Record<string, string | null>): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(MIA, json(cambios, 'PATCH'));
  },

  async historial(): Promise<EventoVisible[]> {
    return apiRequest<EventoVisible[]>(`${MIA}/history`);
  },

  /** Las condiciones vigentes para el país de la postulación. */
  async condiciones(): Promise<Terminos> {
    return apiRequest<Terminos>(`${BASE}/terms`);
  },

  /** Aceptar EXPRESAMENTE la versión que se enseñó, con su huella. */
  async aceptarCondiciones(terminos: Pick<Terminos, 'policy_id' | 'sha256'>): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(
      `${MIA}/terms`,
      json({ terms_policy_id: terminos.policy_id, terms_sha256: terminos.sha256 }),
    );
  },

  /** Sube un documento al depósito privado. La ruta la pone el servidor. */
  async subirDocumento(opciones: { archivo: Blob; nombre: string; tipo: string }): Promise<SolicitudPrivada> {
    const formulario = new FormData();
    formulario.append('file', opciones.archivo, opciones.nombre);
    formulario.append('kind', opciones.tipo);
    return apiRequest<SolicitudPrivada>(`${MIA}/documents`, {
      method: 'POST',
      body: formulario,
      timeoutMs: ESPERA_DE_SUBIDA_MS,
    });
  },

  /** Uno nuevo del mismo tipo; el anterior queda como evidencia. */
  async reemplazarDocumento(
    documentoId: string,
    opciones: { archivo: Blob; nombre: string },
  ): Promise<SolicitudPrivada> {
    const formulario = new FormData();
    formulario.append('file', opciones.archivo, opciones.nombre);
    return apiRequest<SolicitudPrivada>(
      `${MIA}/documents/${encodeURIComponent(documentoId)}/replace`,
      { method: 'POST', body: formulario, timeoutMs: ESPERA_DE_SUBIDA_MS },
    );
  },

  /** Solo lo que nunca se envió. */
  async retirarDocumento(documentoId: string): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(`${MIA}/documents/${encodeURIComponent(documentoId)}`, {
      method: 'DELETE',
    });
  },

  /** Un enlace de dos minutos para mirarlo. No se guarda. */
  async verDocumento(documentoId: string): Promise<EnlaceTemporal> {
    return apiRequest<EnlaceTemporal>(`${MIA}/documents/${encodeURIComponent(documentoId)}/view`, {
      method: 'POST',
    });
  },

  async registrarCredencial(
    peticion: Record<string, string | null>,
    clave: string,
  ): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(`${MIA}/credentials`, json(peticion, 'POST', clave));
  },

  async editarCredencial(
    credencialId: string,
    cambios: Record<string, string | null>,
  ): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(
      `${MIA}/credentials/${encodeURIComponent(credencialId)}`,
      json(cambios, 'PATCH'),
    );
  },

  async retirarCredencial(credencialId: string): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(`${MIA}/credentials/${encodeURIComponent(credencialId)}`, {
      method: 'DELETE',
    });
  },

  /** `draft → submitted`, con la declaración de veracidad expresa. */
  async enviar(clave: string): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(`${MIA}/submit`, json({ declare_truthfulness: true }, 'POST', clave));
  },

  /** `changes_requested → resubmitted`. */
  async reenviar(clave: string): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(
      `${MIA}/resubmit`,
      json({ declare_truthfulness: true }, 'POST', clave),
    );
  },

  /** Retirarse: confirmación expresa y motivo opcional. Final. */
  async retirar(motivo: string | null, clave: string): Promise<SolicitudPrivada> {
    return apiRequest<SolicitudPrivada>(
      `${MIA}/withdraw`,
      json(motivo ? { confirm: true, reason: motivo } : { confirm: true }, 'POST', clave),
    );
  },
};
