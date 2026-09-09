/**
 * Lo que la consola del organizador puede afirmar de su propio evento.
 *
 * El servidor ya manda `motivo_para_no_enviar` y `editable`; esto NO los
 * recalcula ni los sustituye. Lo que hay aquí es lo que la pantalla necesita
 * para no ofrecer algo que va a fallar y para decidir qué pinta mientras espera
 * la respuesta.
 *
 * Sin importaciones entre ficheros en tiempo de ejecución: ver la nota de
 * `admisionDeEvento.ts`.
 */

/** Los estados en los que el organizador todavía puede escribir. */
export const EDITABLES = ['DRAFT', 'CONDITIONAL'] as const;

/** Los que están esperando a otra persona. */
export const EN_REVISION = ['SUBMITTED', 'CONDITIONAL'] as const;

export function sePuedeEditar(estado: string): boolean {
  return (EDITABLES as readonly string[]).includes(estado);
}

export function estaEnRevision(estado: string): boolean {
  return (EN_REVISION as readonly string[]).includes(estado);
}

/** Si el evento está visible para el público ahora mismo. */
export function estaPublicado(estado: string): boolean {
  return estado === 'PUBLISHED' || estado === 'SOLD_OUT';
}

export type CamposDelBorrador = {
  title: string;
  description: string;
  promise: string;
  category: string;
  location: string;
  eventType: 'online' | 'presential' | 'live';
  /** dd/mm/aaaa. Texto, como en el resto de formularios del proyecto. */
  dia: string;
  /** HH:MM en 24 h. Vacío es VACÍO: no se inventa ninguna hora. */
  hora: string;
  capacity: string;
};

/**
 * Día y hora combinados, o `null` si falta alguno o no son reales.
 *
 * LA HORA NO SE INVENTA. La primera versión de esta pantalla solo pedía el día
 * y componía la fecha con `new Date(a, m - 1, d, 19, 0, 0)`: las siete de la
 * tarde, porque sí. Y esa hora se publicaba —`fechaLargaDelEvento` la imprime
 * en la ficha—, así que quien abría el evento leía «07:00 p. m.» sin que nadie
 * la hubiera escrito. Sin hora no hay fecha, y sin fecha no se puede enviar.
 *
 * Rechaza además lo imposible (31/02, 25:00), que `Date` normalizaría en
 * silencio a otro día.
 */
export function fechaDeInicio(dia: string, hora: string): Date | null {
  const d = dia.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const h = hora.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!d || !h) return null;
  const [, dd, mm, yyyy] = d;
  const [, hh, min] = h;
  if (Number(hh) > 23 || Number(min) > 59) return null;
  const fecha = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(min),
  );
  const coincide =
    fecha.getFullYear() === Number(yyyy) &&
    fecha.getMonth() === Number(mm) - 1 &&
    fecha.getDate() === Number(dd);
  return coincide ? fecha : null;
}

/**
 * Qué le falta al borrador para poder enviarse, como CLAVE de traducción.
 *
 * Se comprueba en el mismo orden que `service.motivo_para_no_enviar`, y con los
 * mismos mínimos, para que la app no diga «ya está» y el servidor conteste que
 * no. Cuando las dos discrepan manda el servidor: esto solo adelanta la frase.
 *
 * NO SE PIDE NADA QUE NO SE PUEDA GUARDAR. Un programa detallado o la lista de
 * participantes no tienen dónde escribirse todavía, así que exigirlos sería un
 * requisito imposible de cumplir.
 */
export function motivoParaNoEnviar(campos: CamposDelBorrador): string | null {
  if (campos.title.trim() === '') return 'miEvento.faltaTitulo';
  if (campos.description.trim().length < 40) return 'miEvento.faltaDescripcion';
  if (campos.promise.trim() === '') return 'miEvento.faltaPromesa';
  if (campos.category.trim() === '') return 'miEvento.faltaCategoria';
  if (campos.dia.trim() === '') return 'miEvento.faltaFecha';
  if (campos.hora.trim() === '') return 'miEvento.faltaHora';
  if (fechaDeInicio(campos.dia, campos.hora) === null) {
    return 'miEvento.fechaImposible';
  }
  if (campos.eventType === 'presential' && campos.location.trim() === '') {
    return 'miEvento.faltaRecinto';
  }
  return null;
}

/**
 * El aforo escrito, o `null` si no hay ninguno.
 *
 * VACÍO NO ES CERO. Un campo en blanco significa «sin límite»; un cero
 * significa «no cabe nadie», y son dos eventos distintos. Un texto que no es un
 * número tampoco se convierte en cero: se trata como si no se hubiera escrito.
 */
export function aforoEscrito(texto: string): number | null {
  const limpio = texto.trim();
  if (limpio === '') return null;
  if (!/^\d+$/.test(limpio)) return null;
  const valor = Number(limpio);
  return Number.isSafeInteger(valor) ? valor : null;
}

/** Si hay algo escrito distinto de lo último confirmado por el servidor. */
export function hayCambiosSinGuardar(
  actual: CamposDelBorrador,
  guardado: CamposDelBorrador,
): boolean {
  const iguales =
    actual.title === guardado.title &&
    actual.description === guardado.description &&
    actual.promise === guardado.promise &&
    actual.category === guardado.category &&
    actual.location === guardado.location &&
    actual.eventType === guardado.eventType &&
    actual.capacity === guardado.capacity &&
    actual.dia === guardado.dia &&
    actual.hora === guardado.hora;
  return !iguales;
}

/**
 * Las categorías que la admisión reconoce, del blueprint §2.
 *
 * NO ES UN CAMPO LIBRE: la categoría decide qué requisitos pide la revisión, y
 * un texto escrito a mano no se puede comparar con nada.
 */
export const CATEGORIAS = [
  'negocios',
  'cultura',
  'bienestar',
  'gastronomia',
  'conocimiento',
  'comunidad',
  'experiencias',
] as const;

export type CategoriaDeEvento = (typeof CATEGORIAS)[number];

export function claveDeCategoria(valor: string | null): string {
  return (CATEGORIAS as readonly string[]).includes(valor ?? '')
    ? `categoriaDeEvento.${valor}`
    : 'categoriaDeEvento.sinDefinir';
}
