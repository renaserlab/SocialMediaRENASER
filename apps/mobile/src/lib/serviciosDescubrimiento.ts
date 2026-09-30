/**
 * Z Servicios, Incremento 3: el descubrimiento, del lado del teléfono.
 *
 * LÓGICA PURA, para probarla con `node --test`: los contratos de la API, los
 * filtros como estado de la pantalla (y de la ruta, para que «Atrás» y un
 * enlace los conserven), la consulta que se manda, y las claves de traducción
 * de órdenes, motivos, señales de confianza y reseñas.
 *
 * LO QUE ESTE FICHERO NO DECIDE: qué servicio es público, qué coincide con una
 * búsqueda, en qué orden salen, qué credencial cuenta ni por qué se sugiere
 * algo. Lo decide el servidor, EN LA BASE; aquí no se filtra ni se ordena
 * ninguna lista. Lo único que se revisa antes es lo que el servidor rechazaría
 * igual (una sola letra, un rango sin moneda), para decirlo sin esperar.
 *
 * NADA INVENTADO: sin reseñas no hay estrellas ni «0.0»; una señal de
 * confianza solo se enseña si es verdad; un motivo desconocido no se pinta.
 */
import { importeEscrito } from '@/lib/proveedorDeProductos';
import {
  MODALIDADES,
  MONEDAS,
  type CategoriaPublica,
  type Contenido,
  type Frase,
  type ImagenPublica,
  type Modalidad,
  type Pagina,
  type Precio,
} from '@/lib/serviciosCatalogo';

// --------------------------------------------------------------------------- //
// Valores cerrados (los mismos que el servidor; una prueba los compara)
// --------------------------------------------------------------------------- //
export const ORDENES = ['relevance', 'recent', 'price_asc', 'price_desc'] as const;
export type Orden = (typeof ORDENES)[number];

export const TIPOS_DE_PRECIO = ['free', 'priced', 'on_request'] as const;
export type TipoDePrecio = (typeof TIPOS_DE_PRECIO)[number];

export const MOTIVOS = [
  'matches_search',
  'similar_to_saved',
  'recently_published',
  'same_provider',
  'same_category',
] as const;
export type Motivo = (typeof MOTIVOS)[number];

export const CAMPOS_DE_COINCIDENCIA = [
  'title',
  'category',
  'summary',
  'description',
  'provider',
  'area',
  'modality',
] as const;

export const LARGO_MAXIMO_DE_BUSQUEDA = 120;
export const LARGO_MAXIMO_DE_ZONA = 80;
/** El blueprint: «Frecuentes», máximo cuatro; «Ver todas» abre el resto. */
export const CATEGORIAS_FRECUENTES = 4;
export const TAMANO_DE_PAGINA = 20;

// --------------------------------------------------------------------------- //
// Contratos de la API
// --------------------------------------------------------------------------- //
export type CategoriaDelCatalogo = CategoriaPublica & { parent_id: string | null };

export type TarjetaDeServicio = {
  id: string;
  title: string | null;
  summary: string | null;
  category: CategoriaDelCatalogo;
  modality: string | null;
  location_area: string | null;
  duration_minutes: number | null;
  price: Precio;
  cover: { url: string | null; alt_text: string } | null;
  provider: { id: string; display_name: string };
  credential_verified: boolean;
  saved: boolean;
  reason: string | null;
  reason_fields: string[];
};

export type PaginaDelCatalogo = Pagina<TarjetaDeServicio> & { sort: string };

export type Confianza = {
  admitted_since: string | null;
  identity_verified: boolean;
  credential_verified: boolean;
};

/** Las reseñas VERIFICADAS del servicio. Hoy siempre 0 y `null`. */
export type Resenas = { count: number; average: number | null };

export type FichaPublica = Contenido & {
  id: string;
  category: CategoriaPublica;
  category_parent_id: string | null;
  provider: { id: string; display_name: string; provider_type: string; trust: Confianza };
  images: ImagenPublica[];
  published_at: string;
  approved_by_z: boolean;
  reviews: Resenas;
  saved: boolean;
  more_from_provider: TarjetaDeServicio[];
  related: TarjetaDeServicio[];
};

export type PerfilDePrestador = {
  id: string;
  display_name: string;
  provider_type: string;
  trust: Confianza;
  categories: CategoriaDelCatalogo[];
  modalities: string[];
  areas: string[];
  reviews: Resenas;
};

export type SeccionDeSugerencias = { reason: string; items: TarjetaDeServicio[] };

export type Guardado = {
  service_id: string;
  saved_at: string;
  available: boolean;
  title: string | null;
  service: TarjetaDeServicio | null;
};

