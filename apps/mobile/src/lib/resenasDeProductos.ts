/**
 * Las reseñas verificadas de producto, del lado de la interfaz.
 *
 * NO DECIDEN NADA. Quién puede opinar lo dice `reviewable`; el sello viene en
 * `compra_verificada`; la puntuación ajustada la calcula el servidor. Aquí solo
 * se traduce a texto lo que el servidor ya ha dicho y se decide qué tiene
 * sentido pintar.
 *
 * `null` NO ES CERO. Un producto sin reseñas no tiene una puntuación de 0,0: no
 * tiene puntuación. Por eso `promedioLegible`, `ajustadaLegible`,
 * `porcentajeQueRecomienda` y `valorDelEje` devuelven `null`, y la pantalla
 * escribe que todavía no hay valoraciones en vez de dibujar cinco estrellas
 * vacías o un «0 %» que se leería como una opinión que nadie ha dado.
 *
 * LA GENERAL NO ES LA MEDIA DE LOS EJES. Son dos preguntas distintas —«¿entregó
 * lo que anunció?» frente a cuatro aspectos sueltos— y promediarlas exigiría
 * decidir cuánto pesa cada eje, que no lo ha decidido nadie. En este fichero no
 * hay ninguna función que calcule `overall`.
 *
 * EL SELLO NO SE DEDUCE. `compraVerificada` mira el campo del servidor con
 * `=== true`: un campo ausente NO es un sello, y esta capa no puede inventarse
 * ninguno.
 *
 * LA AJUSTADA TAMPOCO SE CALCULA AQUÍ. La fórmula vive en el servidor, que es
 * quien sabe cuántas reseñas hay y de dónde sale el promedio de referencia.
 * Repetirla aquí daría dos verdades que se separan en cuanto una de las dos
 * cambie.
 *
 * Sin importaciones entre ficheros en tiempo de ejecución: el ejecutor de
 * pruebas de Node no resuelve el alias `@/`.
 */

/** Una clave del diccionario. La convierte la pantalla al traducir. */
export type ClaveDeTraduccion = string;

/** Los cuatro ejes del contrato (`resenas.py`: `EJES`). */
export const EJES = ['quality', 'fidelity', 'functioning', 'value_for_money'] as const;
export type Eje = (typeof EJES)[number];

/** De la mejor a la peor: el orden en el que se lee el histograma. */
export const PUNTUACIONES = [5, 4, 3, 2, 1] as const;

/** De la peor a la mejor: el orden en el que se dibuja una fila de estrellas. */
export const ESTRELLAS = [1, 2, 3, 4, 5] as const;

/** Los códigos que puede contestar el servidor al preguntar si se puede. */
export const MOTIVOS_PARA_RESENAR = [
  'ok',
  'reviews_not_available',
  'order_item_not_found',
  'order_not_paid',
  'not_delivered',
  'own_product',
  'already_reviewed',
] as const;
export type MotivoParaResenar = (typeof MOTIVOS_PARA_RESENAR)[number];

/** Los estados que puede traer la reseña PROPIA. La pública no los trae. */
export const ESTADOS_DE_RESENA = ['visible', 'hidden'] as const;

/** Lo más largo que el servidor acepta como comentario (`max_length=1000`). */
export const LARGO_MAXIMO_DEL_COMENTARIO = 1000;

/** Lo más largo que acepta una respuesta del proveedor. */
export const LARGO_MAXIMO_DE_LA_RESPUESTA = 1000;

/** Cuántas reseñas se piden de una vez. El servidor admite hasta 50. */
export const POR_PAGINA = 20;

/** Lo que contesta `reviews/summary`. Todo lo ausente es ausente, no cero. */
export type ResumenDeResenas = {
  product_id?: string;
  total: number;
  /** `null` cuando no hay reseñas. NUNCA 0. */
  average: number | null;
  /** La del blueprint. `null` con cero reseñas: sería la de la categoría. */
  adjusted: number | null;
  distribution?: Partial<Record<string, number>> | null;
  /** En puntos básicos. `null` = no hay reseñas. */
  recommend_bps: number | null;
  quality?: number | null;
  fidelity?: number | null;
  functioning?: number | null;
  value_for_money?: number | null;
  /** El previo de la fórmula, y si salió de un promedio de categoría real. */
  category_average?: number | null;
  category_configured?: boolean;
};

