import { apiRequest, API_V1 } from '@/services/api';
import {
  cadenaDeFiltros,
  limiteValido,
  type EventoSinPolitica,
  type FiltrosDePoliticas,
  type PoliticaSupervisada,
} from '@/lib/supervisionDePoliticas';

/**
 * Las políticas de evento, desde administración. SOLO LECTURA.
 *
 * Y no por prudencia: el servidor no publica ninguna ruta de escritura bajo
 * `/admin/events/policies`, y es deliberado. Lo que se acepta al comprar no se
 * reescribe nunca —cambiar una regla es publicar otra versión, y eso lo hace
 * quien organiza desde su propio evento—, así que aquí no hay ni puede haber un
 * `editar`, un `borrar`, un `aprobar` ni un `suspender`. Tampoco uno apagado:
 * un botón deshabilitado promete que algún día se encenderá.
 *
 * SEPARADO DEL DEL ORGANIZADOR a propósito, como `EventAftersaleAdminRepository`
 * lo está del comprador: en este fichero no existe un método que escriba, así
 * que no puede colarse uno en la pantalla de supervisión por añadir un campo.
 */
export const EventPolicyAdminRepository = {
  /**
   * Lo que ha publicado cada organizador, filtrado por la base antes del tope.
   *
   * Sin cursor: el servidor acepta `limit` (hasta 200) y no manda ninguno. La
   * pantalla sube el tope y DICE cuál es, en vez de fingir una paginación
   * infinita que haría creer que se está viendo todo.
   */
  async supervisar(filtros?: FiltrosDePoliticas): Promise<PoliticaSupervisada[]> {
    return apiRequest<PoliticaSupervisada[]>(
      `${API_V1}/admin/events/policies/overview?${cadenaDeFiltros(filtros ?? {})}`,
    );
  },

  /**
   * Los eventos publicados SIN política propia de elegibilidad.
   *
   * La consulta que de verdad importa: eventos vendiendo sin condiciones
   * escritas. Una lista vacía es una buena noticia, no un fallo.
   */
  async sinPolitica(limite?: number | null): Promise<EventoSinPolitica[]> {
    return apiRequest<EventoSinPolitica[]>(
      `${API_V1}/admin/events/policies/missing?limit=${limiteValido(limite)}`,
    );
  },

  /** El contenido de una política concreta, para revisarla. */
  async detalle(policyId: string): Promise<PoliticaSupervisada> {
    return apiRequest<PoliticaSupervisada>(
      `${API_V1}/admin/events/policies/${policyId}`,
    );
  },
};
