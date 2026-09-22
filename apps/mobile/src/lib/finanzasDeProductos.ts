/**
 * Las finanzas de una venta de producto, del lado de la interfaz.
 *
 * NO DECIDEN NADA. Cuánto se queda Z, cuándo deja de estar protegido un saldo,
 * por qué no se libera y cuánto se devuelve lo dice el servidor. Aquí solo se
 * traduce a texto lo que ya dijo y se decide qué tiene sentido pintar.
 *
 * SIN COMISIÓN CONFIGURADA NO HAY BALANCE, Y NO SE PINTA UN CERO. `0,00` se lee
 * como «vendiste y no cobraste», que es exactamente lo contrario de la verdad:
 * lo que pasa es que la empresa no ha decidido cuánto se queda la plataforma, y
 * mientras no lo decida no se escribe ni un saldo. `hayBalance()` devuelve
 * `false` y la pantalla escribe «pendiente de configuración».
 *
 * NI UN IMPORTE SIN SU MONEDA. Un número suelto no significa nada: 19 900 soles
 * y 19 900 dólares son el mismo número y distinto dinero. `importe()` devuelve
 * `null` cuando falta la moneda, y con dos monedas distintas en la misma cuenta
 * el servidor manda la moneda nula a propósito, porque sumarlas daría una cifra
 * que no existe.
 *
 * NI UNA COMISIÓN CALCULADA AQUÍ. El porcentaje vive en el servidor y en la
 * versión de reglas que congeló cada venta; recalcularlo con el de hoy
 * reescribiría ventas históricas. En este fichero no hay ninguna multiplicación
 * por un porcentaje, y hay una prueba que lo comprueba sobre el código fuente.
 *
 * Sin importaciones entre ficheros en tiempo de ejecución: el ejecutor de
 * pruebas de Node no resuelve el alias `@/`.
 */

/** Una clave del diccionario. La convierte la pantalla al traducir. */
export type ClaveDeTraduccion = string;

/** Los estados de un saldo. Son los del servidor, no otros. */
export const ESTADOS_DE_SALDO = [
  'pending',
  'frozen',
  'eligible',
  'transferring',
  'transferred',
  'cancelled',
  'failed',
] as const;
export type EstadoDeSaldo = (typeof ESTADOS_DE_SALDO)[number];

/** Por qué un saldo no se libera. Catorce códigos, y ninguna frase. */
export const BLOQUEOS = [
  'fee_not_configured',
  'balance_not_pending',
  'seller_missing',
  'payout_account_missing',
  'payout_account_not_ready',
  'order_not_paid',
  'not_delivered',
  'protection_policy_not_configured',
  'protection_window_open',
  'reserve_held',
  'incident_open',
  'refund_pending',
  'dispute_open',
  'negative_balance',
] as const;
export type Bloqueo = (typeof BLOQUEOS)[number];

/**
 * LOS QUE QUIEN VENDE PUEDE ARREGLAR, y los que no.
 *
 * La diferencia importa más de lo que parece: decirle «te falta la cuenta de
 * cobro» a quien no puede darse de alta —porque el alta de Connect no existe—
 * le manda a buscar un botón que no hay. Estos dos son los únicos que hoy
 * dependen de una persona, y aun así la pantalla explica que el alta todavía no
 * está abierta.
 */
export const BLOQUEOS_SUYOS = ['payout_account_missing', 'payout_account_not_ready'] as const;

/** Los que son «espera, no pasa nada»: el reloj o el paquete. */
export const BLOQUEOS_DE_ESPERA = [
  'not_delivered',
  'protection_window_open',
  'order_not_paid',
] as const;

/** Los estados de una devolución. Cinco, y ninguno es sinónimo de otro. */
export const ESTADOS_DE_DEVOLUCION = [
  'approved',
  'requested',
  'processing',
  'confirmed',
  'failed',
  'cancelled',
] as const;
export type EstadoDeDevolucion = (typeof ESTADOS_DE_DEVOLUCION)[number];

