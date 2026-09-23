/**
 * Las reglas de la selección de entradas, del lado de la interfaz.
 *
 * NO SUSTITUYEN AL SERVIDOR. Cada cuenta que se hace aquí se vuelve a hacer en
 * `events/ticketing.py`, y las que se pueden, en un CHECK de la 0061. Aquí
 * existen para no ofrecer un botón que va a responder 409 y para que el
 * subtotal se vea antes de pedir nada.
 *
 * EL DINERO, EN ENTEROS. Todo son centavos: 4900 son S/ 49.00. Ni una división,
 * ni un `Number` con decimales, ni un `toFixed` en mitad de una cuenta. Un
 * flotante en dinero es un descuadre con fecha, y aquí el descuadre se vería en
 * la pantalla de alguien que está a punto de pagar.
 *
 * ESTO NO ES EL TOTAL A PAGAR. Es el subtotal de las entradas. Faltan comisión,
 * impuestos y condiciones, que la empresa todavía no ha definido, y llamarlo
 * «total» sería prometer un importe que nadie ha decidido.
 *
 * Sin importaciones entre ficheros en tiempo de ejecución: el ejecutor de
 * pruebas de Node no resuelve el alias `@/`.
 */

/** Un tipo de entrada, tal y como llega del servidor. */
export type TipoDeEntrada = {
  id: string;
  name: string;
  description: string;
  price_minor: number;
  currency: string;
  min_per_order: number;
  max_per_order: number;
  inclusions: string[];
  restrictions: string[];
  sort_order: number;
  disponibles: number;
};

/** Lo elegido: cuántas de cada tipo. */
export type Seleccion = Record<string, number>;

/**
 * Cuántas se pueden pedir de este tipo, como mucho.
 *
 * Es el menor de tres cosas: lo que queda, el tope por operación y el tope
 * general del evento menos lo ya elegido de OTROS tipos. Sin el tercero, dos
 * tipos podrían sumar más de lo que cabe en la sala.
 */
export function topeDe(
  tipo: TipoDeEntrada,
  seleccion: Seleccion,
  topePorOperacion: number | null,
): number {
  const otros = Object.entries(seleccion)
    .filter(([id]) => id !== tipo.id)
    .reduce((suma, [, cantidad]) => suma + cantidad, 0);
  const candidatos = [tipo.disponibles, tipo.max_per_order];
  if (topePorOperacion !== null) candidatos.push(topePorOperacion - otros);
  return Math.max(0, Math.min(...candidatos));
}

/**
 * La cantidad ajustada a lo posible.
 *
 * RECORTA EN VEZ DE RECHAZAR. Quien pulsa «+» en el máximo no está cometiendo
 * un error: no hay nada que avisar, simplemente no sube. Y nunca baja de cero
 * ni admite decimales: media entrada no existe.
 */
export function cantidadPosible(
  tipo: TipoDeEntrada,
  pedida: number,
  seleccion: Seleccion,
  topePorOperacion: number | null,
): number {
  if (!Number.isFinite(pedida)) return 0;
  const entera = Math.trunc(pedida);
  if (entera <= 0) return 0;
  return Math.min(Math.max(0, entera), topeDe(tipo, seleccion, topePorOperacion));
}

/** El subtotal de un tipo, en centavos. Multiplicación entera, nada más. */
export function subtotalDe(tipo: TipoDeEntrada, cantidad: number): number {
  return Math.max(0, Math.trunc(cantidad)) * tipo.price_minor;
}

/** El subtotal de todo lo elegido, en centavos. */
export function subtotal(tipos: TipoDeEntrada[], seleccion: Seleccion): number {
  return tipos.reduce(
    (suma, tipo) => suma + subtotalDe(tipo, seleccion[tipo.id] ?? 0),
    0,
  );
}

/** Cuántas entradas hay elegidas en total. */
export function cuantasElegidas(seleccion: Seleccion): number {
  return Object.values(seleccion).reduce((suma, cantidad) => suma + cantidad, 0);
}

/**
 * El precio mínimo de los tipos que quedan, o `null`.
 *
 * `null` cuando no hay ninguno con existencias: entonces la ficha no escribe
 * «Desde», que sería un precio sobre una lista vacía.
 */
