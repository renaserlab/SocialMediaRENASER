/**
 * Z Servicios, Incremento 2: el catálogo de servicios, del lado del teléfono.
 *
 * LÓGICA PURA, para probarla con `node --test`: los contratos de la API, las
 * claves de traducción de cada estado, requisito, campo y error, el formulario
 * del borrador (qué cambió y qué rechazaría el servidor, dicho antes) y el de
 * las categorías. Quien pinta traduce y navega.
 *
 * LO QUE ESTE FICHERO NO DECIDE, igual que en la admisión: qué le falta a un
 * borrador para enviarse (`missing`), qué se puede hacer con él (`can_*`), qué
 * decisiones tiene a mano el equipo (`actions`) ni si el público lo ve
 * (`publicly_visible`). Lo dice el servidor; aquí solo se traduce. Si el
 * teléfono lo calculara, una versión vieja instalada ofrecería un botón que el
 * servidor ya no acepta.
 *
 * NINGÚN CÓDIGO INTERNO LLEGA A LA PANTALLA: lo desconocido se traduce a un
 * texto genérico, nunca se imprime tal cual.
 *
 * EL DINERO NO SE REINVENTA: escribir «49.90» y guardar 4990 (y al revés) es lo
 * mismo que en Productos, con los decimales de cada moneda, y se usa de allí.
 */
import { importeComoTexto, importeEscrito } from '@/lib/proveedorDeProductos';
import { falloDeCarga, hayQueRecargar, type FalloDeCarga } from '@/lib/serviciosAdmision';

// --------------------------------------------------------------------------- //
// Valores cerrados (los mismos que el servidor; una prueba los compara)
// --------------------------------------------------------------------------- //
export const ESTADOS_DEL_SERVICIO = ['draft', 'published', 'suspended', 'retired'] as const;
export type EstadoDelServicio = (typeof ESTADOS_DEL_SERVICIO)[number];

export const ESTADOS_DE_LA_VERSION = [
  'draft',
  'submitted',
  'under_review',
  'changes_requested',
  'approved',
  'published',
  'superseded',
  'withdrawn',
] as const;
export type EstadoDeLaVersion = (typeof ESTADOS_DE_LA_VERSION)[number];

export const MODALIDADES = ['virtual', 'in_person', 'at_home'] as const;
export type Modalidad = (typeof MODALIDADES)[number];

/**
 * LAS QUE Z OFRECE en la primera versión (política P5): en línea y en el local
 * del prestador. «A domicilio» sigue en el modelo —un servicio que ya la tuviera
 * se sigue leyendo y nombrando—, pero ningún formulario ni filtro la ofrece. El
 * servidor es quien manda (`SERVICES_CATALOG_MODALITIES`): si alguien la envía
 * a mano, contesta `service_modality_not_allowed`. Volver a ofrecerla es
 * añadirla aquí Y allí.
 */
export const MODALIDADES_OFRECIDAS = ['virtual', 'in_person'] as const satisfies readonly Modalidad[];

export const MODELOS_DE_PRECIO = ['free', 'fixed', 'from', 'on_request'] as const;
export type ModeloDePrecio = (typeof MODELOS_DE_PRECIO)[number];

/** Los modelos que llevan importe. Los demás NO lo admiten. */
export const CON_IMPORTE: readonly ModeloDePrecio[] = ['fixed', 'from'];

export const TIPOS_DE_IMAGEN = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PESO_MAXIMO_DE_IMAGEN = 5 * 1024 * 1024;

/** Los códigos de `missing`, en el orden en que el formulario los pide. */
export const REQUISITOS = [
  'provider_not_active',
  'category_inactive',
  'title',
  'summary',
  'description',
  'modality',
  'modality_not_allowed',
  'duration',
  'duration_out_of_range',
  'price_model',
  'price_model_not_allowed',
  'price',
  'currency',
  'currency_not_allowed',
  'scope',
  'includes',
  'excludes',
  'requirements',
  'location_area',
  'cover_image',
  'too_many_images',
] as const;

/** Los campos que el equipo de Z puede señalar al pedir cambios. */
export const CAMPOS_SENALABLES = [
  'category',
  'title',
  'summary',
  'description',
  'modality',
  'duration',
  'capacity',
  'price',
  'scope',
  'includes',
  'excludes',
  'requirements',
  'conditions',
  'location_area',
  'images',
] as const;

/** Las decisiones del equipo. Las cuatro primeras son sobre la versión propuesta. */
export const ACCIONES_DEL_CATALOGO = [
  'start_review',
  'request_changes',
  'approve',
  'publish',
  'suspend',
  'reinstate',
  'retire',
] as const;
export type AccionDelCatalogo = (typeof ACCIONES_DEL_CATALOGO)[number];

/** Lo que queda escrito en el historial. */
export const SUCESOS = [
  'created',
  'draft_opened',
  'submitted',
  'resubmitted',
  'withdrawn',
  'review_started',
  'changes_requested',
  'approved',
  'published',
  'superseded',
  'suspended',
  'reinstated',
  'retired',
] as const;

/** Las colas de la bandeja. `pending` = lo que espera a Z (lo de fábrica). */
export const COLAS = ['pending', 'draft', 'published', 'suspended', 'retired', 'all'] as const;
export type Cola = (typeof COLAS)[number];
export const TAMANO_DE_PAGINA = 20;

