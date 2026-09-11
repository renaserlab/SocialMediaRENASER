/**
 * Las reglas de la posventa de eventos, del lado de la interfaz.
 *
 * NO SUSTITUYEN AL SERVIDOR. Quién puede dar cada paso lo decide
 * `posventa_estados.py`, y lo que se puede pedir sobre una compra lo decide
 * `elegibilidad.py` contra la política PUBLICADA. Aquí no hay ni un plazo, ni
 * un porcentaje, ni una aprobación: solo se traduce a texto lo que el servidor
 * ya ha dicho, y se decide qué botón tiene sentido pintar.
 *
 * `null` NO ES CERO, Y NO HAY VALORES SUPUESTOS. Un porcentaje ausente leído
 * como cero regalaría el importe entero; enseñado como «0 %» le diría a alguien
 * que no le corresponde nada cuando lo cierto es que nadie lo ha decidido
 * todavía. Por eso `porcentajeDePolitica` y `importeDeLaDevolucion` devuelven
 * `null`, y la pantalla escribe que está pendiente en vez de una cifra.
 *
 * APROBAR NO ES HABER PAGADO. `approved` y `resolved` son dos hechos distintos
 * y se dicen distinto: el dinero solo ha vuelto cuando lo confirma un aviso
 * verificado del proveedor, que es lo único que alcanza `resolved` desde
 * `refund_processing`. `elDineroYaVolvio` es la única función que puede
 * contestar que sí a esa pregunta, y no lo hace por `approved`.
 *
 * NO SE INVENTAN ACCIONES. `puedeResponder` y `puedeRetirar` miran `acciones[]`
 * —lo que el SERVIDOR dice que este actor puede hacer ahora—, no el estado por
 * su cuenta: una tabla escrita aquí se desviaría de la de allí en el primer
 * cambio, y la pantalla ofrecería botones que responden 403.
 *
 * Sin importaciones entre ficheros en tiempo de ejecución: el ejecutor de
 * pruebas de Node no resuelve el alias `@/`.
 */

/** Una clave del diccionario. Se escribe `string` porque `@/i18n` no se puede
 * importar aquí; la pantalla la convierte al traducir. */
export type ClaveDeTraduccion = string;

/** Los estados que un expediente puede tener en el servidor. */
export const ESTADOS_DE_EXPEDIENTE = [
  'submitted',
  'under_review',
  'awaiting_information',
  'approved',
  'rejected',
  'refund_pending',
  'refund_processing',
  'resolved',
  'cancelled',
  'failed',
] as const;
export type EstadoDeExpediente = (typeof ESTADOS_DE_EXPEDIENTE)[number];

/** Los tipos de expediente que la base admite. */
export const TIPOS_DE_EXPEDIENTE = [
  'buyer_cancellation',
  'event_cancelled',
  'event_rescheduled',
  'essential_change',
  'refund_request',
  'exception',
  'dispute',
] as const;
export type TipoDeExpediente = (typeof TIPOS_DE_EXPEDIENTE)[number];

/**
 * Los que el comprador puede abrir desde la aplicación.
 *
 * `event_cancelled`, `event_rescheduled` y `dispute` NO están: los abre el
 * sistema o administración a partir de un hecho registrado. Ofrecerlos aquí
 * dejaría que alguien declarara cancelado un evento que no lo está.
 */
export const TIPOS_QUE_SE_PUEDEN_PEDIR = [
  'buyer_cancellation',
  'refund_request',
  'essential_change',
  'exception',
] as const;

/** El primero de la lista, que es con el que arranca el formulario. */
export const TIPO_POR_DEFECTO: TipoDeExpediente = TIPOS_QUE_SE_PUEDEN_PEDIR[0];

/** Lo que puede contestar la elegibilidad. */
export const VEREDICTOS = [
  'eligible',
  'not_eligible',
  'needs_review',
  'policy_not_configured',
] as const;
export type Veredicto = (typeof VEREDICTOS)[number];

/** Los códigos de motivo que acompañan al veredicto. */
export const MOTIVOS_DE_ELEGIBILIDAD = [
  'policy_not_configured',
  'order_not_paid',
  'no_tickets',
  'case_already_open',
  'already_refunded',
  'event_finished',
  'window_closed',
  'checked_in',
  'ticket_not_valid',
  'change_unclassified',
  'event_cancelled',
] as const;

/** Los resultados con los que se cierra un expediente. */
export const DESENLACES = [
  'full_refund',
  'partial_refund',
  'no_refund',
  'credit',
  'ticket_revoked',
  'ticket_kept',
  'escalated',
] as const;

/** Cómo queda una entrada dentro de un expediente. */
export const EFECTOS_DE_ENTRADA = [
  'none',
  'under_review',
  'blocked',
  'cancelled',
  'revoked',
  'restored',
] as const;

/** Quién dio cada paso del historial. */
export const ACTORES = ['buyer', 'organizer', 'support', 'admin', 'system'] as const;