export function precioDesde(tipos: TipoDeEntrada[]): number | null {
  const precios = tipos.filter((t) => t.disponibles > 0).map((t) => t.price_minor);
  if (precios.length === 0) return null;
  return precios.reduce((menor, precio) => (precio < menor ? precio : menor));
}

/**
 * Por qué no se puede reservar todavía, o `null`.
 *
 * Devuelve una CLAVE de traducción; la pantalla la traduce en el idioma puesto.
 */
export function motivoParaNoReservar(
  tipos: TipoDeEntrada[],
  seleccion: Seleccion,
): string | null {
  const total = cuantasElegidas(seleccion);
  if (total === 0) return 'entradas.eligeAlMenosUna';
  for (const tipo of tipos) {
    const cantidad = seleccion[tipo.id] ?? 0;
    if (cantidad === 0) continue;
    if (cantidad < tipo.min_per_order) return 'entradas.pordebajoDelMinimo';
    if (cantidad > tipo.max_per_order) return 'entradas.porEncimaDelMaximo';
    if (cantidad > tipo.disponibles) return 'entradas.sinExistencias';
  }
  return null;
}

/** Si quedan entradas de algún tipo. */
export function hayExistencias(tipos: TipoDeEntrada[]): boolean {
  return tipos.some((t) => t.disponibles > 0);
}

/**
 * Los segundos que quedan de una reserva, según el reloj del dispositivo.
 *
 * ES INFORMATIVO. Quien decide si venció es el SERVIDOR: el teléfono puede
 * tener la hora mal, y una cuenta atrás que llega a cero no libera nada. Por
 * eso la pantalla vuelve a preguntar en vez de dar el hold por muerto.
 */
export function segundosRestantes(expiraEn: string, ahora = new Date()): number {
  const fin = new Date(expiraEn);
  if (Number.isNaN(fin.getTime())) return 0;
  return Math.max(0, Math.floor((fin.getTime() - ahora.getTime()) / 1000));
}

/** `mm:ss` para la cuenta atrás. */
export function comoReloj(segundos: number): string {
  const seguros = Math.max(0, Math.trunc(segundos));
  const minutos = Math.floor(seguros / 60);
  const resto = seguros % 60;
  return `${minutos}:${String(resto).padStart(2, '0')}`;
}

/**
 * Qué decirle a la persona cuando el servidor dice que no.
 *
 * POR CÓDIGO ESTABLE, NO POR TEXTO. El servidor contesta siempre en español
 * —los mensajes están escritos en `ticketing.py`—, así que pintar
 * `error.message` le enseñaba «Como mucho 4 entradas por operación.» a alguien
 * con la aplicación en inglés. Era el camino por el que salían todos los 409 y
 * 422 de este flujo.
 *
 * `null` para un código que no se conoce: entonces la pantalla usa el texto del
 * servidor, que en español es correcto y en otro idioma es mejor que nada.
 */
