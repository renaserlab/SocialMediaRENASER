/**
 * Las finanzas de eventos, del lado de la interfaz.
 *
 * AQUÍ NO SE CALCULA DINERO. Ni una comisión, ni un porcentaje, ni un plazo, ni
 * una fecha de cobro. El servidor manda números ya hechos y esto solo decide
 * CÓMO se escriben y CUÁNDO no se escribe ninguno.
 *
 * LA REGLA QUE MANDA SOBRE TODAS: `comision_configurada: false`. Cuando llega
 * en `false`, `comision_minor` y `neto_minor` llegan `null` porque nadie ha
 * decidido cuánto cobra Z. Eso NO se enseña como cero —diría que Z no cobra
 * nada—, ni como `-1`, ni como un porcentaje sacado de ningún sitio: se dice
 * que está pendiente de configuración, que es lo que pasa. El BRUTO sí se
 * enseña: cuánto se ha vendido sí se sabe.
 *
 * `null` NO ES CERO, y `currency: null` NO ES «0,00». Sin moneda no hay ninguna
 * venta registrada, y un importe sin su moneda no es un importe: `$` es dólar y
 * peso a la vez. Por eso `cifra…` devuelve un estado, no una cadena: la
 * pantalla tiene que elegir entre escribir un número, decir que está pendiente
 * o enseñar el estado vacío, y no puede hacerlo con un `?? 0`.
 *
 * NADA DE ESTO MUEVE DINERO. Soltar una reserva levanta una retención y anota
 * por qué; no transfiere nada. `transfers/run` hoy devuelve cero ejecutadas y
 * una lista de bloqueos, y eso es exactamente lo que la pantalla enseña.
 *
 * Sin importaciones con el alias `@/` en tiempo de ejecución: el ejecutor de
 * pruebas de Node no lo resuelve.
 */

/** Una clave del diccionario. `string` porque `@/i18n` no se puede importar
 * aquí; la pantalla la convierte al traducir. */
export type ClaveDeTraduccion = string;

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/* -------------------------------------------------------------------------- */
/* Lo que manda el servidor                                                    */
/* -------------------------------------------------------------------------- */

/** `ResumenFinancieroRead`, tal cual. */
export type ResumenFinanciero = {
  /** LA QUE MANDA. En `false` no hay comisión ni neto que enseñar. */
  comision_configurada: boolean;
  ventas: number;
  bruto_minor: number;
  comision_minor: number | null;
  neto_minor: number | null;
  retenido_minor: number;
  reservado_minor: number;
  disponible_minor: number;
  transferido_minor: number;
  /** `null` cuando no hay ni una venta. */
  currency: string | null;
  motivos: string[];
};

/** `SaldoRead`, tal cual. */
export type SaldoDeVenta = {
  id: string;
  event_id: string | null;
  order_id: string | null;
  gross_amount_minor: number;
  platform_fee_minor: number | null;
  net_amount_minor: number | null;
  currency: string;
  status: string;
  reserved_minor: number;
  available_at: string | null;
  /** Un código, o `null` si nada lo impide. Nunca se enseña crudo. */
  bloqueo: string | null;
  created_at: string;
};

/** Una disputa, tal como la manda administración. */
export type Disputa = {
  id: string;
  event_id: string | null;
  order_id: string | null;
  amount_minor: number;
  currency: string;
  status: string;
  evidence_due_at: string | null;
  /** Quién asume la pérdida. `null` mientras no hay política. */
  liability: string | null;
  created_at: string;
};

/** Un hallazgo de conciliación. Un CÓDIGO, no una frase. */
export type Hallazgo = {
  codigo: string;
  entidad: string;
  id: string;
  detalle: string | null;
};

/** Lo que contesta `transfers/run`. Hoy siempre cero. */
export type ResultadoDeTransferencias = {
  ejecutadas: number;
  bloqueos: string[];
};

/* -------------------------------------------------------------------------- */
/* Importes                                                                    */
/* -------------------------------------------------------------------------- */

