/**
 * Las vistas de una conversación: categorías automáticas y filtros de grupo.
 *
 * Aquí está lo que se puede decidir sin pantalla y sin red: leer lo que manda
 * el servidor sin romperse, saber qué pestañas ofrecer, escribir la consulta de
 * una página y juntar páginas sin repetir mensajes.
 *
 * NADA SE FILTRA AQUÍ. Qué mensajes pertenecen a una vista lo decide el
 * servidor (`messaging/vistas.py`), que es quien tiene la conversación entera.
 * Filtrar en el teléfono solo vería las páginas ya descargadas, y enseñaría
 * «no hay fotos» de un chat que las tiene más arriba.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

/** Las categorías automáticas, en el orden en que se ofrecen. */
export const CATEGORIAS = ['all', 'image', 'video', 'document', 'audio', 'link'] as const;
export type Categoria = (typeof CATEGORIAS)[number];

/** Los tipos de contenido que un filtro puede pedir. */
export const TIPOS_DE_CONTENIDO = ['text', 'image', 'video', 'document', 'audio', 'link'] as const;
export type TipoDeContenido = (typeof TIPOS_DE_CONTENIDO)[number];

export type CriteriosDeFiltro = {
  tipos: TipoDeContenido[];
  palabras: string[];
  /** `any`: basta una palabra. `all`: hacen falta todas. */
  modo: 'any' | 'all';
  autores: string[];
};

export type FiltroDeGrupo = {
  id: string;
  nombre: string;
  descripcion: string;
  icono: string;
  criterios: CriteriosDeFiltro;
  /** Apagado: solo lo ve quien administra el grupo. */
  activo: boolean;
};

export type VistasDeChat = {
  esGrupo: boolean;
  /** Cuántos mensajes tiene cada categoría. `all` no se cuenta. */
  cuentas: Record<Categoria, number>;
  /** Este chat puede tener filtros propios (es un grupo y el servidor los conoce). */
  hayFiltros: boolean;
  filtros: FiltroDeGrupo[];
  /** Comodidad para no pintar botones que responderían 403. El permiso es del servidor. */
  puedoAdministrar: boolean;
  iconos: string[];
  maximoDeFiltros: number;
};

const CUENTAS_A_CERO: Record<Categoria, number> = {
  all: 0,
  image: 0,
  video: 0,
  document: 0,
  audio: 0,
  link: 0,
};

/** Lo que se enseña cuando el servidor no contesta o es antiguo: solo «Todo». */
export const SIN_VISTAS: VistasDeChat = {
  esGrupo: false,
  cuentas: CUENTAS_A_CERO,
  hayFiltros: false,
  filtros: [],
  puedoAdministrar: false,
  iconos: [],
  maximoDeFiltros: 0,
};

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const textos = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

function leerCriterios(bruto: unknown): CriteriosDeFiltro | null {
  if (!esObjeto(bruto)) return null;
  const tipos = textos(bruto.types).filter((t): t is TipoDeContenido =>
    (TIPOS_DE_CONTENIDO as readonly string[]).includes(t),
  );
  const palabras = textos(bruto.keywords);
  const autores = textos(bruto.author_ids);
  // Sin ningún criterio no es un filtro: sería el chat entero con otro nombre.
  if (tipos.length + palabras.length + autores.length === 0) return null;
  return { tipos, palabras, modo: bruto.keyword_mode === 'all' ? 'all' : 'any', autores };
}

function leerFiltro(bruto: unknown): FiltroDeGrupo | null {
  if (!esObjeto(bruto)) return null;
  const criterios = leerCriterios(bruto.criteria);
  if (typeof bruto.id !== 'string' || typeof bruto.name !== 'string' || !criterios) return null;
  return {
    id: bruto.id,
    nombre: bruto.name,
    descripcion: typeof bruto.description === 'string' ? bruto.description : '',
    icono: typeof bruto.icon === 'string' && bruto.icon ? bruto.icon : 'filter',
    criterios,
    activo: bruto.enabled !== false,
  };
}

/**
 * Lo que dice `GET /conversations/{id}/views`, leído sin fiarse de nada.
 *
 * Un servidor antiguo que no conozca la ruta, o una respuesta a medias, dejan
 * la pantalla con «Todo» y nada más: nunca una pestaña que no se puede abrir.
 */
export function leerVistas(bruto: unknown): VistasDeChat {
  if (!esObjeto(bruto)) return SIN_VISTAS;

  const cuentas = { ...CUENTAS_A_CERO };
  if (Array.isArray(bruto.categories)) {
    for (const fila of bruto.categories) {
      if (!esObjeto(fila) || typeof fila.key !== 'string') continue;
      if (!(CATEGORIAS as readonly string[]).includes(fila.key)) continue;
      const cuantos = typeof fila.count === 'number' && fila.count > 0 ? Math.floor(fila.count) : 0;
      cuentas[fila.key as Categoria] = cuantos;
    }
  }

  const hayFiltros = bruto.filters_available === true;
  const filtros = hayFiltros && Array.isArray(bruto.filters)
    ? bruto.filters.map(leerFiltro).filter((f): f is FiltroDeGrupo => f !== null)
    : [];

  return {
    esGrupo: bruto.kind === 'group',
    cuentas,
    hayFiltros,
    filtros,
    puedoAdministrar: hayFiltros && bruto.can_manage === true,
    iconos: textos(bruto.icons),
    maximoDeFiltros:
      typeof bruto.max_filters === 'number' && bruto.max_filters > 0 ? bruto.max_filters : 0,
  };
}

/** La vista que se está mirando: una categoría o un filtro del grupo. */
export type VistaElegida =
  | { tipo: 'categoria'; clave: Categoria }
  | { tipo: 'filtro'; id: string };

