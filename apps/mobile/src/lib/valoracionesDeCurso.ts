import type { TranslationKey } from '@/i18n';

/**
 * Valoraciones de un curso: todo lo que se puede decidir SIN pintar nada.
 *
 * POR QUE VIVE AQUI Y NO DENTRO DEL COMPONENTE. Las dos reglas que de verdad
 * importan en esta funcion no son visuales:
 *
 *   1. `average` puede ser `null`, y `null` NO ES CERO. Un «0,0» debajo del
 *      titulo de un curso dice que esta mal valorado; lo cierto es que todavia
 *      no lo ha valorado nadie. El backend lo deja claro
 *      (`catalog/valoraciones.py`: «`None` y no 0») y aqui se conserva: nada
 *      convierte ese `null` en un numero por el camino.
 *   2. Un fallo con `course_reviews_not_available` NO es un error que ensenar:
 *      es que la migracion 0056 todavia no esta aplicada en esta instalacion.
 *      La seccion entera no se pinta, y no se le cuenta a nadie.
 *
 * Escritas en el `.tsx` no se podrian probar: las pruebas de este proyecto son
 * el runner de Node, sin renderizador de React Native. Aqui si se ejecutan.
 */

/**
 * Como se traduce lo que sale de aqui. Lo pasa quien pinta.
 *
 * Este modulo NO puede importar el diccionario: se prueba con el runner de
 * Node, que no resuelve el alias `@/`. Sin traductor se escribe en español,
 * que es el idioma de referencia.
 */
export type Traductor = (
  clave: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * El español de cada clave. Es el mismo texto que hay en `i18n/es.ts`, y que
 * no se desvien lo comprueba `i18n/diccionariosSincronizados.test.mts`.
 */
export const RESPALDOS_ES = {
  'valoracion.sinValoraciones': 'Sin valoraciones',
  'valoracion.una': '1 valoración',
  'valoracion.varias': '{count} valoraciones',
  'valoracion.deCinco': '{n} de 5',
  'valoracion.resumenA11y': 'Valoración media {media} sobre 5. {total}.',
  'valoracion.distribucionA11y': '{n} de 5: {total}',
  'valoracion.necesitaCompra': 'Solo puede valorar quien ha comprado el curso.',
  'valoracion.necesitaAcceso':
    'Devolviste este curso, así que ya no puedes valorarlo.',
  'valoracion.esTuCurso': 'No puedes valorar un curso que has publicado tú.',
  'valoracion.yaValoraste': 'Ya valoraste este curso. Edita la que ya tienes.',
  'valoracion.noDisponible': 'Las valoraciones todavía no están disponibles.',
  'valoracion.comentarioLargo': 'El comentario no puede pasar de 2000 caracteres.',
  'valoracion.eligePuntuacion': 'Elige una puntuación del 1 al 5.',
  'common.tryAgain': 'Inténtalo de nuevo.',
} as const;

const enEspanol: Traductor = (clave, params) => {
  let texto: string = RESPALDOS_ES[clave as keyof typeof RESPALDOS_ES] ?? '';
  for (const [nombre, valor] of Object.entries(params ?? {})) {
    texto = texto.replace(`{${nombre}}`, String(valor));
  }
  return texto;
};

/** De la mejor a la peor: es el orden en el que se lee la distribucion. */
export const PUNTUACIONES = [5, 4, 3, 2, 1] as const;

/** De la peor a la mejor: es el orden en el que se dibuja una fila de estrellas. */
export const ESTRELLAS = [1, 2, 3, 4, 5] as const;

export type Puntuacion = (typeof PUNTUACIONES)[number];

/** El tope del comentario lo pone el servidor (`ValoracionCreate`). */
export const MAX_COMENTARIO = 2000;

/** Cuantas valoraciones se piden de una vez. El servidor admite hasta 100. */
export const POR_PAGINA = 10;

export type Distribucion = Record<'1' | '2' | '3' | '4' | '5', number>;

export type ResumenDeValoraciones = {
  /** `null` cuando no hay ninguna. NUNCA 0. */
  media: number | null;
  total: number;
  distribucion: Distribucion;
};

/** Lo que llega del servidor, con todo opcional: una API vieja manda menos. */
export type ResumenDto = {
  average?: number | null;
  total?: number | null;
  distribution?: Record<string, number | null | undefined> | null;
};

function enteroNoNegativo(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0
    ? Math.trunc(valor)
    : 0;
}

/**
 * Deja el resumen en la forma que pinta la pantalla.
 *
 * Los cinco cajones se rellenan con 0 cuando faltan, y eso NO es inventar: el
 * servidor los devuelve siempre los cinco (`valoraciones.resumen`), asi que un
 * cajon ausente significa que nadie ha puesto esa nota. La media es distinta:
 * si no viene, no se sustituye por nada.
 */
export function normalizaResumen(
  dto: ResumenDto | null | undefined,
): ResumenDeValoraciones {
  const total = enteroNoNegativo(dto?.total);
  const distribucion: Distribucion = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const n of PUNTUACIONES) {
    const clave = String(n) as keyof Distribucion;
    distribucion[clave] = enteroNoNegativo(dto?.distribution?.[clave]);
  }
  const media =
    typeof dto?.average === 'number' && Number.isFinite(dto.average)
      ? dto.average
      : null;
  // Sin ninguna valoracion no hay media que ensenar, diga lo que diga el campo.
  return { media: total > 0 ? media : null, total, distribucion };
}

