import { apiRequest, API_V1 } from '@/services/api';
import type {
  Condiciones,
  EstadoDeLasPoliticas,
  Politica,
  ResultadoDeCancelacion,
} from '@/lib/politicasDeEvento';

/**
 * Las condiciones de venta de un evento, escritas por quien lo organiza.
 *
 * SEPARADO DEL DE ADMINISTRACIÓN A PROPÓSITO, igual que
 * `EventAftersaleAdminRepository` se separó del del comprador. Aquí no hay ni
 * un método bajo `/admin/`: quien organiza escribe SUS condiciones, y la
 * supervisión de la empresa —`/admin/events/policies/overview`, `.../missing`—
 * es otra pantalla y otro rol. Que no quepa por descuido es la mitad del
 * trabajo de este fichero.
 *
 * NO EXISTE «EDITAR UNA POLÍTICA». Y no puede existir: el servidor solo publica
 * `PUT .../policies/draft` sobre el BORRADOR, y un disparador de la 0069 hace
 * imposible cualquier `UPDATE` sobre una publicada que no sea marcarla
 * superada. Para cambiar una regla se guarda un borrador nuevo y se publica;
 * las compras anteriores conservan la versión que aceptaron. Un método
 * `actualizar(politicaId, ...)` acabaría en 409 `event_policy_not_editable` y,
 * peor, haría creer que lo aceptado se reescribe.
 *
 * CANCELAR EL EVENTO VIVE AQUÍ porque es la otra decisión que esta pantalla
 * ofrece, y la más grave. Es la ruta del organizador (`POST
 * /events/{id}/cancel`), no una de administración. LO QUE CONTESTA NO ES UNA
 * DEVOLUCIÓN: abre un expediente por compra pagada, retiene el saldo y avisa;
 * `regla` dice qué se aplicó, y hoy es siempre «pendiente de decisión
 * empresarial». Este repositorio no interpreta nada de eso: lo devuelve.
 */

/** Lo que se manda a `PUT /events/{id}/policies/draft`. */
export type Borrador = {
  tipo: string;
  version: string;
  params: Record<string, unknown>;
  /** El texto que lee quien compra. `null` = no se escribió ninguno. */
  texto?: string | null;
};

export const EventPolicyRepository = {
  /** Todo lo del evento en una lectura: vigentes, borradores e historial. */
  async estado(eventoId: string): Promise<EstadoDeLasPoliticas> {
    return apiRequest<EstadoDeLasPoliticas>(`${API_V1}/events/${eventoId}/policies`);
  },

  /**
   * Crea el borrador o reescribe el que haya. UNO por tipo y evento.
   *
   * `texto` viaja solo si se escribió: mandar `""` y mandar `null` significan
   * lo mismo para el servidor, pero `""` se lee como «lo dejé en blanco a
   * propósito» al releer el objeto, y no es eso.
   */
  async guardarBorrador(eventoId: string, borrador: Borrador): Promise<Politica> {
    const cuerpo: Record<string, unknown> = {
      policy_type: borrador.tipo,
      version: borrador.version,
      params: borrador.params,
    };
    if (borrador.texto) cuerpo.body = borrador.texto;
    return apiRequest<Politica>(`${API_V1}/events/${eventoId}/policies/draft`, {
      method: 'PUT',
      body: JSON.stringify(cuerpo),
    });
  },

  /** Tira un borrador. SOLO UN BORRADOR: lo publicado no se borra nunca. */
  async descartarBorrador(politicaId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/events/policies/${politicaId}/draft`, {
      method: 'DELETE',
    });
  },

  /**
   * Publica el borrador y supersede la vigente, en la misma transacción.
   *
   * NO ES RETROACTIVO: cada compra guarda la versión y la huella que aceptó, y
   * esto no las toca.
   */
  async publicar(politicaId: string): Promise<Politica> {
    return apiRequest<Politica>(`${API_V1}/events/policies/${politicaId}/publish`, {
      method: 'POST',
    });
  },

  /**
   * Lo que verá quien compra, palabra por palabra.
   *
   * Es la ruta ANÓNIMA del comprador, y se pide tal cual para la
   * previsualización: reconstruir el texto por nuestra cuenta produciría una
   * pantalla que enseña una cosa y una venta que promete otra.
   */
  async condiciones(eventoId: string): Promise<Condiciones> {
    return apiRequest<Condiciones>(`${API_V1}/events/${eventoId}/policies/terms`);
  },

  /**
   * Cancela el evento entero. NO DEVUELVE DINERO Y NO RECHAZA NADA.
   *
   * El evento deja de venderse, se abre un expediente por cada compra pagada y
   * el importe queda RETENIDO y en revisión. Qué pasa después con ese dinero es
   * una decisión que la empresa no ha tomado.
   */
  async cancelarEvento(eventoId: string, motivo: string): Promise<ResultadoDeCancelacion> {
    return apiRequest<ResultadoDeCancelacion>(`${API_V1}/events/${eventoId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ motivo }),
    });
  },
};
