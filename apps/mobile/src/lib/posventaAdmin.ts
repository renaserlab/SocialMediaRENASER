/**
 * Las reglas de la posventa VISTA DESDE DENTRO: administración y organizador.
 *
 * Es el compañero de `posventaDeEventos.ts`, no su sustituto: los estados, los
 * tipos, los desenlaces y el formateo del importe viven allí y se importan; lo
 * único que se escribe aquí es lo que la pantalla del comprador no necesita.
 * Solo los TIPOS se importan en este fichero —el ejecutor de pruebas de Node no
 * resuelve el alias `@/` y `tsc` no admite un `import` de valores con extensión
 * `.ts`—; las pantallas sí importan de los dos módulos a la vez, que es donde
 * de verdad se evita la duplicación.
 *
 * CUATRO COSAS DISTINTAS, Y NO SE PUEDEN DECIR IGUAL:
 *
 *   1. `approved`           alguien dijo que sí. NO ha salido dinero.
 *   2. `refund_pending`     se le ha pedido el movimiento al proveedor.
 *   3. `refund_processing`  el proveedor lo está ejecutando.
 *   4. `resolved` + devolución  el proveedor CONFIRMÓ que el dinero volvió.
 *
 * `faseDelDinero` existe para que la pantalla no pueda mezclarlas por
 * descuido. Entre la primera y la cuarta hay dinero en la cuenta de una
 * persona o no lo hay, y quien revisa toma decisiones distintas según cuál
 * sea. Solo el cuarto caso se puede contar como «devuelto», y coincide
 * exactamente con `elDineroYaVolvio` del otro módulo: la prueba lo comprueba
 * caso por caso para que no se separen.
 *
 * NO SE INVENTAN ACCIONES NI ENDPOINTS. El servidor manda en `acciones[]` los
 * saltos que ESTE actor puede dar, pero solo cuatro tienen una ruta de
 * administración escrita (`review`, `request-info`, `approve`, `reject`).
 * Ejecutar la devolución, marcarla resuelta o darla por fallida NO se hacen
 * desde la aplicación —`resolved` desde `refund_processing` solo lo alcanza un
 * aviso verificado del proveedor—, así que esos pasos se NOMBRAN pero no se
 * pintan como botones que acabarían en un 404 o en una promesa falsa.
 *
 * ALGUIEN PUEDE ADELANTARSE. Dos personas con el mismo caso abierto es la
 * situación normal en una bandeja compartida; el servidor lo corta con un
 * `UPDATE` condicional y contesta 409 `event_case_changed`. Eso NO es un error
 * que mostrar y olvidar: es «vuelve a mirarlo», y la pantalla tiene que
 * recargar y dejar decidir otra vez.
 */

import type { ClaveDeTraduccion, ExpedienteConAcciones } from './posventaDeEventos.ts';

/** Reexportado para que las pantallas de aquí no tengan que saber de dónde sale. */
export type { ClaveDeTraduccion, ExpedienteConAcciones };

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/* -------------------------------------------------------------------------- */
/* Dónde está el dinero                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Las cuatro cosas que NO son la misma, más el fallo.
 *
 * `null` es «este expediente no ha llegado a tocar dinero»: enviado, en
 * revisión, esperando información, rechazado, retirado o cerrado sin
 * devolución. Ahí no hay nada que contar sobre un movimiento que no existe.
 */
export const FASES_DEL_DINERO = [
  'aprobada',
  'pedidoAlProveedor',
  'enProceso',
  'confirmado',
  'fallido',
] as const;
export type FaseDelDinero = (typeof FASES_DEL_DINERO)[number];

/** Los tres pasos anteriores a la confirmación, en orden, para pintar la escalera. */
export const ESCALERA_DEL_DINERO = [
  'aprobada',
  'pedidoAlProveedor',
  'enProceso',
  'confirmado',
] as const;

/**
 * En qué punto está el dinero de este expediente.
 *
 * SE MIRA EL ESTADO, NO EL DESENLACE, salvo para confirmar: un expediente
 * `approved` con `outcome = full_refund` tiene decidido QUÉ se devuelve y no
 * ha movido un céntimo. Contarlo como devuelto es la forma exacta de prometer
 * un abono que todavía no ha salido.
 */