/** Lo mínimo de una reseña para lo que decide este fichero. */
export type ResenaMinima = {
  id: string;
  created_at: string;
  compra_verificada?: boolean;
  reply?: { id: string; body: string } | null;
  status?: string | null;
  order_item_id?: string | null;
};

/** Una línea de un pedido que se puede valorar, o que ya se valoró. */
export type LineaValorable = {
  order_item_id: string;
  order_id: string;
  product_id: string;
  name: string;
  variant_name?: string | null;
  quantity: number;
  delivered_at: string;
  review_id?: string | null;
  can_review?: boolean;
  reason?: string | null;
};

/** Las claves del histograma que devuelve el servidor, en su idioma. */
const CAJONES: Record<number, string> = {
  1: 'uno',
  2: 'dos',
  3: 'tres',
  4: 'cuatro',
  5: 'cinco',
};

function entero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0
    ? Math.trunc(valor)
    : 0;
}

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/** La clave de traducción del nombre de un eje. */
export function claveDelEje(eje: string): ClaveDeTraduccion {
  return conocido(EJES, eje, 'resenaDeProducto.eje');
}

/** La clave de traducción del código de por qué no se puede opinar. */
export function claveDelMotivoParaResenar(motivo: string): ClaveDeTraduccion {
  return conocido(MOTIVOS_PARA_RESENAR, motivo, 'resenaDeProducto.motivo');
}

/**
 * Si hay algo que resumir.
 *
 * Con `total` en cero no hay promedio, ni histograma, ni porcentaje: no es que
 * el producto esté mal valorado, es que todavía no lo ha valorado nadie.
 */
export function hayValoraciones(resumen: ResumenDeResenas | null | undefined): boolean {
  return entero(resumen?.total) > 0;
}

function conUnDecimal(
  valor: number | null | undefined,
  resumen: ResumenDeResenas | null | undefined,
): string | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  if (!hayValoraciones(resumen)) return null;
  return valor.toFixed(1);
}

/**
 * El promedio REAL con un decimal, o `null`.
 *
 * `null` sin promedio y `null` sin reseñas, aunque el campo trajera un número:
 * una media sobre cero opiniones no es una media.
 */
export function promedioLegible(
  resumen: ResumenDeResenas | null | undefined,
): string | null {
  return conUnDecimal(resumen?.average, resumen);
}

/**
 * La puntuación AJUSTADA con un decimal, o `null`.
 *
 * Es la que el blueprint manda enseñar en la ficha. Con cero reseñas el
 * servidor la manda nula a propósito —la fórmula devolvería el promedio de la
 * categoría, que no habla de este producto— y aquí no se rellena con nada.
 */
export function ajustadaLegible(
  resumen: ResumenDeResenas | null | undefined,
): string | null {
  return conUnDecimal(resumen?.adjusted, resumen);
}

/**
 * Si la puntuación ajustada se apoya en un promedio de categoría DE VERDAD.
 *
 * Hoy no: de dónde sale ese promedio es una decisión que nadie ha tomado, y el
 * servidor usa el valor de referencia del blueprint. La pantalla lo dice en vez
 * de dar a entender que Z calculó algo que no calcula.
 */
export function usaReferenciaPorDefecto(
  resumen: ResumenDeResenas | null | undefined,
): boolean {
  if (!hayValoraciones(resumen)) return false;
  return resumen?.category_configured !== true;
}

/**
 * Cuántas de cada nota, de la 5 a la 1.
 *
 * Los cajones que faltan valen 0, y eso NO es inventar: el servidor solo cuenta
 * las notas que existen. Sin ninguna reseña devuelve la lista vacía, para que
 * la pantalla no pinte cinco barras a cero.
 */
