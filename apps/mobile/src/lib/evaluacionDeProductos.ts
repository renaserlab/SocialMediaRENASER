/**
 * Admitir y evaluar un producto: las reglas, sin React y sin red.
 *
 * LO PRIMERO, PORQUE ES LO QUE HACE QUE EL SELLO SIGNIFIQUE ALGO:
 *
 *   1. UNA PUNTUACIÓN CON CINCO DIMENSIONES NO ES UNA PUNTUACIÓN. `puntuacionPonderada`
 *      devuelve `null` mientras falte una, NUNCA cero: una ausencia leída como cero
 *      hundiría un producto bueno y leída como el máximo aprobaría uno que nadie miró.
 *   2. CADA DIMENSIÓN PUNTUADA NECESITA EVIDENCIA. Sin ella la nota es una opinión con
 *      forma de número, y `sePuedeDecidir` se niega.
 *   3. UNA FALLA CRÍTICA RECHAZA Y NO SE COMPENSA CON PUNTAJE. `combinacionImposible`
 *      existe para que nadie pueda pintar «aprobado» al lado de una falla.
 *   4. LAS TRES RAZONES SALEN DE LA EVIDENCIA REGISTRADA. Aquí no hay ninguna función
 *      que fabrique una razón a partir de texto libre: todas piden un `evidence_id`.
 *
 * LA MATRIZ ESTÁ TRANSCRITA DEL SERVIDOR, letra por letra y peso por peso
 * (`products/models.py: DIMENSIONES`), y los umbrales también
 * (`products/evaluations.py: APROBADO_DESDE`, `CONDICIONADO_DESDE`). Está copiada para
 * poder PREVISUALIZAR la decisión antes de pulsar, no para decidirla: quien decide es el
 * servidor, y cada evaluación viaja con su propia `matriz`.
 *
 * TODO VIAJA EN CENTÉSIMAS DE PUNTO: 9 000 son 90,00. `puntuacionLegible` es lo único
 * que pone una coma, y solo para leerla; ninguna función de este fichero produce un texto
 * con coma que se pueda mandar al servidor.
 *
 * NINGÚN PERMISO FINANCIERO. Aquí no hay saldos, ni transferencias, ni precios que se
 * puedan cambiar: evaluar un producto no mueve dinero, y no hay ni una función que lo
 * insinúe.
 *
 * `conditionally_approved` NO PUEDE PUBLICAR, y se dice con su propio texto en vez de
 * esconder el botón: las condiciones exactas son una decisión que la empresa no ha
 * tomado (`products/states.py`, cabecera).
 *
 * Sin importaciones entre ficheros en tiempo de ejecución: el ejecutor de pruebas de
 * Node no resuelve el alias `@/`.
 */

/** Una clave del diccionario. La convierte la pantalla al traducir. */
export type ClaveDeTraduccion = string;

/* -------------------------------------------------------------------------- */
/* El contrato: lo que entra y lo que sale                                     */
/* -------------------------------------------------------------------------- */

/** `PuntuacionRead`. `weight` viene CONGELADO de la fila, no de la matriz de hoy. */
export type PuntuacionRead = {
  dimension: string;
  /** De 0 a 100. */
  score: number;
  /** El peso con el que se puntuó. Es lo que hace explicable una decisión vieja. */
  weight: number;
  note: string | null;
};

/** `EvidenciaRead`. SOLO SE AÑADE: el servidor no publica ninguna ruta que la reescriba. */
export type EvidenciaRead = {
  id: string;
  dimension: string;
  kind: string;
  summary: string;
  /** La RUTA del almacenamiento, nunca una URL. */
  storage_path: string | null;
};

/** `RazonRead`: la razón CON de qué evidencia sale. */
export type RazonRead = {
  position: number;
  text: string;
  evidence_kind: string;
  evidence_dimension: string;
};

/** `EvaluacionRead`. */
export type EvaluacionRead = {
  id: string;
  product_id: string;
  version_id: string;
  evaluator_id: string;
  /** `draft` o `decided`. Una decidida no se reescribe. */
  status: string;
  /** EN CENTÉSIMAS. `null` mientras no se decide, y `null` no es cero. */
  score_total: number | null;
  decision: string | null;
  critical_failure: string | null;
  decided_at: string | null;
  scores: PuntuacionRead[];
  evidence: EvidenciaRead[];
  reasons: RazonRead[];
  /** Los pesos de ESTA evaluación, para que la pantalla no los copie. */
  matriz: Record<string, number>;
  /** Por qué todavía no se puede decidir, como CÓDIGO. `null` = se puede. */
  bloqueo: string | null;
  /** Qué falta exactamente: dimensiones sin puntuar, o sin evidencia. */
  faltan: string[];
};

/** `DocumentoRead`: una ruta o una nota, nunca los dos vacíos. */
export type DocumentoRead = {
  id: string;
  kind: string;
  storage_path: string | null;
  note: string | null;
  /** Enlace firmado de diez minutos para abrirlo (0085). */
  url?: string | null;
};

/** `PostulacionRead`. Las notas internas NO salen de aquí, a propósito. */
export type PostulacionRead = {
  id: string;
  status: string;
  display_name: string;
  proposal: string;
  submitted_at: string | null;
  decided_at: string | null;
  /** El motivo que se le ENSEÑA a quien postuló. */
  decision_reason: string | null;
  documents: DocumentoRead[];
};

export type MediaRead = {
  id: string;
  kind: string;
  storage_path: string;
  alt_text: string | null;
};

export type VarianteRead = {
  id: string;
  sku: string;
  name: string;
  options: Record<string, unknown>;
  price_delta_minor: number;
};

/** `VersionRead`. `price_minor` nulo es SIN PRECIO CONFIGURADO, no gratis. */
export type VersionRead = {
  id: string;
  version: string;
  status: string;
  name: string;
  summary: string | null;
  description: string | null;
  materials: string | null;
  origin_country: string | null;
  manufacturer: string | null;
  price_minor: number | null;
  currency: string | null;
  content_sha256: string;
  published_at: string | null;
  effective_to: string | null;
  variants: VarianteRead[];
  gallery: MediaRead[];
};

/** `ProductoDelProveedor`. */
export type ProductoDelProveedor = {
  id: string;
  status: string;
  category_id: string | null;
  published_at: string | null;
  suspension_reason: string | null;
  created_at: string;
  draft: VersionRead | null;
  published: VersionRead | null;
  /** Lo que ESTE actor puede hacer. Para pintar botones, no para decidir. */
  acciones: string[];
  /** Por qué todavía no se puede publicar, como CÓDIGO. `null` = se puede. */
  bloqueo: string | null;
};

/** `ProductoDeAdministracion`: el del proveedor, con quién lo vende. */
export type ProductoDeAdministracion = ProductoDelProveedor & {
  seller_id: string;
  seller_name: string;
  seller_profile_id: string;
};

