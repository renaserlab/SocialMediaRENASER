/**
 * Las políticas de evento MIRADAS DESDE FUERA: supervisión y trazabilidad.
 *
 * SUPERVISAR NO ES APROBAR, y es la regla que ordena todo este módulo. Aquí no
 * hay ningún paso de visto bueno previo: quien organiza publica sus condiciones
 * y la empresa las mira, las compara y encuentra quién no tiene ninguna. El
 * servidor tampoco tiene otra cosa —`/admin/events/policies/overview`,
 * `/missing` y `/{id}` son las tres rutas, y las tres son de lectura—, así que
 * ni siquiera se podría inventar un botón que aprobara algo.
 *
 * LO PUBLICADO NO SE REESCRIBE. Una versión aceptada es lo que aceptaron las
 * compras de su momento; cambiar una regla es publicar otra versión. Por eso no
 * existe aquí ninguna función que edite o borre: no es que esté deshabilitada,
 * es que no está.
 *
 * LO QUE DE VERDAD IMPORTA MIRAR es la lista de eventos publicados SIN política
 * propia de elegibilidad: son eventos vendiendo sin condiciones escritas. Una
 * lista vacía ahí es una buena noticia y tiene que poder distinguirse de un
 * fallo al pedirla, que no dice nada. `estadoDeLaLista` existe para que la
 * pantalla no pueda confundirlas.
 *
 * `0` NO ES UN HUECO. Un `refund_bps` de cero es una decisión publicada —«no se
 * devuelve nada»— y se enseña como «0 %». Enseñarlo como «sin definir» diría
 * que nadie lo decidió, que es justo lo contrario. El hueco es `null`, y
 * `params` vacío es «no decide nada todavía».
 */

/** Una clave del diccionario. Se escribe `string` porque `@/i18n` no se puede
 * importar aquí; la pantalla la convierte al traducir. */
export type ClaveDeTraduccion = string;

/** Una política tal como la manda `PoliticaRead`. Fechas en ISO. */
export type PoliticaSupervisada = {
  id: string;
  event_id: string | null;
  policy_type: string;
  version: string;
  /** `draft`, `published` o `superseded`. */
  status: string;
  params: Record<string, unknown>;
  /** El texto que lee quien compra. `null` = no se escribió ninguno. */
  body: string | null;
  /** La huella de los parámetros: lo que hace demostrable qué se publicó. */
  params_sha256: string;
  published_at: string | null;
  /** Identificador interno. Referencia para investigar, no un nombre. */
  published_by: string | null;
  created_by: string | null;
  effective_from: string | null;
  effective_to: string | null;
  created_at: string;
};

/** Un evento publicado que no tiene condiciones escritas. */
export type EventoSinPolitica = {
  event_id: string;
  title: string | null;
  organizer_id: string | null;
};

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/* -------------------------------------------------------------------------- */
/* Tipos y estados                                                             */
/* -------------------------------------------------------------------------- */

/** Los tres estados de la tabla. `published` no significa «aprobada por Z». */
export const ESTADOS_DE_POLITICA = ['draft', 'published', 'superseded'] as const;
export type EstadoDePolitica = (typeof ESTADOS_DE_POLITICA)[number];

export function claveDelEstadoDePolitica(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_POLITICA, estado, 'politicasAdmin.estado');
}

/** Todos los tipos que la base admite (`TIPOS_DE_POLITICA` del servidor). */
export const TIPOS_DE_POLITICA = [
  'aftersale_eligibility',
  'refund_execution',
  'ticket_effect',
  'review_window',
  'organizer_reply',
  'settlement_hold',
  'settlement_reserve',
  'dispute_liability',
  'negative_balance',
] as const;
export type TipoDePolitica = (typeof TIPOS_DE_POLITICA)[number];

export function claveDelTipoDePolitica(tipo: string): ClaveDeTraduccion {
  return conocido(TIPOS_DE_POLITICA, tipo, 'politicasAdmin.tipo');
}