const SIMBOLOS: Record<string, string> = {
  PEN: 'S/',
  MXN: '$',
  USD: '$',
};

/**
 * Lo que la pantalla puede escribir en el hueco de un número.
 *
 * Son TRES cosas distintas y ninguna es las otras: hay una cifra, nadie ha
 * configurado la comisión, o no hay ninguna venta de la que hablar. Devolver
 * una cadena obligaría a inventarse un texto para los dos últimos casos, y el
 * que sale solo es «0,00».
 */
export type Cifra =
  | { estado: 'cifra'; texto: string }
  | { estado: 'pendienteDeConfiguracion' }
  | { estado: 'sinVentas' };

/**
 * Un importe en la unidad menor, con su moneda. `null` si no se puede escribir.
 *
 * SIN MONEDA NO SE ESCRIBE NADA. El código va siempre porque `MXN` y `USD`
 * comparten símbolo, y una moneda que no está en la tabla sale sin él.
 */
export function importeConMoneda(
  minor: number | null | undefined,
  moneda: string | null | undefined,
): string | null {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return null;
  const codigo = (moneda ?? '').trim().toUpperCase();
  if (codigo === '') return null;
  const valor = Math.max(0, Math.round(minor));
  const enteros = Math.floor(valor / 100);
  const resto = String(valor % 100).padStart(2, '0');
  const simbolo = SIMBOLOS[codigo] ?? '';
  const cifra = `${simbolo}${simbolo ? ' ' : ''}${enteros}.${resto}`.trim();
  return `${cifra} ${codigo}`;
}

/**
 * Un importe que SÍ se conoce —el bruto, lo retenido, lo transferido—.
 *
 * Sin moneda es `sinVentas`: no hay nada registrado, y un «0,00» ahí diría que
 * se vendió y no se recaudó.
 */
export function cifraDeImporte(
  minor: number | null | undefined,
  moneda: string | null | undefined,
): Cifra {
  const texto = importeConMoneda(minor, moneda);
  if (texto === null) return { estado: 'sinVentas' };
  return { estado: 'cifra', texto };
}

/**
 * Un importe que depende de la comisión: el de comisión y el neto.
 *
 * `comision_configurada: false` MANDA SOBRE EL NÚMERO, aunque llegara uno. Si
 * alguna vez el servidor mandara una cifra con la bandera en `false`, esa cifra
 * se calculó con una comisión que nadie decidió: no se escribe.
 */
export function cifraQueDependeDeLaComision(
  minor: number | null | undefined,
  moneda: string | null | undefined,
  comisionConfigurada: boolean,
): Cifra {
  if (!comisionConfigurada) return { estado: 'pendienteDeConfiguracion' };
  if (typeof minor !== 'number' || !Number.isFinite(minor)) {
    return { estado: 'pendienteDeConfiguracion' };
  }
  return cifraDeImporte(minor, moneda);
}

/** El bruto del resumen. Se enseña siempre que haya ventas. */
export function cifraDelBruto(resumen: ResumenFinanciero): Cifra {
  return cifraDeImporte(resumen.bruto_minor, resumen.currency);
}

/** La comisión. `pendienteDeConfiguracion` mientras nadie la decida. */
export function cifraDeLaComision(resumen: ResumenFinanciero): Cifra {
  return cifraQueDependeDeLaComision(
    resumen.comision_minor,
    resumen.currency,
    resumen.comision_configurada,
  );
}

/** El neto. Depende de la comisión igual que ella. */
export function cifraDelNeto(resumen: ResumenFinanciero): Cifra {
  return cifraQueDependeDeLaComision(
    resumen.neto_minor,
    resumen.currency,
    resumen.comision_configurada,
  );
}

/** La comisión de una línea de venta. Misma regla que la del resumen. */
export function cifraDeLaComisionDelSaldo(saldo: SaldoDeVenta): Cifra {
  return cifraQueDependeDeLaComision(
    saldo.platform_fee_minor,
    saldo.currency,
    saldo.platform_fee_minor !== null,
  );
}

