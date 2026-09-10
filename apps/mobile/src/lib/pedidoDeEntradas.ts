/**
 * Las reglas del pedido y de la entrada, del lado de la interfaz.
 *
 * NO SUSTITUYEN AL SERVIDOR. Cada cosa que se decide aquí se vuelve a decidir en
 * `events/orders.py`, y las que se pueden, en la 0062. Aquí existen para no
 * ofrecer un botón que va a responder 409 y para que el estado que se lee sea el
 * mismo que el servidor tiene.
 *
 * UN PEDIDO NO ES UNA ENTRADA, Y UN INTENTO NO ES UN PAGO. La pantalla llama
 * pedido al pedido, dice «apartado» mientras está apartado y no escribe «pago
 * confirmado» hasta que el servidor lo dice. Tampoco escribe «factura» ni
 * «boleta»: no hay entidad vendedora decidida, y una constancia interna no es
 * un comprobante fiscal.
 *
 * Sin importaciones entre ficheros en tiempo de ejecución: el ejecutor de
 * pruebas de Node no resuelve el alias `@/`.
 */

/** Los estados que un pedido puede tener en el servidor. */
export const ESTADOS_DE_PEDIDO = [
  'PENDING_PAYMENT',
  'PAYMENT_PROCESSING',
  'PAID',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type EstadoDePedido = (typeof ESTADOS_DE_PEDIDO)[number];

/** Los estados de una entrada emitida. */
export const ESTADOS_DE_ENTRADA = ['VALID', 'USED', 'REVOKED'] as const;
export type EstadoDeEntrada = (typeof ESTADOS_DE_ENTRADA)[number];

/** Lo que la puerta puede contestar. Los mismos valores que guarda el servidor. */
export const RESULTADOS_DE_ADMISION = [
  'OK',
  'ALREADY_USED',
  'REVOKED',
  'NOT_FOUND',
  'WRONG_EVENT',
  'NOT_ADMITTING',
] as const;
export type ResultadoDeAdmision = (typeof RESULTADOS_DE_ADMISION)[number];

/** La clave de traducción del estado de un pedido. */
export function claveDelEstadoDePedido(estado: string): string {
  return (ESTADOS_DE_PEDIDO as readonly string[]).includes(estado)
    ? `pedido.estado.${estado}`
    : 'pedido.estado.desconocido';
}

/** La clave de traducción del estado de una entrada. */
export function claveDelEstadoDeEntrada(estado: string): string {
  return (ESTADOS_DE_ENTRADA as readonly string[]).includes(estado)
    ? `miEntrada.estado.${estado}`
    : 'miEntrada.estado.desconocido';
}

/** La clave de traducción de lo que dijo la puerta. */
export function claveDelResultado(resultado: string): string {
  return (RESULTADOS_DE_ADMISION as readonly string[]).includes(resultado)
    ? `checkin.resultado.${resultado}`
    : 'checkin.resultado.desconocido';
}

/**
 * Si este pedido todavía puede llegar a pagarse.
 *
 * NO INCLUYE `PAID`: un pedido pagado no se paga otra vez, y ofrecer el botón
 * sobre él es la forma de que alguien pague dos veces la misma cosa.
 */
export function siguePagable(estado: string, segundosRestantes: number): boolean {
  return (
    (estado === 'PENDING_PAYMENT' || estado === 'PAYMENT_PROCESSING') &&
    segundosRestantes > 0
  );
}

/**
 * Si el pedido ya no va a ninguna parte y hay que volver a empezar.
 *
 * Un pedido cuya reserva venció está muerto aunque su estado tarde en decirlo:
 * el servidor lo cerrará, y mientras tanto la pantalla no debe ofrecer pagar.
 */
export function estaCerrado(estado: string, segundosRestantes: number): boolean {
  if (estado === 'PAID') return false;
  if (estado === 'PENDING_PAYMENT' || estado === 'PAYMENT_PROCESSING') {
    return segundosRestantes <= 0;
  }
  return true;
}

/**
 * Si una entrada sirve para entrar HOY.
 *
 * `USED` no: ya se usó, y enseñar su QR en la puerta solo produce una cola.
 */
export function entradaVigente(estado: string): boolean {
  return estado === 'VALID';
}

/**
 * Cómo se reparten las entradas en la pantalla de «mis entradas».
 *
 * Tres montones y no una lista: quien abre esta pantalla en la puerta busca la
 * que puede usar, no el historial.
 */
export function repartirEntradas<T extends { status: string }>(
  entradas: T[],
): { vigentes: T[]; usadas: T[]; revocadas: T[] } {
  return {
    vigentes: entradas.filter((e) => e.status === 'VALID'),
    usadas: entradas.filter((e) => e.status === 'USED'),
    revocadas: entradas.filter((e) => e.status === 'REVOKED'),
  };
}

/** Cuántas entradas suma un pedido. */
export function cuantasEntradas(items: { quantity: number }[]): number {
  return items.reduce((suma, linea) => suma + linea.quantity, 0);
}

/**
 * El código, partido en grupos para poder leerlo en voz alta.
 *
 * Catorce caracteres seguidos no se dictan por teléfono ni se teclean sin
 * equivocarse. Los grupos son solo presentación: lo que se manda es el código.
 */
export function codigoLegible(codigo: string): string {
  const limpio = (codigo ?? '').trim().toUpperCase();
  if (limpio === '') return '';
  return (limpio.match(/.{1,4}/g) ?? [limpio]).join(' ');
}

/** Lo contrario: lo que alguien teclea, listo para mandar. */
export function codigoTecleado(texto: string): string {
  return (texto ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Si lo que se ha tecleado puede ser un código.
 *
 * NO VALIDA QUE EXISTA —eso solo lo sabe el servidor— sino que no se mande una
 * cadena vacía o media palabra: cada envío es un intento anotado en la puerta.
 */
/**
 * Lo minimo que hay que teclear para buscar por codigo en la puerta.
 *
 * EL SERVIDOR EXIGE LO MISMO Y RESPONDE 422 POR DEBAJO. Sin minimo, la lista
 * de asistentes se recorre letra a letra hasta reconstruir los codigos, y un
 * codigo admite por si solo. Aqui se refleja para no mandar una peticion que
 * se sabe que va a fallar y para poder decirlo antes.
 */
export const LARGO_MINIMO_DE_BUSQUEDA = 6;

/** El texto de busqueda que SI se puede mandar, o `null` si aun es corto. */
export function busquedaUtil(texto: string): string | null {
  const limpia = codigoTecleado(texto);
  return limpia.length >= LARGO_MINIMO_DE_BUSQUEDA ? limpia : null;
}

export function pareceUnCodigo(texto: string): boolean {
  const limpio = codigoTecleado(texto);
  return limpio.length >= 10 && limpio.length <= 24;
}

/**
 * Por qué no se puede pedir todavía, o `null`.
 *
 * Devuelve una CLAVE de traducción; la pantalla la traduce en el idioma puesto.
 */
export function motivoParaNoPedir(
  estado: string,
  segundosRestantes: number,
): string | null {
  if (estado === 'PAID') return 'pedido.yaPagado';
  if (segundosRestantes <= 0) return 'pedido.reservaVencida';
  return null;
}