export function histogramaOrdenado(
  resumen: ResumenDeResenas | null | undefined,
): Array<{ puntuacion: number; cuantas: number; proporcion: number }> {
  if (!hayValoraciones(resumen)) return [];
  const total = entero(resumen?.total);
  return PUNTUACIONES.map((puntuacion) => {
    const cajon = CAJONES[puntuacion] ?? '';
    const cuantas = entero(resumen?.distribution?.[cajon]);
    return { puntuacion, cuantas, proporcion: proporcionDeBarra(cuantas, total) };
  });
}

/** Cuánto ocupa una barra, de 0 a 1. Sin total, nada. */
export function proporcionDeBarra(cuantas: number, total: number): number {
  const c = entero(cuantas);
  const suma = entero(total);
  if (suma === 0 || c === 0) return 0;
  return Math.min(1, c / suma);
}

/** Lo mismo, en la unidad que entiende un estilo. */
export function anchoDeBarra(cuantas: number, total: number): `${number}%` {
  return `${Math.round(proporcionDeBarra(cuantas, total) * 100)}%`;
}

/**
 * Qué porcentaje recomienda, o `null`.
 *
 * `recommend_bps` es `null` cuando no hay reseñas, y eso no es «0 % lo
 * recomienda»: es que no hay respuestas.
 */
export function porcentajeQueRecomienda(bps: number | null | undefined): number | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps)) return null;
  const seguro = Math.min(10_000, Math.max(0, bps));
  return Math.round(seguro / 100);
}

/** El mismo porcentaje ya escrito («87%»), o `null`. */
export function porcentajeLegible(bps: number | null | undefined): string | null {
  const porcentaje = porcentajeQueRecomienda(bps);
  return porcentaje === null ? null : `${porcentaje}%`;
}