/** El neto de una línea de venta. */
export function cifraDelNetoDelSaldo(saldo: SaldoDeVenta): Cifra {
  return cifraQueDependeDeLaComision(
    saldo.net_amount_minor,
    saldo.currency,
    saldo.net_amount_minor !== null,
  );
}

/**
 * Si el evento no tiene NINGUNA venta registrada.
 *
 * Es la moneda la que lo dice: el servidor la saca de los saldos, así que sin
 * saldos no hay moneda. Es un estado vacío, no un cero.
 */
export function sinVentas(resumen: ResumenFinanciero): boolean {
  return (resumen.currency ?? '').trim() === '' || resumen.ventas <= 0;
}

/* -------------------------------------------------------------------------- */
/* Por qué no se libera                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Los códigos que el servidor usa como `bloqueo` y como `motivos`.
 *
 * Son los de `finanzas.py`, ni uno más. Cualquier otro cae en «desconocido» y
 * la pantalla sigue en pie: un código nuevo del servidor no puede dejar a nadie
 * mirando `payout_account_not_ready` escrito tal cual.
 */
export const MOTIVOS_DE_BLOQUEO = [
  'fee_not_configured',
  'balance_not_pending',
  'organizer_missing',
  'payout_account_missing',
  'payout_account_not_ready',
  'hold_policy_not_configured',
  'hold_open',
  'reserve_held',
  'dispute_open',
  'aftersale_case_open',
] as const;
export type MotivoDeBloqueo = (typeof MOTIVOS_DE_BLOQUEO)[number];

/** La frase que explica el bloqueo. NUNCA el código crudo. */
export function claveDeBloqueo(codigo: string): ClaveDeTraduccion {
  return conocido(MOTIVOS_DE_BLOQUEO, codigo, 'finanzasEvento.bloqueo');
}

/** Qué hay que hacer con ese bloqueo, cuando hay algo que hacer. */
export function claveDeQueHacerConElBloqueo(codigo: string): ClaveDeTraduccion {
  return conocido(MOTIVOS_DE_BLOQUEO, codigo, 'finanzasEvento.bloqueoQueHacer');
}

/**
 * El motivo que manda, uno solo.
 *
 * El servidor decide cuál y en qué orden; aquí no se reordena ni se prioriza.
 * `null` cuando no hay ninguno, que es lo que significa que nada lo impide.
 */
export function motivoQueManda(motivos: readonly string[] | null | undefined): string | null {
  for (const motivo of motivos ?? []) {
    if (typeof motivo === 'string' && motivo.trim() !== '') return motivo.trim();
  }
  return null;
}

/** Los motivos del servidor, sin repetidos y en su orden. */
export function motivosVisibles(motivos: readonly string[] | null | undefined): string[] {
  const vistos = new Set<string>();
  const salida: string[] = [];
  for (const motivo of motivos ?? []) {
    if (typeof motivo !== 'string') continue;
    const limpio = motivo.trim();
    if (limpio === '' || vistos.has(limpio)) continue;
    vistos.add(limpio);
    salida.push(limpio);
  }
  return salida;
}

/** Si lo que frena el saldo es que nadie ha configurado la comisión. */
export function bloqueaLaComision(codigo: string | null | undefined): boolean {
  return codigo === 'fee_not_configured';
}

/* -------------------------------------------------------------------------- */
/* El estado de un saldo                                                       */
/* -------------------------------------------------------------------------- */

/** Los estados que `OwnerSaleBalance` puede tener. */
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

export function claveDelEstadoDeSaldo(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_SALDO, estado, 'finanzasEvento.estadoSaldo');
}

/** El color del estado. Solo lo transferido está terminado. */
export function tonoDelEstadoDeSaldo(estado: string): 'bueno' | 'malo' | 'espera' | 'neutro' {
  if (estado === 'transferred') return 'bueno';
  if (estado === 'failed' || estado === 'cancelled') return 'malo';
  if (estado === 'pending' || estado === 'frozen' || estado === 'transferring') {
    return 'espera';
  }
  return 'neutro';
}