/** Los largos que el servidor acepta (`catalogo_schemas.BorradorEditar`). */
export const LARGOS = {
  titulo: [3, 120],
  resumen: [10, 280],
  descripcion: [20, 5000],
  alcance: [10, 2000],
  requisitos: [3, 2000],
  condiciones: [0, 2000],
  zona: [2, 120],
  frase: [2, 200],
  alternativo: [3, 300],
  nota: [3, 2000],
  notaInterna: [0, 4000],
} as const;
export const MAXIMO_DE_FRASES = 20;
export const DURACION = [5, 1440] as const;
export const CAPACIDAD = [1, 1000] as const;

/**
 * La moneda de la primera versión (política P2): soles. Es una lista propia de
 * Servicios, no la de Productos, que ofrece también dólares y euros. El
 * servidor es quien manda (`SERVICES_CATALOG_CURRENCIES`): otra moneda escrita
 * a mano contesta `service_currency_not_allowed`. No se convierte nada.
 */
export const MONEDAS = ['PEN'] as const;

// --------------------------------------------------------------------------- //
// Contratos de la API (`catalogo_schemas.py`)
// --------------------------------------------------------------------------- //
export type Categoria = {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  name_pt: string | null;
  description: string | null;
  icon: string | null;
  parent_id: string | null;
  country_code: string | null;
  sort_order: number;
  status: string;
};

export type CategoriaPublica = Pick<Categoria, 'id' | 'slug' | 'name' | 'name_en' | 'name_pt' | 'icon'>;

export type Imagen = {
  id: string;
  /** Firmada y con caducidad. `null` si el almacenamiento no contestó: NO es un fallo. */
  url: string | null;
  alt_text: string;
  position: number;
  is_cover: boolean;
  width: number;
  height: number;
};

export type Precio = {
  /** `null` = sin configurar. NO es gratis. */
  model: string | null;
  amount_minor: number | null;
  currency: string | null;
};

export type Contenido = {
  title: string | null;
  summary: string | null;
  description: string | null;
  modality: string | null;
  duration_minutes: number | null;
  /**
   * SOLO LLEGA A QUIEN GESTIONA el servicio (su prestador y administración).
   * La ficha pública no la trae (política P51): al público le basta con saber
   * si hay horario.
   */
  capacity?: number | null;
  price: Precio;
  scope: string | null;
  includes: string[];
  excludes: string[];
  requirements: string | null;
  conditions: string | null;
  location_area: string | null;
};

export type Version = Contenido & {
  id: string;
  version: number;
  status: string;
  based_on_version: number | null;
  images: Imagen[];
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  published_at: string | null;
};

export type Observacion = {
  action: string;
  note: string;
  fields: string[];
  version: number | null;
  created_at: string;
};

export type ServicioPrivado = {
  id: string;
  status: string;
  /** El título que lo nombra: la abierta, la publicada o la última. */
  title: string | null;
  /** El estado de la ÚLTIMA versión: `changes_requested` = hay algo que corregir. */
  last_version_status: string | null;
  category: Categoria;
  created_at: string;
  updated_at: string;
  first_published_at: string | null;
  published_at: string | null;
  suspended_at: string | null;
  retired_at: string | null;
  published_version: Version | null;
  open_version: Version | null;
  last_observation: Observacion | null;
  missing: string[];
  can_edit: boolean;
  can_submit: boolean;
  can_withdraw: boolean;
  can_open_draft: boolean;
  publicly_visible: boolean;
  /** Si puede preparar su agenda (Incremento 4). Lo decide el servidor. */
  can_manage_schedule?: boolean;
};

export type ServicioResumen = {
  id: string;
  status: string;
  title: string | null;
  category: CategoriaPublica;
  open_version_status: string | null;
  last_version_status: string | null;
  has_published_version: boolean;
  cover_url: string | null;
  updated_at: string;
};

export type Pagina<T> = { items: T[]; next_cursor: string | null };

export type EventoVisible = {
  id: string;
  action: string;
  from_status: string | null;
  to_status: string;
  version: number | null;
  note: string | null;
  fields: string[];
  created_at: string;
};

export type EventoAdmin = EventoVisible & {
  actor_id: string | null;
  actor_role: string;
  internal_note: string | null;
};

export type PrestadorEnServicio = {
  id: string;
  display_name: string;
  provider_type: string;
  country_code: string | null;
  status: string;
};

export type VersionEnLista = {
  id: string;
  version: number;
  status: string;
  submitted_at: string | null;
  decided_at: string | null;
  published_at: string | null;
};

export type ServicioAdmin = {
  id: string;
  status: string;
  title: string | null;
  category: Categoria;
  provider: PrestadorEnServicio;
  created_at: string;
  updated_at: string;
  first_published_at: string | null;
  published_at: string | null;
  suspended_at: string | null;
  retired_at: string | null;
  published_version: Version | null;
  proposed_version: Version | null;
  changed_fields: string[];
  versions: VersionEnLista[];
  last_observation: Observacion | null;
  actions: string[];
  own: boolean;
  publicly_visible: boolean;
};

export type ServicioAdminResumen = {
  id: string;
  status: string;
  title: string | null;
  category: CategoriaPublica;
  modality: string | null;
  provider_name: string;
  provider_status: string;
  open_version_status: string | null;
  open_version: number | null;
  submitted_at: string | null;
  updated_at: string;
};