// --------------------------------------------------------------------------- //
// Los filtros: estado de la pantalla y de la ruta
// --------------------------------------------------------------------------- //
export type Filtros = {
  q: string;
  categoria: string | null;
  modalidad: Modalidad | null;
  precio: TipoDePrecio | null;
  moneda: string | null;
  /** Como se escriben («120,50»), no en unidades menores. */
  minimo: string;
  maximo: string;
  zona: string;
  conCredencial: boolean;
  orden: Orden | null;
};

export const SIN_FILTROS: Filtros = {
  q: '',
  categoria: null,
  modalidad: null,
  precio: null,
  moneda: null,
  minimo: '',
  maximo: '',
  zona: '',
  conCredencial: false,
  orden: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uno<T extends string>(lista: readonly T[], valor: unknown): T | null {
  return typeof valor === 'string' && (lista as readonly string[]).includes(valor) ? (valor as T) : null;
}

function texto(valor: unknown): string {
  const v = Array.isArray(valor) ? valor[0] : valor;
  return typeof v === 'string' ? v : '';
}

/**
 * Los filtros desde los parámetros de la ruta. LO QUE NO SE ENTIENDE SE
 * DESCARTA (un enlace viejo o tocado a mano no rompe la pantalla), y lo que se
 * guarda es siempre un valor cerrado.
 */
export function filtrosDesdeRuta(params: Record<string, unknown>): Filtros {
  const categoria = texto(params.categoria);
  const moneda = texto(params.moneda).trim().toUpperCase();
  const precio = uno(TIPOS_DE_PRECIO, texto(params.precio));
  // «Gratis» y «a consultar» no tienen importe: una moneda o un rango con
  // ellos es un enlace contradictorio, y se descartan.
  const sinImporte = precio === 'free' || precio === 'on_request';
  return {
    q: texto(params.q).slice(0, LARGO_MAXIMO_DE_BUSQUEDA),
    categoria: UUID.test(categoria) ? categoria : null,
    modalidad: uno(MODALIDADES, texto(params.modalidad)),
    precio,
    moneda: !sinImporte && (MONEDAS as readonly string[]).includes(moneda) ? moneda : null,
    minimo: sinImporte ? '' : texto(params.minimo).slice(0, 20),
    maximo: sinImporte ? '' : texto(params.maximo).slice(0, 20),
    zona: texto(params.zona).slice(0, LARGO_MAXIMO_DE_ZONA),
    conCredencial: texto(params.credencial) === '1',
    orden: uno(ORDENES, texto(params.orden)),
  };
}

/** Los filtros como parámetros de ruta: solo lo que tiene valor. */
export function rutaDesdeFiltros(f: Filtros): Record<string, string> {
  const salida: Record<string, string> = {};
  if (f.q.trim()) salida.q = f.q.trim();
  if (f.categoria) salida.categoria = f.categoria;
  if (f.modalidad) salida.modalidad = f.modalidad;
  if (f.precio) salida.precio = f.precio;
  if (f.moneda) salida.moneda = f.moneda;
  if (f.minimo.trim()) salida.minimo = f.minimo.trim();
  if (f.maximo.trim()) salida.maximo = f.maximo.trim();
  if (f.zona.trim()) salida.zona = f.zona.trim();
  if (f.conCredencial) salida.credencial = '1';
  if (f.orden) salida.orden = f.orden;
  return salida;
}

/** Cuántos filtros hay puestos (sin contar la búsqueda ni el orden). */
export function cuantosFiltros(f: Filtros): number {
  return [
    f.categoria,
    f.modalidad,
    f.precio,
    f.moneda,
    f.minimo.trim() || f.maximo.trim() ? 'rango' : null,
    f.zona.trim() || null,
    f.conCredencial ? 'credencial' : null,
  ].filter(Boolean).length;
}

/** Limpiar los filtros deja la búsqueda: es otra cosa. */
export function limpiarFiltros(f: Filtros): Filtros {
  return { ...SIN_FILTROS, q: f.q };
}

/** ¿Se está buscando o filtrando? Sin nada, se enseñan las sugerencias. */
export function estaBuscando(f: Filtros): boolean {
  return f.q.trim() !== '' || cuantosFiltros(f) > 0;
}

/**
 * Los órdenes que tienen sentido: relevancia solo con una búsqueda; por
 * precio solo con una moneda (no se comparan importes de monedas distintas).
 */
export function ordenesPosibles(f: Filtros): Orden[] {
  const salida: Orden[] = [];
  if (f.q.trim()) salida.push('relevance');
  salida.push('recent');
  if (f.moneda && f.precio !== 'free' && f.precio !== 'on_request') salida.push('price_asc', 'price_desc');
  return salida;
}

/** El orden que se pide: el elegido si sigue teniendo sentido. */
export function ordenElegido(f: Filtros): Orden {
  const posibles = ordenesPosibles(f);
  if (f.orden && posibles.includes(f.orden)) return f.orden;
  return posibles[0] ?? 'recent';
}

/** Un fallo de un filtro, dicho antes de pedir (el servidor diría lo mismo). */
export type FalloDeFiltro = { campo: string; clave: string };

function menores(valor: string, moneda: string | null): number | null | 'invalido' {
  return importeEscrito(valor, moneda);
}

/** Las palabras de dos letras o más, como las cuenta el servidor (el `_`
 *  también separa). «a b» no tiene ninguna. */
function palabrasUtiles(texto: string): string[] {
  return texto.split(/[^\p{L}\p{N}]+|_/u).filter((p) => p.length >= 2);
}

export function revisarFiltros(f: Filtros): FalloDeFiltro | null {
  const q = f.q.trim();
  if (q && palabrasUtiles(q).length === 0) {
    return { campo: 'q', clave: 'servicios.descubrir.error.consultaCorta' };
  }
  if (f.zona.trim() && palabrasUtiles(f.zona).length === 0) {
    return { campo: 'zona', clave: 'servicios.descubrir.error.filtro' };
  }
  const minimo = menores(f.minimo, f.moneda);
  const maximo = menores(f.maximo, f.moneda);
  if ((minimo !== null || maximo !== null) && !f.moneda) {
    return { campo: 'moneda', clave: 'servicios.descubrir.error.moneda' };
  }
  if (minimo === 'invalido') return { campo: 'minimo', clave: 'servicios.descubrir.error.importe' };
  if (maximo === 'invalido') return { campo: 'maximo', clave: 'servicios.descubrir.error.importe' };
  if (typeof minimo === 'number' && typeof maximo === 'number' && minimo > maximo) {
    return { campo: 'minimo', clave: 'servicios.descubrir.error.rango' };
  }
  if (f.zona.trim().length > LARGO_MAXIMO_DE_ZONA) {
    return { campo: 'zona', clave: 'servicios.descubrir.error.filtro' };
  }
  return null;
}

/**
 * La consulta de `GET /services/catalog`. EL SERVIDOR FILTRA: aquí solo se
 * traducen los nombres, y el importe se manda en unidades menores de SU
 * moneda. Sin moneda no se manda ningún importe.
 */
export function consultaDelCatalogo(f: Filtros, cursor: string | null, limite = TAMANO_DE_PAGINA): string {
  const partes: [string, string][] = [];
  const q = f.q.trim();
  if (q) partes.push(['q', q]);
  if (f.categoria) partes.push(['category_id', f.categoria]);
  if (f.modalidad) partes.push(['modality', f.modalidad]);
  if (f.precio === 'free' || f.precio === 'on_request') {
    // Sin importe: ni moneda ni rango (el servidor lo tomaría por contradicción).
    partes.push(['price', f.precio]);
  } else {
    if (f.precio === 'priced' && !f.moneda) partes.push(['price', 'priced']);
    if (f.moneda) {
      partes.push(['currency', f.moneda]);
      const minimo = menores(f.minimo, f.moneda);
      const maximo = menores(f.maximo, f.moneda);
      if (typeof minimo === 'number') partes.push(['min_price', String(minimo)]);
      if (typeof maximo === 'number') partes.push(['max_price', String(maximo)]);
    }
  }
  if (f.zona.trim()) partes.push(['area', f.zona.trim()]);
  if (f.conCredencial) partes.push(['credential_verified', 'true']);
  partes.push(['sort', ordenElegido(f)]);
  partes.push(['limit', String(limite)]);
  if (cursor) partes.push(['cursor', cursor]);
  return partes.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

// --------------------------------------------------------------------------- //
// Listas
// --------------------------------------------------------------------------- //
/** Añade la página siguiente SIN repetir: si alguien publica entre dos
 *  páginas, una tarjeta nunca sale dos veces. No filtra ni reordena. */
export function juntarSinRepetir<T extends { id: string }>(ya: readonly T[], nuevas: readonly T[]): T[] {
  const vistos = new Set(ya.map((t) => t.id));
  return [...ya, ...nuevas.filter((t) => !vistos.has(t.id))];
}

/** Marca guardado o no un servicio en una lista, tras la respuesta del servidor. */
export function conGuardado<T extends { id: string; saved: boolean }>(
  lista: readonly T[],
  id: string,
  guardado: boolean,
): T[] {
  return lista.map((t) => (t.id === id ? { ...t, saved: guardado } : t));
}

/** Las de primer nivel, en su orden, como «Frecuentes» (máximo cuatro). */
export function categoriasFrecuentes(
  todas: readonly CategoriaDelCatalogo[],
  n = CATEGORIAS_FRECUENTES,
): CategoriaDelCatalogo[] {
  return todas.filter((c) => c.parent_id === null).slice(0, n);
}

// --------------------------------------------------------------------------- //
// Claves de traducción
// --------------------------------------------------------------------------- //
export function claveDelOrden(orden: string): string {
  return uno(ORDENES, orden) ? `servicios.descubrir.orden.${orden}` : 'servicios.descubrir.orden.recent';
}

export function claveDelTipoDePrecio(tipo: string | null): string {
  return tipo && uno(TIPOS_DE_PRECIO, tipo)
    ? `servicios.descubrir.precio.${tipo}`
    : 'servicios.descubrir.precio.cualquiera';
}

/** El motivo de una tarjeta, o `null` si no hay (o es uno que no se conoce:
 *  un motivo desconocido no se inventa ni se enseña en crudo). */
export function motivoLegible(tarjeta: Pick<TarjetaDeServicio, 'reason' | 'reason_fields'>): {
  clave: string;
  campos: string[];
} | null {
  const motivo = uno(MOTIVOS, tarjeta.reason);
  if (!motivo) return null;
  const campos =
    motivo === 'matches_search'
      ? tarjeta.reason_fields
          .filter((c) => (CAMPOS_DE_COINCIDENCIA as readonly string[]).includes(c))
          .map((c) => `servicios.descubrir.campo.${c}`)
      : [];
  return { clave: `servicios.descubrir.motivo.${motivo}`, campos };
}

/** La sección de sugerencias, con su título; `null` si el motivo no se conoce. */
export function claveDeLaSeccion(motivo: string): string | null {
  return uno(MOTIVOS, motivo) ? `servicios.descubrir.seccion.${motivo}` : null;
}

/** «09/2026»: el mes y el año, sin depender del idioma. */
export function mesYAno(iso: string | null | undefined): string {
  if (!iso) return '';
  const partes = /^(\d{4})-(\d{2})/.exec(iso);
  return partes ? `${partes[2]}/${partes[1]}` : '';
}

/**
 * Las señales de confianza que SON VERDAD, en el orden en que se leen, y
 * nombrando exactamente lo que Z comprobó. Ninguna promete el resultado.
 */
export function senalesDeConfianza(trust: Confianza | null | undefined): Frase[] {
  if (!trust) return [];
  const salida: Frase[] = [];
  const fecha = mesYAno(trust.admitted_since);
  if (fecha) salida.push({ clave: 'servicios.descubrir.confianza.admitido', params: { fecha } });
  if (trust.identity_verified === true) salida.push({ clave: 'servicios.descubrir.confianza.identidad' });
  if (trust.credential_verified === true) salida.push({ clave: 'servicios.descubrir.confianza.credencial' });
  return salida;
}

/**
 * Las reseñas, en palabras. SIN RESEÑAS VERIFICADAS NO HAY NOTA: ni «0.0» ni
 * estrellas vacías. (Hoy no existen: llegan con el Incremento 6.)
 */
export function resenasLegibles(resenas: Resenas | null | undefined): Frase {
  const cuantas = resenas?.count ?? 0;
  const media = resenas?.average ?? null;
  if (cuantas <= 0 || media === null || !Number.isFinite(media)) {
    return { clave: 'servicios.descubrir.resenas.ninguna' };
  }
  return { clave: 'servicios.descubrir.resenas.media', params: { media: media.toFixed(1), n: cuantas } };
}

export function claveDelTipoDePrestador(tipo: string | null | undefined): string {
  return tipo === 'individual' || tipo === 'company'
    ? `servicios.descubrir.tipo.${tipo}`
    : 'servicios.descubrir.tipo.desconocido';
}

// --------------------------------------------------------------------------- //
// Errores
// --------------------------------------------------------------------------- //
const ERRORES: Record<string, string> = {
  service_catalog_query_too_short: 'servicios.descubrir.error.consultaCorta',
  service_catalog_filter_invalid: 'servicios.descubrir.error.filtro',
  service_catalog_currency_required: 'servicios.descubrir.error.moneda',
  service_provider_not_found: 'servicios.descubrir.error.prestadorNoEncontrado',
  invalid_cursor: 'servicios.descubrir.error.cursor',
};

/** Los códigos propios del descubrimiento. Una prueba los compara con el servidor. */
export const CODIGOS_DE_ERROR_DEL_DESCUBRIMIENTO = Object.keys(ERRORES);

export function claveDeErrorDelDescubrimiento(codigo: string | null | undefined): string | null {
  return codigo ? (ERRORES[codigo] ?? null) : null;
}