export function claveDeErrorDeEntradas(
  codigo: string | null | undefined,
): string | null {
  const conocidos: Record<string, string> = {
    event_not_ticketed: 'entradas.sinEntradas',
    event_ticketing_not_available: 'entradas.noDisponible',
    event_sales_not_open: 'errorDeEntradas.ventaSinAbrir',
    event_sales_closed: 'errorDeEntradas.ventaCerrada',
    ticket_type_unavailable: 'errorDeEntradas.tipoNoDisponible',
    ticket_quantity_invalid: 'errorDeEntradas.cantidadInvalida',
    ticket_limit_exceeded: 'errorDeEntradas.limiteSuperado',
    event_capacity_exceeded: 'errorDeEntradas.sinCupo',
    ticket_hold_expired: 'errorDeEntradas.reservaVencida',
    ticket_hold_already_consumed: 'errorDeEntradas.reservaUsada',
    ticket_hold_conflict: 'errorDeEntradas.otroPedido',
    ticket_hold_already_active: 'errorDeEntradas.yaTienesUna',
    ticket_hold_not_found: 'errorDeEntradas.reservaNoEncontrada',
    ticket_type_not_found: 'errorDeEntradas.tipoNoEncontrado',
    event_mode_conflict: 'errorDeEntradas.modoIncompatible',
    ticket_quota_invalid: 'errorDeEntradas.cupoImposible',
    ticket_type_in_use: 'errorDeEntradas.tipoEnUso',
    inventory_lock_timeout: 'errorDeEntradas.otraEnCurso',
    event_order_already_exists: 'errorDeEntradas.pedidoYaExiste',
    ticket_hold_not_usable: 'errorDeEntradas.reservaNoUtilizable',
    event_order_not_payable: 'errorDeEntradas.pedidoNoPagable',
    event_payment_mismatch: 'errorDeEntradas.pagoNoCuadra',
    event_order_not_found: 'errorDeEntradas.pedidoNoEncontrado',
    event_orders_not_available: 'errorDeEntradas.pedidosNoDisponibles',
    event_payments_not_available: 'errorDeEntradas.pagosNoDisponibles',
    event_order_conflict: 'errorDeEntradas.claveDePedidoReutilizada',
    event_ticket_not_found: 'errorDeEntradas.entradaNoEncontrada',
    event_ticket_not_valid: 'errorDeEntradas.entradaNoValida',
    event_ticket_already_used: 'errorDeEntradas.entradaYaUsada',
    event_not_admitting: 'errorDeEntradas.eventoSinAdmision',
    // NO INVITAN A REINTENTAR. Un 403 no se arregla volviendo a pulsar, y un
    // 429 se arregla esperando: pintar los dos como «inténtalo de nuevo» pone
    // a quien está en la puerta a repetir algo que no va a funcionar.
    forbidden: 'errorDeEntradas.sinPermiso',
    not_authorized: 'errorDeEntradas.sinPermiso',
    rate_limited: 'errorDeEntradas.demasiadosIntentos',
    too_many_requests: 'errorDeEntradas.demasiadosIntentos',
  };
  if (typeof codigo !== 'string') return null;
  return conocidos[codigo] ?? null;
}

/**
 * Si el fallo fue de la red y no del servidor.
 *
 * `StateView` tiene un estado `offline` con su icono y su frase, y ninguna de
 * las tres pantallas lo usaba: un teléfono sin cobertura leía «No pudimos
 * cargar el contenido», que suena a que algo se rompió y no a lo que pasa.
 */
export function esFalloDeRed(codigo: string | null | undefined): boolean {
  return codigo === 'network_error' || codigo === 'timeout';
}

/**
 * La reserva que estorba, sacada del detalle de un 409.
 *
 * El servidor manda `{"hold_id": ...}` con `ticket_hold_already_active`. Sin
 * ese identificador la persona que cierra la aplicación con una reserva viva no
 * tiene forma de volver a ella: se queda diez minutos bloqueada, y lo único que
 * puede hacer es esperar.
 */
export function reservaQueEstorba(detalle: unknown): string | null {
  return _delDetalle(detalle, 'hold_id');
}

/**
 * El pedido que estorba, sacado del detalle de un 409.
 *
 * El servidor manda `{"order_id": ...}` con `event_order_already_exists`. Sin
 * ese identificador, quien vuelve a una reserva que ya tiene pedido se queda
 * mirando un error sin salida en vez de ir al pedido que ya existe.
 */
export function pedidoQueEstorba(detalle: unknown): string | null {
  return _delDetalle(detalle, 'order_id');
}