export type ImagenPublica = Pick<Imagen, 'url' | 'alt_text' | 'width' | 'height' | 'is_cover'>;

export type ServicioPublico = Contenido & {
  id: string;
  category: CategoriaPublica;
  provider: { display_name: string };
  images: ImagenPublica[];
  published_at: string;
};

// --------------------------------------------------------------------------- //
// Claves de traducción
// --------------------------------------------------------------------------- //
function esUno<T extends string>(lista: readonly T[], valor: string | null | undefined): valor is T {
  return typeof valor === 'string' && (lista as readonly string[]).includes(valor);
}

export function claveDelEstadoDelServicio(estado: string): string {
  return esUno(ESTADOS_DEL_SERVICIO, estado)
    ? `servicios.catalogo.estado.${estado}`
    : 'servicios.catalogo.estado.desconocido';
}

/** Lo que significa ese estado para quien ofrece el servicio, en una frase. */
export function claveDelCuerpoDelEstado(estado: string): string {
  return esUno(ESTADOS_DEL_SERVICIO, estado)
    ? `servicios.catalogo.estadoCuerpo.${estado}`
    : 'servicios.catalogo.estadoCuerpo.desconocido';
}

export function claveDelEstadoDeLaVersion(estado: string | null | undefined): string {
  return esUno(ESTADOS_DE_LA_VERSION, estado)
    ? `servicios.catalogo.version.${estado}`
    : 'servicios.catalogo.version.desconocido';
}

export function claveDeLaModalidad(modalidad: string | null | undefined): string {
  if (modalidad === null || modalidad === undefined) return 'servicios.catalogo.modalidad.sinDefinir';
  return esUno(MODALIDADES, modalidad)
    ? `servicios.catalogo.modalidad.${modalidad}`
    : 'servicios.catalogo.modalidad.desconocida';
}

export function claveDelModeloDePrecio(modelo: string | null | undefined): string {
  if (modelo === null || modelo === undefined) return 'servicios.catalogo.precio.sinDefinir';
  return esUno(MODELOS_DE_PRECIO, modelo)
    ? `servicios.catalogo.modelo.${modelo}`
    : 'servicios.catalogo.modelo.desconocido';
}

/** Un código de `missing`, en palabras. Uno nuevo NO se imprime: sale el genérico. */
export function claveDelRequisito(codigo: string): string {
  return esUno(REQUISITOS, codigo) ? `servicios.catalogo.falta.${codigo}` : 'servicios.catalogo.falta.otro';
}

export function claveDelCampo(campo: string): string {
  return esUno(CAMPOS_SENALABLES, campo) ? `servicios.catalogo.campo.${campo}` : 'servicios.catalogo.campo.otro';
}

export function claveDeLaAccion(accion: string): string {
  return esUno(ACCIONES_DEL_CATALOGO, accion)
    ? `servicios.catalogo.admin.accion.${accion}`
    : 'servicios.catalogo.admin.accion.otra';
}

export function claveDelSuceso(accion: string): string {
  return esUno(SUCESOS, accion) ? `servicios.catalogo.suceso.${accion}` : 'servicios.catalogo.suceso.otro';
}

export function claveDeLaCola(cola: string): string {
  return esUno(COLAS, cola) ? `servicios.catalogo.cola.${cola}` : 'servicios.catalogo.cola.pending';
}

export function claveDeLaFuncion(funcion: string): string {
  return ['provider', 'reviewer', 'admin', 'system'].includes(funcion)
    ? `servicios.catalogo.funcion.${funcion}`
    : 'servicios.catalogo.funcion.system';
}

/** Qué decisiones exigen un motivo que el prestador lee. */
export function exigeMotivo(accion: string): boolean {
  return accion === 'request_changes' || accion === 'suspend' || accion === 'reinstate' || accion === 'retire';
}

/** Las que quitan algo del público. Se confirman marcadas como destructivas. */
export function esDestructiva(accion: string): boolean {
  return accion === 'suspend' || accion === 'retire';
}

/** Las que se hacen sobre la VERSIÓN propuesta, no sobre el servicio. */
export function esDeLaVersion(accion: string): boolean {
  return accion === 'start_review' || accion === 'request_changes' || accion === 'approve' || accion === 'publish';
}

/** El nombre de una categoría en el idioma de quien mira; si no lo hay, el base. */
export function nombreDeLaCategoria(
  categoria: Pick<Categoria, 'name' | 'name_en' | 'name_pt'> | null | undefined,
  idioma: string,
): string {
  if (!categoria) return '';
  if (idioma === 'en' && categoria.name_en) return categoria.name_en;
  if (idioma === 'pt' && categoria.name_pt) return categoria.name_pt;
  return categoria.name;
}

/** «Madre › Hija» para una subcategoría; el nombre solo para una de primer nivel. */
export function etiquetaDeCategoria(categoria: Categoria, todas: readonly Categoria[], idioma: string): string {
  const madre = categoria.parent_id ? todas.find((c) => c.id === categoria.parent_id) : undefined;
  const propio = nombreDeLaCategoria(categoria, idioma);
  return madre ? `${nombreDeLaCategoria(madre, idioma)} › ${propio}` : propio;
}