/**
 * Si ese saldo tiene dinero retenido por una reserva viva.
 *
 * `reserved_minor` puede llegar en cero y eso NO es una reserva pequeña: es que
 * no hay ninguna.
 */
export function tieneReserva(saldo: SaldoDeVenta): boolean {
  return Number.isFinite(saldo.reserved_minor) && saldo.reserved_minor > 0;
}

/* -------------------------------------------------------------------------- */
/* Conciliación                                                               */
/* -------------------------------------------------------------------------- */

/** Los códigos de `conciliacion.py`. Conciliar REPORTA, no corrige. */
export const CODIGOS_DE_HALLAZGO = [
  'paid_order_without_tickets',
  'ticket_without_payment',
  'paid_order_without_balance',
  'balance_without_order',
  'duplicate_balance',
  'amount_mismatch',
  'currency_mismatch',
  'event_mismatch',
  'environment_mismatch',
  'transferred_with_reserve',
] as const;
export type CodigoDeHallazgo = (typeof CODIGOS_DE_HALLAZGO)[number];

export function claveDeHallazgo(codigo: string): ClaveDeTraduccion {
  return conocido(CODIGOS_DE_HALLAZGO, codigo, 'finanzasEvento.hallazgo');
}

/** Un código agrupado, con cuántas veces salió y algún identificador. */
export type GrupoDeHallazgos = {
  codigo: string;
  cuantos: number;
  /** Los primeros, para poder ir a mirarlos. No son todos. */
  ejemplos: string[];
};

/** Cuántos ejemplos se guardan por código. Enseñar cien no ayuda a nadie. */
export const EJEMPLOS_POR_CODIGO = 3;

/**
 * Los hallazgos agrupados por código, del más repetido al que menos.
 *
 * SE AGRUPAN, NO SE SUMAN IMPORTES. Un hallazgo dice que dos cifras no cuadran,
 * no cuánto falta; sumar «diferencias» produciría un número que no existe.
 * Los códigos desconocidos se cuentan igual: un panel que se los come diría que
 * todo cuadra.
 */
export function agruparHallazgos(
  hallazgos: readonly Hallazgo[] | null | undefined,
): GrupoDeHallazgos[] {
  const porCodigo = new Map<string, GrupoDeHallazgos>();
  for (const hallazgo of hallazgos ?? []) {
    const codigo = (hallazgo?.codigo ?? '').trim();
    if (codigo === '') continue;
    const grupo = porCodigo.get(codigo) ?? { codigo, cuantos: 0, ejemplos: [] };
    grupo.cuantos += 1;
    if (grupo.ejemplos.length < EJEMPLOS_POR_CODIGO && hallazgo.id) {
      grupo.ejemplos.push(hallazgo.id);
    }
    porCodigo.set(codigo, grupo);
  }
  return [...porCodigo.values()].sort(
    (a, b) => b.cuantos - a.cuantos || a.codigo.localeCompare(b.codigo),
  );
}

/* -------------------------------------------------------------------------- */
/* Salud                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Los contadores que `conciliacion.salud` puede mandar, en el orden en que se
 * leen: primero lo vendido, después dónde está el dinero, al final lo abierto.
 */
export const CONTADORES_DE_SALUD = [
  'pedidos_pagados',
  'entradas_vivas',
  'saldos_pending',
  'saldos_frozen',
  'saldos_eligible',
  'saldos_transferring',
  'saldos_transferred',
  'saldos_sin_fecha',
  'reservas_vivas',
  'disputas_abiertas',
  'expedientes_abiertos',
] as const;

export function claveDeContador(clave: string): ClaveDeTraduccion {
  return conocido(CONTADORES_DE_SALUD, clave, 'finanzasEvento.contador');
}

/** Una fila del panel: la clave del servidor y su número. */
export type FilaDeSalud = { clave: string; valor: number; conocido: boolean };

/**
 * Si el esquema de pedidos todavía no está en esta base.
 *
 * `salud` contesta `{"disponible": 0}` y nada más. Eso no es «cero pedidos»: es
 * que no hay dónde contarlos.
 */