/** Los estados de una disputa. Son los de la pasarela. */
export const ESTADOS_DE_DISPUTA = [
  'open',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'withdrawn',
] as const;

/**
 * Los estados de una retención. SON OTROS QUE LOS DE UN SALDO.
 *
 * Y hacen falta porque no tenerlos costaba una pantalla mintiendo: la lista de
 * retenciones pasaba `held` por el vocabulario de los saldos —pending, frozen,
 * eligible…—, ninguno casaba, y cada importe apartado salía con el estado
 * «desconocido» debajo. Lo encontró la revisión independiente.
 */
export const ESTADOS_DE_RETENCION = ['held', 'released', 'consumed'] as const;

/** Los motivos de una retención, cerrados por la base. */
export const MOTIVOS_DE_RETENCION = [
  'aftersale_case',
  'refund',
  'cancellation',
  'essential_change',
  'dispute',
  'operational_risk',
] as const;

/** Lo que contesta el resumen del proveedor. */
export type ResumenFinanciero = {
  /** NULA si no hay ventas o si hay más de una moneda. */
  currency?: string | null;
  gross_minor?: number;
  platform_fee_minor?: number;
  net_minor?: number;
  held_minor?: number;
  available_minor?: number;
  sales?: number;
  /** `false` = la empresa no ha decidido cuánto se queda Z. */
  fee_configured?: boolean;
  by_status?: Record<string, number> | null;
};

/** Un movimiento: una venta cobrada, con su bloqueo si lo tiene. */
export type SaldoDeProducto = {
  id: string;
  order_id: string;
  status: string;
  currency: string;
  gross_minor: number;
  platform_fee_minor: number;
  provider_fee_minor: number;
  net_minor: number;
  fee_rules_version: string;
  held_minor?: number;
  available_at?: string | null;
  block?: string | null;
  block_detail?: string | null;
  created_at: string;
};

export type DevolucionDeProducto = {
  id: string;
  order_id: string;
  incident_id?: string | null;
  amount_minor: number;
  currency: string;
  kind: string;
  status: string;
  provider: string;
  decision_reason: string;
  requested_at?: string | null;
  confirmed_at?: string | null;
  failed_at?: string | null;
  failure_code?: string | null;
  created_at: string;
};

export type CuentaDeCobro = {
  configured?: boolean;
  payouts_enabled?: boolean;
  onboarding_status?: string | null;
  missing?: string[] | null;
};

export type SaludFinanciera = {
  fee_configured?: boolean;
  transfers_enabled?: boolean;
  refunds_enabled?: boolean;
  balances_pending?: number;
  balances_eligible?: number;
  balances_blocked?: number;
  reserves_held?: number;
  refunds_in_flight?: number;
  disputes_open?: number;
  missing?: string[] | null;
};

function entero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? Math.trunc(valor) : 0;
}

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/** La clave de traducción del estado de un saldo. */
export function claveDelEstadoDeSaldo(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_SALDO, estado, 'finanzaDeProducto.estado');
}

/** La clave de traducción de un bloqueo. */
export function claveDelBloqueo(bloqueo: string): ClaveDeTraduccion {
  return conocido(BLOQUEOS, bloqueo, 'finanzaDeProducto.bloqueo');
}

/** Y la de qué hacer con él, que no siempre es «hacer algo». */
export function claveDeQueHacer(bloqueo: string): ClaveDeTraduccion {
  return conocido(BLOQUEOS, bloqueo, 'finanzaDeProducto.queHacer');
}

/** La clave del estado de una devolución. */
export function claveDelEstadoDeDevolucion(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_DEVOLUCION, estado, 'finanzaDeProducto.devolucion');
}

/** La clave del estado de una disputa. */
export function claveDelEstadoDeDisputa(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_DISPUTA, estado, 'finanzaDeProducto.disputa');
}