export function faseDelDinero(
  estado: string,
  desenlace: string | null | undefined,
): FaseDelDinero | null {
  if (estado === 'approved') return 'aprobada';
  if (estado === 'refund_pending') return 'pedidoAlProveedor';
  if (estado === 'refund_processing') return 'enProceso';
  if (estado === 'failed') return 'fallido';
  if (
    estado === 'resolved' &&
    (desenlace === 'full_refund' || desenlace === 'partial_refund')
  ) {
    return 'confirmado';
  }
  return null;
}

/** El titular de la fase. */
export function claveDeFaseDelDinero(fase: string): ClaveDeTraduccion {
  return conocido(FASES_DEL_DINERO, fase, 'posventaAdmin.dinero');
}

/** La explicación de la fase: qué ha pasado y qué NO ha pasado todavía. */
export function claveDelCuerpoDeLaFase(fase: string): ClaveDeTraduccion {
  return conocido(FASES_DEL_DINERO, fase, 'posventaAdmin.dineroCuerpo');
}

/** El color con el que se pinta la fase. Solo lo confirmado va en verde. */
export function tonoDeLaFase(fase: string): 'bueno' | 'malo' | 'espera' | 'neutro' {
  if (fase === 'confirmado') return 'bueno';
  if (fase === 'fallido') return 'malo';
  if (fase === 'pedidoAlProveedor' || fase === 'enProceso') return 'espera';
  return 'neutro';
}

/**
 * Si esta fase ya ocurrió, estando el expediente en `actual`.
 *
 * Para pintar la escalera: lo recorrido se ve hecho, lo que queda se ve por
 * delante. `fallido` no está en la escalera y no marca nada como hecho.
 */
export function faseAlcanzada(actual: string | null, fase: string): boolean {
  if (actual === null) return false;
  const hasta = (ESCALERA_DEL_DINERO as readonly string[]).indexOf(actual);
  const cual = (ESCALERA_DEL_DINERO as readonly string[]).indexOf(fase);
  if (hasta < 0 || cual < 0) return false;
  return cual <= hasta;
}

/* -------------------------------------------------------------------------- */
/* Lo que administración puede hacer desde aquí                                */
/* -------------------------------------------------------------------------- */

/**
 * Los saltos que tienen una ruta escrita bajo `/admin/events`.
 *
 * En el orden en que se ofrecen, que es el del triaje: tomarlo, pedir lo que
 * falte, y solo después decidir.
 */
export const ACCIONES_CON_PANTALLA = [
  'under_review',
  'awaiting_information',
  'approved',
  'rejected',
] as const;
export type AccionDeAdministracion = (typeof ACCIONES_CON_PANTALLA)[number];

/**
 * Los saltos que el servidor admite y que NO se dan desde la aplicación.
 *
 * Están escritos para poder DECIRLO —«esto existe y no se hace aquí»— en vez
 * de dejar un expediente aparentemente muerto en una pantalla sin botones.
 */
export const PASOS_FUERA_DE_LA_APLICACION = [
  'refund_pending',
  'refund_processing',
  'resolved',
  'cancelled',
  'failed',
] as const;

/** Lo que se le puede ofrecer a quien revisa: el servidor manda, nosotros filtramos. */
export function accionesDeAdministracion(
  expediente: ExpedienteConAcciones,
): AccionDeAdministracion[] {
  const dice = expediente.acciones ?? [];
  return ACCIONES_CON_PANTALLA.filter((accion) => dice.includes(accion));
}

/** Lo que el servidor permite y aquí no se pinta. Para explicarlo, no para ocultarlo. */
export function pasosSinPantalla(expediente: ExpedienteConAcciones): string[] {
  const dice = expediente.acciones ?? [];
  return PASOS_FUERA_DE_LA_APLICACION.filter((paso) => dice.includes(paso));
}

/** El texto del botón de cada acción. */
export function claveDeAccion(accion: string): ClaveDeTraduccion {
  return conocido(ACCIONES_CON_PANTALLA, accion, 'posventaAdmin.accion');
}

/**
 * Si esa acción no se puede mandar sin un motivo que la persona vaya a leer.
 *
 * Rechazar lo exige el servidor (`event_case_reject_needs_reason`), y pedir
 * información sin decir qué falta deja al comprador mirando una pantalla que
 * le pide algo sin decirle el qué.
 */
export function exigeMotivo(accion: string): boolean {
  return accion === 'rejected' || accion === 'awaiting_information';
}