/** `DecisionDePostulacion`. El motivo es obligatorio para rechazar. */
export type DecisionDePostulacion = {
  aceptar: boolean;
  motivo: string | null;
  notas: string | null;
};

/** `PuntuacionRequest`. `score` va de 0 a 100, ENTERO y sin coma. */
export type PuntuacionRequest = { score: number; note: string | null };

/** `EvidenciaRequest`. */
export type EvidenciaRequest = {
  dimension: string;
  kind: string;
  summary: string;
  storage_path: string | null;
};

/** `RazonRequest`: SIEMPRE con la evidencia de la que sale. */
export type RazonRequest = { evidence_id: string; text: string };

/** `RazonesRequest`: como mucho tres. */
export type RazonesRequest = { razones: RazonRequest[] };

/** `DecisionDeEvaluacion`. Lo único que se decide a mano es la falla crítica. */
export type DecisionDeEvaluacion = {
  critical_failure: string | null;
  notes: string | null;
};

/** `TransicionRequest`. */
export type TransicionRequest = { hasta: string; motivo: string | null };

/** `MotivoRequest`. */
export type MotivoRequest = { motivo: string | null };

/* -------------------------------------------------------------------------- */
/* Utilidades comunes                                                          */
/* -------------------------------------------------------------------------- */

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/**
 * Lo que llegue, leído como texto y recortado de los bordes.
 *
 * Un número, un objeto o un booleano del servidor no pueden tumbar una pantalla de
 * decisión: se leen como «no hay texto» en vez de lanzar.
 */
function limpiar(valor: unknown): string {
  return typeof valor === 'string' ? valor.trim() : '';
}

/** El texto que SÍ se puede mandar, recortado al tope. `null` si no hay nada. */
export function textoUtil(
  texto: string | null | undefined,
  maximo: number,
): string | null {
  const limpio = limpiar(texto);
  if (limpio === '') return null;
  return limpio.slice(0, Math.max(0, maximo));
}

/** Cuántos caracteres del identificador bastan para reconocerlo en la lista. */
export const LARGO_DE_LA_REFERENCIA = 8;

/**
 * El identificador, acortado para poder mencionarlo.
 *
 * NO ES UN NOMBRE. Es una referencia interna con la que investigar, y se enseña
 * como tal. `null` cuando no hay nada; nunca una cadena inventada.
 */
export function abreviarIdentificador(
  id: string | null | undefined,
  largo: number = LARGO_DE_LA_REFERENCIA,
): string | null {
  const limpio = limpiar(id);
  if (limpio === '') return null;
  const tope = Math.max(1, Math.trunc(largo));
  return limpio.length <= tope ? limpio : `${limpio.slice(0, tope)}…`;
}

/* -------------------------------------------------------------------------- */
/* La matriz del blueprint §5.2, transcrita                                    */
/* -------------------------------------------------------------------------- */

/**
 * Las SEIS dimensiones con su peso, en el orden del servidor.
 *
 * Copiadas de `products/models.py: DIMENSIONES`, letra por letra y peso por peso:
 * 25/20/20/15/10/10. Están aquí para PREVISUALIZAR la decisión antes de pulsar; la
 * decisión la escribe el servidor, y cada evaluación viaja con su propia `matriz` por
 * si la de hoy cambia.
 */
export const DIMENSIONES_ORDENADAS = [
  'quality',
  'design',
  'usefulness',
  'durability',
  'origin',
  'warranty',
] as const;

export type Dimension = (typeof DIMENSIONES_ORDENADAS)[number];

/**
 * El peso de cada dimensión. Las claves son las seis y solo las seis, así que
 * indexar con una `Dimension` da siempre un número: no hay hueco por el que se cuele
 * un `undefined` sumado como si fuera un peso.
 */
export const DIMENSIONES: Readonly<Record<Dimension, number>> = Object.freeze({
  quality: 25,
  design: 20,
  usefulness: 20,
  durability: 15,
  origin: 10,
  warranty: 10,
});

/** Cuántas hay que puntuar para que haya puntuación. Seis de seis o ninguna. */
export const DIMENSIONES_EXIGIDAS = DIMENSIONES_ORDENADAS.length;

/**
 * La suma de los pesos. 100, y el servidor lo comprueba al importar.
 *
 * Una matriz que no sume 100 daría puntuaciones que no se pueden comparar entre
 * productos, y el sello dejaría de querer decir lo mismo en dos fichas.
 */
export const PESO_TOTAL = DIMENSIONES_ORDENADAS.reduce(
  (suma, dimension) => suma + DIMENSIONES[dimension],
  0,
);

/** El máximo posible en centésimas: cien puntos por cien de peso. */
export const PUNTUACION_MAXIMA = 100 * PESO_TOTAL;

/** Los umbrales del blueprint, EN CENTÉSIMAS: 9 000 son 90,00 y 8 500 son 85,00. */
export const APROBADO_DESDE = 9_000;
export const CONDICIONADO_DESDE = 8_500;

/** De 0 a 100, que es lo que acepta `PuntuacionRequest`. */
export const PUNTUACION_MINIMA_DE_DIMENSION = 0;
export const PUNTUACION_MAXIMA_DE_DIMENSION = 100;

/** Si esa dimensión está en la matriz. Estrecha el tipo, para poder indexarla. */
export function dimensionValida(
  dimension: string | null | undefined,
): dimension is Dimension {
  return (
    typeof dimension === 'string' &&
    (DIMENSIONES_ORDENADAS as readonly string[]).includes(dimension)
  );
}

/** El nombre de la dimensión. Lo que no está en la matriz se dice desconocido. */
export function claveDeLaDimension(dimension: string): ClaveDeTraduccion {
  return conocido(DIMENSIONES_ORDENADAS, dimension, 'productosAdmin.dimension');
}

/**
 * El peso con el que se va a puntuar esta dimensión.
 *
 * MANDA LA MATRIZ DE LA EVALUACIÓN, que es la que el servidor va a usar; la copia local
 * solo se usa si el servidor no la mandó. Al revés se enseñaría un peso que no es el que
 * se va a aplicar.
 */
export function pesoDeLaDimension(
  matriz: Record<string, number> | null | undefined,
  dimension: string,
): number | null {
  const delServidor = matriz?.[dimension];
  if (typeof delServidor === 'number' && Number.isFinite(delServidor)) {
    return delServidor;
  }
  return dimensionValida(dimension) ? DIMENSIONES[dimension] : null;
}

/** Las dimensiones de una matriz, en el orden conocido y con las raras al final. */
export function dimensionesDeLaMatriz(
  matriz: Record<string, number> | null | undefined,
): string[] {
  const claves = Object.keys(matriz ?? {});
  if (claves.length === 0) return [...DIMENSIONES_ORDENADAS];
  const conocidas = DIMENSIONES_ORDENADAS.filter((d) => claves.includes(d));
  const raras = claves.filter((d) => !(DIMENSIONES_ORDENADAS as readonly string[]).includes(d));
  return [...conocidas, ...raras.sort()];
}

