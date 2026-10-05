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
  /** Fin, opcional. Un evento puede anunciarse sin hora de cierre. */
  diaFin: string;
  horaFin: string;
  /** Zona IANA («America/Lima»). Vacía mientras no se elija: no se supone. */
  timezone: string;
  capacity: string;
};

/**
 * Las zonas horarias que se ofrecen, en formato IANA.
 *
 * NO SE PONE LA DEL TELÉFONO POR DEFECTO. Quien organiza desde un aeropuerto no
 * está creando un evento en la zona del aeropuerto, y `starts_at` guarda el
 * instante: la zona es una afirmación aparte sobre dónde ocurre. Se ofrece la
 * del dispositivo como primera opción de la lista, pero hay que elegirla.
 *
 * La lista es corta a propósito —el mercado inicial es Perú— y crece cuando
 * haya eventos que la necesiten. Un desplegable con las 400 zonas de la base de
 * datos IANA no ayuda a nadie a encontrar la suya.
 */
export const ZONAS_HORARIAS = [
  'America/Lima',
  'America/Bogota',
  'America/Mexico_City',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'America/Sao_Paulo',
  'America/New_York',
  'Europe/Madrid',
] as const;

/** Los nombres que no salen bien de partir el identificador. */
const NOMBRES_DE_ZONA: Readonly<Record<string, string>> = {
  'America/Bogota': 'Bogotá',
  'America/Sao_Paulo': 'São Paulo',
  'America/Mexico_City': 'Ciudad de México',
  'America/New_York': 'Nueva York',
};

/**
 * Cómo se LEE una zona horaria.
 *
 * Lo que se guarda y viaja al servidor sigue siendo el identificador IANA
 * (`America/Argentina/Buenos_Aires`), que es lo único inequívoco. Pero nadie
 * elige su ciudad leyendo eso: en el formulario se enseña «Buenos Aires». Es
 * solo la etiqueta; el valor no cambia.
 *
 * Una zona que no esté en la lista —la del teléfono, por ejemplo— se nombra
 * por su última parte, con los guiones bajos como espacios.
 */
export function nombreDeZona(zona: string): string {
  const conocido = NOMBRES_DE_ZONA[zona];
  if (conocido) return conocido;
  const ciudad = (zona.split('/').pop() ?? '').replace(/_/g, ' ').trim();
  return ciudad || zona;
}

/** La zona del dispositivo, si es una IANA reconocible. `''` si no. */
export function zonaDelDispositivo(): string {
  try {
    const zona = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zona === 'string' && zona.includes('/') ? zona : '';
  } catch {
    return '';
  }
}

/** Si el texto tiene forma de zona IANA. No valida que exista. */
export function pareceZonaIana(valor: string): boolean {
  return /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(valor.trim());
}

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
export function motivoParaNoEnviar(
  campos: CamposDelBorrador,
  { flexible = false }: { flexible?: boolean } = {},
): string | null {
  if (campos.title.trim() === '') return 'miEvento.faltaTitulo';
  // MODO FLEXIBLE (`MINIMO_DE_DESCRIPCION_FLEXIBLE` del servidor): basta una
  // frase de 10 caracteres y la promesa es opcional, porque nadie evalúa.
  if (flexible) {
    if (campos.description.trim().length < 10) return 'miEvento.faltaDescripcionCorta';
  } else {
    if (campos.description.trim().length < 40) return 'miEvento.faltaDescripcion';
    if (campos.promise.trim() === '') return 'miEvento.faltaPromesa';
  }
  if (campos.category.trim() === '') return 'miEvento.faltaCategoria';
  if (campos.dia.trim() === '') return 'miEvento.faltaFecha';
  if (campos.hora.trim() === '') return 'miEvento.faltaHora';
  if (fechaDeInicio(campos.dia, campos.hora) === null) {
    return 'miEvento.fechaImposible';
  }
  if (campos.eventType === 'presential' && campos.location.trim() === '') {
    return 'miEvento.faltaRecinto';
  }
  if (campos.timezone.trim() === '') return 'miEvento.faltaZona';
  if (!pareceZonaIana(campos.timezone)) return 'miEvento.zonaInvalida';
  const fin = fechaDeFin(campos);
  if (fin === 'invalida') return 'miEvento.finImposible';
  if (fin === 'anterior') return 'miEvento.finAntesDelInicio';
  return null;
}

/**
 * La fecha de fin: `null` si no se puso, la fecha, o por qué no vale.
 *
 * SE ADMITE SIN FIN. Un evento puede anunciarse sin hora de cierre y el modelo
 * lo permite (`ends_at` es anulable). Lo que no se admite es un fin ANTERIOR al
 * inicio, que no es un evento: es un error de tecleo que después sale impreso
 * en la ficha como un rango al revés.
 *
 * Poner solo el día o solo la hora es incompleto, no vacío: se rechaza en vez
 * de completar la otra mitad por nuestra cuenta.
 */
export function fechaDeFin(
  campos: CamposDelBorrador,
): Date | null | 'invalida' | 'anterior' {
  const dia = campos.diaFin.trim();
  const hora = campos.horaFin.trim();
  if (dia === '' && hora === '') return null;
  if (dia === '' || hora === '') return 'invalida';
  const fin = fechaDeInicio(dia, hora);
  if (fin === null) return 'invalida';
  const inicio = fechaDeInicio(campos.dia, campos.hora);
  if (inicio !== null && fin.getTime() < inicio.getTime()) return 'anterior';
  return fin;
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
    actual.hora === guardado.hora &&
    actual.diaFin === guardado.diaFin &&
    actual.horaFin === guardado.horaFin &&
    actual.timezone === guardado.timezone;
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