/** Si esa acción cierra el expediente con un resultado y, quizá, un importe. */
export function llevaDesenlace(accion: string): boolean {
  return accion === 'approved';
}

/* -------------------------------------------------------------------------- */
/* Alguien se adelantó                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Si el 409 dice «otra persona lo movió mientras decidías».
 *
 * SE RECUPERA, no se acaba: la pantalla recarga el expediente y deja volver a
 * decidir sobre lo que hay ahora. Tratarlo como un error seco obliga a salir y
 * entrar, y quien revisa vuelve con la decisión que ya no vale.
 */
export function esConflictoDeExpediente(codigo: string | null | undefined): boolean {
  return codigo === 'event_case_changed';
}

/**
 * Los códigos que solo aparecen decidiendo, traducidos.
 *
 * Los del comprador siguen en `claveDeErrorDePosventa`; la pantalla pregunta
 * primero aquí y después allí. `null` significa «no lo conozco»: entonces se
 * usa el mensaje del servidor, que en español es correcto.
 */
export function claveDeErrorDeAdministracion(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const conocidos: Record<string, string> = {
    event_case_changed: 'posventaAdmin.conflictoCuerpo',
    event_case_outcome_invalid: 'posventaAdmin.error.desenlaceInvalido',
    event_case_outcome_without_policy: 'posventaAdmin.error.sinPoliticaPublicada',
    event_case_amount_without_currency: 'posventaAdmin.error.importeSinMoneda',
    event_case_reject_needs_reason: 'posventaAdmin.error.rechazoSinMotivo',
    event_change_classification_invalid: 'posventaAdmin.error.clasificacionInvalida',
  };
  if (typeof codigo !== 'string') return null;
  return conocidos[codigo] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Cambios del evento                                                          */
/* -------------------------------------------------------------------------- */

/** Lo que la base guarda cuando nadie ha mirado el cambio todavía. */
export const SIN_CLASIFICAR = 'pending';

/**
 * Lo que una persona puede elegir.
 *
 * `pending` NO está: es el estado de partida, no una decisión. Ofrecerlo como
 * opción dejaría «sin mirar» escrito como si alguien lo hubiera mirado, y
 * además el servidor lo rechaza.
 */
export const CLASIFICACIONES_QUE_SE_PUEDEN_ELEGIR = [
  'editorial',
  'operational',
  'possibly_essential',
  'essential',
  'not_essential',
] as const;
export type ClasificacionDeCambio =
  (typeof CLASIFICACIONES_QUE_SE_PUEDEN_ELEGIR)[number];

/** Todas las que la base admite, incluida la de partida. */
export const CLASIFICACIONES = [
  SIN_CLASIFICAR,
  ...CLASIFICACIONES_QUE_SE_PUEDEN_ELEGIR,
] as const;

export function claveDeClasificacion(valor: string): ClaveDeTraduccion {
  return conocido(CLASIFICACIONES, valor, 'posventaAdmin.clasificacion');
}

/** `pending` no es «no esencial»: es que nadie lo ha mirado. */
export function estaSinClasificar(valor: string | null | undefined): boolean {
  return valor === SIN_CLASIFICAR;
}

/**
 * Los campos cuyo cambio se registra (`CAMPOS_VIGILADOS` del backend).
 *
 * Se traducen porque `starts_at` no es algo que se le enseñe a nadie, y los usan
 * las dos pantallas: la de administración para el cambio suelto y la del
 * organizador para los campos de cada versión.
 */
export const CAMPOS_VIGILADOS = [
  'starts_at',
  'ends_at',
  'timezone',
  'location',
  'event_type',
  'capacity',
  'title',
  'promise',
  'description',
  'category',
] as const;

export function claveDelCampoDelEvento(campo: string): ClaveDeTraduccion {
  return conocido(CAMPOS_VIGILADOS, campo, 'posventaAdmin.campo');
}

/* -------------------------------------------------------------------------- */
/* Textos que viajan al servidor                                               */
/* -------------------------------------------------------------------------- */

/** `DecisionRequest.reason`: lo que la persona va a leer. */
export const LARGO_MAXIMO_DEL_MOTIVO_DE_DECISION = 500;
/** `DecisionRequest.notes`: lo que no sale de administración. */
export const LARGO_MAXIMO_DE_LA_NOTA_INTERNA = 2000;

/**
 * El texto que SÍ se puede mandar, recortado al máximo de ESE campo.
 *
 * No es `motivoUtil`: aquel lleva dentro el tope del comprador (1000) y aquí
 * hay dos topes distintos, 500 y 2000. Mandar 900 caracteres a un campo de 500
 * devuelve un 422 sobre un texto que alguien ya había escrito.
 */
export function textoUtil(
  texto: string | null | undefined,
  maximo: number,
): string | null {
  const limpio = (texto ?? '').trim();
  if (limpio === '') return null;
  return limpio.slice(0, Math.max(0, maximo));
}

/* -------------------------------------------------------------------------- */
/* El importe que se escribe al aprobar                                        */
/* -------------------------------------------------------------------------- */

/** Lo que se ha escrito en los dos campos del importe, leído. */
export type ImporteEscrito =
  | { estado: 'vacio' }
  | { estado: 'incompleto'; falta: 'importe' | 'moneda' }
  | { estado: 'invalido' }
  | { estado: 'listo'; centavos: number; moneda: string };

/**
 * Lo que hay escrito en «importe» y «moneda», junto.
 *
 * VAN JUNTOS O NO VAN. El servidor contesta 409
 * `event_case_amount_without_currency` a un importe sin moneda, y con razón:
 * «49.90» sin decir de qué es un número, no un importe. Y los dos vacíos es un
 * caso legítimo —aprobar sin cifra decidida—, distinto de uno a medias.
 *
 * NO SE INVENTA NADA: sin cifra escrita no se manda ninguna, y desde luego no
 * un cero, que sería decidir que no corresponde nada.
 */
export function leerImporte(
  importe: string | null | undefined,
  moneda: string | null | undefined,
): ImporteEscrito {
  const cifra = (importe ?? '').trim();
  const codigo = (moneda ?? '').trim();
  if (cifra === '' && codigo === '') return { estado: 'vacio' };
  if (cifra === '') return { estado: 'incompleto', falta: 'importe' };
  if (codigo === '') return { estado: 'incompleto', falta: 'moneda' };
  const centavos = centavosDesdeTexto(cifra);
  const enMayusculas = codigo.toUpperCase();
  if (centavos === null || !/^[A-Z]{3}$/.test(enMayusculas)) {
    return { estado: 'invalido' };
  }
  return { estado: 'listo', centavos, moneda: enMayusculas };
}

/**
 * «49.90» -> 4990. `null` si eso no es una cantidad.
 *
 * Se acepta la coma porque medio mundo escribe así, y se cortan los decimales
 * a dos porque la unidad menor no tiene más. Negativo es `null`: una
 * devolución de menos de nada no existe, y mandarlo devuelve un 422.
 */
export function centavosDesdeTexto(texto: string | null | undefined): number | null {
  const limpio = (texto ?? '').trim().replace(',', '.');
  if (limpio === '' || !/^\d+(\.\d{1,2})?$/.test(limpio)) return null;
  const valor = Number(limpio);
  if (!Number.isFinite(valor)) return null;
  return Math.round(valor * 100);
}

/* -------------------------------------------------------------------------- */
/* La bandeja                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cuántos expedientes se piden. EL SERVIDOR NO PAGINA ESTA BANDEJA.
 *
 * `/admin/events/aftersale-cases` acepta `limit` (máximo 200) y no devuelve
 * cursor. Así que no se puede fingir una paginación: se sube el tope y se DICE
 * cuál es, para que nadie crea que está viendo todo cuando está viendo los
 * primeros cincuenta.
 */
export const LIMITES_DE_LA_BANDEJA = [50, 100, 200] as const;
export const LIMITE_INICIAL = LIMITES_DE_LA_BANDEJA[0];

/** El siguiente tope, o `null` si ya estamos en el máximo del servidor. */
export function siguienteLimite(actual: number): number | null {
  for (const limite of LIMITES_DE_LA_BANDEJA) {
    if (limite > actual) return limite;
  }
  return null;
}

/**
 * Si lo que se ve podría no ser todo.
 *
 * Tantos resultados como el tope significa que el corte lo puso el `limit`, no
 * la realidad. Es cuando hay que avisar de que se filtre.
 */
export function llegoAlTope(cuantos: number, limite: number): boolean {
  return cuantos >= limite;
}

/** Un identificador de evento escrito a mano, listo para el filtro, o `null`. */
export function filtroDeEvento(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  return limpio === '' ? null : limpio;
}