/** La clave del motivo de una retención. */
export function claveDelMotivoDeRetencion(motivo: string): ClaveDeTraduccion {
  return conocido(MOTIVOS_DE_RETENCION, motivo, 'finanzaDeProducto.retencion');
}

/** Y la de su ESTADO, que no es el de un saldo. */
export function claveDelEstadoDeRetencion(estado: string): ClaveDeTraduccion {
  return conocido(
    ESTADOS_DE_RETENCION,
    estado,
    'finanzaDeProducto.estadoDeRetencion',
  );
}

/**
 * Si hay un balance que se pueda enseñar.
 *
 * DOS CONDICIONES, Y LA PRIMERA ES LA QUE IMPORTA. Sin comisión configurada no
 * existe ni un saldo, así que cualquier cifra sería inventada. Y sin ventas
 * tampoco hay nada que sumar.
 */
export function hayBalance(resumen: ResumenFinanciero | null | undefined): boolean {
  if (resumen?.fee_configured !== true) return false;
  return entero(resumen?.sales) > 0;
}

/** Si lo que falta es una decisión de la empresa y no un dato que llegue solo. */
export function faltaDecidirLaComision(
  resumen: ResumenFinanciero | null | undefined,
): boolean {
  return resumen?.fee_configured !== true;
}

/**
 * Un importe listo para pintar, o `null`.
 *
 * `null` SIN MONEDA, y no un número suelto: 19 900 no significa nada sin decir
 * de qué. Con dos monedas distintas el servidor manda la moneda nula a
 * propósito, y entonces aquí tampoco se pinta un total.
 *
 * NO SE FORMATEA CON SÍMBOLOS NI SEPARADORES LOCALES: eso lo hace la pantalla,
 * que sabe el idioma. Aquí solo se pasa de unidad menor a unidad y se junta con
 * el código de la moneda.
 */
export function importe(
  minor: number | null | undefined,
  moneda: string | null | undefined,
): string | null {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return null;
  if (typeof moneda !== 'string' || moneda.length !== 3) return null;
  const unidades = (Math.trunc(minor) / 100).toFixed(2);
  return `${unidades} ${moneda.toUpperCase()}`;
}

/** Lo que de verdad puede cobrar: lo disponible menos lo retenido, nunca negativo. */
export function disponibleLegible(
  resumen: ResumenFinanciero | null | undefined,
): string | null {
  if (!hayBalance(resumen)) return null;
  return importe(entero(resumen?.available_minor), resumen?.currency);
}

/** Lo retenido, o `null` si no hay nada apartado. */
export function retenidoLegible(
  resumen: ResumenFinanciero | null | undefined,
): string | null {
  if (!hayBalance(resumen)) return null;
  const retenido = entero(resumen?.held_minor);
  if (retenido <= 0) return null;
  return importe(retenido, resumen?.currency);
}

/** El bruto y la comisión, para que se vea de dónde sale el neto. */
export function desglose(
  resumen: ResumenFinanciero | null | undefined,
): Array<{ clave: ClaveDeTraduccion; texto: string }> {
  if (!hayBalance(resumen)) return [];
  const moneda = resumen?.currency;
  const filas: Array<{ clave: ClaveDeTraduccion; texto: string }> = [];
  for (const [clave, valor] of [
    ['finanzaDeProducto.desglose.bruto', resumen?.gross_minor],
    ['finanzaDeProducto.desglose.comision', resumen?.platform_fee_minor],
    ['finanzaDeProducto.desglose.neto', resumen?.net_minor],
  ] as Array<[string, number | undefined]>) {
    const texto = importe(entero(valor), moneda);
    if (texto !== null) filas.push({ clave, texto });
  }
  return filas;
}

/** Si un saldo está bloqueado. */
export function estaBloqueado(saldo: SaldoDeProducto | null | undefined): boolean {
  return typeof saldo?.block === 'string' && saldo.block.length > 0;
}

/**
 * Si el bloqueo depende de quien vende.
 *
 * Solo los dos de la cuenta de cobro, y **aun así** hoy no puede arreglarlos:
 * el alta de Connect no existe. La pantalla lo dice.
 */
