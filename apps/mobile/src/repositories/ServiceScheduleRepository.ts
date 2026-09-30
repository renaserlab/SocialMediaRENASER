import { apiRequest, API_V1 } from '@/services/api';
import type { AgendaPrivada, Calendario, PaginaDeHorarios } from '@/lib/serviciosAgenda';

/**
 * Z Servicios, Incremento 4: la agenda del prestador y los horarios públicos.
 *
 * EL SERVIDOR CALCULA LOS HORARIOS: aquí se piden y se pintan. El teléfono no
 * decide si un horario está libre ni convierte zonas horarias.
 *
 * Cada escritura devuelve la agenda ENTERA recién leída, y las altas llevan
 * `Idempotency-Key`: un doble toque o un reintento no duplican nada.
 *
 * NINGUNA LLAMADA DE AQUÍ RESERVA NI RETIENE UN HORARIO.
 */
const BASE = `${API_V1}/services`;

function agenda(servicio: string): string {
  return `${BASE}/provider/services/${encodeURIComponent(servicio)}/schedule`;
}

function publica(servicio: string): string {
  return `${BASE}/catalog/${encodeURIComponent(servicio)}/availability`;
}

function rango(desde: string | null, hasta: string | null): string {
  const partes: string[] = [];
  if (desde) partes.push(`from=${encodeURIComponent(desde)}`);
  if (hasta) partes.push(`to=${encodeURIComponent(hasta)}`);
  return partes.length ? `?${partes.join('&')}` : '';
}

function pagina(cursor: string | null): string {
  return cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
}

function json(body: unknown, method: string, clave?: string): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    ...(clave ? { headers: { 'Idempotency-Key': clave } } : {}),
  };
}

export const ServiceScheduleRepository = {
  // ------------------------------------------------------------------ //
  // El prestador
  // ------------------------------------------------------------------ //
  async agenda(servicio: string): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(agenda(servicio));
  },

  async configurar(servicio: string, cuerpo: Record<string, unknown>): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(agenda(servicio), json(cuerpo, 'PUT'));
  },

  async crearRegla(servicio: string, cuerpo: Record<string, unknown>, clave: string): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(`${agenda(servicio)}/rules`, json(cuerpo, 'POST', clave));
  },

  async editarRegla(servicio: string, id: string, cambios: Record<string, unknown>): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(`${agenda(servicio)}/rules/${encodeURIComponent(id)}`, json(cambios, 'PATCH'));
  },

  async borrarRegla(servicio: string, id: string): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(`${agenda(servicio)}/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async crearExcepcion(servicio: string, cuerpo: Record<string, unknown>, clave: string): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(`${agenda(servicio)}/exceptions`, json(cuerpo, 'POST', clave));
  },

  async editarExcepcion(servicio: string, id: string, cambios: Record<string, unknown>): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(`${agenda(servicio)}/exceptions/${encodeURIComponent(id)}`, json(cambios, 'PATCH'));
  },

  async borrarExcepcion(servicio: string, id: string): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(`${agenda(servicio)}/exceptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async crearBloqueo(servicio: string, cuerpo: Record<string, unknown>, clave: string): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(`${agenda(servicio)}/blocks`, json(cuerpo, 'POST', clave));
  },

  async borrarBloqueo(servicio: string, id: string): Promise<AgendaPrivada> {
    return apiRequest<AgendaPrivada>(`${agenda(servicio)}/blocks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** Las fechas que vería una persona, con por qué aún no las ve. */
  async vistaPrevia(servicio: string, desde: string | null, hasta: string | null): Promise<Calendario> {
    return apiRequest<Calendario>(`${agenda(servicio)}/preview${rango(desde, hasta)}`);
  },

  async vistaPreviaDelDia(servicio: string, fecha: string, cursor: string | null): Promise<PaginaDeHorarios> {
    return apiRequest<PaginaDeHorarios>(`${agenda(servicio)}/preview/${encodeURIComponent(fecha)}${pagina(cursor)}`);
  },

  // ------------------------------------------------------------------ //
  // Lo público
  // ------------------------------------------------------------------ //
  async disponibilidad(servicio: string, desde: string | null, hasta: string | null): Promise<Calendario> {
    return apiRequest<Calendario>(`${publica(servicio)}${rango(desde, hasta)}`);
  },

  async horarios(servicio: string, fecha: string, cursor: string | null): Promise<PaginaDeHorarios> {
    return apiRequest<PaginaDeHorarios>(`${publica(servicio)}/${encodeURIComponent(fecha)}${pagina(cursor)}`);
  },
};
