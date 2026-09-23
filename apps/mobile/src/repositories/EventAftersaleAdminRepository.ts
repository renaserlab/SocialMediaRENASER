import { apiRequest, API_V1 } from '@/services/api';
import type { Expediente } from '@/repositories/EventAftersaleRepository';

/**
 * La posventa de eventos, desde administración.
 *
 * SEPARADO DEL DEL COMPRADOR A PROPÓSITO, igual que `QuizAutorRepository` se
 * separó del del alumno. En `EventAftersaleRepository` no hay ni un método que
 * apruebe, rechace o lea una nota interna, así que no puede colarse uno en la
 * pantalla de quien compró por añadir un campo.
 *
 * APROBAR NO ES PAGAR, y aquí es donde se nota en el contrato: `aprobar` deja
 * el expediente en `approved`. No existe —ni puede existir— un método que lo
 * declare devuelto: `resolved` desde `refund_processing` solo lo alcanza un
 * aviso verificado del proveedor, y ninguna persona puede darlo. Si algún día
 * hace falta ejecutar la devolución desde aquí, será una ruta nueva del
 * servidor, no una que nos inventemos.
 *
 * NO HAY «LEER UN EXPEDIENTE POR SU ID». El servidor publica la bandeja
 * (`GET /admin/events/aftersale-cases`) con filtros de estado y evento, y
 * ninguna ruta `/admin/events/aftersale-cases/{id}` de lectura. `buscarEnLaBandeja`
 * hace lo único honesto que se puede hacer con lo que hay: pedir la bandeja
 * —acotada por evento cuando se conoce— y encontrar el caso dentro. Puede no
 * estar, y entonces devuelve `null` y la pantalla lo dice; falsear una lectura
 * individual sería peor.
 */

/** El expediente con lo que solo ve quien administra. */
export type ExpedienteDeAdministracion = Expediente & {
  buyer_id: string;
  organizer_id: string;
  /** NO SALE DE ADMINISTRACIÓN. Ni al comprador ni a quien organiza. */
  internal_notes: string | null;
  /** Quién lo tiene tomado. `null` mientras nadie lo ha cogido. */
  assignee_id: string | null;
  /** Con qué política se decidió. `null` mientras no hay decisión. */
  policy_id: string | null;
  /** La pasarela con la que se cobró. */
  provider: string;
  /** `live` o `test`. Un caso de prueba no es un caso. */
  environment: string;
};

/** Un cambio registrado del evento. Sin clasificar es SIN CLASIFICAR. */
export type CambioDelEvento = {
  id: string;
  event_id: string;
  field: string;
  previous_value: string | null;
  new_value: string | null;
  /** `pending`, `editorial`, `operational`, `possibly_essential`,
   * `essential` o `not_essential`. `pending` NO es «no esencial». */
  classification: string;
  classified_at: string | null;
  created_at: string;
};

/** Una política publicada, con sus números. Esto es de administración. */
export type PoliticaPublicada = {
  id: string;
  policy_type: string;
  scope: string;
  event_id: string | null;
  version: string;
  status: string;
  params: Record<string, unknown>;
  params_sha256: string;
  published_at: string | null;
};

/** Lo que se manda al decidir. `notes` no sale de administración. */
export type Decision = {
  /** Lo que la persona va a leer. */
  motivo?: string | null;
  /** Lo que solo se ve aquí dentro. */
  notas?: string | null;
  /** Con qué resultado se cierra. */
  desenlace?: string | null;
  /** En la unidad menor. Va SIEMPRE con su moneda. */
  importeMinor?: number | null;
  moneda?: string | null;
};

function cuerpoDeDecision(decision: Decision): string {
  /*
    SOLO LO ESCRITO. Un `null` explícito y un campo ausente significan lo mismo
    para el servidor, pero mandar `refund_amount_minor: 0` porque la pantalla
    tenía el campo vacío sería decidir que no corresponde nada. Lo que nadie ha
    escrito, no viaja.
  */
  const cuerpo: Record<string, unknown> = {};
  if (decision.motivo) cuerpo.reason = decision.motivo;
  if (decision.notas) cuerpo.notes = decision.notas;
  if (decision.desenlace) cuerpo.outcome = decision.desenlace;
  if (typeof decision.importeMinor === 'number' && decision.moneda) {
    cuerpo.refund_amount_minor = decision.importeMinor;
    cuerpo.currency = decision.moneda;
  }
  return JSON.stringify(cuerpo);
}

