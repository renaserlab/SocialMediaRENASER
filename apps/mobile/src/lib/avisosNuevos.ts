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