function _delDetalle(detalle: unknown, campo: string): string | null {
  if (typeof detalle !== 'object' || detalle === null) return null;
  const valor = (detalle as Record<string, unknown>)[campo];
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/**
 * El menor de varios topes, ignorando los que no existen.
 *
 * El evento puede tener DOS: lo que queda en la sala y el máximo por operación
 * que fijó el organizador. Mirando solo el primero, la pantalla dejaba armar
 * una selección que el servidor iba a rechazar con un 409.
 */
export function menorTope(...topes: (number | null | undefined)[]): number | null {
  const puestos = topes.filter(
    (tope): tope is number => typeof tope === 'number' && Number.isFinite(tope),
  );
  if (puestos.length === 0) return null;
  return puestos.reduce((menor, tope) => (tope < menor ? tope : menor));
}

/**
 * Una huella de lo elegido, para la clave de idempotencia.
 *
 * La clave se generaba UNA VEZ por pantalla. Apartar, volver atrás, cambiar la
 * selección y apartar otra vez mandaba la misma clave con otro pedido: el
 * servidor contestaba, con razón, que esa clave ya se usó para otra petición, y
 * la clave no cambiaba mientras la pantalla siguiera viva. No había salida.
 *
 * Con la huella, un reintento del MISMO pedido reusa la clave —que es para lo
 * que existe— y un pedido distinto estrena una.
 */
export function huellaDeSeleccion(seleccion: Seleccion): string {
  return Object.entries(seleccion)
    .filter(([, cantidad]) => cantidad > 0)
    .map(([id, cantidad]) => `${id}:${cantidad}`)
    .sort()
    .join('|');
}

/**
 * Si el evento todavía no ha puesto ningún tipo a la venta.
 *
 * NO ES LO MISMO QUE AGOTADO, y el servidor se molesta en separarlos. Un
 * organizador que pone el evento en modo «con entradas» antes de crear los
 * tipos tenía la ficha ofreciendo «Elegir entradas» y la pantalla contestando
 * «Agotado · No quedan entradas de ningún tipo», que es una afirmación falsa
 * sobre un evento que aún no ha empezado a vender.
 */
export function todaviaSinTipos(tipos: TipoDeEntrada[]): boolean {
  return tipos.length === 0;
}

/** Los estados de una reserva que el servidor puede devolver. */
export type EstadoDeReserva = 'ACTIVE' | 'EXPIRED' | 'RELEASED' | 'CONSUMED';

/** Si la reserva sigue apartando entradas. */
export function sigueEnPie(estado: string, segundos: number): boolean {
  return estado === 'ACTIVE' && segundos > 0;
}

/** La clave de traducción del estado de una reserva. */
export function claveDelEstadoDeReserva(estado: string): string {
  const conocidos = ['ACTIVE', 'EXPIRED', 'RELEASED', 'CONSUMED'];
  return conocidos.includes(estado)
    ? `reserva.estado.${estado}`
    : 'reserva.estado.desconocido';
}

/**
 * Los tres modos de acceso de un evento.
 *
 * `INVITATION_ONLY` está en el contrato y NO tiene flujo: la aplicación no lo
 * ofrece. Un modo que la base admite y la interfaz no enseña es honesto; uno
 * que la interfaz enseña sin flujo detrás, no.
 */
export const MODOS_DE_ACCESO = ['FREE_RSVP', 'TICKETED', 'INVITATION_ONLY'] as const;
export type ModoDeAcceso = (typeof MODOS_DE_ACCESO)[number];

/** Los que la aplicación deja elegir hoy. */
export const MODOS_OFRECIDOS: ModoDeAcceso[] = ['FREE_RSVP', 'TICKETED'];

export function vendeEntradas(modo: string | null | undefined): boolean {
  return modo === 'TICKETED';
}

/** La clave de traducción del modo. */
export function claveDelModo(modo: string): string {
  return (MODOS_DE_ACCESO as readonly string[]).includes(modo)
    ? `modoDeAcceso.${modo}`
    : 'modoDeAcceso.desconocido';
}

/**
 * Por qué no se puede guardar este tipo de entrada, o `null`.
 *
 * El aforo va aparte: lo comprueba el servidor contra el APROBADO, que la
 * pantalla no siempre conoce.
 */
export function motivoParaNoGuardarTipo(campos: {
  nombre: string;
  precio: string;
  cupo: string;
  minimo: string;
  maximo: string;
}): string | null {
  if (campos.nombre.trim() === '') return 'entradas.faltaNombre';
  if (enteroEscrito(campos.precio) === null) return 'entradas.precioInvalido';
  const cupo = enteroEscrito(campos.cupo);
  if (cupo === null || cupo < 1) return 'entradas.cupoInvalido';
  const minimo = enteroEscrito(campos.minimo);
  const maximo = enteroEscrito(campos.maximo);
  if (minimo === null || minimo < 1) return 'entradas.minimoInvalido';
  if (maximo === null || maximo < 1) return 'entradas.maximoInvalido';
  if (maximo < minimo) return 'entradas.maximoMenorQueMinimo';
  return null;
}

/**
 * Un entero escrito por una persona, o `null`.
 *
 * VACÍO NO ES CERO y «muchos» tampoco. Devolver cero por un texto que no es un
 * número convierte un descuido en un precio.
 */
export function enteroEscrito(texto: string): number | null {
  const limpio = texto.trim();
  if (limpio === '') return null;
  if (!/^\d+$/.test(limpio)) return null;
  const valor = Number(limpio);
  return Number.isSafeInteger(valor) ? valor : null;
}