export function esBloqueoSuyo(bloqueo: string | null | undefined): boolean {
  return typeof bloqueo === 'string' && (BLOQUEOS_SUYOS as readonly string[]).includes(bloqueo);
}

/** Si el bloqueo es simplemente «espera». */
export function esBloqueoDeEspera(bloqueo: string | null | undefined): boolean {
  return (
    typeof bloqueo === 'string' &&
    (BLOQUEOS_DE_ESPERA as readonly string[]).includes(bloqueo)
  );
}

/**
 * Cuándo deja de estar protegido, o `null`.
 *
 * `null` NO ES «YA», y es la confusión que más dinero costaría: significa que
 * todavía no se sabe, porque el paquete no ha llegado o porque la política de
 * ese pedido no fija el plazo. La pantalla escribe por qué no hay fecha en vez
 * de pintar una.
 */
export function cuandoSeLibera(saldo: SaldoDeProducto | null | undefined): string | null {
  const cuando = saldo?.available_at;
  return typeof cuando === 'string' && cuando.length > 0 ? cuando : null;
}

/** Cuántas horas le quedan, o `null` si no se sabe. Redondea hacia arriba. */
export function horasQueFaltan(
  saldo: SaldoDeProducto | null | undefined,
  ahora: Date = new Date(),
): number | null {
  const cuando = cuandoSeLibera(saldo);
  if (cuando === null) return null;
  const fin = Date.parse(cuando);
  if (!Number.isFinite(fin)) return null;
  const faltan = fin - ahora.getTime();
  if (faltan <= 0) return 0;
  return Math.ceil(faltan / 3_600_000);
}

/**
 * Si se le puede ofrecer dar la conformidad.
 *
 * TRES CONDICIONES: que haya llegado, que no la haya dado ya y que no tenga una
 * reclamación viva. La tercera no se deduce: la manda el servidor con el pedido,
 * y quien dice que algo llegó mal no puede a la vez decir que está bien.
 */
export function sePuedeDarConformidad(
  envio: { status?: string; delivered_at?: string | null; conformity_at?: string | null } | null | undefined,
  hayReclamacionViva: boolean,
): boolean {
  if (!envio) return false;
  if (envio.status !== 'DELIVERED') return false;
  if (typeof envio.conformity_at === 'string' && envio.conformity_at.length > 0) {
    return false;
  }
  return !hayReclamacionViva;
}

/** Si ya dio la conformidad. NO es lo mismo que haber confirmado que llegó. */
export function yaDioLaConformidad(
  envio: { conformity_at?: string | null } | null | undefined,
): boolean {
  return typeof envio?.conformity_at === 'string' && envio.conformity_at.length > 0;
}

/**
 * Si el dinero de una devolución ya salió.
 *
 * SOLO `confirmed`. `approved` es una decisión, `requested` es una petición y
 * `processing` es una espera: ninguna de las tres es dinero devuelto, y decir
 * que sí sería lo peor que puede decir esta pantalla.
 */
export function elDineroYaVolvio(
  devolucion: DevolucionDeProducto | null | undefined,
): boolean {
  return devolucion?.status === 'confirmed';
}

/** Si esa devolución todavía espera algo. */
export function sigueEnMarcha(
  devolucion: DevolucionDeProducto | null | undefined,
): boolean {
  return (
    devolucion?.status === 'approved' ||
    devolucion?.status === 'requested' ||
    devolucion?.status === 'processing'
  );
}

/** Si se le puede pedir a la pasarela. Una confirmada no se vuelve a pedir. */
export function sePuedePedir(
  devolucion: DevolucionDeProducto | null | undefined,
): boolean {
  return devolucion?.status === 'approved' || devolucion?.status === 'failed';
}

/** Si se puede anular. Una confirmada no: el dinero ya volvió. */
export function sePuedeAnular(
  devolucion: DevolucionDeProducto | null | undefined,
): boolean {
  return sigueEnMarcha(devolucion);
}