/**
 * Las categorías en el orden en que se eligen: cada madre seguida de sus
 * hijas. Una hija cuya madre no está (inactiva, por ejemplo) va al final.
 */
export function categoriasEnArbol(todas: readonly Categoria[]): Categoria[] {
  const madres = todas.filter((c) => c.parent_id === null);
  const salida: Categoria[] = [];
  for (const madre of madres) {
    salida.push(madre, ...todas.filter((c) => c.parent_id === madre.id));
  }
  return [...salida, ...todas.filter((c) => !salida.includes(c))];
}

/** Una frase traducible con sus huecos. */
export type Frase = { clave: string; params?: Record<string, string | number> };

/**
 * El precio, en palabras. SIN CONFIGURAR NO ES GRATIS: son dos frases
 * distintas. Y el importe va con el CÓDIGO de su moneda, nunca con un símbolo
 * elegido por nuestra cuenta.
 */
export function precioLegible(precio: Precio | null | undefined): Frase {
  const modelo = precio?.model ?? null;
  if (modelo === null) return { clave: 'servicios.catalogo.precio.sinDefinir' };
  if (modelo === 'free') return { clave: 'servicios.catalogo.precio.free' };
  if (modelo === 'on_request') return { clave: 'servicios.catalogo.precio.on_request' };
  if (modelo === 'fixed' || modelo === 'from') {
    const moneda = (precio?.currency ?? '').trim().toUpperCase();
    const importe = precio?.amount_minor;
    if (typeof importe !== 'number' || !Number.isFinite(importe) || moneda === '') {
      return { clave: 'servicios.catalogo.precio.sinImporte' };
    }
    return {
      clave: `servicios.catalogo.precio.${modelo}`,
      params: { importe: `${importeComoTexto(importe, moneda)} ${moneda}` },
    };
  }
  return { clave: 'servicios.catalogo.modelo.desconocido' };
}

/** La duración, en palabras: «45 min», «2 h», «1 h 30 min». */
export function duracionLegible(minutos: number | null | undefined): Frase {
  if (typeof minutos !== 'number' || !Number.isFinite(minutos) || minutos <= 0) {
    return { clave: 'servicios.catalogo.duracion.sinDefinir' };
  }
  const total = Math.round(minutos);
  if (total < 60) return { clave: 'servicios.catalogo.duracion.minutos', params: { n: total } };
  const horas = Math.floor(total / 60);
  const resto = total % 60;
  if (resto === 0) return { clave: 'servicios.catalogo.duracion.horas', params: { h: horas } };
  return { clave: 'servicios.catalogo.duracion.horasYMinutos', params: { h: horas, m: resto } };
}

// --------------------------------------------------------------------------- //
// Errores
// --------------------------------------------------------------------------- //
const ERRORES: Record<string, string> = {
  service_provider_not_active: 'servicios.catalogo.error.prestadorInactivo',
  service_provider_unavailable: 'servicios.catalogo.error.prestadorNoDisponible',
  service_not_found: 'servicios.catalogo.error.noEncontrado',
  service_version_not_found: 'servicios.catalogo.error.versionNoEncontrada',
  service_category_not_found: 'servicios.catalogo.error.categoriaNoEncontrada',
  service_category_inactive: 'servicios.catalogo.error.categoriaInactiva',
  service_category_not_available: 'servicios.catalogo.error.categoriaNoDisponible',
  service_category_locked: 'servicios.catalogo.error.categoriaFija',
  service_retired: 'servicios.catalogo.error.retirado',
  service_draft_missing: 'servicios.catalogo.error.sinBorrador',
  service_version_pending: 'servicios.catalogo.error.versionPendiente',
  service_catalog_incomplete: 'servicios.catalogo.error.incompleto',
  service_price_invalid: 'servicios.catalogo.error.precio',
  // Lo que Z no ofrece en la primera versión (P5 y P2). La app no lo enseña,
  // así que solo llega si el servidor cambió sus reglas con el borrador abierto:
  // el mismo texto que ya se da cuando eso falta al enviar.
  service_modality_not_allowed: 'servicios.catalogo.falta.modality_not_allowed',
  service_currency_not_allowed: 'servicios.catalogo.falta.currency_not_allowed',
  service_reason_required: 'servicios.catalogo.error.motivo',
  service_field_unknown: 'servicios.error.datosInvalidos',
  service_catalog_transition_invalid: 'servicios.catalogo.error.yaCambio',
  service_catalog_transition_forbidden: 'servicios.catalogo.error.sinPermiso',
  service_self_review_forbidden: 'servicios.catalogo.error.propio',
  service_image_not_found: 'servicios.catalogo.error.imagenNoEncontrada',
  service_image_invalid: 'servicios.catalogo.error.imagenInvalida',
  service_image_limit_reached: 'servicios.catalogo.error.imagenLimite',
  service_storage_unavailable: 'servicios.error.almacenamiento',
  service_category_slug_taken: 'servicios.catalogo.error.slugOcupado',
  service_category_hierarchy_invalid: 'servicios.catalogo.error.jerarquia',
};

/** Los códigos propios del catálogo. Una prueba los compara con el servidor. */
export const CODIGOS_DE_ERROR_DEL_CATALOGO = Object.keys(ERRORES);

