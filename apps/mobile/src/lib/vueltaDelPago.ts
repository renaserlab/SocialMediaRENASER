/**
 * Qué enseñar cuando alguien vuelve de la pasarela de pago.
 *
 * POR QUÉ ESTA DECISIÓN VIVE APARTE DE LA PANTALLA. Porque es la única de toda
 * la aplicación en la que equivocarse significa decirle a una persona que ha
 * pagado —o que no— sin que eso sea verdad, y una decisión así tiene que poder
 * ejecutarse en una prueba. La pantalla importa React Native; esto no.
 *
 * LA REGLA QUE ORDENA EL FICHERO: **la URL no decide nada.** Al volver, el
 * navegador trae `?order=<id>` y punto. Ese parámetro lo escribe cualquiera, y
 * la ausencia de él tampoco prueba una cancelación: se pierde con un
 * redireccionamiento mal hecho. Todo lo que se afirma en la pantalla sale de lo
 * que conteste el servidor sobre esa orden concreta.
 *
 * Y EL ACCESO NO LO CONCEDE ESTA PANTALLA. Lo concede el aviso de la pasarela,
 * contra el backend. Aquí solo se mira y se cuenta.
 */

/** Lo que la pantalla puede estar diciendo en un momento dado. */
export type EstadoDeLaVuelta =
  /** Todavía preguntando al servidor. */
  | 'verificando'
  /** Pagado y con el acceso ya concedido. */
  | 'confirmado'
  /** Pagado, pero el acceso aún no está: falta que llegue el aviso. */
  | 'concediendo'
  /** El cobro sigue en curso en la pasarela. */
  | 'pendiente'
  /** La pasarela lo rechazó, o la persona canceló. */
  | 'rechazado'
  /** Ya devuelto: no es un error, pero tampoco es una compra viva. */
  | 'devuelto'
  /** Fallo de red o del servidor: se puede reintentar. */
  | 'error_recuperable'
  /** No hay orden que mirar, o no es de esta cuenta. */
  | 'no_encontrada';

export type RespuestaDeOrden = {
  status: string;
  tieneAcceso: boolean;
};

/**
 * Traduce lo que dice el servidor al estado que ve la persona.
 *
 * `confirmado` EXIGE LAS DOS COSAS: que la orden esté pagada y que el acceso
 * esté concedido. Con solo `paid` la pantalla enviaría al curso a alguien que
 * todavía no puede entrar, y ese viaje termina en un «no tienes acceso» justo
 * después de pagar, que es el peor momento posible para un mensaje así.
 */
export function estadoDeLaVuelta(
  respuesta: RespuestaDeOrden | null,
  fallo: 'no_encontrada' | 'red' | null,
): EstadoDeLaVuelta {
  if (fallo === 'no_encontrada') return 'no_encontrada';
  if (fallo === 'red') return 'error_recuperable';
  if (respuesta === null) return 'verificando';
  switch (respuesta.status) {
    case 'paid':
      return respuesta.tieneAcceso ? 'confirmado' : 'concediendo';
    case 'pending':
      return 'pendiente';
    case 'failed':
    case 'cancelled':
      return 'rechazado';
    case 'refunded':
      return 'devuelto';
    default:
      // Un estado que este cliente no conoce. NO se inventa una lectura
      // optimista: se trata como algo que hay que volver a mirar.
      return 'pendiente';
  }
}

/** Si vale la pena volver a preguntar, dado el estado actual. */
export function convieneReintentar(estado: EstadoDeLaVuelta): boolean {
  // `concediendo` y `pendiente` son los dos estados que se resuelven solos en
  // segundos, cuando llega el aviso de la pasarela. Los demás no cambian por
  // mirarlos otra vez, y repreguntar sobre un rechazo solo alarga la espera de
  // alguien que ya tiene una respuesta.
  return estado === 'concediendo' || estado === 'pendiente';
}

/** Cuántas veces como mucho, y cada cuánto. */
export const REINTENTOS_MAXIMOS = 5;
export const ESPERA_ENTRE_REINTENTOS_MS = 2000;

/**
 * El identificador de la orden que trae la URL, si es utilizable.
 *
 * SE VALIDA LA FORMA antes de mandarlo al servidor: lo que llega en la barra de
 * direcciones es texto libre. Un identificador con otra forma no es una orden
 * de nadie, así que no hace falta preguntar para saber que no hay nada que
 * enseñar.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ordenDeLaUrl(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  return UUID.test(limpio) ? limpio : null;
}