/** El importe de una devolución, con su moneda. */
export function importeDeLaDevolucion(
  devolucion: DevolucionDeProducto | null | undefined,
): string | null {
  if (!devolucion) return null;
  return importe(devolucion.amount_minor, devolucion.currency);
}

/**
 * Qué le falta a la cuenta de cobro, en claves.
 *
 * VIENE DEL SERVIDOR Y NO SE DEDUCE. Y el alta NO se ofrece: darse de alta en
 * Connect exige una cuenta de la empresa verificada, la confirmación de que la
 * modalidad está disponible para el país y el rubro, y una decisión de quién
 * cobra. La pantalla lo dice en vez de pintar un botón que no daría de alta a
 * nadie.
 */
export function queLeFaltaALaCuenta(
  cuenta: CuentaDeCobro | null | undefined,
): ClaveDeTraduccion[] {
  return (cuenta?.missing ?? []).map((falta) =>
    conocido(
      ['platform_fee_bps', 'stripe_connect_enabled', 'creator_transfers_enabled', 'payout_account'],
      falta,
      'finanzaDeProducto.falta',
    ),
  );
}

/** Si la cuenta de cobro está lista de verdad. */
export function laCuentaEstaLista(cuenta: CuentaDeCobro | null | undefined): boolean {
  return (
    cuenta?.configured === true &&
    cuenta?.payouts_enabled === true &&
    cuenta?.onboarding_status === 'active' &&
    (cuenta?.missing ?? []).length === 0
  );
}

/**
 * Si el panel financiero puede mover dinero.
 *
 * `missing` VACÍO Y LAS TRES BANDERAS. Enseñar botones de transferir con Connect
 * apagado sería ofrecer algo que falla; el panel dice qué hay y qué falta.
 */
export function puedeMoverDinero(salud: SaludFinanciera | null | undefined): boolean {
  if ((salud?.missing ?? []).length > 0) return false;
  return (
    salud?.fee_configured === true &&
    salud?.transfers_enabled === true &&
    salud?.refunds_enabled === true
  );
}

/** Lo que falta para que el dinero pueda salir, en claves. */
export function queLeFaltaAlPanel(
  salud: SaludFinanciera | null | undefined,
): ClaveDeTraduccion[] {
  return (salud?.missing ?? []).map((falta) =>
    conocido(
      [
        'platform_fee_bps',
        'stripe_connect_enabled',
        'creator_transfers_enabled',
        'stripe_refunds_enabled',
        'migration_0082',
      ],
      falta,
      'finanzaDeProducto.falta',
    ),
  );
}

/** Los números del panel, para pintarlos en fila. Cero SÍ es cero aquí. */
export function contadoresDelPanel(
  salud: SaludFinanciera | null | undefined,
): Array<{ clave: ClaveDeTraduccion; cuantos: number }> {
  return [
    ['finanzaDeProducto.panel.pendientes', salud?.balances_pending],
    ['finanzaDeProducto.panel.elegibles', salud?.balances_eligible],
    ['finanzaDeProducto.panel.bloqueados', salud?.balances_blocked],
    ['finanzaDeProducto.panel.retenciones', salud?.reserves_held],
    ['finanzaDeProducto.panel.devoluciones', salud?.refunds_in_flight],
    ['finanzaDeProducto.panel.disputas', salud?.disputes_open],
  ].map(([clave, cuantos]) => ({
    clave: clave as string,
    //: UNA CUENTA DE FILAS SÍ PUEDE SER CERO, y cero significa cero. Es
    //: distinto de un importe sin moneda, que no significa nada.
    cuantos: entero(cuantos),
  }));
}

/** El cursor de la siguiente página de movimientos. */
export function cursorDeLaPagina(
  recibidos: readonly SaldoDeProducto[] | null | undefined,
  limite = 20,
): { before: string; before_id: string } | null {
  const lista = recibidos ?? [];
  if (lista.length < limite) return null;
  const ultimo = lista[lista.length - 1];
  if (!ultimo?.created_at || !ultimo?.id) return null;
  return { before: ultimo.created_at, before_id: ultimo.id };
}