/** La que decide si se puede pedir un cambio o una devolución. */
export const POLITICA_ELEGIBILIDAD = 'aftersale_eligibility';

/**
 * Lo que decide quien organiza: lo que le PROMETE a quien compra.
 *
 * El resto —ejecución del reembolso, retenciones, reservas, disputas, saldo
 * negativo— es dinero de la plataforma y lo escribe la empresa. Se distingue
 * para poder decir de quién es cada regla, no para habilitar nada.
 */
export const TIPOS_DEL_ORGANIZADOR = ['aftersale_eligibility', 'ticket_effect'] as const;

export function loEscribeElOrganizador(tipo: string): boolean {
  return (TIPOS_DEL_ORGANIZADOR as readonly string[]).includes(tipo);
}

/** Publicada y sin fecha de fin: es la que rige hoy. */
export function estaVigente(politica: {
  status: string;
  effective_to?: string | null;
}): boolean {
  return politica.status === 'published' && (politica.effective_to ?? null) === null;
}

/** El tono con el que se pinta el estado. Ninguno es «aprobado». */
export function tonoDelEstado(estado: string): 'vigente' | 'espera' | 'historico' | 'neutro' {
  if (estado === 'published') return 'vigente';
  if (estado === 'draft') return 'espera';
  if (estado === 'superseded') return 'historico';
  return 'neutro';
}

/* -------------------------------------------------------------------------- */
/* La huella y los identificadores internos                                    */
/* -------------------------------------------------------------------------- */

/** Lo que se enseña de un sha256: bastante para reconocerlo, no una pared. */
export const LARGO_DE_LA_HUELLA = 12;
/** Lo que se enseña de un identificador interno: sirve para buscarlo. */
export const LARGO_DE_LA_REFERENCIA = 8;

/**
 * La huella, abreviada. `null` cuando no hay ninguna.
 *
 * SE ENSEÑA porque es lo que hace demostrable qué se publicó: dos versiones con
 * la misma huella tienen exactamente los mismos parámetros. Es una referencia
 * técnica, no un dato de nadie.
 */
export function huellaAbreviada(
  sha: string | null | undefined,
  largo: number = LARGO_DE_LA_HUELLA,
): string | null {
  const limpio = (sha ?? '').trim().toLowerCase();
  if (limpio === '') return null;
  return limpio.slice(0, Math.max(1, largo));
}

/**
 * Un identificador interno, abreviado. `null` cuando no hay ninguno.
 *
 * `published_by` y `created_by` son UUID de perfil y el contrato NO trae ningún
 * nombre. Se enseñan abreviados para poder investigar quién publicó qué; no se
 * inventa una persona a partir de un identificador.
 */
export function referenciaAbreviada(
  id: string | null | undefined,
  largo: number = LARGO_DE_LA_REFERENCIA,
): string | null {
  const limpio = (id ?? '').trim();
  if (limpio === '') return null;
  return limpio.slice(0, Math.max(1, largo));
}

/**
 * Si dos políticas publicaron exactamente los mismos parámetros.
 *
 * Sin huella en alguno de los dos es `false`: «no lo sé» no es «son iguales».
 */
export function mismaHuella(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const uno = (a ?? '').trim().toLowerCase();
  const otro = (b ?? '').trim().toLowerCase();
  if (uno === '' || otro === '') return false;
  return uno === otro;
}

/* -------------------------------------------------------------------------- */
/* Los parámetros, legibles                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cómo se dice un valor.
 *
 * `texto` ya está formateado; `clave` lleva una frase del diccionario porque la
 * unidad y el sí/no se escriben distinto en cada idioma.
 */
export type ValorDeParametro =
  | { forma: 'texto'; texto: string }
  | {
      forma: 'clave';
      clave: ClaveDeTraduccion;
      params?: Record<string, string | number>;
    };