/** Lo mínimo que un expediente enseña para decidir qué botones caben. */
export type ExpedienteConAcciones = {
  status: string;
  acciones?: readonly string[] | null;
};

/** Lo que la elegibilidad contesta sobre una compra. */
export type VeredictoDeElegibilidad = {
  resultado: string;
  motivos?: readonly string[] | null;
  puede_pedir?: boolean;
  porcentaje_bps?: number | null;
};

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/** La clave de traducción del estado de un expediente. */
export function claveDelEstadoDeExpediente(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_EXPEDIENTE, estado, 'posventa.estado');
}

/** La clave de traducción del tipo de solicitud. */
export function claveDelTipoDeExpediente(tipo: string): ClaveDeTraduccion {
  return conocido(TIPOS_DE_EXPEDIENTE, tipo, 'posventa.tipo');
}

/** La clave de traducción del veredicto de elegibilidad. */
export function claveDelVeredicto(resultado: string): ClaveDeTraduccion {
  return conocido(VEREDICTOS, resultado, 'posventa.veredicto');
}

/** La clave de traducción de un motivo. */
export function claveDelMotivo(motivo: string): ClaveDeTraduccion {
  return conocido(MOTIVOS_DE_ELEGIBILIDAD, motivo, 'posventa.motivo');
}

/** La clave de traducción del resultado con el que se cerró. */
export function claveDelDesenlace(desenlace: string): ClaveDeTraduccion {
  return conocido(DESENLACES, desenlace, 'posventa.desenlace');
}

/** La clave de traducción del efecto sobre una entrada. */
export function claveDelEfecto(efecto: string): ClaveDeTraduccion {
  return conocido(EFECTOS_DE_ENTRADA, efecto, 'posventa.efecto');
}

/** La clave de traducción de quién dio un paso. */
export function claveDelActor(rol: string): ClaveDeTraduccion {
  return conocido(ACTORES, rol, 'posventa.actor');
}

/**
 * La clave del estado de una entrada afectada.
 *
 * Reutiliza las claves que ya escribe «mis entradas»: el mismo hecho contado
 * con dos textos distintos en dos pantallas es la forma de que uno de los dos
 * se quede viejo.
 */
export function claveDelEstadoDeEntradaAfectada(estado: string): ClaveDeTraduccion {
  return conocido(['VALID', 'USED', 'REVOKED'], estado, 'miEntrada.estado');
}

/**
 * Si el comprador puede contestar a una petición de información.
 *
 * DOS CONDICIONES, no una. El servidor manda `under_review` entre las acciones
 * porque es el destino del salto, y ese mismo destino existe también para
 * soporte desde otros estados: sin comprobar que estamos esperando información,
 * la pantalla pintaría el formulario de respuesta donde no toca.
 */
export function puedeResponder(expediente: ExpedienteConAcciones): boolean {
  return (
    expediente.status === 'awaiting_information' &&
    (expediente.acciones ?? []).includes('under_review')
  );
}

/** Si el comprador todavía puede retirar su solicitud. Lo dice el servidor. */
export function puedeRetirar(expediente: ExpedienteConAcciones): boolean {
  return (expediente.acciones ?? []).includes('cancelled');
}

/** Si el expediente ya no va a moverse más. */
export function expedienteCerrado(estado: string): boolean {
  return estado === 'resolved' || estado === 'rejected' || estado === 'cancelled';
}

/**
 * Si el dinero ha vuelto DE VERDAD.
 *
 * Solo `resolved` con un desenlace de devolución. `approved` no, `refund_pending`
 * no y `refund_processing` tampoco: son «alguien dijo que sí», «está en la cola»
 * y «se está ejecutando». Escribir «te devolvimos el dinero» en cualquiera de
 * esos tres es prometer un movimiento bancario que todavía no ha ocurrido.
 */
export function elDineroYaVolvio(
  estado: string,
  desenlace: string | null | undefined,
): boolean {
  return (
    estado === 'resolved' &&
    (desenlace === 'full_refund' || desenlace === 'partial_refund')
  );
}

/** El tono con el que se pinta el estado: color e icono, nada más. */
export type TonoDelEstado = 'bueno' | 'malo' | 'espera' | 'neutro';

export function tonoDelEstado(estado: string): TonoDelEstado {
  if (estado === 'resolved') return 'bueno';
  if (estado === 'rejected' || estado === 'failed') return 'malo';
  if (estado === 'awaiting_information') return 'espera';
  return 'neutro';
}

const SIMBOLOS: Record<string, string> = {
  PEN: 'S/',
  MXN: '$',
  USD: '$',
};

/**
 * El importe de la devolución, SOLO cuando hay importe y moneda.
 *
 * Sin moneda no se escribe una cifra: `$` es dólar y peso a la vez, y en una
 * devolución la moneda no es un adorno. Sin importe tampoco: `null` significa
 * que nadie lo ha decidido, y un «0.00» ahí sería una negativa que nadie ha
 * dado.
 */
