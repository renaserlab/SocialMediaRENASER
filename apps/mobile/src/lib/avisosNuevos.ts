/**
 * Qué avisos de la bandeja son NUEVOS y merecen salir en pantalla.
 *
 * EL PROBLEMA. Con la aplicación abierta no había nada que dijera «te acaban
 * de reaccionar» o «te han pedido una sesión»: la campana solo se actualizaba
 * al volver a Explorar. Ahora la aplicación pregunta de vez en cuando cuántos
 * avisos hay sin leer y, si han subido, pide los últimos. Esto decide cuáles
 * de esos se anuncian.
 *
 * LAS REGLAS
 *
 *   - AL ARRANCAR NO SE ANUNCIA NADA. Lo que ya estaba sin leer cuando se abrió
 *     la aplicación no es una novedad: sacar tres avisos de ayer nada más
 *     entrar sería ruido. La primera lectura solo fija la marca.
 *   - SOLO LO POSTERIOR A LA MARCA, y solo lo no leído.
 *   - CON TOPE. Si llegaron veinte mientras tanto, salen los más recientes y la
 *     campana cuenta el resto.
 *   - LA MARCA AVANZA SIEMPRE, se anuncie o no: lo que ya se vio pasar no
 *     vuelve a salir. Es también lo que impide el doble aviso cuando el mismo
 *     hecho ya se avisó por otro lado —un push, o el sistema mientras la
 *     aplicación estaba en segundo plano—: basta llamar con `marca = null`,
 *     que fija la marca sin anunciar nada.
 *   - LA MARCA SALE DE LAS FECHAS DEL SERVIDOR, nunca del reloj del teléfono:
 *     uno adelantado se comería avisos y uno atrasado los repetiría.
 *
 * SIN REACT: se prueba con el runner de Node.
 */

export type AvisoFechado = {
  id: string;
  /** Cuándo se creó, en ISO. Sin fecha válida no se puede saber si es nuevo. */
  createdAtIso?: string | null;
  read: boolean;
};

/** Cuántos se anuncian como mucho de una sola vez. */
export const MAXIMO_A_ANUNCIAR = 2;