/** Si hay media que ensenar. Con `null` o con total 0, no la hay. */
export function hayMedia(resumen: ResumenDeValoraciones): boolean {
  return resumen.media !== null && Number.isFinite(resumen.media) && resumen.total > 0;
}

/** La media con UN decimal, o «Sin valoraciones». Nunca «0.0». */
export function textoDeMedia(
  resumen: ResumenDeValoraciones,
  t: Traductor = enEspanol,
): string {
  return hayMedia(resumen)
    ? (resumen.media as number).toFixed(1)
    : t('valoracion.sinValoraciones');
}

/** «1 valoración» / «{n} valoraciones». El 0 se dice, no se calla. */
function cuenta(cuantas: number, t: Traductor): string {
  return cuantas === 1 ? t('valoracion.una') : t('valoracion.varias', { count: cuantas });
}

/** Cuantas hay. Con ninguna se dice «Sin valoraciones», no «0 valoraciones». */
export function textoDelTotal(total: number, t: Traductor = enEspanol): string {
  const n = enteroNoNegativo(total);
  return n === 0 ? t('valoracion.sinValoraciones') : cuenta(n, t);
}

/** «N de 5». Es lo que se anuncia; las estrellas dibujadas no bastan. */
export function etiquetaDePuntuacion(
  puntuacion: number,
  t: Traductor = enEspanol,
): string {
  return t('valoracion.deCinco', { n: puntuacion });
}

/** Lo que lee el lector de pantalla sobre el resumen: media Y total. */
export function anuncioDelResumen(
  resumen: ResumenDeValoraciones,
  t: Traductor = enEspanol,
): string {
  if (!hayMedia(resumen)) return t('valoracion.sinValoraciones');
  return t('valoracion.resumenA11y', {
    media: textoDeMedia(resumen, t),
    total: textoDelTotal(resumen.total, t),
  });
}

/** Cada fila de la distribucion, para quien no ve la barra. */
export function etiquetaDeDistribucion(
  puntuacion: number,
  cuantas: number,
  t: Traductor = enEspanol,
): string {
  return t('valoracion.distribucionA11y', {
    n: puntuacion,
    total: cuenta(enteroNoNegativo(cuantas), t),
  });
}

/** Cuanto ocupa la barra de una nota, de 0 a 1. Sin total, nada. */
export function proporcionDeBarra(cuantas: number, total: number): number {
  const c = enteroNoNegativo(cuantas);
  const suma = enteroNoNegativo(total);
  if (suma === 0 || c === 0) return 0;
  return Math.min(1, c / suma);
}

/** Lo mismo, ya en la unidad que entiende un estilo. */
export function anchoDeBarra(cuantas: number, total: number): `${number}%` {
  return `${Math.round(proporcionDeBarra(cuantas, total) * 100)}%`;
}

/**
 * Si conviene ofrecer «ver mas».
 *
 * Una pagina corta significa que se acabo. Una pagina llena NO garantiza que
 * haya mas, pero el servidor no dice cuantas quedan, y la lectura segura es
 * ofrecer el boton: quedarse corto esconde valoraciones que existen.
 */