export const VISTA_TODO: VistaElegida = { tipo: 'categoria', clave: 'all' };

/** Un texto único por vista: para comparar, y como `key` de su pestaña. */
export function claveDeVista(vista: VistaElegida): string {
  return vista.tipo === 'categoria' ? `c:${vista.clave}` : `f:${vista.id}`;
}

export type Pestana =
  | { vista: VistaElegida & { tipo: 'categoria' }; cuantos: number }
  | { vista: VistaElegida & { tipo: 'filtro' }; filtro: FiltroDeGrupo };

/**
 * Las pestañas que se ofrecen, en orden: «Todo», las categorías QUE TIENEN
 * ALGO, y los filtros del grupo.
 *
 * Una categoría a cero no se ofrece: una pestaña que siempre sale vacía es un
 * botón muerto. `conservar` es la vista abierta ahora mismo, que se mantiene
 * aunque se haya quedado a cero —se acaba de borrar su último mensaje— para
 * que la pestaña no desaparezca debajo del dedo.
 */
export function pestanasDe(vistas: VistasDeChat, conservar?: VistaElegida): Pestana[] {
  const abierta = conservar ? claveDeVista(conservar) : null;
  const salida: Pestana[] = [];
  for (const clave of CATEGORIAS) {
    const vista = { tipo: 'categoria' as const, clave };
    const cuantos = vistas.cuentas[clave] ?? 0;
    if (clave === 'all' || cuantos > 0 || claveDeVista(vista) === abierta) {
      salida.push({ vista, cuantos });
    }
  }
  for (const filtro of vistas.filtros) {
    salida.push({ vista: { tipo: 'filtro', id: filtro.id }, filtro });
  }
  return salida;
}

/**
 * Si la vista abierta sigue existiendo.
 *
 * Deja de existir cuando quien administra borra o apaga el filtro que se
 * estaba mirando. Una categoría existe siempre.
 */
export function sigueExistiendo(vistas: VistasDeChat, vista: VistaElegida): boolean {
  return vista.tipo === 'categoria' || vistas.filtros.some((f) => f.id === vista.id);
}

/** El cursor de una página: el instante y el id del último mensaje de la anterior. */
export type CursorDeVista = { antes: string; antesId: string };

export const MENSAJES_POR_PAGINA_DE_VISTA = 30;
export const MAX_BUSQUEDA_EN_VISTA = 80;

/** La consulta de una página de una vista, lista para pegar tras el `?`. */
export function parametrosDeVista(
  vista: VistaElegida,
  {
    buscar = '',
    cursor = null,
    limite = MENSAJES_POR_PAGINA_DE_VISTA,
  }: { buscar?: string; cursor?: CursorDeVista | null; limite?: number } = {},
): string {
  const partes: [string, string][] = [
    vista.tipo === 'categoria' ? ['category', vista.clave] : ['filter_id', vista.id],
  ];
  const texto = buscar.trim().slice(0, MAX_BUSQUEDA_EN_VISTA);
  if (texto) partes.push(['q', texto]);
  if (cursor) {
    partes.push(['before', cursor.antes]);
    partes.push(['before_id', cursor.antesId]);
  }
  partes.push(['limit', String(limite)]);
  return partes.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/**
 * El cursor de la página siguiente, o `null` si no hay más.
 *
 * Hacen falta LOS DOS datos. Con el instante solo, dos mensajes del mismo
 * momento harían que la página siguiente repitiera uno o se lo saltara.
 */
export function leerCursor(bruto: unknown): CursorDeVista | null {
  if (!esObjeto(bruto)) return null;
  const { next_before: antes, next_before_id: antesId } = bruto;
  return typeof antes === 'string' && antes && typeof antesId === 'string' && antesId
    ? { antes, antesId }
    : null;
}

/**
 * Junta lo que ya había con una página nueva, sin repetir ningún mensaje.
 *
 * El cursor ya impide que el servidor repita. Esto cubre lo otro: que la
 * primera página se vuelva a pedir —llegó un mensaje nuevo— mientras hay más
 * páginas cargadas debajo. Gana lo recién llegado, en su sitio.
 */
export function fundirPaginas<T extends { id: string }>(previos: T[], nuevos: T[]): T[] {
  const vistos = new Set<string>();
  const salida: T[] = [];
  for (const mensaje of [...previos, ...nuevos]) {
    if (vistos.has(mensaje.id)) continue;
    vistos.add(mensaje.id);
    salida.push(mensaje);
  }
  return salida;
}

/**
 * Pone delante la primera página recién pedida y conserva lo demás.
 *
 * Los mensajes que ya no vienen en la primera página pero estaban entre los
 * `tope` primeros se quitan: es lo que pasa cuando uno se borra mientras se
 * mira la vista. Sin esto se quedaría en pantalla hasta salir y volver.
 */
export function refrescarPrimeraPagina<T extends { id: string }>(
  previos: T[],
  primera: T[],
  tope: number,
): T[] {
  const frescos = new Set(primera.map((m) => m.id));
  const cola = previos.filter((m, indice) => indice >= tope && !frescos.has(m.id));
  return [...primera, ...cola];
}

/**
 * Para que solo cuente la ÚLTIMA petición lanzada.
 *
 * Quien cambia de pestaña deprisa lanza varias; si la primera tarda más que la
 * segunda, sin esto pintaría las fotos encima de los archivos. `siguiente()`
 * da un turno y `vigente(turno)` dice si sigue siendo el último.
 */
export function crearTurnos(): { siguiente: () => number; vigente: (turno: number) => boolean } {
  let ultimo = 0;
  return {
    siguiente: () => {
      ultimo += 1;
      return ultimo;
    },
    vigente: (turno) => turno === ultimo,
  };
}