function instante(aviso: AvisoFechado): number {
  const ms = aviso.createdAtIso ? Date.parse(aviso.createdAtIso) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * @param marca el instante (ms) hasta el que ya se ha visto. `null` la primera vez.
 * @returns lo que hay que anunciar —del más antiguo al más nuevo, que es el
 *   orden en que tienen que salir— y la marca nueva.
 */
export function queAnunciar<T extends AvisoFechado>(
  avisos: readonly T[],
  marca: number | null,
  maximo: number = MAXIMO_A_ANUNCIAR,
): { anunciar: T[]; marca: number } {
  const masReciente = avisos.reduce((tope, aviso) => Math.max(tope, instante(aviso)), marca ?? 0);
  if (marca === null) return { anunciar: [], marca: masReciente };

  const nuevos = avisos
    .filter((aviso) => !aviso.read && instante(aviso) > marca)
    .sort((a, b) => instante(a) - instante(b));
  return { anunciar: nuevos.slice(-maximo), marca: masReciente };
}

/**
 * Desde cuándo preguntar al servidor por avisos nuevos: justo después de lo
 * último que ya se vio. `null` la primera vez, cuando todavía no hay marca.
 *
 * UN MILISEGUNDO DESPUÉS, y no la marca tal cual. El servidor guarda
 * microsegundos y aquí la marca tiene milisegundos: preguntar «posteriores a
 * 21:41:00.123» devolvería como nuevo el aviso de las 21:41:00.123456, que es
 * justo el que fijó la marca, y se leería la bandeja entera en cada vuelta.
 */
export function desdeCuandoPreguntar(marca: number | null): string | null {
  if (marca === null || !Number.isFinite(marca) || marca <= 0) return null;
  return new Date(marca + 1).toISOString();
}

/**
 * Si hay que pedir la bandeja para anunciar algo.
 *
 * LO QUE HABÍA. Se pedía «si la cuenta de ahora es mayor que la de antes», y
 * la de antes se leía de un contador que también escriben otras pantallas:
 * bastaba con que una lo refrescara primero para que la cuenta ya no «subiera»
 * y el aviso —«te han pedido una sesión»— no se anunciara nunca. Fue lo
 * reportado el 04/10/2026.
 *
 * AHORA LO DICE EL SERVIDOR: cuántos sin leer son posteriores a lo último que
 * se vio (`nuevos`). No depende de ningún número guardado en el teléfono.
 *
 * @param nuevos `null` si el servidor no lo dice (una API anterior). Entonces
 *   se pide la bandeja siempre que haya algo sin leer: una lectura de más es
 *   mejor que un aviso de menos.
 */
export function hayQueLeerLaBandeja(datos: {
  /** Todavía no hay marca: hay que fijarla. */
  primera: boolean;
  /** Solo ponerse al día, sin anunciar. */
  callado: boolean;
  cuenta: number;
  nuevos: number | null;
}): boolean {
  if (datos.primera || datos.callado) return true;
  if (datos.nuevos === null) return datos.cuenta > 0;
  return datos.nuevos > 0;
}

/**
 * De quién son los avisos de SESIÓN que acaban de llegar.
 *
 * UN HECHO, UN AVISO. Pedir una sesión, aceptarla o cancelarla deja un aviso
 * en la bandeja Y un mensaje en el chat de las dos personas (es su registro).
 * Sin esto, con la aplicación abierta saldrían dos avisos flotantes por lo
 * mismo: el de la sesión y el de «mensaje nuevo». Se anuncia el de la sesión,
 * que dice qué ha pasado, y el del mensaje de esa misma persona se calla.
 *
 * @param marcaPrevia hasta cuándo se había visto ANTES de esta lectura.
 */
export function actoresDeSesionNuevos(
  avisos: readonly (AvisoFechado & { entityType?: string | null; actorId?: string })[],
  marcaPrevia: number | null,
): string[] {
  if (marcaPrevia === null) return [];
  const actores = new Set<string>();
  for (const aviso of avisos) {
    if (aviso.entityType !== 'booking' || !aviso.actorId) continue;
    if (instante(aviso) > marcaPrevia) actores.add(aviso.actorId);
  }
  return Array.from(actores);
}

/** Cuánto tiempo calla un aviso de sesión al mensaje de la misma persona. */
export const SILENCIO_TRAS_UN_AVISO_DE_SESION_MS = 15_000;

/** Lo que hace falta de un aviso de la bandeja para saber a dónde lleva. */
export type AvisoConDestino = {
  type?: string;
  entityType?: string | null;
  entityId?: string | null;
  postId?: string | null;
  actorId?: string;
};

/**
 * A dónde lleva tocar un aviso de la bandeja. `null` si no lleva a ningún
 * sitio (un aviso sin actor ni entidad).
 *
 * Es la misma decisión para la fila de la bandeja y para el aviso flotante:
 * vivía escrita dentro de la pantalla, como una cadena de condiciones, y el
 * aviso flotante la habría copiado.
 */
export function destinoDelAviso(
  aviso: AvisoConDestino,
  rutaDeDecision: (tipo: string, entidadId: string | null | undefined) => string | null,
): string | null {
  // Un aviso al creador lleva a donde se ve o se corrige lo decidido.
  const deDecision = rutaDeDecision(aviso.type ?? '', aviso.entityId);
  if (deDecision !== null) return deDecision;
  if (aviso.entityType === 'booking') return '/agenda';
  // La etiqueta, el «me gusta» y el comentario están en la publicación.
  if (aviso.entityType === 'post' && aviso.entityId) return `/post/${aviso.entityId}`;
  // Un corazón a un comentario: la publicación viene aparte.
  if (aviso.entityType === 'comment' && aviso.postId) return `/post/${aviso.postId}`;
  if (aviso.actorId) return `/profile/${aviso.actorId}`;
  return null;
}
