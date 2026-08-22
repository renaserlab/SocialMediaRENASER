/**
 * Contrato de las transmisiones en vivo.
 *
 * Este archivo describe QUE necesita la interfaz de "Live" para funcionar, sin
 * implementarlo: hoy no existe infraestructura de directo en el proyecto (ver
 * `FEATURE_LIVE` en `config/features.ts`, donde esta el detalle del bloqueo).
 *
 * Se escribe ahora, y no cuando llegue el proveedor, para que la pantalla se
 * construya contra una forma de datos estable. El dia que haya directo, lo
 * unico que cambia es la implementacion de `listarTransmisiones`; ni la
 * pantalla ni sus estados se tocan.
 */

export type EstadoDeTransmision = 'programada' | 'en_directo' | 'finalizada';

export type Transmision = {
  id: string;
  /** Quien emite. */
  autorId: string;
  autor: string;
  avatarUrl?: string;
  titulo: string;
  estado: EstadoDeTransmision;
  /** Espectadores ahora mismo; solo tiene sentido en `en_directo`. */
  espectadores?: number;
  /** Cuando empieza (programada) o cuando empezo (en directo), en ISO. */
  comienzaEnIso?: string;
  /**
   * Playlist de reproduccion que entregue el proveedor. Nunca se rellena con
   * un video grabado: si no hay directo, no hay URL.
   */
  reproduccionUrl?: string;
  posterUrl?: string;
};

/**
 * Transmisiones disponibles.
 *
 * Devuelve la lista vacia mientras no exista proveedor. NO es un dato de
 * relleno ni una simulacion: es la verdad —no hay ninguna emision— y la
 * pantalla la cuenta tal cual.
 */
export async function listarTransmisiones(): Promise<Transmision[]> {
  return [];
}