export type FilaDeParametro = {
  /** La clave CRUDA, siempre. Es lo que se enseña si no la conocemos. */
  clave: string;
  /** La clave de traducción del nombre, o `null` si no la conocemos. */
  etiqueta: ClaveDeTraduccion | null;
  valor: ValorDeParametro;
};

/**
 * Las claves que el servidor nombra (`CLAVES_CON_SENTIDO`).
 *
 * Es una lista corta a propósito: cualquier otra se enseña cruda. Una clave
 * nueva en el servidor tiene que APARECER en la pantalla sin traducir, no
 * desaparecer ni romperla.
 */
export const PARAMETROS_CONOCIDOS = [
  'window_hours_before_event',
  'days_after_event',
  'refund_bps',
  'cancelled_event_bps',
  'allow_buyer_cancellation',
  'allow_exchange',
  'revoke_on_refund',
  'revoke_on_partial_refund',
  'hold_on_dispute',
  'restore_on_rejected_refund',
] as const;

/** La clave de traducción del nombre del parámetro, o `null` si no la hay. */
export function claveDelParametro(clave: string): ClaveDeTraduccion | null {
  return (PARAMETROS_CONOCIDOS as readonly string[]).includes(clave)
    ? `politicasAdmin.param.${clave}`
    : null;
}

export type UnidadDeParametro = 'porcentaje' | 'horas' | 'dias' | null;

/** Las unidades que no se deducen del nombre. `window_hours_before_event` no
 * acaba en `_hours`, y aun así son horas. */
const UNIDAD_POR_CLAVE: Record<string, UnidadDeParametro> = {
  window_hours_before_event: 'horas',
  days_after_event: 'dias',
  refund_bps: 'porcentaje',
  cancelled_event_bps: 'porcentaje',
};

/**
 * En qué se mide este parámetro.
 *
 * Primero lo que sabemos del nombre exacto; después el sufijo, que es lo único
 * que se puede deducir de una clave que todavía no conocemos.
 */
export function unidadDelParametro(clave: string): UnidadDeParametro {
  const fija = UNIDAD_POR_CLAVE[clave];
  if (fija !== undefined) return fija;
  if (clave.endsWith('_bps')) return 'porcentaje';
  if (clave.endsWith('_hours')) return 'horas';
  if (clave.endsWith('_days')) return 'dias';
  return null;
}

/**
 * Puntos básicos a porcentaje. 10000 = «100 %».
 *
 * `0` SE ESCRIBE «0 %». Es una decisión publicada —no se devuelve nada— y
 * contarla como hueco diría que nadie la tomó.
 */
export function porcentajeDesdeBps(bps: number): string {
  const valor = Math.round((bps / 100) * 100) / 100;
  return `${String(valor === 0 ? 0 : valor)} %`;
}

/** Un volcado corto de lo que no es un número, un texto ni un booleano. */
function volcadoSeguro(valor: unknown, maximo = 200): string | null {
  try {
    const texto = JSON.stringify(valor);
    if (typeof texto !== 'string' || texto === '') return null;
    return texto.length > maximo ? `${texto.slice(0, maximo)}…` : texto;
  } catch {
    // Una estructura cíclica no puede tumbar la pantalla.
    return null;
  }
}

/**
 * Cómo se dice ESTE valor.
 *
 * Ninguna forma de valor puede romper nada: un objeto se vuelca, una estructura
 * imposible de volcar se nombra, y lo que no llegó se dice «sin definir».
 */