/* -------------------------------------------------------------------------- */
/* Las fallas críticas: rechazo directo, sin compensar con puntaje             */
/* -------------------------------------------------------------------------- */

/** Las seis del blueprint §5.2, transcritas de `products/models.py`. */
export const FALLAS_CRITICAS = [
  'safety',
  'counterfeit',
  'misleading_advertising',
  'unverifiable_origin',
  'missing_permits',
  'tampered_evidence',
] as const;

export type FallaCritica = (typeof FALLAS_CRITICAS)[number];

export function fallaCriticaValida(falla: string | null | undefined): boolean {
  return (
    typeof falla === 'string' && (FALLAS_CRITICAS as readonly string[]).includes(falla)
  );
}

export function claveDeLaFallaCritica(falla: string): ClaveDeTraduccion {
  return conocido(FALLAS_CRITICAS, falla, 'productosAdmin.falla');
}

/** La falla que SÍ se puede mandar. `null` para «no hay ninguna». */
export function fallaQueViaja(falla: string | null | undefined): string | null {
  const limpia = limpiar(falla);
  if (limpia === '') return null;
  return fallaCriticaValida(limpia) ? limpia : null;
}

/* -------------------------------------------------------------------------- */
/* La evidencia                                                                */
/* -------------------------------------------------------------------------- */

/** Los tipos de la columna «evidencia mínima» (`products/models.py`). */
export const TIPOS_DE_EVIDENCIA = [
  'functional_test',
  'inspection',
  'usage_review',
  'problem_and_result',
  'materials',
  'batch',
  'warranty_policy',
  'photo',
  'document',
  'sample',
] as const;

export type TipoDeEvidencia = (typeof TIPOS_DE_EVIDENCIA)[number];

export function tipoDeEvidenciaValido(kind: string | null | undefined): boolean {
  return (
    typeof kind === 'string' && (TIPOS_DE_EVIDENCIA as readonly string[]).includes(kind)
  );
}

export function claveDelTipoDeEvidencia(kind: string): ClaveDeTraduccion {
  return conocido(TIPOS_DE_EVIDENCIA, kind, 'productosAdmin.evidencia');
}

/** `EvidenciaRequest.summary`: de 10 a 1 000 en el servidor. */
export const LARGO_DEL_RESUMEN_DE_EVIDENCIA = { minimo: 10, maximo: 1_000 } as const;

/** Lo escrito en el resumen de una evidencia, revisado ANTES de llamar. */
export type ResumenRevisado =
  | { estado: 'listo'; resumen: string }
  | { estado: 'falta' }
  | { estado: 'corto'; minimo: number }
  | { estado: 'largo'; maximo: number };

/**
 * El resumen, comprobado aquí.
 *
 * El tope se mira antes de mandar porque un 422 sobre un texto ya escrito es trabajo
 * tirado, y el mínimo porque «ok» no es un resumen de nada.
 */
export function revisarResumenDeEvidencia(
  texto: string | null | undefined,
): ResumenRevisado {
  const limpio = limpiar(texto);
  if (limpio === '') return { estado: 'falta' };
  if (limpio.length < LARGO_DEL_RESUMEN_DE_EVIDENCIA.minimo) {
    return { estado: 'corto', minimo: LARGO_DEL_RESUMEN_DE_EVIDENCIA.minimo };
  }
  if (limpio.length > LARGO_DEL_RESUMEN_DE_EVIDENCIA.maximo) {
    return { estado: 'largo', maximo: LARGO_DEL_RESUMEN_DE_EVIDENCIA.maximo };
  }
  return { estado: 'listo', resumen: limpio };
}

/** La ruta del almacenamiento. UNA URL NO ES UNA RUTA: el servidor la rechaza. */
export function rutaValida(ruta: string | null | undefined): boolean {
  const limpia = limpiar(ruta);
  return limpia === '' || !limpia.includes('://');
}

/** La evidencia de esa dimensión, y solo de esa. */
export function evidenciaDeLaDimension(
  evidencia: ReadonlyArray<EvidenciaRead>,
  dimension: string,
): EvidenciaRead[] {
  return evidencia.filter((e) => e.dimension === dimension);
}

/** Cuántas evidencias hay por dimensión. Para decir qué falta sin recontar. */
export function evidenciaPorDimension(
  evidencia: ReadonlyArray<EvidenciaRead>,
): Record<string, number> {
  const cuenta: Record<string, number> = {};
  for (const e of evidencia) {
    if (typeof e?.dimension !== 'string' || e.dimension === '') continue;
    cuenta[e.dimension] = (cuenta[e.dimension] ?? 0) + 1;
  }
  return cuenta;
}

/* -------------------------------------------------------------------------- */
/* La puntuación                                                               */
/* -------------------------------------------------------------------------- */

/** Si eso es una puntuación que `PuntuacionRequest` acepta (entera, 0–100). */
export function puntuacionDeDimensionValida(score: unknown): boolean {
  return (
    typeof score === 'number' &&
    Number.isInteger(score) &&
    score >= PUNTUACION_MINIMA_DE_DIMENSION &&
    score <= PUNTUACION_MAXIMA_DE_DIMENSION
  );
}

/** Lo escrito en el campo de puntuación, leído. */
export type PuntuacionEscrita =
  | { estado: 'listo'; score: number }
  | { estado: 'falta' }
  | { estado: 'invalida' }
  | { estado: 'fuera'; minimo: number; maximo: number };

/**
 * Lo que se escribió en el campo, convertido a lo que viaja.
 *
 * SOLO DÍGITOS. Una coma o un punto se rechazan aquí en vez de mandarse: el servidor
 * quiere un entero de 0 a 100, y «90,5» acabaría en un 422 o, peor, redondeado por
 * alguien a algo que nadie escribió.
 */
export function revisarPuntuacion(texto: string | null | undefined): PuntuacionEscrita {
  const limpio = limpiar(texto);
  if (limpio === '') return { estado: 'falta' };
  if (!/^\d+$/.test(limpio)) return { estado: 'invalida' };
  const score = Number.parseInt(limpio, 10);
  if (!puntuacionDeDimensionValida(score)) {
    return {
      estado: 'fuera',
      minimo: PUNTUACION_MINIMA_DE_DIMENSION,
      maximo: PUNTUACION_MAXIMA_DE_DIMENSION,
    };
  }
  return { estado: 'listo', score };
}

/** Solo los dígitos de lo que se teclea, recortado a tres. Para el campo. */
export function soloDigitos(texto: string | null | undefined): string {
  return (typeof texto === 'string' ? texto : '').replace(/\D+/g, '').slice(0, 3);
}

/** `PuntuacionRequest.note`: `max_length=2 000`. */
export const LARGO_DE_LA_NOTA = 2_000;