/**
 * Un código del catálogo, en palabras, o `null` si no es suyo (entonces vale
 * el de la admisión: `services_disabled`, `idempotency_key_reused`…).
 */
export function claveDeErrorDelCatalogo(codigo: string | null | undefined): string | null {
  return codigo ? (ERRORES[codigo] ?? null) : null;
}

/**
 * Por qué no se pudo CARGAR una pantalla del catálogo. Además de los de la
 * admisión, uno propio: quien todavía no es prestador activo no tiene
 * catálogo, y eso no es «sin permiso», es «aún no»: se le lleva a su
 * postulación.
 */
export type FalloDelCatalogo = FalloDeCarga | 'prestadorInactivo';

export function falloDelCatalogo(estado: number, codigo: string | null | undefined): FalloDelCatalogo {
  if (codigo === 'service_provider_not_active') return 'prestadorInactivo';
  return falloDeCarga(estado, codigo);
}

/**
 * Tras un error, si hay que volver a leer. Lo de la admisión (409, 404) y,
 * además, un envío incompleto: la lista de lo que falta se pinta de nuevo con
 * lo que diga el servidor.
 */
export function hayQueRecargarElCatalogo(estado: number, codigo: string | null | undefined): boolean {
  return hayQueRecargar(estado, codigo) || codigo === 'service_catalog_incomplete';
}

// --------------------------------------------------------------------------- //
// El formulario del borrador
// --------------------------------------------------------------------------- //
export type Fallo = { campo: string; clave: string };

export type FormularioDelServicio = {
  categoria: string;
  titulo: string;
  resumen: string;
  descripcion: string;
  modalidad: Modalidad | null;
  duracion: string;
  capacidad: string;
  modeloDePrecio: ModeloDePrecio | null;
  importe: string;
  moneda: string;
  alcance: string;
  /** Una frase por línea. */
  incluye: string;
  excluye: string;
  requisitos: string;
  condiciones: string;
  zona: string;
};