export const EventAftersaleAdminRepository = {
  /**
   * La bandeja. El filtrado lo hace la base ANTES del límite.
   *
   * `limite` es explícito y sin cursor porque el servidor no manda ninguno:
   * lo que vuelve es «los más recientes hasta este tope», y la pantalla lo dice.
   */
  async bandeja(opciones?: {
    estado?: string | null;
    eventoId?: string | null;
    limite?: number;
  }): Promise<ExpedienteDeAdministracion[]> {
    const q = new URLSearchParams({ limit: String(opciones?.limite ?? 50) });
    if (opciones?.estado) q.set('estado', opciones.estado);
    if (opciones?.eventoId) q.set('event_id', opciones.eventoId);
    return apiRequest<ExpedienteDeAdministracion[]>(
      `${API_V1}/admin/events/aftersale-cases?${q.toString()}`,
    );
  },

  /**
   * Un expediente concreto, buscado dentro de la bandeja.
   *
   * `eventoId` acota la búsqueda al evento del caso cuando se conoce —se sabe
   * al llegar desde la lista—, que es lo que hace que esto no dependa de la
   * suerte. Devuelve `null` cuando no aparece dentro del tope: la pantalla
   * tiene que decir que no lo encuentra, no fingir un 404 del servidor.
   */
  async buscarEnLaBandeja(
    caseId: string,
    eventoId?: string | null,
  ): Promise<ExpedienteDeAdministracion | null> {
    const filas = await this.bandeja({ eventoId: eventoId ?? null, limite: 200 });
    return filas.find((fila) => fila.id === caseId) ?? null;
  },

  /** Lo toma para revisarlo. El servidor impide que dos lo tomen. */
  async tomar(caseId: string, notas?: string | null): Promise<ExpedienteDeAdministracion> {
    return apiRequest<ExpedienteDeAdministracion>(
      `${API_V1}/admin/events/aftersale-cases/${caseId}/review`,
      { method: 'POST', body: cuerpoDeDecision({ notas }) },
    );
  },

  /** Le pide a quien compró lo que falte. El motivo lo lee esa persona. */
  async pedirInformacion(
    caseId: string,
    motivo: string,
    notas?: string | null,
  ): Promise<ExpedienteDeAdministracion> {
    return apiRequest<ExpedienteDeAdministracion>(
      `${API_V1}/admin/events/aftersale-cases/${caseId}/request-info`,
      { method: 'POST', body: cuerpoDeDecision({ motivo, notas }) },
    );
  },

  /**
   * Aprueba. **Y APROBAR NO ES DEVOLVER**: el expediente queda en `approved`
   * y el dinero no se ha movido. Sin política publicada el servidor no deja.
   */
  async aprobar(
    caseId: string,
    decision: Decision,
  ): Promise<ExpedienteDeAdministracion> {
    return apiRequest<ExpedienteDeAdministracion>(
      `${API_V1}/admin/events/aftersale-cases/${caseId}/approve`,
      { method: 'POST', body: cuerpoDeDecision(decision) },
    );
  },

  /** Rechaza. El motivo es obligatorio: es lo que la persona va a leer. */
  async rechazar(
    caseId: string,
    motivo: string,
    notas?: string | null,
  ): Promise<ExpedienteDeAdministracion> {
    return apiRequest<ExpedienteDeAdministracion>(
      `${API_V1}/admin/events/aftersale-cases/${caseId}/reject`,
      { method: 'POST', body: cuerpoDeDecision({ motivo, notas }) },
    );
  },

  /** Los cambios registrados de un evento. Sin clasificar es SIN CLASIFICAR. */
  async cambios(opciones?: {
    eventoId?: string | null;
    soloSinClasificar?: boolean;
    limite?: number;
  }): Promise<CambioDelEvento[]> {
    const q = new URLSearchParams({ limit: String(opciones?.limite ?? 50) });
    if (opciones?.eventoId) q.set('event_id', opciones.eventoId);
    if (opciones?.soloSinClasificar) q.set('solo_sin_clasificar', 'true');
    return apiRequest<CambioDelEvento[]>(
      `${API_V1}/admin/events/changes?${q.toString()}`,
    );
  },

  /** Clasifica un cambio. LO HACE UNA PERSONA, no una regla automática. */
  async clasificar(
    changeId: string,
    clasificacion: string,
    motivo?: string | null,
  ): Promise<CambioDelEvento> {
    return apiRequest<CambioDelEvento>(
      `${API_V1}/admin/events/changes/${changeId}/classify`,
      {
        method: 'POST',
        body: JSON.stringify({
          classification: clasificacion,
          ...(motivo ? { reason: motivo } : {}),
        }),
      },
    );
  },

  /** Las políticas publicadas, con sus números. */
  async politicas(tipo?: string | null): Promise<PoliticaPublicada[]> {
    const q = new URLSearchParams();
    if (tipo) q.set('policy_type', tipo);
    const cola = q.toString();
    return apiRequest<PoliticaPublicada[]>(
      `${API_V1}/admin/events/policies${cola ? `?${cola}` : ''}`,
    );
  },
};