export function valorDeParametro(clave: string, valor: unknown): ValorDeParametro {
  if (valor === null || valor === undefined) {
    return { forma: 'clave', clave: 'politicasAdmin.valor.sinDefinir' };
  }
  if (typeof valor === 'boolean') {
    return {
      forma: 'clave',
      clave: valor ? 'politicasAdmin.valor.si' : 'politicasAdmin.valor.no',
    };
  }
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) return { forma: 'texto', texto: String(valor) };
    const unidad = unidadDelParametro(clave);
    if (unidad === 'porcentaje') {
      return { forma: 'texto', texto: porcentajeDesdeBps(valor) };
    }
    if (unidad === 'horas') {
      return { forma: 'clave', clave: 'politicasAdmin.valor.horas', params: { n: valor } };
    }
    if (unidad === 'dias') {
      return { forma: 'clave', clave: 'politicasAdmin.valor.dias', params: { n: valor } };
    }
    return { forma: 'texto', texto: String(valor) };
  }
  if (typeof valor === 'string') {
    const limpio = valor.trim();
    if (limpio === '') return { forma: 'clave', clave: 'politicasAdmin.valor.vacio' };
    // Un número escrito como texto sigue siendo ese número: JSON no distingue.
    if (unidadDelParametro(clave) !== null && /^-?\d+(\.\d+)?$/.test(limpio)) {
      return valorDeParametro(clave, Number(limpio));
    }
    return { forma: 'texto', texto: limpio };
  }
  const volcado = volcadoSeguro(valor);
  if (volcado === null) {
    return { forma: 'clave', clave: 'politicasAdmin.valor.noLegible' };
  }
  return { forma: 'texto', texto: volcado };
}