/** Si puede haber más páginas detrás de esta. */
export function hayMasPaginas(recibidos: number, limite = 20): boolean {
  return entero(recibidos) >= entero(limite);
}

/** Pega una página nueva detrás sin repetir. */
export function fusionarPaginas<T extends { id: string }>(
  anteriores: readonly T[],
  nuevas: readonly T[],
): T[] {
  const vistos = new Set(anteriores.map((x) => x.id));
  return [...anteriores, ...nuevas.filter((x) => !vistos.has(x.id))];
}

/** Si el error dice que las finanzas todavía no están disponibles. */
export function esFinanzasApagadas(codigo: string | null | undefined): boolean {
  return codigo === 'product_finance_not_available';
}

/**
 * Cada código que contesta el servidor, con su texto.
 *
 * ES UNA TABLA Y NO UNA LISTA: hay una prueba que lee los códigos del propio
 * servidor y los busca aquí, así que un código nuevo se queda sin texto en rojo
 * y no en silencio.
 */
export const ERRORES_DE_FINANZAS = {
  product_finance_not_available: 'finanzaDeProducto.error.product_finance_not_available',
  product_finance_forbidden: 'finanzaDeProducto.error.product_finance_forbidden',
  product_refund_not_allowed: 'finanzaDeProducto.error.product_refund_not_allowed',
  product_refund_not_found: 'finanzaDeProducto.error.product_refund_not_found',
  product_refund_already_exists: 'finanzaDeProducto.error.product_refund_already_exists',
  product_reserve_already_held: 'finanzaDeProducto.error.product_reserve_already_held',
  product_reserve_amount_invalid: 'finanzaDeProducto.error.product_reserve_amount_invalid',
  product_reserve_not_found: 'finanzaDeProducto.error.product_reserve_not_found',
  product_shipment_not_delivered: 'finanzaDeProducto.error.product_shipment_not_delivered',
  product_shipment_incident_open: 'finanzaDeProducto.error.product_shipment_incident_open',
} as const;

/** La clave de traducción del error que contestó el servidor. */
export function claveDeErrorFinanciero(
  codigo: string | null | undefined,
): ClaveDeTraduccion {
  if (typeof codigo === 'string' && codigo in ERRORES_DE_FINANZAS) {
    return ERRORES_DE_FINANZAS[codigo as keyof typeof ERRORES_DE_FINANZAS];
  }
  return 'finanzaDeProducto.error.desconocido';
}

/** El motivo que viene dentro del detalle de un 409, si lo hay. */
export function motivoDelRechazo(detalle: unknown): ClaveDeTraduccion | null {
  if (!detalle || typeof detalle !== 'object') return null;
  const motivo = (detalle as { reason?: unknown }).reason;
  if (typeof motivo !== 'string' || !motivo) return null;
  return conocido(
    [
      'order_not_paid',
      'incident_not_resolved',
      'resolution_without_money',
      'amount_invalid',
      'amount_above_charge',
      'already_requested',
      'already_confirmed',
      'no_original_charge',
    ],
    motivo,
    'finanzaDeProducto.rechazo',
  );
}

/**
 * El tope que la pantalla puede ofrecer al teclear un importe.
 *
 * VIENE DEL 409 DEL SERVIDOR, que dice `max_minor`. No se calcula aquí: restar
 * lo ya devuelto exige saber qué devoluciones hay vivas, y eso lo sabe el
 * servidor. `null` = todavía no lo ha dicho.
 */
export function topeDeLaDevolucion(detalle: unknown): number | null {
  if (!detalle || typeof detalle !== 'object') return null;
  const tope = (detalle as { max_minor?: unknown }).max_minor;
  return typeof tope === 'number' && Number.isFinite(tope) ? Math.trunc(tope) : null;
}