/** Una frase por línea → la lista, sin líneas vacías. */
export function listaDesdeTexto(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

export function textoDesdeLista(lista: readonly string[] | null | undefined): string {
  return (lista ?? []).join('\n');
}

const MONEDA_DE_FABRICA = MONEDAS[0];

/** El formulario nace de lo que dice el servidor. */
export function formularioDesde(version: Version, categoriaId: string): FormularioDelServicio {
  const moneda = version.price.currency ?? MONEDA_DE_FABRICA;
  return {
    categoria: categoriaId,
    titulo: version.title ?? '',
    resumen: version.summary ?? '',
    descripcion: version.description ?? '',
    modalidad: esUno(MODALIDADES, version.modality) ? version.modality : null,
    duracion: version.duration_minutes === null ? '' : String(version.duration_minutes),
    capacidad: version.capacity == null ? '' : String(version.capacity),
    modeloDePrecio: esUno(MODELOS_DE_PRECIO, version.price.model) ? version.price.model : null,
    importe:
      version.price.amount_minor === null ? '' : importeComoTexto(version.price.amount_minor, moneda),
    moneda,
    alcance: version.scope ?? '',
    incluye: textoDesdeLista(version.includes),
    excluye: textoDesdeLista(version.excludes),
    requisitos: version.requirements ?? '',
    condiciones: version.conditions ?? '',
    zona: version.location_area ?? '',
  };
}

/** Un texto libre: vacío = `null` (se vacía), y si no, dentro de su largo. */
function textoLibre(
  valor: string,
  [minimo, maximo]: readonly [number, number],
  campo: string,
  fallos: Fallo[],
): string | null {
  const limpio = valor.trim();
  if (limpio === '') return null;
  if (limpio.length < minimo) fallos.push({ campo, clave: 'servicios.validacion.corto' });
  else if (limpio.length > maximo) fallos.push({ campo, clave: 'servicios.validacion.largo' });
  return limpio;
}

/** Un entero dentro de un rango, o `null` si se dejó vacío. */
function entero(
  valor: string,
  [minimo, maximo]: readonly [number, number],
  campo: string,
  clave: string,
  fallos: Fallo[],
): number | null {
  const limpio = valor.trim();
  if (limpio === '') return null;
  if (!/^\d+$/.test(limpio)) {
    fallos.push({ campo, clave });
    return null;
  }
  const n = Number(limpio);
  if (n < minimo || n > maximo) fallos.push({ campo, clave });
  return n;
}

function frases(valor: string, campo: string, fallos: Fallo[]): string[] {
  const lista = listaDesdeTexto(valor);
  const [minimo, maximo] = LARGOS.frase;
  if (lista.length > MAXIMO_DE_FRASES) fallos.push({ campo, clave: 'servicios.catalogo.validacion.demasiadasFrases' });
  else if (lista.some((f) => f.length < minimo || f.length > maximo)) {
    fallos.push({ campo, clave: 'servicios.catalogo.validacion.frase' });
  }
  return lista;
}

function iguales(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Lo que CAMBIÓ respecto del borrador guardado, listo para el PATCH, y lo que
 * el servidor rechazaría (dicho antes, con palabras).
 *
 * - SOLO VIAJA LO QUE CAMBIÓ, y nunca un estado.
 * - Vaciar un campo manda `null`: guardar a medias no exige nada. Lo que hace
 *   falta para ENVIAR lo dice el servidor en `missing`.
 * - Un modelo sin importe (gratis, a consultar) NO manda importe ni moneda: el
 *   servidor los rechazaría, y los que hubiera los borra él.
 * - La categoría solo viaja si se puede cambiar (`categoriaCambiable`: el
 *   servicio nunca se publicó).
 */
export function cambiosDelBorrador(
  formulario: FormularioDelServicio,
  version: Version,
  categoriaActual: string,
  { categoriaCambiable }: { categoriaCambiable: boolean },
): { cambios: Record<string, unknown>; fallos: Fallo[] } {
  const fallos: Fallo[] = [];
  const nuevo: Record<string, unknown> = {
    title: textoLibre(formulario.titulo, LARGOS.titulo, 'titulo', fallos),
    summary: textoLibre(formulario.resumen, LARGOS.resumen, 'resumen', fallos),
    description: textoLibre(formulario.descripcion, LARGOS.descripcion, 'descripcion', fallos),
    modality: formulario.modalidad,
    duration_minutes: entero(formulario.duracion, DURACION, 'duracion', 'servicios.catalogo.validacion.duracion', fallos),
    capacity: entero(formulario.capacidad, CAPACIDAD, 'capacidad', 'servicios.catalogo.validacion.capacidad', fallos),
    price_model: formulario.modeloDePrecio,
    scope: textoLibre(formulario.alcance, LARGOS.alcance, 'alcance', fallos),
    includes: frases(formulario.incluye, 'incluye', fallos),
    excludes: frases(formulario.excluye, 'excluye', fallos),
    requirements: textoLibre(formulario.requisitos, LARGOS.requisitos, 'requisitos', fallos),
    conditions: textoLibre(formulario.condiciones, LARGOS.condiciones, 'condiciones', fallos),
    location_area: textoLibre(formulario.zona, LARGOS.zona, 'zona', fallos),
  };
  const actual: Record<string, unknown> = {
    title: version.title,
    summary: version.summary,
    description: version.description,
    modality: version.modality,
    duration_minutes: version.duration_minutes,
    capacity: version.capacity,
    price_model: version.price.model,
    scope: version.scope,
    includes: version.includes,
    excludes: version.excludes,
    requirements: version.requirements,
    conditions: version.conditions,
    location_area: version.location_area,
  };

  if (formulario.modeloDePrecio !== null && CON_IMPORTE.includes(formulario.modeloDePrecio)) {
    const moneda = formulario.moneda.trim().toUpperCase();
    const importe = importeEscrito(formulario.importe, moneda);
    if (importe === 'invalido' || (typeof importe === 'number' && importe <= 0)) {
      fallos.push({ campo: 'importe', clave: 'servicios.catalogo.validacion.importe' });
    }
    if (importe !== null && !/^[A-Z]{3}$/.test(moneda)) {
      fallos.push({ campo: 'moneda', clave: 'servicios.catalogo.validacion.moneda' });
    }
    nuevo.price_minor = typeof importe === 'number' ? importe : null;
    nuevo.currency = importe === null ? version.price.currency : moneda;
    actual.price_minor = version.price.amount_minor;
    actual.currency = version.price.currency;
  }

  if (categoriaCambiable && formulario.categoria && formulario.categoria !== categoriaActual) {
    nuevo.category_id = formulario.categoria;
    actual.category_id = categoriaActual;
  }

  const cambios: Record<string, unknown> = {};
  for (const [campo, valor] of Object.entries(nuevo)) {
    if (!iguales(valor, actual[campo])) cambios[campo] = valor;
  }
  return { cambios, fallos };
}

/** Si el formulario tiene algo sin guardar (para avisar antes de salir). */
export function hayCambiosSinGuardar(
  formulario: FormularioDelServicio | null,
  version: Version | null,
  categoriaActual: string,
  categoriaCambiable: boolean,
): boolean {
  if (formulario === null || version === null) return false;
  return Object.keys(cambiosDelBorrador(formulario, version, categoriaActual, { categoriaCambiable }).cambios).length > 0;
}

/** Si el modelo elegido lleva importe (para enseñar o no el campo). */
export function llevaImporte(modelo: string | null): boolean {
  return modelo !== null && (CON_IMPORTE as readonly string[]).includes(modelo);
}

// --------------------------------------------------------------------------- //
// Imágenes
// --------------------------------------------------------------------------- //
export function revisarAlternativo(texto: string): string | null {
  const limpio = texto.trim();
  if (limpio === '') return 'servicios.catalogo.imagenes.alternativoObligatorio';
  if (limpio.length < LARGOS.alternativo[0]) return 'servicios.validacion.corto';
  if (limpio.length > LARGOS.alternativo[1]) return 'servicios.validacion.largo';
  return null;
}

/**
 * Lo barato que se puede mirar antes de subir: el tipo y el peso. Quien
 * decide de verdad es el servidor, que abre la imagen. Cuántas caben tampoco
 * se decide aquí: es configuración de la empresa y el servidor lo dice.
 */
export function porQueNoSeSube(elegida: { tipo: string | null; bytes: number | null }): string | null {
  if (elegida.tipo !== null && !(TIPOS_DE_IMAGEN as readonly string[]).includes(elegida.tipo)) {
    return 'servicios.catalogo.imagenes.formato';
  }
  if (elegida.bytes !== null && elegida.bytes > PESO_MAXIMO_DE_IMAGEN) return 'servicios.catalogo.imagenes.pesada';
  if (elegida.bytes === 0) return 'servicios.catalogo.imagenes.vacia';
  return null;
}

/** Las imágenes en su orden (por `position`), sin tocar la lista original. */
export function enOrden<T extends { position: number }>(imagenes: readonly T[]): T[] {
  return [...imagenes].sort((a, b) => a.position - b.position);
}

/** El nuevo orden COMPLETO tras mover una imagen un puesto. Fuera de rango, igual. */
export function moverImagen(imagenes: readonly Imagen[], id: string, paso: 1 | -1): string[] {
  const ids = enOrden(imagenes).map((i) => i.id);
  const desde = ids.indexOf(id);
  const hasta = desde + paso;
  if (desde < 0 || hasta < 0 || hasta >= ids.length) return ids;
  [ids[desde], ids[hasta]] = [ids[hasta] as string, ids[desde] as string];
  return ids;
}

/** La portada, o la primera si ninguna lo es. */
export function portada<T extends { is_cover: boolean; position?: number }>(imagenes: readonly T[]): T | null {
  return imagenes.find((i) => i.is_cover) ?? imagenes[0] ?? null;
}

// --------------------------------------------------------------------------- //
// Lo que se enseña del servicio propio
// --------------------------------------------------------------------------- //
/** La versión que se edita o se revisa ahora; si no hay, la publicada. */
export function versionQueSeEnsena(servicio: Pick<ServicioPrivado, 'open_version' | 'published_version'>): Version | null {
  return servicio.open_version ?? servicio.published_version ?? null;
}

/**
 * El estado de versión que merece una línea en la lista: el de la abierta y,
 * si no hay, «con cambios pedidos» cuando Z devolvió la última (hay algo que
 * hacer). Lo demás ya lo dice el estado del servicio.
 */
export function estadoDeVersionQueSeEnsena(
  resumen: Pick<ServicioResumen, 'open_version_status' | 'last_version_status'>,
): string | null {
  if (resumen.open_version_status) return resumen.open_version_status;
  return resumen.last_version_status === 'changes_requested' ? 'changes_requested' : null;
}

/** Si la versión abierta está en manos de Z (enviada, en revisión o aprobada). */
export function estaEnManosDeZ(servicio: Pick<ServicioPrivado, 'open_version'>): boolean {
  const estado = servicio.open_version?.status;
  return estado === 'submitted' || estado === 'under_review' || estado === 'approved';
}

/**
 * Si la próxima vez que se envíe será un REENVÍO: el borrador sale de la
 * versión a la que Z le pidió cambios. El servidor lo decide igual (la base
 * del borrador quedó en `changes_requested`); aquí solo cambia el texto del
 * botón.
 */
export function esReenvio(servicio: Pick<ServicioPrivado, 'open_version' | 'last_observation'>): boolean {
  const abierta = servicio.open_version;
  const ultima = servicio.last_observation;
  return (
    abierta?.status === 'draft' &&
    abierta.based_on_version !== null &&
    ultima?.action === 'changes_requested' &&
    ultima.version === abierta.based_on_version
  );
}

// --------------------------------------------------------------------------- //
// Bandeja de administración
// --------------------------------------------------------------------------- //
export const FILTROS_DE_VERSION = [null, 'submitted', 'under_review', 'approved'] as const;
export const FILTROS_DE_MODALIDAD: (Modalidad | null)[] = [null, ...MODALIDADES_OFRECIDAS];

export function consultaDelCatalogo(opciones: {
  cola: Cola;
  estadoDeVersion?: string | null;
  modalidad?: string | null;
  categoria?: string | null;
  cursor?: string | null;
  limite?: number;
}): string {
  const q: string[] = [`queue=${encodeURIComponent(opciones.cola)}`, `limit=${opciones.limite ?? TAMANO_DE_PAGINA}`];
  if (opciones.estadoDeVersion) q.push(`version_status=${encodeURIComponent(opciones.estadoDeVersion)}`);
  if (opciones.modalidad) q.push(`modality=${encodeURIComponent(opciones.modalidad)}`);
  if (opciones.categoria) q.push(`category_id=${encodeURIComponent(opciones.categoria)}`);
  if (opciones.cursor) q.push(`cursor=${encodeURIComponent(opciones.cursor)}`);
  return q.join('&');
}

/** Junta una página nueva sin repetir filas (un reintento puede traer la misma). */
export function juntar<T extends { id: string }>(actuales: readonly T[], nuevas: readonly T[]): T[] {
  const vistos = new Set(actuales.map((s) => s.id));
  return [...actuales, ...nuevas.filter((s) => !vistos.has(s.id))];
}

/** El motivo de una decisión: obligatorio donde el servidor lo exige. */
export function revisarMotivo(accion: string, texto: string): string | null {
  const limpio = texto.trim();
  if (limpio === '') return exigeMotivo(accion) ? 'servicios.catalogo.validacion.motivoObligatorio' : null;
  if (limpio.length < LARGOS.nota[0]) return 'servicios.validacion.corto';
  if (limpio.length > LARGOS.nota[1]) return 'servicios.validacion.largo';
  return null;
}

/** El cuerpo de una decisión. Solo lo que esa decisión admite. */
export function cuerpoDeLaDecision(
  accion: string,
  datos: { motivo: string; notaInterna: string; campos: string[] },
): Record<string, unknown> {
  const cuerpo: Record<string, unknown> = {};
  const interna = datos.notaInterna.trim();
  if (interna !== '') cuerpo.internal_note = interna;
  if (exigeMotivo(accion)) cuerpo.note = datos.motivo.trim();
  if (accion === 'request_changes') {
    cuerpo.fields = [...new Set(datos.campos)].filter((c) => esUno(CAMPOS_SENALABLES, c));
  }
  return cuerpo;
}

// --------------------------------------------------------------------------- //
// Categorías (administración)
// --------------------------------------------------------------------------- //
export type FormularioDeCategoria = {
  slug: string;
  nombre: string;
  nombreEn: string;
  nombrePt: string;
  descripcion: string;
  icono: string;
  pais: string;
  orden: string;
  madre: string | null;
};

export function categoriaVacia(): FormularioDeCategoria {
  return { slug: '', nombre: '', nombreEn: '', nombrePt: '', descripcion: '', icono: '', pais: '', orden: '0', madre: null };
}

export function categoriaDesde(c: Categoria): FormularioDeCategoria {
  return {
    slug: c.slug,
    nombre: c.name,
    nombreEn: c.name_en ?? '',
    nombrePt: c.name_pt ?? '',
    descripcion: c.description ?? '',
    icono: c.icon ?? '',
    pais: c.country_code ?? '',
    orden: String(c.sort_order),
    madre: c.parent_id,
  };
}

/**
 * Las que pueden ser madre de `propia`: solo las de primer nivel, nunca ella
 * misma. Dos niveles como mucho; la base lo impone igual.
 */
export function madresPosibles(categorias: readonly Categoria[], propia: string | null): Categoria[] {
  return categorias.filter((c) => c.parent_id === null && c.id !== propia);
}

/**
 * La petición de ALTA (sin original) o de EDICIÓN (solo lo que cambió; el slug
 * y el estado no se editan por aquí). Con lo que el servidor rechazaría.
 */
export function peticionDeCategoria(
  f: FormularioDeCategoria,
  original: Categoria | null,
): { peticion: Record<string, unknown> | null; fallos: Fallo[] } {
  const fallos: Fallo[] = [];
  const opcional = (valor: string, [minimo, maximo]: readonly [number, number], campo: string) => {
    const limpio = valor.trim();
    if (limpio === '') return null;
    if (limpio.length < minimo) fallos.push({ campo, clave: 'servicios.validacion.corto' });
    else if (limpio.length > maximo) fallos.push({ campo, clave: 'servicios.validacion.largo' });
    return limpio;
  };
  const nombre = f.nombre.trim();
  if (nombre.length < 2) fallos.push({ campo: 'nombre', clave: 'servicios.validacion.corto' });
  else if (nombre.length > 80) fallos.push({ campo: 'nombre', clave: 'servicios.validacion.largo' });
  const icono = f.icono.trim();
  if (icono !== '' && !/^[a-z0-9-]{2,40}$/.test(icono)) {
    fallos.push({ campo: 'icono', clave: 'servicios.catalogo.validacion.icono' });
  }
  const pais = f.pais.trim().toUpperCase();
  if (pais !== '' && !/^[A-Z]{2}$/.test(pais)) fallos.push({ campo: 'pais', clave: 'servicios.validacion.pais' });
  const orden = f.orden.trim() === '' ? 0 : Number(f.orden.trim());
  if (!Number.isInteger(orden) || orden < 0 || orden > 100_000) {
    fallos.push({ campo: 'orden', clave: 'servicios.catalogo.validacion.orden' });
  }
  const datos: Record<string, unknown> = {
    name: nombre,
    name_en: opcional(f.nombreEn, [2, 80], 'nombreEn'),
    name_pt: opcional(f.nombrePt, [2, 80], 'nombrePt'),
    description: opcional(f.descripcion, [0, 280], 'descripcion'),
    icon: icono === '' ? null : icono,
    country_code: pais === '' ? null : pais,
    sort_order: orden,
    parent_id: f.madre,
  };
  if (original === null) {
    const slug = f.slug.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(slug)) fallos.push({ campo: 'slug', clave: 'servicios.catalogo.validacion.slug' });
    if (fallos.length > 0) return { peticion: null, fallos };
    const alta: Record<string, unknown> = { slug };
    for (const [campo, valor] of Object.entries(datos)) if (valor !== null) alta[campo] = valor;
    return { peticion: alta, fallos };
  }
  if (fallos.length > 0) return { peticion: null, fallos };
  const antes: Record<string, unknown> = {
    name: original.name,
    name_en: original.name_en,
    name_pt: original.name_pt,
    description: original.description,
    icon: original.icon,
    country_code: original.country_code,
    sort_order: original.sort_order,
    parent_id: original.parent_id,
  };
  const cambios: Record<string, unknown> = {};
  for (const [campo, valor] of Object.entries(datos)) {
    if (!iguales(valor, antes[campo])) cambios[campo] = valor;
  }
  if (Object.keys(cambios).length === 0) {
    return { peticion: null, fallos: [{ campo: 'formulario', clave: 'servicios.validacion.sinCambios' }] };
  }
  return { peticion: cambios, fallos };
}