/** Lo conocido primero y en su orden; lo demás detrás, alfabético. */
function ordenDeParametros(a: string, b: string): number {
  const lista = PARAMETROS_CONOCIDOS as readonly string[];
  const uno = lista.indexOf(a);
  const otro = lista.indexOf(b);
  if (uno >= 0 && otro >= 0) return uno - otro;
  if (uno >= 0) return -1;
  if (otro >= 0) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Los parámetros, uno por fila y legibles.
 *
 * UNA CLAVE DESCONOCIDA SE ENSEÑA CRUDA. Ocultarla escondería una regla que el
 * servidor sí aplica, y romper la pantalla por no reconocerla sería peor.
 */
export function filasDeParametros(
  params: Record<string, unknown> | null | undefined,
): FilaDeParametro[] {
  if (params === null || params === undefined || typeof params !== 'object') return [];
  return Object.keys(params)
    .sort(ordenDeParametros)
    .map((clave) => ({
      clave,
      etiqueta: claveDelParametro(clave),
      valor: valorDeParametro(clave, (params as Record<string, unknown>)[clave]),
    }));
}

/**
 * Si esta política no decide nada todavía.
 *
 * `{}` NO es «todo en cero»: es que no hay ninguna regla escrita. Son cosas
 * distintas y se leen distinto.
 */
export function noDecideNada(params: Record<string, unknown> | null | undefined): boolean {
  if (params === null || params === undefined || typeof params !== 'object') return true;
  return Object.keys(params).length === 0;
}

/* -------------------------------------------------------------------------- */
/* Comparar dos versiones                                                      */
/* -------------------------------------------------------------------------- */

export type CambioDeParametro = 'igual' | 'distinto' | 'anadido' | 'quitado';

export type FilaDeComparacion = {
  clave: string;
  etiqueta: ClaveDeTraduccion | null;
  cambio: CambioDeParametro;
  antes: ValorDeParametro | null;
  ahora: ValorDeParametro | null;
};

function mismoValor(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const uno = volcadoSeguro(a, 4000);
  const otro = volcadoSeguro(b, 4000);
  if (uno === null || otro === null) return false;
  return uno === otro;
}

/**
 * Qué cambió entre dos versiones del mismo tipo.
 *
 * Es para LEER la historia, no para editarla: las dos versiones existen y
 * ninguna de las dos se toca. Un parámetro que desapareció se dice «quitado»,
 * no se pinta como un cero.
 */
export function compararParametros(
  antes: Record<string, unknown> | null | undefined,
  ahora: Record<string, unknown> | null | undefined,
): FilaDeComparacion[] {
  const viejos = antes ?? {};
  const nuevos = ahora ?? {};
  const claves = [...new Set([...Object.keys(viejos), ...Object.keys(nuevos)])].sort(
    ordenDeParametros,
  );
  return claves.map((clave) => {
    const estabaAntes = Object.prototype.hasOwnProperty.call(viejos, clave);
    const estaAhora = Object.prototype.hasOwnProperty.call(nuevos, clave);
    const cambio: CambioDeParametro = !estabaAntes
      ? 'anadido'
      : !estaAhora
        ? 'quitado'
        : mismoValor(viejos[clave], nuevos[clave])
          ? 'igual'
          : 'distinto';
    return {
      clave,
      etiqueta: claveDelParametro(clave),
      cambio,
      antes: estabaAntes ? valorDeParametro(clave, viejos[clave]) : null,
      ahora: estaAhora ? valorDeParametro(clave, nuevos[clave]) : null,
    };
  });
}

/** Solo lo que se movió. Una lista de «iguales» no cuenta ninguna historia. */
export function soloLosCambios(filas: FilaDeComparacion[]): FilaDeComparacion[] {
  return filas.filter((fila) => fila.cambio !== 'igual');
}

export function claveDelCambio(cambio: string): ClaveDeTraduccion {
  return conocido(
    ['igual', 'distinto', 'anadido', 'quitado'],
    cambio,
    'politicasAdmin.cambio',
  );
}

/* -------------------------------------------------------------------------- */
/* Agrupar y ordenar                                                           */
/* -------------------------------------------------------------------------- */

export type GrupoDeEvento = {
  eventoId: string | null;
  politicas: PoliticaSupervisada[];
};

/** Las políticas de cada evento, en el orden en que llegaron. */
export function agruparPorEvento(politicas: PoliticaSupervisada[]): GrupoDeEvento[] {
  const grupos: GrupoDeEvento[] = [];
  const indice = new Map<string, number>();
  for (const politica of politicas) {
    const eventoId = politica.event_id ?? null;
    const llave = eventoId ?? ' global';
    const donde = indice.get(llave);
    if (donde === undefined) {
      indice.set(llave, grupos.length);
      grupos.push({ eventoId, politicas: [politica] });
    } else {
      grupos[donde]?.politicas.push(politica);
    }
  }
  return grupos;
}

export type GrupoDeOrganizador = {
  organizadorId: string | null;
  eventos: EventoSinPolitica[];
};

/**
 * Los eventos sin política, por organizador.
 *
 * Agrupar es lo que convierte una lista larga en un dato: cinco eventos de un
 * mismo organizador es una conversación con esa persona, no cinco incidencias.
 */
export function agruparPorOrganizador(
  eventos: EventoSinPolitica[],
): GrupoDeOrganizador[] {
  const grupos: GrupoDeOrganizador[] = [];
  const indice = new Map<string, number>();
  for (const evento of eventos) {
    const organizadorId = evento.organizer_id ?? null;
    const llave = organizadorId ?? ' sinOrganizador';
    const donde = indice.get(llave);
    if (donde === undefined) {
      indice.set(llave, grupos.length);
      grupos.push({ organizadorId, eventos: [evento] });
    } else {
      grupos[donde]?.eventos.push(evento);
    }
  }
  return grupos;
}

/** Cuántos eventos distintos están vendiendo sin condiciones escritas. */
export function contarEventosSinPolitica(eventos: EventoSinPolitica[]): number {
  return new Set(eventos.map((evento) => evento.event_id)).size;
}

/** A cuántos organizadores hay que hablarles. Los sin organizador cuentan uno. */
export function contarOrganizadoresSinPolitica(eventos: EventoSinPolitica[]): number {
  return new Set(eventos.map((evento) => evento.organizer_id ?? ' sinOrganizador'))
    .size;
}

function momento(iso: string | null | undefined): number {
  if (typeof iso !== 'string' || iso.trim() === '') return Number.NaN;
  const fecha = new Date(iso);
  const valor = fecha.getTime();
  return Number.isNaN(valor) ? Number.NaN : valor;
}

/**
 * De la más reciente a la más vieja. Lo que no trae fecha legible NO se
 * adelanta: se queda donde estaba, detrás de lo fechado.
 */
export function ordenarPorCreacion(
  politicas: PoliticaSupervisada[],
): PoliticaSupervisada[] {
  return [...politicas]
    .map((politica, posicion) => ({ politica, posicion }))
    .sort((a, b) => {
      const unoIso = momento(a.politica.created_at);
      const otroIso = momento(b.politica.created_at);
      const uno = Number.isNaN(unoIso) ? null : unoIso;
      const otro = Number.isNaN(otroIso) ? null : otroIso;
      if (uno !== null && otro !== null && uno !== otro) return otro - uno;
      if (uno !== null && otro === null) return -1;
      if (uno === null && otro !== null) return 1;
      return a.posicion - b.posicion;
    })
    .map((fila) => fila.politica);
}

/** Las versiones del mismo evento y el mismo tipo, de la nueva a la vieja. */
export function versionesDelMismoTipo(
  politicas: PoliticaSupervisada[],
  referencia: { event_id: string | null; policy_type: string },
): PoliticaSupervisada[] {
  return ordenarPorCreacion(
    politicas.filter(
      (politica) =>
        (politica.event_id ?? null) === (referencia.event_id ?? null) &&
        politica.policy_type === referencia.policy_type,
    ),
  );
}

/**
 * La versión inmediatamente anterior a esta, si está en lo que se pidió.
 *
 * `null` no significa «es la primera»: puede ser que la anterior no entrara en
 * el tope. La pantalla lo dice así.
 */
export function versionAnterior(
  politicas: PoliticaSupervisada[],
  politica: PoliticaSupervisada,
): PoliticaSupervisada | null {
  const todas = versionesDelMismoTipo(politicas, politica);
  const donde = todas.findIndex((otra) => otra.id === politica.id);
  if (donde < 0) return null;
  return todas[donde + 1] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Los filtros                                                                 */
/* -------------------------------------------------------------------------- */

/** El tope del servidor: `limit` es `ge=1, le=200`. */
export const LIMITE_DEL_SERVIDOR = 200;
export const LIMITES = [50, 100, 200] as const;
export const LIMITE_INICIAL = LIMITES[0];

/** El siguiente tope, o `null` si ya estamos en el máximo del servidor. */
export function siguienteLimite(actual: number): number | null {
  for (const limite of LIMITES) {
    if (limite > actual) return limite;
  }
  return null;
}

/**
 * Si lo que se ve podría no ser todo.
 *
 * Tantas filas como el tope significa que el corte lo puso el `limit` y no la
 * realidad: es cuando hay que avisar de que se filtre.
 */
export function llegoAlTope(cuantos: number, limite: number): boolean {
  return cuantos >= limite;
}

/** Lo escrito a mano, listo para filtrar, o `null` si no hay nada escrito. */
export function textoDeFiltro(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  return limpio === '' ? null : limpio;
}

/** Un `limit` que el servidor va a aceptar. Fuera de rango se recorta. */
export function limiteValido(limite: number | null | undefined): number {
  if (typeof limite !== 'number' || !Number.isFinite(limite)) return LIMITE_INICIAL;
  const entero = Math.trunc(limite);
  if (entero < 1) return 1;
  if (entero > LIMITE_DEL_SERVIDOR) return LIMITE_DEL_SERVIDOR;
  return entero;
}

export type FiltrosDePoliticas = {
  organizadorId?: string | null;
  eventoId?: string | null;
  tipo?: string | null;
  estado?: string | null;
  limite?: number | null;
};

/**
 * La cadena de consulta de `overview`, en un orden fijo.
 *
 * Lo vacío NO viaja: mandar `event_id=` filtra por un identificador que nadie
 * escribió. El orden es estable para que dos llamadas iguales se vean iguales.
 */
export function cadenaDeFiltros(filtros: FiltrosDePoliticas): string {
  const q = new URLSearchParams();
  const organizador = textoDeFiltro(filtros.organizadorId);
  const evento = textoDeFiltro(filtros.eventoId);
  const tipo = textoDeFiltro(filtros.tipo);
  const estado = textoDeFiltro(filtros.estado);
  if (organizador !== null) q.set('organizer_id', organizador);
  if (evento !== null) q.set('event_id', evento);
  if (tipo !== null) q.set('policy_type', tipo);
  if (estado !== null) q.set('estado', estado);
  q.set('limit', String(limiteValido(filtros.limite)));
  return q.toString();
}

/** Cuántos filtros están puestos. Para decir «no hay nada con estos filtros». */
export function cuantosFiltros(filtros: FiltrosDePoliticas): number {
  return [filtros.organizadorId, filtros.eventoId, filtros.tipo, filtros.estado].filter(
    (valor) => textoDeFiltro(valor) !== null,
  ).length;
}

/* -------------------------------------------------------------------------- */
/* Qué se está viendo                                                          */
/* -------------------------------------------------------------------------- */

/** Los cuatro desenlaces de una lectura. `vacio` NO es `error`. */
export type EstadoDeLaLista = 'cargando' | 'error' | 'vacio' | 'lleno';

/**
 * Qué enseñar: lo que se está esperando, lo que falló, lo que no hay y lo que
 * hay.
 *
 * VACÍO Y ERROR SON COSAS DISTINTAS, y en la pestaña de «sin política» son
 * opuestas: vacío es la buena noticia —nadie vende sin condiciones— y error es
 * que no sabemos nada. Contar una como la otra es lo que esta función impide.
 */
export function estadoDeLaLista(lectura: {
  cargando: boolean;
  fallo: string | null;
  filas: number;
}): EstadoDeLaLista {
  if (lectura.cargando) return 'cargando';
  if (lectura.fallo !== null) return 'error';
  return lectura.filas === 0 ? 'vacio' : 'lleno';
}

/** Las cuatro formas de no poder enseñar la lista. */
export const FALLOS = ['red', 'sinConexion', 'sinPermiso', 'noDisponible'] as const;
export type Fallo = (typeof FALLOS)[number];

/** El 503 de la posventa: la migración todavía no está aplicada. */
export function esSupervisionNoDisponible(codigo: string | null | undefined): boolean {
  return codigo === 'event_aftersale_not_available';
}

/** Sin red no es «falló el servidor», y se dice distinto. */
export function esFalloDeConexion(codigo: string | null | undefined): boolean {
  return codigo === 'network_error' || codigo === 'timeout';
}

/**
 * Qué clase de fallo fue.
 *
 * EL 403 TIENE SU PROPIO MENSAJE. Quien no administra tiene que leer que esta
 * pantalla no es suya, no un «no hay nada» que diría que no hay políticas.
 */
export function falloDesde(
  status: number | null | undefined,
  codigo: string | null | undefined,
): Fallo {
  if (esSupervisionNoDisponible(codigo)) return 'noDisponible';
  if (status === 403) return 'sinPermiso';
  if (esFalloDeConexion(codigo)) return 'sinConexion';
  return 'red';
}

/** El titular de cada fallo. */
export function claveDelFallo(fallo: string): ClaveDeTraduccion {
  return conocido(FALLOS, fallo, 'politicasAdmin.fallo');
}

/** La explicación de cada fallo. */
export function claveDelCuerpoDelFallo(fallo: string): ClaveDeTraduccion {
  return conocido(FALLOS, fallo, 'politicasAdmin.falloCuerpo');
}

/* -------------------------------------------------------------------------- */
/* Las dos pestañas                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `sinPolitica` VA PRIMERA. Es la pregunta que de verdad se supervisa: qué se
 * está vendiendo sin condiciones escritas.
 */
export const PESTANAS = ['sinPolitica', 'publicadas'] as const;
export type Pestana = (typeof PESTANAS)[number];
export const PESTANA_INICIAL = PESTANAS[0];

export function claveDeLaPestana(pestana: string): ClaveDeTraduccion {
  return conocido(PESTANAS, pestana, 'politicasAdmin.pestana');
}