export function importeDeLaDevolucion(
  centavos: number | null | undefined,
  moneda: string | null | undefined,
): string | null {
  if (typeof centavos !== 'number' || !Number.isFinite(centavos)) return null;
  const codigo = (moneda ?? '').trim().toUpperCase();
  if (codigo === '') return null;
  const valor = Math.max(0, Math.round(centavos));
  const enteros = Math.floor(valor / 100);
  const resto = String(valor % 100).padStart(2, '0');
  const simbolo = SIMBOLOS[codigo] ?? '';
  const cifra = `${simbolo}${simbolo ? ' ' : ''}${enteros}.${resto}`.trim();
  return `${cifra} ${codigo}`;
}

/**
 * El porcentaje que permite la política, o `null`.
 *
 * `null` cuando la política no trae el número. NO ES CERO: la pantalla escribe
 * que está pendiente de configurar, que es lo que pasa, en vez de un «0 %» que
 * suena a decisión tomada.
 */
export function porcentajeDePolitica(bps: number | null | undefined): string | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps)) return null;
  const seguro = Math.max(0, Math.trunc(bps));
  const enteros = Math.floor(seguro / 100);
  const resto = seguro % 100;
  if (resto === 0) return `${enteros}%`;
  const decimales = String(resto).padStart(2, '0').replace(/0$/, '');
  return `${enteros}.${decimales}%`;
}

/** Lo más largo que el servidor acepta como motivo (`max_length=1000`). */
export const LARGO_MAXIMO_DEL_MOTIVO = 1000;

/**
 * El motivo que SÍ se puede mandar, o `null`.
 *
 * Vacío no es un motivo, y ni los espacios ni los saltos de línea lo son. El
 * recorte al máximo se hace aquí para no mandar una petición que el servidor va
 * a rechazar con un 422 sobre un texto que la persona ya había escrito.
 */
export function motivoUtil(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  if (limpio === '') return null;
  return limpio.slice(0, LARGO_MAXIMO_DEL_MOTIVO);
}

/** Cuántos caracteres lleva escritos el motivo, para el contador. */
export function largoDelMotivo(texto: string | null | undefined): number {
  return (texto ?? '').length;
}

/**
 * Por qué no se puede abrir una solicitud, o `null`.
 *
 * Devuelve una CLAVE de traducción. `policy_not_configured` tiene la suya
 * propia y va primero: no es un «no», es un «todavía no lo hemos decidido», y
 * decirlo con la frase de una negativa sería dar por dicha una decisión que
 * nadie ha tomado.
 */
export function motivoParaNoPedir(
  veredicto: VeredictoDeElegibilidad,
): ClaveDeTraduccion | null {
  if (veredicto.resultado === 'policy_not_configured') {
    return 'posventa.sinPoliticaCuerpo';
  }
  if (veredicto.puede_pedir === true) return null;
  const primero = (veredicto.motivos ?? [])[0];
  return primero ? claveDelMotivo(primero) : 'posventa.noSePuedePedir';
}

/**
 * Qué decirle a la persona cuando el servidor dice que no.
 *
 * POR CÓDIGO ESTABLE, NO POR TEXTO: los mensajes del servidor están escritos en
 * español dentro de `posventa_router.py`, así que pintarlos tal cual le enseña
 * castellano a alguien que tiene la aplicación en inglés.
 *
 * `null` para un código que no se conoce: entonces la pantalla usa el texto del
 * servidor, que en español es correcto y en otro idioma es mejor que nada.
 */
export function claveDeErrorDePosventa(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const conocidos: Record<string, string> = {
    event_aftersale_not_available: 'posventa.error.noDisponible',
    event_case_not_eligible: 'posventa.error.noElegible',
    event_case_policy_not_configured: 'posventa.error.sinPolitica',
    event_case_needs_review: 'posventa.error.aRevisar',
    event_case_not_found: 'posventa.error.noEncontrado',
    event_case_policy_not_applied: 'posventa.politicaSinAplicar',
    event_case_transition_invalid: 'posventa.error.pasoInvalido',
    event_case_transition_forbidden: 'posventa.error.sinPermiso',
    // NO INVITAN A REINTENTAR. Un 403 no se arregla volviendo a pulsar y un 429
    // se arregla esperando: pintarlos como «inténtalo de nuevo» pone a la
    // persona a repetir algo que no va a funcionar.
    forbidden: 'posventa.error.sinPermiso',
    not_authorized: 'posventa.error.sinPermiso',
    rate_limited: 'errorDeEntradas.demasiadosIntentos',
    too_many_requests: 'errorDeEntradas.demasiadosIntentos',
  };
  if (typeof codigo !== 'string') return null;
  return conocidos[codigo] ?? null;
}

/**
 * Si este código significa «la posventa todavía no está encendida».
 *
 * El servidor contesta 503 con `event_aftersale_not_available` cuando las
 * tablas no están. No es un error de la compra ni de quien mira: es una parte
 * del sistema que aún no existe, y merece su propia pantalla.
 */
export function esPosventaApagada(codigo: string | null | undefined): boolean {
  return codigo === 'event_aftersale_not_available';
}