/**
 * LA PUNTUACIÓN PONDERADA, O `null` SI FALTA ALGUNA DIMENSIÓN.
 *
 * `null` NO ES CERO, y esta es la función por la que existe todo el fichero. Es la misma
 * cuenta del servidor (`evaluations.calcular`): la suma de `score * weight`, con el peso
 * CONGELADO en cada fila, y nada si el conjunto de dimensiones puntuadas no es
 * exactamente el de la matriz.
 *
 * El peso sale de la fila, no de la matriz de hoy: así una decisión pasada se sigue
 * explicando con sus propios números.
 */
export function puntuacionPonderada(
  puntuaciones: ReadonlyArray<PuntuacionRead> | null | undefined,
): number | null {
  const filas = puntuaciones ?? [];
  const utiles = new Map<string, PuntuacionRead>();
  for (const fila of filas) {
    if (!dimensionValida(fila?.dimension)) continue;
    if (!puntuacionDeDimensionValida(fila.score)) continue;
    utiles.set(fila.dimension, fila);
  }
  // SEIS DE SEIS O NADA. Ni una menos, y tampoco vale una repetida por otra.
  if (utiles.size !== DIMENSIONES_EXIGIDAS) return null;
  for (const dimension of DIMENSIONES_ORDENADAS) {
    if (!utiles.has(dimension)) return null;
  }
  let total = 0;
  for (const dimension of DIMENSIONES_ORDENADAS) {
    const fila = utiles.get(dimension) as PuntuacionRead;
    const peso =
      typeof fila.weight === 'number' && Number.isFinite(fila.weight)
        ? fila.weight
        : DIMENSIONES[dimension];
    total += fila.score * peso;
  }
  return total;
}

/**
 * La puntuación escrita para leerla: 9 000 son «90,00».
 *
 * Es lo ÚNICO que pone una coma, y su salida no vuelve al servidor nunca. `null` se
 * queda en `null`: escribir «0,00» donde no hay puntuación sería inventarse un cero.
 */
