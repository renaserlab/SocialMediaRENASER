/**
 * La cola de los avisos transitorios: qué se enseña, en qué orden y cuánto.
 *
 * UNA SOLA AUTORIDAD. El toast de «guardado», el error de red, el «deshacer» y
 * el aviso de una notificación que llega con la aplicación abierta salen todos
 * por el mismo sitio (`ToastHost`), y aquí se decide cómo conviven. Nunca hay
 * dos a la vez en pantalla: hay uno visible y, como mucho, unos pocos
 * esperando.
 *
 * LAS TRES REGLAS
 *
 *   1. LO MISMO NO SE REPITE. Dos avisos con la misma `clave` son el mismo
 *      aviso: el nuevo ocupa el sitio del viejo en vez de ponerse detrás.
 *      Tres mensajes seguidos de la misma conversación son un aviso, no tres.
 *
 *   2. UNA CONFIRMACIÓN SUSTITUYE A OTRA. «Guardado» y, medio segundo después,
 *      «Quitado de guardados»: lo último que hizo la persona es lo que cuenta,
 *      y hacerle esperar tres segundos a que termine el primero sería contarle
 *      algo que ya no es verdad.
 *
 *   3. LO QUE IMPORTA ESPERA SU TURNO. Un error o una notificación no se
 *      pierden porque llegara otra cosa: se encolan. Pero con tope: si se
 *      acumulan, se cae el que más lleva esperando, no el que se está viendo.
 *
 * SIN REACT: es una decisión, no un dibujo, y se prueba con el runner de Node.
 */

export type TipoDeAviso =
  /** Salió bien: publicado, guardado, enviado. */
  | 'exito'
  /** Algo que conviene saber y no pide nada. */
  | 'info'
  /** Salió, pero con un pero. */
  | 'advertencia'
  /** No salió. Para errores que NO se corrigen en un formulario. */
  | 'error'
  /** Salió y se puede deshacer: trae una acción y dura más. */
  | 'reversible'
  /** Llegó una notificación con la aplicación abierta. */
  | 'notificacion';

export type AvisoEnCola = {
  /** Único por aparición: remonta el componente y reinicia su reloj. */
  id: number;
  /** Lo que hace que dos avisos sean «el mismo». */
  clave: string;
  tipo: TipoDeAviso;
};

/** Los que caben esperando detrás del visible. */
export const MAXIMO_EN_ESPERA = 3;

/** Milisegundos en pantalla. Lo que pide leer más o decidir algo dura más. */
export const DURACION_DEL_AVISO: Record<TipoDeAviso, number> = {
  exito: 2600,
  info: 3000,
  advertencia: 4000,
  error: 5000,
  reversible: 5000,
  notificacion: 4500,
};

const CONFIRMACIONES: ReadonlySet<TipoDeAviso> = new Set(['exito', 'info', 'reversible']);

/** Si este tipo cede el sitio a la siguiente confirmación (regla 2). */
export function esConfirmacion(tipo: TipoDeAviso): boolean {
  return CONFIRMACIONES.has(tipo);
}

/**
 * Cuánto dura un aviso. Uno con acción nunca dura menos que uno reversible:
 * hay que dar tiempo a leerlo Y a llegar con el dedo.
 */
export function duracionDelAviso(tipo: TipoDeAviso, conAccion: boolean, pedida?: number): number {
  if (pedida && pedida > 0) return pedida;
  const base = DURACION_DEL_AVISO[tipo];
  return conAccion ? Math.max(base, DURACION_DEL_AVISO.reversible) : base;
}

/** La clave de un aviso que no trae una: su tipo y su texto. */
export function claveDelAviso(tipo: TipoDeAviso, mensaje: string, clave?: string): string {
  return clave ?? `${tipo}:${mensaje}`;
}

/**
 * Mete un aviso en la cola. Devuelve una cola NUEVA; el primero es el visible.
 */
export function encolarAviso<T extends AvisoEnCola>(cola: readonly T[], nuevo: T): T[] {
  // 1. Lo mismo no se repite: ocupa el sitio del que ya estaba.
  const repetido = cola.findIndex((aviso) => aviso.clave === nuevo.clave);
  if (repetido !== -1) {
    const copia = cola.slice();
    copia[repetido] = nuevo;
    return copia;
  }

  // 2. Una confirmación sustituye a la confirmación que se está viendo.
  const visible = cola[0];
  if (!visible) return [nuevo];
  if (esConfirmacion(nuevo.tipo) && esConfirmacion(visible.tipo)) {
    return [nuevo, ...cola.slice(1)];
  }

  // 3. Lo demás espera. Si no cabe, se cae el que más lleva esperando.
  const espera = [...cola.slice(1), nuevo];
  const sobran = espera.length - MAXIMO_EN_ESPERA;
  return [visible, ...(sobran > 0 ? espera.slice(sobran) : espera)];
}

/** El visible se ha ido: pasa el siguiente. */
export function avanzarCola<T extends AvisoEnCola>(cola: readonly T[], id: number): T[] {
  // Por id y no «quitar el primero»: si el visible ya fue sustituido mientras
  // se despedía, su cierre no puede llevarse por delante al que lo sustituyó.
  if (cola[0]?.id !== id) return cola.slice();
  return cola.slice(1);
}

/** Quita los avisos de una clave: p. ej. al abrir la conversación de la que hablaban. */
export function retirarAvisos<T extends AvisoEnCola>(
  cola: readonly T[],
  esDeLaClave: (clave: string) => boolean,
): T[] {
  return cola.filter((aviso) => !esDeLaClave(aviso.clave));
}