/** La nota de un eje, o `null` si no hay reseñas. */
export function valorDelEje(
  resumen: ResumenDeResenas | null | undefined,
  eje: string,
): number | null {
  if (!hayValoraciones(resumen)) return null;
  const valor = (resumen as Record<string, unknown> | null | undefined)?.[eje];
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/** Los cuatro ejes con su nota, para pintarlos en orden. */
export function ejesDelResumen(
  resumen: ResumenDeResenas | null | undefined,
): Array<{ eje: Eje; valor: number | null; clave: ClaveDeTraduccion }> {
  return EJES.map((eje) => ({
    eje,
    valor: valorDelEje(resumen, eje),
    clave: claveDelEje(eje),
  }));
}

/** Cuántas compras verificadas hay detrás de la puntuación. */
export function comprasVerificadas(
  resumen: ResumenDeResenas | null | undefined,
): number {
  return entero(resumen?.total);
}

/** El sello. NO SE DEDUCE: un campo ausente no es un sello. */
export function compraVerificada(resena: ResenaMinima | null | undefined): boolean {
  return resena?.compra_verificada === true;
}

/** Si esa reseña lleva respuesta visible del proveedor. */
export function tieneRespuesta(resena: ResenaMinima | null | undefined): boolean {
  return typeof resena?.reply?.id === 'string' && resena.reply.id.length > 0;
}

/** Si está escondida por moderación. Solo viaja en la propia. */
export function estaEscondida(resena: ResenaMinima | null | undefined): boolean {
  return resena?.status === 'hidden';
}

/**
 * Si se le puede ofrecer responder a quien vende.
 *
 * Una escondida no: responder a lo que no se ve dejaría una respuesta colgando
 * de una reseña invisible, y el servidor la rechaza.
 */
export function puedeOfrecerResponder(resena: ResenaMinima | null | undefined): boolean {
  if (!resena) return false;
  if (estaEscondida(resena)) return false;
  return !tieneRespuesta(resena);
}

/** Si una escondida se puede editar. NO: el servidor lo rechaza. */
export function puedeEditar(resena: ResenaMinima | null | undefined): boolean {
  return Boolean(resena) && !estaEscondida(resena);
}

/** Una puntuación válida es un entero de 1 a 5. Nada más. */
export function puntuacionValida(puntuacion: unknown): boolean {
  return (
    typeof puntuacion === 'number' &&
    Number.isInteger(puntuacion) &&
    puntuacion >= 1 &&
    puntuacion <= 5
  );
}

/** Cuántos caracteres lleva el comentario, para el contador. */
export function largoDelComentario(texto: string | null | undefined): number {
  return (texto ?? '').trim().length;
}

/** El comentario listo para enviar, recortado al tope del servidor. */
export function comentarioParaEnviar(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  if (!limpio) return null;
  return limpio.slice(0, LARGO_MAXIMO_DEL_COMENTARIO);
}

/** Lo que la pantalla va llenando. */
export type BorradorDeResena = {
  overall: number | null;
  quality: number | null;
  fidelity: number | null;
  functioning: number | null;
  value_for_money: number | null;
  recommends: boolean | null;
  comment?: string | null;
};

/** Un borrador vacío, para arrancar el formulario. */
export function borradorVacio(): BorradorDeResena {
  return {
    overall: null,
    quality: null,
    fidelity: null,
    functioning: null,
    value_for_money: null,
    recommends: null,
    comment: '',
  };
}

/**
 * Por qué todavía no se puede enviar, o `null` si ya se puede.
 *
 * LAS SEIS SON OBLIGATORIAS. Lo dice el blueprint: las cinco puntuaciones y la
 * pregunta de si lo recomendaría. El comentario no.
 */
export function motivoParaNoEnviar(
  borrador: BorradorDeResena | null | undefined,
): ClaveDeTraduccion | null {
  if (!borrador) return 'resenaDeProducto.falta.general';
  if (!puntuacionValida(borrador.overall)) return 'resenaDeProducto.falta.general';
  for (const eje of EJES) {
    if (!puntuacionValida(borrador[eje])) return `resenaDeProducto.falta.${eje}`;
  }
  if (typeof borrador.recommends !== 'boolean') {
    return 'resenaDeProducto.falta.recomienda';
  }
  if (largoDelComentario(borrador.comment) > LARGO_MAXIMO_DEL_COMENTARIO) {
    return 'resenaDeProducto.falta.comentarioLargo';
  }
  return null;
}

/** Si el formulario está listo. */
export function sePuedeEnviar(borrador: BorradorDeResena | null | undefined): boolean {
  return motivoParaNoEnviar(borrador) === null;
}

/** Lo que viaja al servidor. NADA MÁS: lo demás lo pone él. */
export type CuerpoDeResena = {
  overall: number;
  quality: number;
  fidelity: number;
  functioning: number;
  value_for_money: number;
  recommends: boolean;
  comment: string | null;
};

/**
 * El cuerpo de la petición.
 *
 * NO LLEVA NI EL PRODUCTO NI EL PEDIDO NI NINGUNA FECHA. Todo lo que verifica
 * la compra lo pone el servidor leyendo las filas, y la base lo vuelve a
 * comprobar. Si esta función los añadiera, «compra verificada» sería un campo
 * de formulario.
 */
export function cuerpoDeResena(borrador: BorradorDeResena): CuerpoDeResena {
  if (!sePuedeEnviar(borrador)) {
    throw new Error('El borrador no está completo');
  }
  return {
    overall: borrador.overall as number,
    quality: borrador.quality as number,
    fidelity: borrador.fidelity as number,
    functioning: borrador.functioning as number,
    value_for_money: borrador.value_for_money as number,
    recommends: borrador.recommends as boolean,
    comment: comentarioParaEnviar(borrador.comment),
  };
}

/** La respuesta del proveedor, lista para enviar, o `null` si está vacía. */
export function respuestaParaEnviar(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  if (!limpio) return null;
  return limpio.slice(0, LARGO_MAXIMO_DE_LA_RESPUESTA);
}

/** Las líneas de un pedido que todavía se pueden valorar. */
export function lineasPendientes(
  lineas: readonly LineaValorable[] | null | undefined,
): LineaValorable[] {
  return (lineas ?? []).filter((l) => l.can_review === true);
}

/** Las que ya se valoraron, para poder ir a la reseña. */
export function lineasYaValoradas(
  lineas: readonly LineaValorable[] | null | undefined,
): LineaValorable[] {
  return (lineas ?? []).filter((l) => typeof l.review_id === 'string' && l.review_id);
}

/**
 * Si desde un pedido tiene sentido ofrecer «valorar».
 *
 * Sin líneas pendientes no se ofrece: el botón llevaría a una pantalla vacía.
 */
export function sePuedeOfrecerValorar(
  lineas: readonly LineaValorable[] | null | undefined,
): boolean {
  return lineasPendientes(lineas).length > 0;
}

/** El cursor de la siguiente página. `null` si no hay más que pedir. */
export function cursorDeLaPagina(
  recibidas: readonly ResenaMinima[] | null | undefined,
  limite: number = POR_PAGINA,
): { before: string; before_id: string } | null {
  const lista = recibidas ?? [];
  if (lista.length < limite) return null;
  const ultima = lista[lista.length - 1];
  if (!ultima?.created_at || !ultima?.id) return null;
  return { before: ultima.created_at, before_id: ultima.id };
}

/** Si puede haber más páginas detrás de esta. */
export function hayMasPaginas(recibidas: number, limite: number = POR_PAGINA): boolean {
  return entero(recibidas) >= entero(limite);
}

/**
 * Pega una página nueva detrás de las anteriores SIN REPETIR.
 *
 * El cursor es estable, pero dos peticiones que se solapan pueden traer la
 * misma fila; quedarse con la primera evita una clave repetida en la lista.
 */
export function fusionarPaginas<T extends { id: string }>(
  anteriores: readonly T[],
  nuevas: readonly T[],
): T[] {
  const vistos = new Set(anteriores.map((x) => x.id));
  return [...anteriores, ...nuevas.filter((x) => !vistos.has(x.id))];
}

/** Si el error dice que las reseñas todavía no están disponibles. */
export function esResenasApagadas(codigo: string | null | undefined): boolean {
  return codigo === 'product_reviews_not_available';
}

/**
 * Cada código que contesta el servidor, con su texto.
 *
 * ES UNA TABLA Y NO UNA LISTA A PROPÓSITO: hay una prueba que lee los códigos
 * del propio servidor y los busca aquí, así que un código nuevo se queda sin
 * texto en rojo y no en silencio.
 */
export const ERRORES_DE_RESENA = {
  product_review_not_allowed: 'resenaDeProducto.error.product_review_not_allowed',
  product_review_already_exists: 'resenaDeProducto.error.product_review_already_exists',
  product_review_not_found: 'resenaDeProducto.error.product_review_not_found',
  product_review_reply_forbidden: 'resenaDeProducto.error.product_review_reply_forbidden',
  product_review_reply_already_exists: 'resenaDeProducto.error.product_review_reply_already_exists',
  product_reviews_not_available: 'resenaDeProducto.error.product_reviews_not_available',
} as const;

/** La clave de traducción del error que contestó el servidor. */
export function claveDeErrorDeResena(
  codigo: string | null | undefined,
): ClaveDeTraduccion {
  if (typeof codigo === 'string' && codigo in ERRORES_DE_RESENA) {
    return ERRORES_DE_RESENA[codigo as keyof typeof ERRORES_DE_RESENA];
  }
  return 'resenaDeProducto.error.desconocido';
}

/**
 * El motivo que viene dentro del detalle de un 409, si lo hay.
 *
 * El servidor manda un CÓDIGO y no una frase, para que la aplicación lo
 * traduzca y una consulta lo pueda agrupar.
 */
export function motivoDelRechazo(detalle: unknown): ClaveDeTraduccion | null {
  if (!detalle || typeof detalle !== 'object') return null;
  const motivo = (detalle as { reason?: unknown }).reason;
  if (typeof motivo !== 'string' || !motivo) return null;
  return claveDelMotivoParaResenar(motivo);
}