export function saludNoDisponible(salud: Record<string, unknown> | null | undefined): boolean {
  if (!salud) return true;
  return Number(salud.disponible ?? 0) !== 1;
}

/**
 * Los contadores, en el orden conocido y con los nuevos al final.
 *
 * `disponible` no es un contador: es la bandera de si hay algo que contar, y
 * pintarla como «disponible: 1» no le dice nada a nadie. Un contador que el
 * servidor añada mañana se enseña igual, con su clave dentro de una frase
 * traducida, en vez de desaparecer del panel.
 */
export function filasDeSalud(
  salud: Record<string, unknown> | null | undefined,
): FilaDeSalud[] {
  if (!salud) return [];
  const filas: FilaDeSalud[] = [];
  const puesto = new Set<string>();
  for (const clave of CONTADORES_DE_SALUD) {
    const valor = salud[clave];
    if (typeof valor !== 'number' || !Number.isFinite(valor)) continue;
    filas.push({ clave, valor, conocido: true });
    puesto.add(clave);
  }
  for (const [clave, valor] of Object.entries(salud)) {
    if (clave === 'disponible' || puesto.has(clave)) continue;
    if (typeof valor !== 'number' || !Number.isFinite(valor)) continue;
    filas.push({ clave, valor, conocido: false });
  }
  return filas;
}

/**
 * Los contadores que valen la pena mirar hoy: lo que está esperando algo.
 *
 * NO SON ALARMAS. Ninguno tiene umbral porque nadie ha decidido ninguno:
 * simplemente son los números que significan «algo está parado».
 */
export const CONTADORES_QUE_ESPERAN = [
  'saldos_sin_fecha',
  'reservas_vivas',
  'disputas_abiertas',
  'expedientes_abiertos',
] as const;

export function esperaAlgo(clave: string): boolean {
  return (CONTADORES_QUE_ESPERAN as readonly string[]).includes(clave);
}

/* -------------------------------------------------------------------------- */
/* Disputas                                                                    */
/* -------------------------------------------------------------------------- */

/** Los estados que la base admite para una disputa. */
export const ESTADOS_DE_DISPUTA = [
  'open',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'closed',
] as const;
export type EstadoDeDisputa = (typeof ESTADOS_DE_DISPUTA)[number];

/** Las que siguen vivas, según `finanzas.py`. */
export const DISPUTAS_VIVAS = ['open', 'needs_response', 'under_review'] as const;

export function claveDelEstadoDeDisputa(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_DISPUTA, estado, 'finanzasEvento.disputa');
}

export function disputaViva(estado: string): boolean {
  return (DISPUTAS_VIVAS as readonly string[]).includes(estado);
}

/**
 * Si queda plazo para mandar pruebas, mirado contra un momento dado.
 *
 * NO SE INVENTA NINGÚN PLAZO: si el servidor no manda `evidence_due_at`, no hay
 * fecha y no se dice nada sobre ella. `null` es «no se sabe», que es distinto
 * de «se pasó».
 */
export function plazoDePruebasVencido(
  vence: string | null | undefined,
  ahora: Date = new Date(),
): boolean | null {
  if (!vence) return null;
  const momento = new Date(vence);
  if (Number.isNaN(momento.getTime())) return null;
  return momento.getTime() < ahora.getTime();
}

/* -------------------------------------------------------------------------- */
/* Soltar una reserva                                                          */
/* -------------------------------------------------------------------------- */

/** `SoltarReservaRequest.motivo`: `min_length=3`, `max_length=500`. */
export const LARGO_MINIMO_DEL_MOTIVO = 3;
export const LARGO_MAXIMO_DEL_MOTIVO = 500;

/** Lo que hay escrito en el motivo de soltar, leído. */
export type MotivoLeido =
  | { ok: true; motivo: string }
  | { ok: false; falta: 'vacio' | 'corto' };

