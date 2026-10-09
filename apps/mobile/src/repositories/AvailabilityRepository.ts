import {
  leerDisponibilidad,
  leerHuecos,
  type Disponibilidad,
  type Franja,
  type Hueco,
} from '@/lib/disponibilidad';
import { apiRequest, API_V1 } from '@/services/api';

/**
 * La disponibilidad para las sesiones 1:1 (prototipo; ver `lib/disponibilidad`).
 *
 * Un servidor sin la migración 0100 contesta `available: false`, y uno anterior
 * a esta función, 404. En los dos casos la aplicación no enseña nada de esto y
 * pedir una sesión funciona como siempre.
 */
export const AvailabilityRepository = {
  /** Mi semana tipo. */
  async mia(): Promise<Disponibilidad> {
    return aDisponibilidad(await apiRequest<unknown>(`${API_V1}/availability/me`));
  },

  /** Guarda la semana ENTERA: sustituye a la que hubiera. */
  async guardar(franjas: readonly Franja[]): Promise<Disponibilidad> {
    return aDisponibilidad(
      await apiRequest<unknown>(`${API_V1}/availability/me`, {
        method: 'PUT',
        body: JSON.stringify({
          // Las horas se dicen en la zona del teléfono: «a las 9» es a las 9
          // de quien las pone.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima',
          slots: franjas.map((f) => ({ weekday: f.dia, start: f.desde, end: f.hasta })),
        }),
      }),
    );
  },

  /**
   * Cuándo se le puede pedir una sesión a una persona.
   *
   * NUNCA FALLA: si no hay huecos, o el servidor no tiene la función, o no hay
   * red, devuelve una lista vacía y quien pide propone el momento a mano, que
   * es lo que había antes.
   */
  async huecosDe(usuarioId: string): Promise<Hueco[]> {
    try {
      return leerHuecos(
        await apiRequest<unknown>(`${API_V1}/availability/${usuarioId}/openings`),
      );
    } catch {
      return [];
    }
  },
};

function aDisponibilidad(bruto: unknown): Disponibilidad {
  const leida = leerDisponibilidad(bruto);
  if (!leida) throw new Error('El servidor no devolvió la disponibilidad.');
  return leida;
}