export function hayMasPaginas(recibidas: number, limite: number): boolean {
  return limite > 0 && recibidas >= limite;
}

/**
 * Une la pagina nueva con lo que ya habia, SIN repetir.
 *
 * La paginacion va por posicion (`offset`), asi que una valoracion publicada
 * entre dos peticiones desplaza a las demas y alguna vuelve a llegar. Sin esta
 * union, la misma valoracion aparecia dos veces en la lista.
 */
export function fusionarPaginas<T extends { id: string }>(
  previas: readonly T[],
  nuevas: readonly T[],
): T[] {
  const vistas = new Set(previas.map((v) => v.id));
  return [...previas, ...nuevas.filter((v) => !vistas.has(v.id))];
}

/**
 * La valoracion propia, si esta entre las cargadas.
 *
 * OJO: el servidor no tiene «dame la mia», asi que solo se encuentra si cayo
 * en alguna de las paginas que se han pedido. Cuando no aparece y la persona
 * intenta crear otra, el 409 (`course_review_exists`) es lo que lo dice.
 */
export function miValoracion<T extends { esMia: boolean }>(
  lista: readonly T[],
): T | null {
  return lista.find((v) => v.esMia) ?? null;
}

/** Del 1 al 5, entero. Lo vuelve a comprobar el servidor. */
export function puntuacionValida(puntuacion: number): boolean {
  return Number.isInteger(puntuacion) && puntuacion >= 1 && puntuacion <= 5;
}

/** El comentario que se manda: sin espacios de sobra, y `null` si no hay. */
export function comentarioParaEnviar(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  return limpio === '' ? null : limpio;
}

/** Por que NO se puede enviar todavia, o `null` si se puede. */
export function motivoParaNoEnviar(
  puntuacion: number,
  comentario: string,
  t: Traductor = enEspanol,
): string | null {
  if (!puntuacionValida(puntuacion)) return t('valoracion.eligePuntuacion');
  if ((comentario ?? '').trim().length > MAX_COMENTARIO) {
    return t('valoracion.comentarioLargo');
  }
  return null;
}

/**
 * El codigo del fallo, sin depender de la clase.
 *
 * Se mira la propiedad y no `instanceof ApiError` para que este modulo siga
 * siendo puro: importar el servicio lo ataria a `fetch` y a la configuracion.
 */
export function codigoDeFallo(fallo: unknown): string | null {
  if (typeof fallo === 'object' && fallo !== null && 'code' in fallo) {
    const code = (fallo as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim() !== '') return code;
  }
  return null;
}

/**
 * Si lo que fallo es que ESTA FUNCION NO EXISTE todavia aqui (503).
 *
 * No es un error de nadie: la migracion 0056 no esta aplicada. La seccion no
 * se pinta y no se dice nada, igual que `ReviewRepository.disponibles()` hace
 * con la 0030.
 */
export function seccionNoMontada(fallo: unknown): boolean {
  return codigoDeFallo(fallo) === 'course_reviews_not_available';
}

/**
 * Traduce el fallo del servidor a algo que se pueda LEER Y HACER.
 *
 * Los codigos vienen de `catalog/valoraciones.py` y de `catalog/router.py`.
 * Sin esto, quien devolvio el curso y vuelve a valorarlo leia «No puedes
 * valorar este curso todavía», que no dice ni por que ni si hay algo que
 * cambiar.
 */
export function mensajeDeErrorDeValoracion(
  fallo: unknown,
  t: Traductor = enEspanol,
): string {
  switch (codigoDeFallo(fallo)) {
    case 'review_purchase_required':
      return t('valoracion.necesitaCompra');
    case 'review_access_required':
      return t('valoracion.necesitaAcceso');
    case 'review_owner_not_allowed':
      return t('valoracion.esTuCurso');
    case 'course_review_exists':
      return t('valoracion.yaValoraste');
    case 'course_reviews_not_available':
      return t('valoracion.noDisponible');
    default:
      break;
  }
  // El resto los explica el propio servidor mejor que un texto generico.
  if (fallo instanceof Error && fallo.message.trim() !== '') return fallo.message;
  return t('common.tryAgain');
}
