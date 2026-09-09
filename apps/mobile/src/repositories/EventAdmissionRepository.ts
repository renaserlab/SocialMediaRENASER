import { apiRequest, API_V1 } from '@/services/api';
import type { EventoDelOrganizador } from '@/repositories/EventOrganizerRepository';

/**
 * La admisión: la cola de revisión, los ocho puntajes y las decisiones.
 *
 * VIVE APARTE del repositorio del organizador. La separación es la garantía:
 * `EventoDelOrganizador` no declara `evaluacion`, así que la consola de quien
 * organiza no puede enseñar por descuido la deliberación interna de curaduría.
 *
 * QUIÉN PUEDE LLAMAR A QUÉ lo decide el servidor, no esta pantalla. Ocultar un
 * botón es comodidad; la comprobación está en `events/permissions.py`.
 */

export type PuntajesDeAdmision = {
  propuesta: number;
  trayectoria: number;
  programa: number;
  recinto: number;
  seguridad: number;
  precio: number;
  accesibilidad: number;
  afinidad: number;
};

export type EvaluacionDeEvento = PuntajesDeAdmision & {
  version: number;
  total: number;
  falla_critica: boolean;
  motivo_de_la_falla: string;
  evidencia: string;
  /** Hasta dónde permite llegar el puntaje. NO es la decisión tomada. */
  decision_posible: 'approved' | 'conditional' | 'rejected';
  updated_at: string;
};

export type DocumentoDeEvento = {
  kind: string;
  status: 'pending' | 'received' | 'approved' | 'rejected' | 'expired';
  expires_at: string | null;
  required: boolean;
  blocks_publication: boolean;
  note: string;
};

export type ExpedienteDeEvento = EventoDelOrganizador & {
  organizer_id: string;
  origin: 'events_v2' | 'legacy';
  submitted_at: string | null;
  evaluacion: EvaluacionDeEvento | null;
  documentos: DocumentoDeEvento[];
  bloqueos_para_publicar: string[];
};

export type DecisionDeAdmision = 'approved' | 'conditional' | 'rejected';

const base = `${API_V1}/admin/events`;

export const EventAdmissionRepository = {
  async pendientes(): Promise<ExpedienteDeEvento[]> {
    return apiRequest<ExpedienteDeEvento[]>(`${base}/pending?limit=50`);
  },

  async expediente(id: string): Promise<ExpedienteDeEvento> {
    return apiRequest<ExpedienteDeEvento>(`${base}/${id}`);
  },

  /** Guarda los ocho puntajes con su evidencia. Puntuar no es decidir. */
  async evaluar(
    id: string,
    datos: PuntajesDeAdmision & {
      evidencia: string;
      falla_critica: boolean;
      motivo_de_la_falla: string;
    },
  ): Promise<ExpedienteDeEvento> {
    return apiRequest<ExpedienteDeEvento>(`${base}/${id}/review`, {
      method: 'POST',
      body: JSON.stringify(datos),
    });
  },

  /** Devuelve el evento a su organizador con una observación. */
  async pedirCorrecciones(id: string, motivo: string): Promise<ExpedienteDeEvento> {
    return apiRequest<ExpedienteDeEvento>(`${base}/${id}/request-changes`, {
      method: 'POST',
      body: JSON.stringify({ motivo }),
    });
  },

  async decidir(
    id: string,
    decision: DecisionDeAdmision,
    motivo: string,
  ): Promise<ExpedienteDeEvento> {
    return apiRequest<ExpedienteDeEvento>(`${base}/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, motivo }),
    });
  },

  async publicar(id: string): Promise<ExpedienteDeEvento> {
    return apiRequest<ExpedienteDeEvento>(`${base}/${id}/publish`, { method: 'POST' });
  },

  async suspender(id: string, motivo: string): Promise<ExpedienteDeEvento> {
    return apiRequest<ExpedienteDeEvento>(`${base}/${id}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ motivo }),
    });
  },

  async reanudar(id: string, motivo: string): Promise<ExpedienteDeEvento> {
    return apiRequest<ExpedienteDeEvento>(`${base}/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ motivo }),
    });
  },
};
