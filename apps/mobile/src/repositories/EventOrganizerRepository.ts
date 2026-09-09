import { apiRequest, API_V1 } from '@/services/api';

/**
 * Los eventos de quien los organiza.
 *
 * SEPARADO DEL DE ADMISIÓN a propósito, igual que `QuizAutorRepository` se
 * separó del del alumno. Aquí no hay ninguna función que devuelva los ocho
 * puntajes de curaduría, así que no puede colarse uno en la consola del
 * organizador por añadir un campo: la deliberación no vive en este fichero.
 */

export type EstadoDeEvento =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'CONDITIONAL'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'SOLD_OUT'
  | 'SUSPENDED'
  | 'CANCELLED'
  | 'COMPLETED_PENDING';

export type ObservacionDeEvento = {
  decision: 'approved' | 'conditional' | 'rejected' | 'changes_requested';
  reason: string;
  version: number;
  created_at: string;
};

export type EventoDelOrganizador = {
  id: string;
  title: string;
  description: string;
  promise: string | null;
  category: string | null;
  timezone: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  cover_path: string | null;
  whatsapp_url: string | null;
  event_type: 'online' | 'presential' | 'live';
  capacity: number | null;
  approved_capacity: number | null;
  workflow_status: EstadoDeEvento;
  selection_status: 'none' | 'pending' | 'approved' | 'rejected';
  /** LO AFIRMA EL SERVIDOR. La app no lo deduce de ninguna otra cosa. */
  seleccionado_por_z: boolean;
  current_version: number | null;
  registrations_count: number;
  /** Por qué no se puede enviar todavía. `null` cuando sí se puede. */
  motivo_para_no_enviar: string | null;
  editable: boolean;
  ultima_observacion: ObservacionDeEvento | null;
};

export type VersionDeEvento = {
  version: number;
  status: string;
  reason: string;
  changed_fields: string[];
  created_at: string;
};

/** Lo que el formulario manda. Todo opcional salvo el título al crear. */
export type BorradorDeEvento = {
  title?: string;
  description?: string;
  promise?: string | null;
  category?: string | null;
  timezone?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  location?: string | null;
  cover_path?: string | null;
  whatsapp_url?: string | null;
  event_type?: 'online' | 'presential' | 'live';
  capacity?: number | null;
};

export const EventOrganizerRepository = {
  async listarMios(): Promise<EventoDelOrganizador[]> {
    return apiRequest<EventoDelOrganizador[]>(`${API_V1}/events/mine?limit=50`);
  },

  async leer(id: string): Promise<EventoDelOrganizador> {
    return apiRequest<EventoDelOrganizador>(`${API_V1}/events/${id}`);
  },

  async crear(datos: BorradorDeEvento): Promise<EventoDelOrganizador> {
    return apiRequest<EventoDelOrganizador>(`${API_V1}/events`, {
      method: 'POST',
      body: JSON.stringify(datos),
    });
  },

  /** Guarda lo que se haya escrito. Lo que no se manda no se toca. */
  async guardar(id: string, datos: BorradorDeEvento): Promise<EventoDelOrganizador> {
    return apiRequest<EventoDelOrganizador>(`${API_V1}/events/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(datos),
    });
  },

  /** Congela una versión y la manda a revisión. NO publica nada. */
  async enviarARevision(id: string, motivo = ''): Promise<EventoDelOrganizador> {
    return apiRequest<EventoDelOrganizador>(`${API_V1}/events/${id}/submit`, {
      method: 'POST',
      body: JSON.stringify({ motivo }),
    });
  },

  async versiones(id: string): Promise<VersionDeEvento[]> {
    return apiRequest<VersionDeEvento[]>(`${API_V1}/events/${id}/versions`);
  },
};
