/**
 * En qué punto está una solicitud de devolución, para poder pintarlo.
 *
 * LOS ESTADOS LOS DEFINE EL SERVIDOR (`refunds/estados.py`) y son ocho. La
 * línea de tiempo de la captura tiene TRES pasos. Este módulo hace esa
 * traducción y nada más: no decide nada, no adivina el siguiente paso y no
 * inventa fechas.
 *
 * POR QUÉ NO SE PINTAN LOS OCHO. Porque `refund_processing` y `approved` no son
 * dos noticias distintas para quien espera —las dos significan «va en camino»—
 * y separarlas obligaría a explicar una fontanería que no es asunto suyo. Lo
 * que sí tiene que quedar claro es si terminó, y cómo.
 */

/** Los estados del expediente, tal cual los nombra el servidor. */
export type EstadoDeSolicitud =
  | 'requested'
  | 'under_review'
  | 'approved'
  | 'refund_processing'
  | 'refunded'
  | 'rejected'
  | 'failed'
  | 'cancelled';

/** Los tres pasos de la línea de tiempo. */
export type Paso = 'recibida' | 'revision' | 'resolucion';

/**
 * En qué paso está. `resolucion` incluye los estados finales, también los que
 * terminan mal: una solicitud rechazada TERMINÓ, y dejarla en «en revisión»
 * para siempre sería mentir por omisión.
 */
export function pasoDe(estado: EstadoDeSolicitud): Paso {
  switch (estado) {
    case 'requested':
      return 'recibida';
    case 'under_review':
      return 'revision';
    default:
      // approved, refund_processing, refunded, rejected, failed y cancelled.
      return 'resolucion';
  }
}

/** Cuántos pasos van cumplidos, del 1 al 3. Para pintar la línea. */
export function pasosCumplidos(estado: EstadoDeSolicitud): number {
  const paso = pasoDe(estado);
  return paso === 'recibida' ? 1 : paso === 'revision' ? 2 : 3;
}

/** Si ya no va a cambiar sin que nadie haga nada más. */
export function estaCerrada(estado: EstadoDeSolicitud): boolean {
  return (
    estado === 'refunded' ||
    estado === 'rejected' ||
    estado === 'failed' ||
    estado === 'cancelled'
  );
}

/**
 * Si el dinero se devolvió de verdad.
 *
 * Es lo único que autoriza la pantalla de «Reembolso completado» y el aviso de
 * que el acceso se retiró: `approved` NO basta —aprobar no es haber pagado— y
 * enseñarlo como completado dejaría a alguien esperando un ingreso que todavía
 * no salió.
 */
export function estaReembolsada(estado: EstadoDeSolicitud): boolean {
  return estado === 'refunded';
}

/**
 * Si se puede cancelar todavía.
 *
 * Solo mientras nadie la ha resuelto. El servidor vuelve a comprobarlo; esto
 * es para no ofrecer un botón que va a dar error.
 */
export function sePuedeCancelar(estado: EstadoDeSolicitud): boolean {
  return estado === 'requested' || estado === 'under_review';
}

/** La clave de traducción del estado. Los ocho tienen la suya. */
export function claveDelEstado(estado: EstadoDeSolicitud): string {
  return `solicitud.estado.${estado}`;
}