/**
 * El motivo que SÍ se puede mandar.
 *
 * OBLIGATORIO Y AUDITABLE. Una retención que se levanta sin motivo escrito no
 * se puede revisar después, y el servidor lo rechaza con un 422 sobre un texto
 * que alguien ya había escrito. Se recorta aquí al tope de ese campo.
 */
export function leerMotivoDeSoltar(texto: string | null | undefined): MotivoLeido {
  const limpio = (texto ?? '').trim();
  if (limpio === '') return { ok: false, falta: 'vacio' };
  if (limpio.length < LARGO_MINIMO_DEL_MOTIVO) return { ok: false, falta: 'corto' };
  return { ok: true, motivo: limpio.slice(0, LARGO_MAXIMO_DEL_MOTIVO) };
}

/**
 * Qué se le advierte a quien suelta, según marque «consumida» o no.
 *
 * NINGUNA DE LAS DOS MUEVE DINERO, y las dos lo dicen. La diferencia es lo que
 * se anota: que el dinero vuelve a estar disponible, o que ya se fue y no
 * vuelve.
 */
export function claveDelAvisoDeSoltar(consumida: boolean): ClaveDeTraduccion {
  return consumida
    ? 'finanzasEvento.soltarConsumidaAviso'
    : 'finanzasEvento.soltarLiberadaAviso';
}

/* -------------------------------------------------------------------------- */
/* Transferencias                                                              */
/* -------------------------------------------------------------------------- */

/** Los bloqueos que `transfers/run` puede devolver hoy. */
export const BLOQUEOS_DE_TRANSFERENCIA = [
  'transfers_disabled',
  'connect_disabled',
  'fee_not_configured',
] as const;

export function claveDeBloqueoDeTransferencia(codigo: string): ClaveDeTraduccion {
  return conocido(
    BLOQUEOS_DE_TRANSFERENCIA,
    codigo,
    'finanzasEvento.bloqueoTransferencia',
  );
}

/**
 * Si esa ejecución no movió nada.
 *
 * HOY SIEMPRE ES `true`: las banderas están apagadas y la comisión sin
 * configurar. La pantalla lo enseña tal cual; no hay ningún botón que prometa
 * pagar.
 */
export function nadaSeMovio(resultado: ResultadoDeTransferencias | null | undefined): boolean {
  if (!resultado) return true;
  return !Number.isFinite(resultado.ejecutadas) || resultado.ejecutadas <= 0;
}

/* -------------------------------------------------------------------------- */
/* Errores                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * El 503 de `FinanzasNoDisponibles`.
 *
 * NO ES UN ERROR: la migración de finanzas todavía no está aplicada en esta
 * base. Se dice «todavía no está disponible», no «algo falló», y no se ofrece
 * reintentar como si el siguiente toque fuera a cambiarlo.
 */
export function esFinanzasNoDisponible(codigo: string | null | undefined): boolean {
  return codigo === 'event_finance_not_available';
}

/** Los códigos de error que tienen texto propio aquí. `null` si no se conoce. */
export function claveDeErrorFinanciero(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const conocidos: Record<string, string> = {
    event_finance_not_available: 'finanzasEvento.noDisponibleCuerpo',
  };
  if (typeof codigo !== 'string') return null;
  return conocidos[codigo] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Los topes de las listas                                                     */
/* -------------------------------------------------------------------------- */

/**
 * El servidor no pagina NINGUNA de estas listas: acepta `limit` y no manda
 * cursor. Se sube el tope, se dice cuál es, y no se finge un «cargar más».
 */
export const LIMITES = [50, 100, 200] as const;
export const LIMITE_INICIAL = LIMITES[0];

/** El siguiente tope, o `null` si ya estamos en el máximo del servidor. */
export function siguienteLimite(actual: number): number | null {
  for (const limite of LIMITES) {
    if (limite > actual) return limite;
  }
  return null;
}

/** Tantos resultados como el tope significa que puede haber más. */
export function llegoAlTope(cuantos: number, limite: number): boolean {
  return cuantos >= limite;
}

/** Cuántas filas mira la conciliación. `le=1000` en el servidor. */
export const LIMITE_DE_CONCILIACION = 200;