export function puntuacionLegible(
  centesimas: number | null | undefined,
  separador: string = ',',
): string | null {
  if (typeof centesimas !== 'number' || !Number.isFinite(centesimas)) return null;
  const enteras = Math.trunc(Math.abs(centesimas) / 100);
  const resto = Math.abs(centesimas) % 100;
  const signo = centesimas < 0 ? '-' : '';
  return `${signo}${enteras}${separador}${String(resto).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* La decisión: la da la matriz, no quien pulsa                                */
/* -------------------------------------------------------------------------- */

export const DECISIONES = ['approved', 'conditionally_approved', 'rejected'] as const;
export type Decision = (typeof DECISIONES)[number];

export function claveDeLaDecision(decision: string): ClaveDeTraduccion {
  return conocido(DECISIONES, decision, 'productosAdmin.decision');
}

/**
 * Qué decisión corresponde a una puntuación. Los umbrales del blueprint.
 *
 * 90–100 aprobado, 85–89 aprobado con condiciones, menos rechazado. Y en centésimas:
 * 8 999 son 89,99, que son condiciones; 9 000 son 90,00, que son aprobado.
 */
export function decisionPorPuntuacion(total: number): Decision {
  if (total >= APROBADO_DESDE) return 'approved';
  if (total >= CONDICIONADO_DESDE) return 'conditionally_approved';
  return 'rejected';
}

/**
 * Si esa decisión es «aprobado con condiciones», que NO PUEDE PUBLICAR.
 *
 * Existe para que la pantalla no escriba el código a mano: el mismo valor es un estado
 * del producto y una decisión de la evaluación, y confundirlos es fácil.
 */
export function esDecisionCondicionada(decision: string | null | undefined): boolean {
  return decision === 'conditionally_approved';
}

/** Si la evaluación sigue abierta (`draft`). Una decidida no se reescribe. */
export function evaluacionAbierta(status: string | null | undefined): boolean {
  return status === 'draft';
}

/**
 * UNA FALLA CRÍTICA NO SE COMBINA CON UNA APROBACIÓN.
 *
 * Lo impone también un CHECK de la base (`product_evaluations_falla_rechaza`). Está aquí
 * para que la pantalla no pueda pintar «aprobado» junto a una falla ni un segundo.
 */
export function combinacionImposible(
  decision: string | null | undefined,
  falla: string | null | undefined,
): boolean {
  const hayFalla = limpiar(falla) !== '';
  if (!hayFalla) return false;
  return decision !== null && decision !== undefined && decision !== 'rejected';
}

/** Qué falta para poder decidir: sin puntuar y sin evidencia, por separado. */
export type LoQueFalta = {
  sinPuntuar: string[];
  sinEvidencia: string[];
};

/**
 * Las dimensiones sin puntuar y las puntuadas sin evidencia.
 *
 * Las DOS a la vez, aunque el servidor conteste primero una y luego la otra: quien
 * evalúa necesita saber todo lo que le queda, no descubrirlo de uno en uno.
 */
export function queFalta(
  evaluacion: {
    scores?: ReadonlyArray<PuntuacionRead> | null;
    evidence?: ReadonlyArray<EvidenciaRead> | null;
  } | null
  | undefined,
): LoQueFalta {
  const puntuadas = new Set(
    (evaluacion?.scores ?? [])
      .filter((s) => dimensionValida(s?.dimension) && puntuacionDeDimensionValida(s.score))
      .map((s) => s.dimension),
  );
  const cuenta = evidenciaPorDimension(evaluacion?.evidence ?? []);
  return {
    sinPuntuar: DIMENSIONES_ORDENADAS.filter((d) => !puntuadas.has(d)).sort(),
    sinEvidencia: DIMENSIONES_ORDENADAS.filter((d) => !cuenta[d]).sort(),
  };
}

/**
 * Si esta evaluación se puede decidir con puntuación. `false` mientras falte algo.
 *
 * NO CUENTA la falla crítica: una falsificación rechaza sin necesitar seis notas, y eso
 * lo dice `previsualizarDecision`.
 */
export function sePuedeDecidir(
  evaluacion: {
    scores?: ReadonlyArray<PuntuacionRead> | null;
    evidence?: ReadonlyArray<EvidenciaRead> | null;
  } | null
  | undefined,
): boolean {
  const falta = queFalta(evaluacion);
  return falta.sinPuntuar.length === 0 && falta.sinEvidencia.length === 0;
}

/** Lo que se le va a enseñar antes de pulsar «decidir». */
export type Previsualizacion =
  | { estado: 'fallaCritica'; falla: string; decision: 'rejected'; total: null }
  | { estado: 'faltan'; sinPuntuar: string[]; sinEvidencia: string[] }
  | { estado: 'listo'; decision: Decision; total: number };

/**
 * LA DECISIÓN, PREVISUALIZADA. Lo mismo que va a hacer el servidor, dicho antes.
 *
 * Una falla crítica manda sobre todo lo demás y solo puede acabar en rechazo, sin exigir
 * la matriz completa —igual que `evaluations.decidir`—. Sin falla, hace falta las seis
 * dimensiones puntuadas y evidencia en cada una; si falta algo se dice qué, y NO se
 * inventa una puntuación con lo que hay.
 */
export function previsualizarDecision(
  evaluacion: {
    scores?: ReadonlyArray<PuntuacionRead> | null;
    evidence?: ReadonlyArray<EvidenciaRead> | null;
  } | null
  | undefined,
  falla?: string | null,
): Previsualizacion {
  const critica = fallaQueViaja(falla);
  if (critica !== null) {
    return { estado: 'fallaCritica', falla: critica, decision: 'rejected', total: null };
  }
  const pendiente = queFalta(evaluacion);
  if (pendiente.sinPuntuar.length > 0 || pendiente.sinEvidencia.length > 0) {
    return {
      estado: 'faltan',
      sinPuntuar: pendiente.sinPuntuar,
      sinEvidencia: pendiente.sinEvidencia,
    };
  }
  const total = puntuacionPonderada(evaluacion?.scores ?? []);
  if (total === null) {
    // No debería llegar aquí, pero inventarse un cero sería peor que repetirse.
    return {
      estado: 'faltan',
      sinPuntuar: pendiente.sinPuntuar,
      sinEvidencia: pendiente.sinEvidencia,
    };
  }
  return { estado: 'listo', decision: decisionPorPuntuacion(total), total };
}

/* -------------------------------------------------------------------------- */
/* Las tres razones, SIEMPRE sobre evidencia registrada                        */
/* -------------------------------------------------------------------------- */

/** EXACTAMENTE TRES (blueprint §4.1). */
export const RAZONES_EXIGIDAS = 3;

/** `RazonRequest.text`: de 10 a 240 en el servidor. */
export const LARGO_DE_LA_RAZON = { minimo: 10, maximo: 240 } as const;

export type RazonRevisada =
  | { estado: 'listo'; razon: RazonRequest }
  | { estado: 'sinEvidencia' }
  | { estado: 'falta' }
  | { estado: 'corto'; minimo: number }
  | { estado: 'largo'; maximo: number };

/**
 * Una razón, revisada. SIN EVIDENCIA NO HAY RAZÓN.
 *
 * La evidencia tiene que ser de ESTA evaluación: apuntar a la de otro producto es
 * exactamente cómo se acaba enseñando una razón que nadie comprobó aquí. Y no hay
 * ninguna otra función en este fichero que construya una razón sin `evidence_id`.
 */
export function revisarRazon(
  evidenciaId: string | null | undefined,
  texto: string | null | undefined,
  evidenciaDeLaEvaluacion: ReadonlyArray<EvidenciaRead>,
): RazonRevisada {
  const id = limpiar(evidenciaId);
  if (id === '' || !evidenciaDeLaEvaluacion.some((e) => e.id === id)) {
    return { estado: 'sinEvidencia' };
  }
  const limpio = limpiar(texto);
  if (limpio === '') return { estado: 'falta' };
  if (limpio.length < LARGO_DE_LA_RAZON.minimo) {
    return { estado: 'corto', minimo: LARGO_DE_LA_RAZON.minimo };
  }
  if (limpio.length > LARGO_DE_LA_RAZON.maximo) {
    return { estado: 'largo', maximo: LARGO_DE_LA_RAZON.maximo };
  }
  return { estado: 'listo', razon: { evidence_id: id, text: limpio } };
}

export type RazonesRevisadas =
  | { estado: 'listo'; razones: RazonRequest[] }
  | { estado: 'demasiadas'; maximo: number }
  | { estado: 'repetida'; posicion: number }
  /** `motivo` NUNCA es «listo»: una razón válida no llega aquí. */
  | {
      estado: 'invalida';
      posicion: number;
      motivo: Exclude<RazonRevisada, { estado: 'listo' }>;
    };

/**
 * Las razones que se van a mandar, revisadas de una vez.
 *
 * Se rechaza repetir la misma evidencia en dos razones: tres frases sobre una sola
 * comprobación son una comprobación, no tres.
 */
export function revisarRazones(
  escritas: ReadonlyArray<{ evidence_id?: string | null; text?: string | null }>,
  evidenciaDeLaEvaluacion: ReadonlyArray<EvidenciaRead>,
): RazonesRevisadas {
  if (escritas.length > RAZONES_EXIGIDAS) {
    return { estado: 'demasiadas', maximo: RAZONES_EXIGIDAS };
  }
  const razones: RazonRequest[] = [];
  const vistas = new Set<string>();
  for (let i = 0; i < escritas.length; i += 1) {
    const revisada = revisarRazon(
      escritas[i]?.evidence_id,
      escritas[i]?.text,
      evidenciaDeLaEvaluacion,
    );
    if (revisada.estado !== 'listo') {
      return { estado: 'invalida', posicion: i + 1, motivo: revisada };
    }
    if (vistas.has(revisada.razon.evidence_id)) {
      return { estado: 'repetida', posicion: i + 1 };
    }
    vistas.add(revisada.razon.evidence_id);
    razones.push(revisada.razon);
  }
  return { estado: 'listo', razones };
}

/** Si ya están las tres que hace falta para publicar. */
export function razonesCompletas(
  razones: ReadonlyArray<unknown> | null | undefined,
): boolean {
  return (razones?.length ?? 0) === RAZONES_EXIGIDAS;
}

/* -------------------------------------------------------------------------- */
/* El ciclo del producto                                                       */
/* -------------------------------------------------------------------------- */

/** La cadena del blueprint §5, letra por letra (`products/models.py`). */
export const ESTADOS_DE_PRODUCTO = [
  'draft',
  'submitted',
  'document_review',
  'sample_requested',
  'evaluation',
  'conditionally_approved',
  'approved',
  'published',
  'observation',
  'suspended',
  'removed',
] as const;

export type EstadoDeProducto = (typeof ESTADOS_DE_PRODUCTO)[number];

export function claveDelEstadoDeProducto(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_PRODUCTO, estado, 'productosAdmin.estado');
}

/** Los estados por los que tiene sentido filtrar la bandeja administrativa. */
export const ESTADOS_QUE_SE_FILTRAN = [
  'submitted',
  'document_review',
  'sample_requested',
  'evaluation',
  'conditionally_approved',
  'approved',
  'published',
  'observation',
  'suspended',
] as const;

/** Con qué tono se pinta. Publicado no es «bueno»: es «está en catálogo». */
export function tonoDelEstado(estado: string): 'catalogo' | 'alerta' | 'neutro' {
  if (estado === 'published' || estado === 'observation') return 'catalogo';
  if (estado === 'suspended' || estado === 'removed') return 'alerta';
  return 'neutro';
}

/** Si el producto está visible en el catálogo público (`states.EN_CATALOGO`). */
export function enCatalogo(estado: string | null | undefined): boolean {
  return estado === 'published' || estado === 'observation';
}

/** `conditionally_approved`. Se pregunta mucho, y siempre para explicarlo. */
export function esAprobadoConCondiciones(estado: string | null | undefined): boolean {
  return estado === 'conditionally_approved';
}

/**
 * Las transiciones que se piden por `POST /transition`, de las que manda el servidor.
 *
 * PUBLICAR Y SUSPENDER SE QUEDAN FUERA: tienen su propia ruta, que comprueba cosas que
 * `transition` no comprueba —las tres razones, la foto, la evaluación aprobada, el
 * motivo—. Ofrecerlas también aquí sería ofrecer un atajo que se salta esas puertas.
 */
export function transicionesQueSeOfrecen(
  acciones: ReadonlyArray<string> | null | undefined,
): string[] {
  return (acciones ?? []).filter(
    (accion) => accion !== 'published' && accion !== 'suspended',
  );
}

/** Si el servidor ofrece publicar este producto entre sus acciones. */
export function ofrecePublicar(
  acciones: ReadonlyArray<string> | null | undefined,
): boolean {
  return (acciones ?? []).includes('published');
}

/** Si el servidor ofrece suspenderlo. */
export function ofreceSuspender(
  acciones: ReadonlyArray<string> | null | undefined,
): boolean {
  return (acciones ?? []).includes('suspended');
}

/**
 * Suspender EXIGE motivo, y retirar o devolver a borrador también se piden con uno.
 *
 * El servidor solo lo impone al suspender (`product_suspension_needs_reason`), pero un
 * producto devuelto a borrador sin una línea que explique por qué deja a quien lo vende
 * sin nada que corregir.
 */
export function transicionExigeMotivo(hasta: string | null | undefined): boolean {
  return hasta === 'suspended' || hasta === 'draft' || hasta === 'removed';
}

/** `MotivoRequest.motivo` y `TransicionRequest.motivo`: `max_length=2 000`. */
export const LARGO_MAXIMO_DEL_MOTIVO = 2_000;

/** `DecisionDePostulacion.notas` y `DecisionDeEvaluacion.notes`: `max_length=4 000`. */
export const LARGO_MAXIMO_DE_LAS_NOTAS = 4_000;

export type MotivoRevisado =
  | { estado: 'listo'; motivo: string | null }
  | { estado: 'falta' }
  | { estado: 'largo'; maximo: number };

/**
 * El motivo, revisado ANTES de llamar a nadie.
 *
 * Se le pasa si es obligatorio, que depende de qué se esté haciendo: un rechazo y una
 * suspensión lo exigen, y aceptar no.
 */
export function revisarMotivo(
  obligatorio: boolean,
  texto: string | null | undefined,
  maximo: number = LARGO_MAXIMO_DEL_MOTIVO,
): MotivoRevisado {
  const limpio = limpiar(texto);
  if (limpio === '') {
    return obligatorio ? { estado: 'falta' } : { estado: 'listo', motivo: null };
  }
  if (limpio.length > maximo) return { estado: 'largo', maximo };
  return { estado: 'listo', motivo: limpio };
}

/* -------------------------------------------------------------------------- */
/* Publicar: se lee el `bloqueo` del servidor, no se recalcula                 */
/* -------------------------------------------------------------------------- */

/** Los códigos que `service.por_que_no_se_publica` puede devolver. */
export const BLOQUEOS_DE_PUBLICACION = [
  'product_not_approved',
  'product_version_missing',
  'product_media_required',
  'product_admission_not_available',
  'product_evaluation_required',
  'product_reasons_required',
] as const;

/**
 * SI SE PUEDE PUBLICAR. LO DICE EL SERVIDOR, y aquí solo se lee.
 *
 * Hacen falta las dos cosas: que el servidor ofrezca la acción para ESTE actor —publicar
 * es de administración, no de curaduría— y que no haya mandado ningún `bloqueo`. No se
 * recalcula nada: repetir aquí las comprobaciones de las tres razones, la foto y la
 * evaluación es cómo se acaba enseñando un botón que el servidor va a rechazar.
 */
export function sePuedePublicar(
  producto: { acciones?: ReadonlyArray<string> | null; bloqueo?: string | null } | null
  | undefined,
): boolean {
  if (producto == null) return false;
  const bloqueo = limpiar(producto.bloqueo);
  if (bloqueo !== '') return false;
  return ofrecePublicar(producto.acciones);
}

/**
 * POR QUÉ NO SE PUEDE PUBLICAR, para DECIRLO en vez de esconder el botón.
 *
 * `conditionally_approved` tiene su propio texto: el servidor manda
 * `product_not_approved`, que no explica nada, y lo que pasa de verdad es que la empresa
 * no ha definido qué condiciones se le exigen a un producto aprobado con condiciones.
 * Hay que volver a evaluarlo, y eso es lo que se lee.
 */
export function claveDelBloqueoDePublicacion(
  producto: { status?: string | null; bloqueo?: string | null } | null | undefined,
): ClaveDeTraduccion | null {
  if (producto == null) return null;
  const bloqueo = limpiar(producto.bloqueo);
  if (bloqueo === '') return null;
  if (esAprobadoConCondiciones(producto.status)) {
    return 'productosAdmin.bloqueo.condicionado';
  }
  return conocido(BLOQUEOS_DE_PUBLICACION, bloqueo, 'productosAdmin.bloqueo');
}

/** Por qué todavía no se puede decidir una evaluación, dicho con su código. */
export const BLOQUEOS_DE_EVALUACION = [
  'product_dimensions_missing',
  'product_evidence_missing',
] as const;

export function claveDelBloqueoDeEvaluacion(
  bloqueo: string | null | undefined,
): ClaveDeTraduccion | null {
  const limpio = limpiar(bloqueo);
  if (limpio === '') return null;
  return conocido(BLOQUEOS_DE_EVALUACION, limpio, 'productosAdmin.bloqueoEvaluacion');
}

/* -------------------------------------------------------------------------- */
/* La postulación del proveedor                                                */
/* -------------------------------------------------------------------------- */

export const ESTADOS_DE_POSTULACION = [
  'draft',
  'submitted',
  'under_review',
  'accepted',
  'rejected',
  'withdrawn',
] as const;

export function claveDelEstadoDePostulacion(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_POSTULACION, estado, 'productosAdmin.postulacion');
}

/** Por lo que se filtra la bandeja: lo que espera y lo que alguien ya tomó. */
export const POSTULACIONES_QUE_SE_FILTRAN = ['submitted', 'under_review'] as const;

/** Desde dónde se puede tomar (`applications.tomar`): solo lo enviado. */
export function sePuedeTomar(estado: string | null | undefined): boolean {
  return estado === 'submitted';
}

/** Desde dónde se puede decidir (`applications.DECIDIBLES`). */
export function sePuedeDecidirPostulacion(estado: string | null | undefined): boolean {
  return estado === 'submitted' || estado === 'under_review';
}

/**
 * UN RECHAZO EXIGE MOTIVO, y se comprueba aquí antes de llamar.
 *
 * El servidor también lo exige, y un CHECK de la base detrás; se adelanta en la pantalla
 * porque un «no» sin motivo no se le puede enseñar a nadie, y descubrirlo después de
 * pulsar es trabajo tirado.
 */
export function decisionExigeMotivo(aceptar: boolean): boolean {
  return !aceptar;
}

/** Los tipos del blueprint §5.1 (`products/models.py: DOCUMENTOS`). */
export const DOCUMENTOS = [
  'identity',
  'tax_data',
  'bank_account',
  'manufacturer',
  'materials_and_batch',
  'warranty_procedure',
  'permits',
  'photos',
  'other',
] as const;

export function claveDelDocumento(kind: string): ClaveDeTraduccion {
  return conocido(DOCUMENTOS, kind, 'productosAdmin.documento');
}

/**
 * El cuerpo de la decisión de una postulación, ya revisado.
 *
 * `motivo` viaja en los dos casos si se escribió: aceptar con una nota visible también
 * es legítimo. Lo que no se puede es rechazar sin nada.
 */
export type DecisionRevisada =
  | { estado: 'listo'; cuerpo: DecisionDePostulacion }
  | { estado: 'faltaMotivo' }
  | { estado: 'motivoLargo'; maximo: number }
  | { estado: 'notasLargas'; maximo: number };

export function revisarDecisionDePostulacion(
  aceptar: boolean,
  motivo: string | null | undefined,
  notas?: string | null,
): DecisionRevisada {
  const revisado = revisarMotivo(decisionExigeMotivo(aceptar), motivo);
  if (revisado.estado === 'falta') return { estado: 'faltaMotivo' };
  if (revisado.estado === 'largo') {
    return { estado: 'motivoLargo', maximo: revisado.maximo };
  }
  const apunte = limpiar(notas);
  if (apunte.length > LARGO_MAXIMO_DE_LAS_NOTAS) {
    return { estado: 'notasLargas', maximo: LARGO_MAXIMO_DE_LAS_NOTAS };
  }
  return {
    estado: 'listo',
    cuerpo: {
      aceptar,
      motivo: revisado.motivo,
      notas: apunte === '' ? null : apunte,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* La lista                                                                    */
/* -------------------------------------------------------------------------- */

/** Los topes que el servidor admite (`limit` de 1 a 200). NO HAY CURSOR. */
export const LIMITES_DE_LA_LISTA = [50, 100, 200] as const;
export const LIMITE_INICIAL = LIMITES_DE_LA_LISTA[0];
export const LIMITE_MAXIMO = 200;

export function siguienteLimite(actual: number): number | null {
  for (const limite of LIMITES_DE_LA_LISTA) {
    if (limite > actual) return limite;
  }
  return null;
}

/** Si lo que se ve podría no ser todo: el corte lo puso el `limit`. */
export function llegoAlTope(cuantos: number, limite: number): boolean {
  return cuantos >= limite;
}

export function limiteValido(limite: number | null | undefined): number {
  if (typeof limite !== 'number' || !Number.isFinite(limite)) return LIMITE_INICIAL;
  return Math.min(LIMITE_MAXIMO, Math.max(1, Math.trunc(limite)));
}

/**
 * La cola de las listas de administración.
 *
 * Siempre con `limit`, para que el tope sea explícito y la pantalla pueda decirlo.
 * `estado` solo viaja si hay algo que filtrar: mandarlo vacío filtraría por la cadena
 * vacía y devolvería nada.
 */
export function cadenaDeFiltros(opciones?: {
  estado?: string | null;
  limite?: number | null;
}): string {
  const partes = [`limit=${limiteValido(opciones?.limite)}`];
  const estado = limpiar(opciones?.estado);
  if (estado !== '') partes.push(`estado=${encodeURIComponent(estado)}`);
  return partes.join('&');
}

/* -------------------------------------------------------------------------- */
/* Cuando el servidor dice que no                                              */
/* -------------------------------------------------------------------------- */

/** Alguien movió lo mismo mientras decidías. Se recarga y se vuelve a mirar. */
export function esConflicto(codigo: string | null | undefined): boolean {
  return (
    codigo === 'product_changed' ||
    codigo === 'seller_application_changed' ||
    codigo === 'product_evaluation_closed'
  );
}

/** NADIE EVALÚA NI PUBLICA LO SUYO, ni siendo administrador. */
export function esAutoevaluacion(codigo: string | null | undefined): boolean {
  return (
    codigo === 'product_self_review_forbidden' ||
    codigo === 'seller_application_self_review_forbidden'
  );
}

/** Las migraciones de admisión o de productos no están aplicadas (503). */
export function esNoDisponible(codigo: string | null | undefined): boolean {
  return (
    codigo === 'product_admission_not_available' ||
    codigo === 'products_not_available' ||
    codigo === 'product_evaluation_not_available' ||
    codigo === 'product_saves_not_available'
  );
}

/**
 * Los códigos del servidor, traducidos. `null` = no lo conozco.
 *
 * Sin clave se usa el mensaje del servidor, que en español es correcto. Están todos los
 * `product_*` y `seller_application_*` que estas pantallas pueden provocar.
 */
export function claveDeErrorDeProductos(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  if (typeof codigo !== 'string') return null;
  return CLAVES_DE_ERROR[codigo] ?? null;
}

const CLAVES_DE_ERROR: Record<string, string> = {
  // Permisos y propiedad
  product_self_review_forbidden: 'productosAdmin.error.product_self_review_forbidden',
  product_review_forbidden: 'productosAdmin.error.product_review_forbidden',
  product_publish_forbidden: 'productosAdmin.error.product_publish_forbidden',
  product_seller_not_active: 'productosAdmin.error.product_seller_not_active',
  product_not_found: 'productosAdmin.error.product_not_found',
  // Despliegue
  product_admission_not_available:
    'productosAdmin.error.product_admission_not_available',
  products_not_available: 'productosAdmin.error.products_not_available',
  product_evaluation_not_available:
    'productosAdmin.error.product_evaluation_not_available',
  product_saves_not_available: 'productosAdmin.error.product_saves_not_available',
  // El ciclo
  product_transition_invalid: 'productosAdmin.error.product_transition_invalid',
  product_transition_forbidden: 'productosAdmin.error.product_transition_forbidden',
  product_changed: 'productosAdmin.error.product_changed',
  product_not_editable: 'productosAdmin.error.product_not_editable',
  product_not_in_evaluation: 'productosAdmin.error.product_not_in_evaluation',
  product_suspension_needs_reason:
    'productosAdmin.error.product_suspension_needs_reason',
  // Publicar
  product_not_approved: 'productosAdmin.bloqueo.product_not_approved',
  product_version_missing: 'productosAdmin.bloqueo.product_version_missing',
  product_media_required: 'productosAdmin.bloqueo.product_media_required',
  product_evaluation_required: 'productosAdmin.bloqueo.product_evaluation_required',
  product_reasons_required: 'productosAdmin.bloqueo.product_reasons_required',
  // Evaluar
  product_evaluation_not_found: 'productosAdmin.error.product_evaluation_not_found',
  product_evaluation_closed: 'productosAdmin.error.product_evaluation_closed',
  product_dimensions_missing: 'productosAdmin.bloqueoEvaluacion.product_dimensions_missing',
  product_evidence_missing: 'productosAdmin.bloqueoEvaluacion.product_evidence_missing',
  product_dimension_invalid: 'productosAdmin.error.product_dimension_invalid',
  product_score_out_of_range: 'productosAdmin.error.product_score_out_of_range',
  product_score_note_too_long: 'productosAdmin.error.product_score_note_too_long',
  product_critical_failure_invalid:
    'productosAdmin.error.product_critical_failure_invalid',
  product_evidence_kind_invalid: 'productosAdmin.error.product_evidence_kind_invalid',
  product_evidence_summary_invalid:
    'productosAdmin.error.product_evidence_summary_invalid',
  product_evidence_path_invalid: 'productosAdmin.error.product_evidence_path_invalid',
  product_reason_evidence_invalid:
    'productosAdmin.error.product_reason_evidence_invalid',
  product_reason_text_invalid: 'productosAdmin.error.product_reason_text_invalid',
  product_reasons_too_many: 'productosAdmin.error.product_reasons_too_many',
  // La versión y su ficha
  product_version_not_editable: 'productosAdmin.error.product_version_not_editable',
  product_version_taken: 'productosAdmin.error.product_version_taken',
  product_name_required: 'productosAdmin.error.product_name_required',
  product_field_out_of_range: 'productosAdmin.error.product_field_out_of_range',
  product_category_invalid: 'productosAdmin.error.product_category_invalid',
  product_country_invalid: 'productosAdmin.error.product_country_invalid',
  product_currency_invalid: 'productosAdmin.error.product_currency_invalid',
  product_price_invalid: 'productosAdmin.error.product_price_invalid',
  product_price_without_currency: 'productosAdmin.error.product_price_without_currency',
  product_media_alt_too_long: 'productosAdmin.error.product_media_alt_too_long',
  product_media_kind_invalid: 'productosAdmin.error.product_media_kind_invalid',
  product_media_path_invalid: 'productosAdmin.error.product_media_path_invalid',
  product_media_repeated: 'productosAdmin.error.product_media_repeated',
  product_media_too_many: 'productosAdmin.error.product_media_too_many',
  product_variant_delta_invalid: 'productosAdmin.error.product_variant_delta_invalid',
  product_variant_incomplete: 'productosAdmin.error.product_variant_incomplete',
  product_variant_options_invalid:
    'productosAdmin.error.product_variant_options_invalid',
  product_variant_sku_repeated: 'productosAdmin.error.product_variant_sku_repeated',
  product_variants_too_many: 'productosAdmin.error.product_variants_too_many',
  // La postulación
  seller_application_not_found: 'productosAdmin.error.seller_application_not_found',
  seller_application_not_editable:
    'productosAdmin.error.seller_application_not_editable',
  seller_application_changed: 'productosAdmin.error.seller_application_changed',
  seller_application_self_review_forbidden:
    'productosAdmin.error.seller_application_self_review_forbidden',
  seller_application_reject_needs_reason:
    'productosAdmin.error.seller_application_reject_needs_reason',
  seller_application_reason_too_long:
    'productosAdmin.error.seller_application_reason_too_long',
  seller_application_name_invalid: 'productosAdmin.error.seller_application_name_invalid',
  seller_application_proposal_invalid:
    'productosAdmin.error.seller_application_proposal_invalid',
  seller_application_documents_too_many:
    'productosAdmin.error.seller_application_documents_too_many',
  seller_application_document_kind_invalid:
    'productosAdmin.error.seller_application_document_kind_invalid',
  seller_application_document_empty:
    'productosAdmin.error.seller_application_document_empty',
  seller_application_document_path_invalid:
    'productosAdmin.error.seller_application_document_path_invalid',
  seller_application_document_too_big:
    'productosAdmin.error.seller_application_document_too_big',
  seller_application_document_type_invalid:
    'productosAdmin.error.seller_application_document_type_invalid',
  seller_application_document_note_too_long:
    'productosAdmin.error.seller_application_document_note_too_long',
  seller_already_active: 'productosAdmin.error.seller_already_active',
};

/** Todos los códigos que estas pantallas saben traducir. */
export const CODIGOS_TRADUCIDOS = Object.freeze(Object.keys(CLAVES_DE_ERROR));

/** Lo que hay que enseñar cuando la carga falla. Cada caso se dice distinto. */
export type FalloDeCarga =
  | 'sinSesion'
  | 'sinPermiso'
  | 'esTuProducto'
  | 'noDisponible'
  | 'noEncontrada'
  | 'datosInvalidos'
  | 'sinConexion'
  | 'red';

const FALLOS_CON_TEXTO = [
  'sinSesion',
  'sinPermiso',
  'esTuProducto',
  'noDisponible',
  'noEncontrada',
  'datosInvalidos',
] as const;

/**
 * El 401, el 403, el 404, el 422, el 503 y la red, separados.
 *
 * NO SE JUNTAN. «No has iniciado sesión», «esto no es para ti» y «esto es tuyo y nadie
 * evalúa lo suyo» piden cosas distintas a quien lo lee. Y EL CÓDIGO MANDA SOBRE EL
 * NÚMERO: un 403 por ser tu propio producto no es el mismo 403 que por no ser curaduría.
 */
export function falloDeCarga(
  estadoHttp: number | null | undefined,
  codigo: string | null | undefined,
): FalloDeCarga {
  if (esAutoevaluacion(codigo)) return 'esTuProducto';
  if (esNoDisponible(codigo)) return 'noDisponible';
  if (codigo === 'network_error' || codigo === 'timeout') return 'sinConexion';
  if (estadoHttp === 401) return 'sinSesion';
  if (estadoHttp === 403) return 'sinPermiso';
  if (estadoHttp === 404) return 'noEncontrada';
  if (estadoHttp === 422) return 'datosInvalidos';
  if (estadoHttp === 503) return 'noDisponible';
  return 'red';
}

export function claveDelFallo(fallo: string): ClaveDeTraduccion {
  return conocido(FALLOS_CON_TEXTO, fallo, 'productosAdmin.fallo');
}

export function claveDelCuerpoDelFallo(fallo: string): ClaveDeTraduccion {
  return conocido(FALLOS_CON_TEXTO, fallo, 'productosAdmin.falloCuerpo');
}

/** Si ese fallo tiene sentido reintentarlo. Un permiso denegado no lo tiene. */
export function seReintenta(fallo: string): boolean {
  return fallo === 'red' || fallo === 'sinConexion';
}
