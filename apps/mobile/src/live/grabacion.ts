/**
 * La grabación de un directo, para quien lo emitió (prototipo, 09/10/2026).
 *
 * LO QUE SE PIDIÓ: poder descargar el vídeo del directo durante un tiempo.
 *
 * Z NO GRABA. Graba el proveedor de vídeo, y solo si la grabación está
 * encendida en su panel. Cuando termina de prepararla —unos minutos después de
 * cerrar la sala— avisa al servidor con un enlace temporal, y el servidor se lo
 * entrega a quien gestiona la emisión. Ese enlace CADUCA.
 *
 * Aquí solo se lee la respuesta. Sin importaciones, a propósito.
 */

export type EstadoDeGrabacion =
  /** El servidor no tiene esta función: no se enseña nada. */
  | 'sin_funcion'
  /** Todavía no ha llegado ninguna grabación (o la grabación está apagada). */
  | 'pendiente'
  /** Hay un enlace para bajarla. */
  | 'lista';

export type Grabacion = {
  estado: EstadoDeGrabacion;
  url: string | null;
  duracionS: number | null;
  tamanoBytes: number | null;
};

const SIN_FUNCION: Grabacion = { estado: 'sin_funcion', url: null, duracionS: null, tamanoBytes: null };

const numero = (valor: unknown): number | null =>
  typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 ? valor : null;

/**
 * De lo que manda el servidor a lo que usa la pantalla.
 *
 * SOLO SE ACEPTA UN ENLACE `https`. La aplicación lo va a abrir fuera; uno que
 * no lo sea no se le ofrece a nadie, diga lo que diga la respuesta.
 */
export function leerGrabacion(bruto: unknown): Grabacion {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return SIN_FUNCION;
  const dto = bruto as Record<string, unknown>;
  if (dto.available !== true) return SIN_FUNCION;
  const url = typeof dto.url === 'string' && dto.url.startsWith('https://') ? dto.url : null;
  if (dto.ready !== true || !url) {
    return { estado: 'pendiente', url: null, duracionS: null, tamanoBytes: null };
  }
  return {
    estado: 'lista',
    url,
    duracionS: numero(dto.duration_seconds),
    tamanoBytes: numero(dto.size_bytes),
  };
}

/** «12 min», «1 h 5 min». Para acompañar al botón, no para medir nada. */
export function duracionLegible(segundos: number | null): string | null {
  if (segundos === null || segundos <= 0) return null;
  const minutos = Math.max(1, Math.round(segundos / 60));
  if (minutos < 60) return `${minutos} min`;
  const resto = minutos % 60;
  return resto ? `${Math.floor(minutos / 60)} h ${resto} min` : `${Math.floor(minutos / 60)} h`;
}

/** «13 MB», «1,2 GB». */
export function tamanoLegible(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  const megas = bytes / (1024 * 1024);
  if (megas < 1024) return `${Math.max(1, Math.round(megas))} MB`;
  return `${(megas / 1024).toFixed(1).replace('.', ',')} GB`;
}
