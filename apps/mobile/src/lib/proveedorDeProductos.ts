/**
 * El proveedor de Productos Z: su postulación y sus productos.
 *
 * Es el espejo en el cliente de `app/modules/products/` —`applications.py`,
 * `service.py`, `states.py` y los CHECK de las migraciones 0070 y 0071— y lo es
 * a propósito: cada regla de aquí está copiada de una del servidor, con el mismo
 * código de error, para que la pantalla pueda decir lo que pasa ANTES de mandar
 * un formulario que va a volver rechazado. No es una validación distinta ni más
 * blanda: donde el servidor acepta, aquí se acepta.
 *
 * SEIS COSAS QUE NO SE PUEDEN CONFUNDIR, y que este módulo separa:
 *
 *   1. NINGÚN CAMPO NACE CON VALOR. `formularioDeProductoVacio` devuelve
 *      cadenas vacías y listas vacías, nunca un `0`. Un `price_minor: 0`
 *      precargado dice «este producto es gratis», y lo ha dicho la aplicación
 *      por su cuenta. Lo que nadie escribió NO VIAJA: la clave ausente es
 *      exactamente lo que el servidor entiende por «sin configurar», y
 *      `price_minor: null` es «sin precio», no «gratis».
 *
 *   2. EL PRECIO VA CON SU MONEDA O NO VA. Lo impone el CHECK
 *      `product_versions_precio_con_moneda` de la 0070 —`(price_minor is null) =
 *      (currency is null)`— y lo repite `_exigir_textos`. Un importe sin moneda
 *      no es un importe.
 *
 *   3. SOLO EL BORRADOR SE EDITA. `states.EDITABLES` es `{draft}` y nada más:
 *      editar lo que alguien está evaluando cambia el objeto de la evaluación a
 *      mitad de camino, y el sello de Z acabaría puesto sobre un texto que el
 *      evaluador no vio. Por eso `sePuedeEditarProducto` mira el estado y no
 *      hay ningún otro camino al editor.
 *
 *   4. LOS BOTONES LOS DICTA EL SERVIDOR. `ProductoDelProveedor.acciones` viene
 *      de `states.siguientes(status, 'seller')`, y esta pantalla solo pinta las
 *      que además TIENEN RUTA de proveedor: `submitted` (postular) y `draft`
 *      (retirar). `removed` está en la máquina para el proveedor pero no hay
 *      ninguna ruta suya que lo haga, así que pintarlo sería un botón que no
 *      puede funcionar.
 *
 *   5. LA GALERÍA NO SE ESCRIBE DESDE AQUÍ. Este módulo llegó a construir un
 *      `gallery` con rutas del almacenamiento TECLEADAS en la pantalla. Desde
 *      la 0073 no existe: `VersionRequest` no tiene `gallery` —Pydantic
 *      descartaba la clave sin error, así que aquello se guardaba con un 200 y
 *      no llegaba a ninguna parte— y una ruta escrita a mano podía apuntar al
 *      archivo de otra persona o a ninguno. Las fotografías se SUBEN en
 *      `fotosDeProducto.ts`: la API mira los bytes y genera el nombre. Aquí la
 *      galería solo se LEE, para enseñar cuántas hay y en qué estado están.
 *
 *      Los documentos de la postulación siguen llevando ruta escrita, porque
 *      esa otra ruta del servidor todavía la pide: no es lo mismo.
 *
 *   6. `bloqueo` ES UN CÓDIGO, NO UNA FRASE. Dice por qué ese producto todavía
 *      no puede llevar el sello, y se traduce; inventar el motivo aquí sería
 *      repartir la regla entre el servidor y la pantalla.
 *
 * Y LO QUE AQUÍ NO EXISTE: existencias, envíos, pedidos, incidencias y saldos.
 * No están en el contrato porque no están construidos, y una pantalla vacía que
 * los simulara prometería una operación que no hay.
 *
 * Sin importaciones en tiempo de ejecución: el ejecutor de pruebas de Node no
 * resuelve el alias `@/`. La única que hay es `import type`, que desaparece al
 * compilar y al quitar los tipos, así que no llega a ejecutarse nada.
 */
import type { FotoDelProveedor } from '@/lib/fotosDeProducto';

/** Una clave del diccionario. La pantalla la convierte al traducir. */
export type ClaveDeTraduccion = string;

/* -------------------------------------------------------------------------- */
/* Lo que el servidor es                                                       */
/* -------------------------------------------------------------------------- */

/** Un documento presentado, tal como lo manda `DocumentoRead`. */
export type DocumentoDeLaPostulacion = {
  id: string;
  kind: string;
  /** La RUTA del almacenamiento, no una URL. `null` = solo hay nota. */
  storage_path: string | null;
  note: string | null;
  /** Enlace firmado de diez minutos para abrirlo (0085). `null` = sin archivo. */
  url?: string | null;
};

/** La postulación, tal como la manda `PostulacionRead`. */
export type Postulacion = {
  id: string;
  /** `draft`, `submitted`, `under_review`, `accepted`, `rejected`, `withdrawn`. */
  status: string;
  display_name: string;
  proposal: string;
  submitted_at: string | null;
  decided_at: string | null;
  /** El motivo que se le ENSEÑA. Las notas internas no salen del servidor. */
  decision_reason: string | null;
  documents: DocumentoDeLaPostulacion[];
};

/** `GET /products/seller/application`: `EstadoDelProveedor`. */
export type EstadoDelProveedor = {
  /** `null` = no tiene capacidad comercial. `pending`/`active`/`suspended`. */
  seller_status: string | null;
  seller_id: string | null;
  application: Postulacion | null;
  /**
   * Si se puede abrir una postulación NUEVA. `false` también cuando ya hay un
   * borrador escrito, que sí se puede seguir editando: para eso está
   * `sePuedeEscribirPostulacion`, y confundirlos esconde el propio borrador.
   */
  puede_postular: boolean;
  /** `false` = las migraciones de admisión no están aplicadas en esta base. */
  disponible: boolean;
};

/** Una variante leída, tal como la manda `VarianteRead`. */
export type Variante = {
  id: string;
  sku: string;
  name: string;
  options: Record<string, unknown>;
  price_delta_minor: number;
};

/** Una versión, tal como la manda `VersionRead`. */
export type Version = {
  id: string;
  version: string;
  /** `draft`, `published` o `superseded`. */
  status: string;
  name: string;
  summary: string | null;
  description: string | null;
  materials: string | null;
  origin_country: string | null;
  manufacturer: string | null;
  /** `null` es SIN PRECIO CONFIGURADO. Nunca cero. */
  price_minor: number | null;
  currency: string | null;
  /** La huella de lo publicado. Es lo que hace demostrable qué se evaluó. */
  content_sha256: string;
  published_at: string | null;
  effective_to: string | null;
  variants: Variante[];
  /*
    LA GALERÍA DE QUIEN VENDE, CON SU ESTADO. `VersionRead.gallery` es
    `list[FotoDelProveedor]`, no `MediaRead`: trae `status` y
    `rejection_reason`, que son su razón de existir —quien vende necesita saber
    cuáles están pendientes y por qué le rechazaron una—. Aquí se reusa ese
    mismo tipo en vez de copiar un molde de cuatro campos que se quedaba corto y
    hacía creer que esa información no venía. SOLO SE LEE: escribirla es cosa de
    `fotosDeProducto.ts`.
  */
  gallery: FotoDelProveedor[];
};

/** El producto como lo ve quien lo vende: `ProductoDelProveedor`. */
export type ProductoDelProveedor = {
  id: string;
  status: string;
  category_id: string | null;
  published_at: string | null;
  suspension_reason: string | null;
  created_at: string;
  draft: Version | null;
  published: Version | null;
  /** Lo que ESTE actor puede hacer. Para pintar botones, no para decidir. */
  acciones: string[];
  /** Por qué todavía no se puede publicar, como CÓDIGO. `null` = se puede. */
  bloqueo: string | null;
  /** Si quien vende puede editarlo ahora (en modo flexible, también publicado). */
  editable?: boolean;
  /** MODO FLEXIBLE: «enviar» publica al momento (y «Publicar cambios»). */
  publicacion_directa?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Las constantes del servidor, transcritas                                    */
/* -------------------------------------------------------------------------- */

/** `models.DOCUMENTOS` (blueprint §5.1). Lo que no está aquí, no existe. */
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
export type TipoDeDocumento = (typeof DOCUMENTOS)[number];

/** `models.ESTADOS_DE_POSTULACION`. */
export const ESTADOS_DE_POSTULACION = [
  'draft',
  'submitted',
  'under_review',
  'accepted',
  'rejected',
  'withdrawn',
] as const;

/** `models.POSTULACIONES_VIVAS`: las que ocupan sitio. */
export const POSTULACIONES_VIVAS = ['draft', 'submitted', 'under_review'] as const;

/** `applications.EDITABLES` y `applications.ENVIABLES`: solo el borrador. */
export const POSTULACIONES_EDITABLES = ['draft'] as const;

/** `models.ESTADOS_DE_VENDEDOR`. Nace `pending`: nadie vende por registrarse. */
export const ESTADOS_DE_VENDEDOR = ['pending', 'active', 'suspended'] as const;

/** `models.ESTADOS_DE_PRODUCTO`, en el orden del blueprint §5. */
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

/**
 * `states.EDITABLES`. SOLO `draft`, y no es una comodidad: desde `submitted`
 * el producto ya está en manos de quien lo evalúa.
 */
export const PRODUCTOS_EDITABLES = ['draft'] as const;

/**
 * Las acciones de `ProductoDelProveedor.acciones` que ESTA aplicación puede
 * ejecutar, porque tienen ruta de proveedor.
 *
 * `removed` no está: la máquina permite `(draft, removed)` al proveedor, pero no
 * hay ninguna ruta `/products/seller/...` que retire un producto del catálogo.
 * Pintarlo sería un botón sin destino.
 */
export const ACCIONES_CON_RUTA = ['submitted', 'draft'] as const;
export type AccionDeProducto = (typeof ACCIONES_CON_RUTA)[number];

/** `por_que_no_se_publica`: los códigos que puede traer `bloqueo`. */
export const BLOQUEOS = [
  'product_not_approved',
  'product_version_missing',
  'product_media_required',
  'product_admission_not_available',
  'product_evaluation_required',
  'product_reasons_required',
] as const;

/* Cotas. Cada una está en `service.LARGOS`, en un `Field(...)` de `schemas.py` o
   en un CHECK de la 0070/0071, y ninguna se ha redondeado. */

/** `applications.LARGO_DEL_NOMBRE`. */
export const LARGO_DEL_NOMBRE = [2, 120] as const;
/** `applications.LARGO_DE_LA_PROPUESTA`. */
export const LARGO_DE_LA_PROPUESTA = [20, 4_000] as const;
/** `applications.MAXIMO_DE_DOCUMENTOS`. */
export const MAXIMO_DE_DOCUMENTOS = 30;
/** `DocumentoRequest.note`. */
export const LARGO_DE_LA_NOTA = 2_000;
/**
 * `DocumentoRequest.storage_path`.
 *
 * SOLO PARA LOS DOCUMENTOS de la postulación, que son los únicos que todavía
 * llevan una ruta escrita a mano. Las fotografías no: su ruta la genera el
 * servidor, y el tope de su texto alternativo vive en `fotosDeProducto.ts`.
 */
export const LARGO_DE_LA_RUTA = [3, 512] as const;

/** `service.LARGOS['name']`. */
export const LARGO_DEL_NOMBRE_DEL_PRODUCTO = [3, 140] as const;
/** `service.LARGOS['summary']`. */
export const LARGO_DEL_RESUMEN = 300;
/** `service.LARGOS['description']`. */
export const LARGO_DE_LA_DESCRIPCION = 8_000;
/** `service.LARGOS['materials']`. */
export const LARGO_DE_LOS_MATERIALES = 2_000;
/** `service.LARGOS['manufacturer']`. El mínimo es 2, no 1. */
export const LARGO_DEL_FABRICANTE = [2, 160] as const;
/** `VersionRequest.version`, y el CHECK `product_versions_version`. */
export const LARGO_DE_LA_VERSION = 32;
/** `service.MAXIMO_DE_VARIANTES`. */
export const MAXIMO_DE_VARIANTES = 50;
/** `VarianteRequest.name`, y el CHECK `product_variants_nombre`. */
export const LARGO_DEL_NOMBRE_DE_VARIANTE = [1, 80] as const;
/*
  AQUÍ ESTABAN `MAXIMO_DE_FOTOS` y `LARGO_DEL_ALTERNATIVO`, copiados de un
  `MediaRequest` que el servidor ya no tiene. Los topes de las fotografías viven
  en `fotosDeProducto.ts` —`MAXIMO_DE_FOTOS` es 5, no 12— y allí son los de la
  ruta que de verdad sube archivos. Tener dos números distintos con el mismo
  nombre es peor que no tener ninguno.
*/

/** El CHECK `product_variants_sku` de la 0070, letra por letra. */
export const FORMATO_DEL_SKU = /^[A-Za-z0-9._-]{2,48}$/;
/** El CHECK `product_versions_origen` de la 0070: dos letras. */
export const FORMATO_DEL_PAIS = /^[A-Za-z]{2}$/;
/** El CHECK `product_versions_moneda` de la 0070: tres letras. */
export const FORMATO_DE_LA_MONEDA = /^[A-Za-z]{3}$/;
/** Un entero, con signo o sin él. El servidor exige `int`, no un decimal. */
export const FORMATO_DEL_ENTERO = /^-?\d+$/;

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/* -------------------------------------------------------------------------- */
/* Nombrar las cosas                                                           */
/* -------------------------------------------------------------------------- */

export function claveDelTipoDeDocumento(tipo: string): ClaveDeTraduccion {
  return conocido([...DOCUMENTOS], tipo, 'proveedorProductos.documento');
}

export function claveDelEstadoDePostulacion(estado: string): ClaveDeTraduccion {
  return conocido(
    [...ESTADOS_DE_POSTULACION],
    estado,
    'proveedorProductos.postular.estado',
  );
}

export function claveDelCuerpoDelEstadoDePostulacion(estado: string): ClaveDeTraduccion {
  return conocido(
    [...ESTADOS_DE_POSTULACION],
    estado,
    'proveedorProductos.postular.estadoCuerpo',
  );
}

export function claveDelEstadoDelVendedor(estado: string): ClaveDeTraduccion {
  return conocido([...ESTADOS_DE_VENDEDOR], estado, 'proveedorProductos.vendedor');
}

export function claveDelEstadoDeProducto(estado: string): ClaveDeTraduccion {
  return conocido([...ESTADOS_DE_PRODUCTO], estado, 'proveedorProductos.estado');
}

export function claveDelCuerpoDelEstadoDeProducto(estado: string): ClaveDeTraduccion {
  return conocido([...ESTADOS_DE_PRODUCTO], estado, 'proveedorProductos.estadoCuerpo');
}

/** Por qué ese producto todavía no puede llevar el sello. */
export function claveDelBloqueo(codigo: string | null | undefined): ClaveDeTraduccion | null {
  if (typeof codigo !== 'string' || codigo === '') return null;
  return conocido([...BLOQUEOS], codigo, 'proveedorProductos.bloqueo');
}

/** El texto del botón de cada acción del proveedor. */
export function claveDeAccionDeProducto(accion: string): ClaveDeTraduccion {
  return conocido([...ACCIONES_CON_RUTA], accion, 'proveedorProductos.accion');
}

/* -------------------------------------------------------------------------- */
/* Dónde está quien postula                                                    */
/* -------------------------------------------------------------------------- */

/**
 * En qué punto está esta persona. UNA SOLA RESPUESTA, y se lee en este orden.
 *
 * «Sin postular» y «retirada» no son lo mismo, y «aceptada» no es lo mismo que
 * «ya eres responsable comercial»: la capacidad comercial la crea la decisión,
 * y puede estar suspendida después.
 */
export type SituacionDelProveedor =
  | 'noDisponible'
  | 'proveedorActivo'
  | 'proveedorSuspendido'
  | 'sinPostular'
  | 'borrador'
  | 'enviada'
  | 'enRevision'
  | 'aceptada'
  | 'rechazada'
  | 'retirada'
  | 'desconocida';

const SITUACION_POR_ESTADO: Record<string, SituacionDelProveedor> = {
  draft: 'borrador',
  submitted: 'enviada',
  under_review: 'enRevision',
  accepted: 'aceptada',
  rejected: 'rechazada',
  withdrawn: 'retirada',
};

export function situacionDelProveedor(
  estado: EstadoDelProveedor | null,
): SituacionDelProveedor {
  if (estado === null || !estado.disponible) return 'noDisponible';
  // LA SUSPENSIÓN SE DICE ANTES QUE NADA: es lo que explica por qué una
  // postulación aceptada no deja postular productos.
  if (estado.seller_status === 'suspended') return 'proveedorSuspendido';
  if (estado.seller_status === 'active') return 'proveedorActivo';
  const postulacion = estado.application;
  if (postulacion === null || postulacion === undefined) return 'sinPostular';
  return SITUACION_POR_ESTADO[postulacion.status] ?? 'desconocida';
}

export function claveDeLaSituacion(situacion: SituacionDelProveedor): ClaveDeTraduccion {
  return `proveedorProductos.situacion.${situacion}`;
}

export function claveDelCuerpoDeLaSituacion(
  situacion: SituacionDelProveedor,
): ClaveDeTraduccion {
  return `proveedorProductos.situacionCuerpo.${situacion}`;
}

/** Si ya es responsable comercial en Z. Solo `active` lo es. */
export function esProveedorActivo(estado: EstadoDelProveedor | null): boolean {
  return estado?.seller_status === 'active';
}

/**
 * A dónde lleva el acceso del perfil.
 *
 * Quien ya es responsable comercial va a sus productos; quien no, a postular.
 * `pending` y `suspended` NO son «casi activo»: `exigir_vendedor_activo` los
 * rechaza, así que mandarlos a crear un producto sería mandarlos a un 403.
 */
export function rutaDelProveedor(estado: EstadoDelProveedor | null): string {
  return esProveedorActivo(estado) ? '/proveedor/productos' : '/proveedor/postular';
}

/**
 * Si se puede escribir o reescribir la postulación.
 *
 * El espejo de `applications.guardar`: no si ya es responsable comercial activo
 * y no si la viva ya salió del borrador. NO se usa `puede_postular`, que es
 * «puedo abrir una nueva» y vale `false` justo cuando hay un borrador.
 */
export function sePuedeEscribirPostulacion(estado: EstadoDelProveedor | null): boolean {
  if (estado === null || !estado.disponible) return false;
  if (estado.seller_status === 'active') return false;
  const postulacion = estado.application;
  if (postulacion === null || postulacion === undefined) return true;
  if (!(POSTULACIONES_VIVAS as readonly string[]).includes(postulacion.status)) {
    // Rechazada, retirada o aceptada: no ocupa sitio, así que se abre otra.
    return true;
  }
  return (POSTULACIONES_EDITABLES as readonly string[]).includes(postulacion.status);
}

/** El espejo de `applications.ENVIABLES`: se envía un borrador y nada más. */
export function sePuedeEnviarPostulacion(estado: EstadoDelProveedor | null): boolean {
  const postulacion = estado?.application ?? null;
  if (postulacion === null || estado === null || !estado.disponible) return false;
  return (POSTULACIONES_EDITABLES as readonly string[]).includes(postulacion.status);
}

/** El espejo de `applications.retirar`: solo mientras esté viva. */
export function sePuedeRetirarPostulacion(estado: EstadoDelProveedor | null): boolean {
  const postulacion = estado?.application ?? null;
  if (postulacion === null || estado === null || !estado.disponible) return false;
  return (POSTULACIONES_VIVAS as readonly string[]).includes(postulacion.status);
}

/** El motivo que se le enseña, si lo hay. `null` no es «sin motivo». */
export function motivoDeLaDecision(estado: EstadoDelProveedor | null): string | null {
  const razon = (estado?.application?.decision_reason ?? '').trim();
  return razon === '' ? null : razon;
}

/* -------------------------------------------------------------------------- */
/* Qué se puede hacer con cada producto                                        */
/* -------------------------------------------------------------------------- */

/**
 * Las acciones que se pintan: las que manda el servidor Y tienen ruta.
 *
 * Se conserva el orden de `ACCIONES_CON_RUTA` para que los botones no bailen
 * según cómo llegue la lista.
 */
export function accionesOfrecidas(producto: ProductoDelProveedor): AccionDeProducto[] {
  const dice = producto.acciones ?? [];
  return ACCIONES_CON_RUTA.filter((accion) => dice.includes(accion));
}

/** Estados en los que ya no se publica nada, ni en modo flexible. */
const SIN_PUBLICACION = ['suspended', 'removed'];

/**
 * «Postula tu producto»: manda el borrador a admisión. En MODO FLEXIBLE
 * (`publicacion_directa`) el mismo botón PUBLICA, y basta con tener un
 * borrador —el producto nuevo o los cambios de uno publicado—.
 */
export function sePuedePostularProducto(producto: ProductoDelProveedor): boolean {
  if (producto.publicacion_directa === true) {
    return producto.draft !== null && !SIN_PUBLICACION.includes(producto.status);
  }
  return accionesOfrecidas(producto).includes('submitted');
}

/** Si «enviar» publica al momento (modo flexible del servidor). */
export function publicaAlEnviar(producto: ProductoDelProveedor | null): boolean {
  return producto?.publicacion_directa === true;
}

/** Si lo que se va a publicar son CAMBIOS de un producto que ya se ve. */
export function sonCambiosDeUnPublicado(producto: ProductoDelProveedor | null): boolean {
  return producto !== null && producto.published !== null && producto.draft !== null;
}

/** Devolverlo a borrador. Solo mientras nadie lo haya mirado. */
export function sePuedeRetirarProducto(producto: ProductoDelProveedor): boolean {
  return accionesOfrecidas(producto).includes('draft');
}

/**
 * Si se puede abrir el editor.
 *
 * Lo dice el servidor (`editable`): con revisión, solo en borrador; en MODO
 * FLEXIBLE, también publicado. Sin ese dato —un servidor anterior— se cae a
 * la regla de siempre, `states.EDITABLES`.
 *
 * No se mira `acciones`: un producto en `submitted` tiene la acción `draft`
 * —retirarlo— y seguiría sin ser editable.
 */
export function sePuedeEditarProducto(producto: ProductoDelProveedor): boolean {
  if (typeof producto.editable === 'boolean') return producto.editable;
  return (PRODUCTOS_EDITABLES as readonly string[]).includes(producto.status);
}

/** La versión que se está escribiendo, o `null` si no hay ninguna. */
export function versionEnBorrador(producto: ProductoDelProveedor): Version | null {
  return producto.draft ?? null;
}

/** Lo que hay que enseñar de un producto: el borrador, y si no, lo publicado. */
export function versionQueSeEnsena(producto: ProductoDelProveedor): Version | null {
  return producto.draft ?? producto.published ?? null;
}

/**
 * El precio tal como se guardó: el entero en unidades MENORES y su moneda.
 *
 * `null` es SIN PRECIO CONFIGURADO, y no se convierte a «gratis» ni a
 * «0,00». No se divide por cien tampoco: cuántos decimales tiene una moneda
 * depende de la moneda —el yen no tiene ninguno— y el servidor no manda ese
 * dato. Se enseña el importe como se escribió, diciendo en qué unidad está.
 */
export function precioLegible(version: Version | null): string | null {
  if (version === null) return null;
  const { price_minor: importe, currency: moneda } = version;
  if (importe === null || importe === undefined) return null;
  if (moneda === null || moneda === undefined || moneda.trim() === '') return null;
  const codigo = moneda.trim().toUpperCase();
  return `${importeComoTexto(importe, codigo)} ${codigo}`;
}

/* -------------------------------------------------------------------------- */
/* El precio, como lo escribe una persona                                      */
/* -------------------------------------------------------------------------- */

/**
 * Las monedas que se ofrecen en el formulario. Cualquier otra de tres letras
 * sigue siendo válida si llega del servidor, pero no se ofrece: elegir entre
 * tres es más cómodo que escribir un código.
 */
export const MONEDAS_OFRECIDAS = ['PEN', 'USD', 'EUR'] as const;

/**
 * Cuántos decimales tiene cada moneda (ISO 4217). La inmensa mayoría, dos; las
 * de esta tabla, otro número. Es lo que permite escribir «49.90» y guardar
 * 4990, y que el yen, que no tiene céntimos, se escriba sin ellos.
 */
const DECIMALES_DISTINTOS_DE_DOS: Record<string, number> = {
  JPY: 0, KRW: 0, CLP: 0, PYG: 0, ISK: 0, VND: 0, UGX: 0, XAF: 0, XOF: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, LYD: 3, IQD: 3,
};

export function decimalesDeLaMoneda(moneda: string | null | undefined): number {
  const codigo = (moneda ?? '').trim().toUpperCase();
  return DECIMALES_DISTINTOS_DE_DOS[codigo] ?? 2;
}

/**
 * Lo escrito («49.90», «49,90», «50») en unidades MENORES, que es lo que pide
 * el contrato. Misma regla que `dinero.aCentavos` de los cursos: con coma o
 * con punto, sin signo ni símbolos, y compuesto con enteros —nunca
 * `Number(x) * 100`, que en coma flotante pierde un céntimo—.
 *
 * `conSigno` es para la diferencia de precio de una variante, que puede ser
 * negativa.
 */
export function importeEscrito(
  texto: string | null | undefined,
  moneda: string | null | undefined,
  { conSigno = false }: { conSigno?: boolean } = {},
): number | null | 'invalido' {
  const limpio = (texto ?? '').trim().replace(/\s/g, '');
  if (limpio === '') return null;
  const negativo = conSigno && limpio.startsWith('-');
  const cuerpo = negativo ? limpio.slice(1) : limpio;
  const decimales = decimalesDeLaMoneda(moneda);
  const formato =
    decimales === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:[.,]\\d{1,${decimales}})?$`);
  if (!formato.test(cuerpo)) return 'invalido';
  const [enteros, fraccion = ''] = cuerpo.replace(',', '.').split('.');
  const valor = Number(enteros) * 10 ** decimales + Number(fraccion.padEnd(decimales, '0') || '0');
  if (!Number.isSafeInteger(valor)) return 'invalido';
  return negativo ? -valor : valor;
}

/** Unidades menores → lo que se escribe en el formulario: 4990 PEN → «49.90». */
export function importeComoTexto(menores: number, moneda: string | null | undefined): string {
  const decimales = decimalesDeLaMoneda(moneda);
  const signo = menores < 0 ? '-' : '';
  const absoluto = Math.abs(Math.round(menores));
  if (decimales === 0) return `${signo}${absoluto}`;
  const divisor = 10 ** decimales;
  const enteros = Math.floor(absoluto / divisor);
  const resto = String(absoluto % divisor).padStart(decimales, '0');
  return `${signo}${enteros}.${resto}`;
}

/* -------------------------------------------------------------------------- */
/* Lo que el servidor rechazaría, dicho antes                                  */
/* -------------------------------------------------------------------------- */

/**
 * Un motivo por el que esto no se puede mandar todavía.
 *
 * `codigo` es el del servidor siempre que exista. `indice` es la fila de la
 * variante o de la foto, para poder señalar cuál.
 */
export type Fallo = {
  /** El campo, o `producto`/`postulacion` cuando es de todo el formulario. */
  campo: string;
  codigo: string;
  min?: number;
  max?: number;
  indice?: number;
};

/**
 * Códigos que el servidor NO devuelve con nombre: los rechaza Pydantic con un
 * 422 sin código, o revienta un CHECK de la base.
 *
 * Están aquí para poder decir cuál de ellos es en vez de un «no se pudo». La
 * regla sí es del servidor —el CHECK `product_variants_sku` de la 0070, los
 * `Field(...)` de `schemas.py`—; lo único local es el nombre del código.
 */
export const CODIGOS_LOCALES = [
  'product_variant_sku_invalid',
  'product_variant_name_out_of_range',
  'product_version_label_too_long',
] as const;

/* -------------------------------------------------------------------------- */
/* La postulación: el formulario, que nace vacío                               */
/* -------------------------------------------------------------------------- */

/** Un documento escrito en la pantalla. Todo texto: se escribe texto. */
export type DocumentoEscrito = {
  kind: string;
  /** La ruta del almacenamiento. Vacía si solo se deja una nota. */
  ruta: string;
  nota: string;
};

/** Lo que hay escrito en la pantalla de postulación. */
export type FormularioDePostulacion = {
  nombre: string;
  propuesta: string;
  documentos: DocumentoEscrito[];
};

/**
 * El formulario en blanco. SIN UN SOLO VALOR Y SIN UN SOLO DOCUMENTO.
 *
 * Ni un tipo de documento sugerido: qué papeles exige la empresa depende de la
 * entidad legal y del país, y eso no está decidido. Poner `identity` de partida
 * sería decidirlo aquí.
 */
export function formularioDePostulacionVacio(): FormularioDePostulacion {
  return { nombre: '', propuesta: '', documentos: [] };
}

/** Un documento nuevo, también vacío: el tipo lo elige quien postula. */
export function documentoVacio(): DocumentoEscrito {
  return { kind: '', ruta: '', nota: '' };
}

/** El formulario cargado desde la postulación que ya existe. */
export function formularioDePostulacionDesde(
  postulacion: Postulacion,
): FormularioDePostulacion {
  return {
    nombre: postulacion.display_name ?? '',
    propuesta: postulacion.proposal ?? '',
    documentos: (postulacion.documents ?? []).map((d) => ({
      kind: d.kind ?? '',
      ruta: d.storage_path ?? '',
      nota: d.note ?? '',
    })),
  };
}

/** Lo que viaja a `PUT /products/seller/application`. */
export type PeticionDePostulacion = {
  display_name: string;
  proposal: string;
  documents: Array<{ kind: string; storage_path?: string; note?: string }>;
};

/**
 * El espejo exacto de `applications.guardar` y `_exigir_documentos`.
 *
 * Mismos límites y mismos códigos. Un documento necesita ruta o nota: los dos
 * vacíos no es «pendiente», es una fila que la base no admite.
 */
export function validarPostulacion(formulario: FormularioDePostulacion): Fallo[] {
  const fallos: Fallo[] = [];
  const nombre = (formulario.nombre ?? '').trim();
  const [nombreMin, nombreMax] = LARGO_DEL_NOMBRE;
  if (nombre.length < nombreMin || nombre.length > nombreMax) {
    fallos.push({
      campo: 'nombre',
      codigo: 'seller_application_name_invalid',
      min: nombreMin,
      max: nombreMax,
    });
  }
  const propuesta = (formulario.propuesta ?? '').trim();
  const [propuestaMin, propuestaMax] = LARGO_DE_LA_PROPUESTA;
  if (propuesta.length < propuestaMin || propuesta.length > propuestaMax) {
    fallos.push({
      campo: 'propuesta',
      codigo: 'seller_application_proposal_invalid',
      min: propuestaMin,
      max: propuestaMax,
    });
  }

  const documentos = formulario.documentos ?? [];
  if (documentos.length > MAXIMO_DE_DOCUMENTOS) {
    fallos.push({
      campo: 'postulacion',
      codigo: 'seller_application_documents_too_many',
      max: MAXIMO_DE_DOCUMENTOS,
    });
  }
  documentos.forEach((documento, indice) => {
    const tipo = (documento.kind ?? '').trim();
    if (!(DOCUMENTOS as readonly string[]).includes(tipo)) {
      fallos.push({
        campo: 'documento',
        codigo: 'seller_application_document_kind_invalid',
        indice,
      });
    }
    const ruta = (documento.ruta ?? '').trim();
    const nota = (documento.nota ?? '').trim();
    if (ruta === '' && nota === '') {
      fallos.push({
        campo: 'documento',
        codigo: 'seller_application_document_empty',
        indice,
      });
    }
    if (ruta !== '' && (ruta.includes('://') || ruta.length > LARGO_DE_LA_RUTA[1])) {
      fallos.push({
        campo: 'documento',
        codigo: 'seller_application_document_path_invalid',
        indice,
        max: LARGO_DE_LA_RUTA[1],
      });
    }
    if (nota.length > LARGO_DE_LA_NOTA) {
      fallos.push({
        campo: 'documento',
        codigo: 'seller_application_document_note_too_long',
        indice,
        max: LARGO_DE_LA_NOTA,
      });
    }
  });
  return fallos;
}

/**
 * La petición lista para viajar, o `null` si todavía no se puede mandar.
 *
 * LO QUE NO SE ESCRIBIÓ NO VIAJA: un documento con nota y sin archivo manda
 * `note` y nada más. Mandar `storage_path: ""` haría que la base viera una
 * cadena vacía donde no hay ruta.
 */
export function peticionDePostulacion(formulario: FormularioDePostulacion): {
  peticion: PeticionDePostulacion | null;
  fallos: Fallo[];
} {
  const fallos = validarPostulacion(formulario);
  if (fallos.length > 0) return { peticion: null, fallos };
  const documents = (formulario.documentos ?? []).map((documento) => {
    const fila: { kind: string; storage_path?: string; note?: string } = {
      kind: (documento.kind ?? '').trim(),
    };
    const ruta = (documento.ruta ?? '').trim();
    const nota = (documento.nota ?? '').trim();
    if (ruta !== '') fila.storage_path = ruta;
    if (nota !== '') fila.note = nota;
    return fila;
  });
  return {
    peticion: {
      display_name: (formulario.nombre ?? '').trim(),
      proposal: (formulario.propuesta ?? '').trim(),
      documents,
    },
    fallos: [],
  };
}

/* -------------------------------------------------------------------------- */
/* El producto: el formulario, que también nace vacío                          */
/* -------------------------------------------------------------------------- */

/** Una opción de una variante, escrita como par. */
export type OpcionEscrita = { clave: string; valor: string };

/** Una variante escrita en la pantalla. */
export type VarianteEscrita = {
  sku: string;
  nombre: string;
  opciones: OpcionEscrita[];
  /** La diferencia de precio en unidades menores. Vacía NO es cero escrito. */
  diferencia: string;
};

/*
  AQUÍ ESTABA `FotoEscrita`, una foto TECLEADA: `{ ruta, alternativo }`. Se ha
  ido con el editor de galería de `EditarProductoScreen`. Una fotografía no se
  escribe: se sube, y de eso se ocupa `fotosDeProducto.ts`.
*/

/** Lo que hay escrito en la pantalla de un producto. Todo texto. */
export type FormularioDeProducto = {
  version: string;
  nombre: string;
  resumen: string;
  descripcion: string;
  materiales: string;
  pais: string;
  fabricante: string;
  /**
   * El importe como lo escribe una persona: «49.90» o «49,90». Se convierte a
   * unidades MENORES al mandarlo (`importeEscrito`). Antes se escribía ya en
   * céntimos («4990») y nadie que probaba la app lo adivinaba.
   */
  precio: string;
  moneda: string;
  /** La categoría elegida (`category_id`), o vacío. Vive en el producto. */
  categoria: string;
  variantes: VarianteEscrita[];
};

/**
 * El formulario en blanco. NI UN CERO NI UNA MONEDA DE PARTIDA.
 *
 * Un `precio: '0'` precargado dice «gratis» y una moneda precargada dice en qué
 * país se vende. Las dos son decisiones de quien produce, no de la aplicación.
 */
export function formularioDeProductoVacio(): FormularioDeProducto {
  return {
    version: '',
    nombre: '',
    resumen: '',
    descripcion: '',
    materiales: '',
    pais: '',
    fabricante: '',
    precio: '',
    moneda: '',
    categoria: '',
    variantes: [],
  };
}

/** Una variante nueva, vacía. La diferencia de precio también. */
export function varianteVacia(): VarianteEscrita {
  return { sku: '', nombre: '', opciones: [], diferencia: '' };
}

/** Una opción nueva, vacía. */
export function opcionVacia(): OpcionEscrita {
  return { clave: '', valor: '' };
}

/** Un valor de `options` como texto, sin interpretarlo. */
function valorDeOpcion(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  try {
    return JSON.stringify(valor);
  } catch {
    return '';
  }
}

/**
 * El formulario cargado desde el borrador que ya existe.
 *
 * Lo que la versión NO trae sigue vacío. Un `price_minor` nulo deja el precio
 * en blanco: escribir «0» ahí convertiría «sin precio» en «gratis» al guardar.
 */
export function formularioDeProductoDesde(
  version: Version,
  categoria: string | null = null,
): FormularioDeProducto {
  return {
    version: version.version ?? '',
    nombre: version.name ?? '',
    resumen: version.summary ?? '',
    descripcion: version.description ?? '',
    materiales: version.materials ?? '',
    pais: version.origin_country ?? '',
    fabricante: version.manufacturer ?? '',
    precio:
      version.price_minor === null || version.price_minor === undefined
        ? ''
        : importeComoTexto(version.price_minor, version.currency),
    moneda: version.currency ?? '',
    categoria: categoria ?? '',
    variantes: (version.variants ?? []).map((v) => ({
      sku: v.sku ?? '',
      nombre: v.name ?? '',
      opciones: Object.keys(v.options ?? {}).map((clave) => ({
        clave,
        valor: valorDeOpcion((v.options ?? {})[clave]),
      })),
      diferencia:
        v.price_delta_minor === null || v.price_delta_minor === undefined
          ? ''
          : importeComoTexto(v.price_delta_minor, version.currency),
    })),
    // `version.gallery` NO SE COPIA AL FORMULARIO. Se lee para enseñar cuántas
    // fotografías hay y en qué estado están, pero no hay ningún campo que las
    // escriba: traerlas aquí solo serviría para volver a mandarlas.
  };
}

/** Lo que viaja en una variante. */
export type PeticionDeVariante = {
  sku: string;
  name: string;
  options: Record<string, string>;
  price_delta_minor: number;
};

/*
  AQUÍ ESTABA `PeticionDeMedia`, lo que viajaba en `gallery`. El servidor ya no
  lee ese campo: se ha ido con él.
*/

/**
 * Lo que viaja a `POST /products/seller/products` y a
 * `PUT /products/seller/products/{id}/draft`.
 *
 * `name` es lo único obligatorio. TODO LO DEMÁS SE OMITE SI NO SE ESCRIBIÓ, y
 * omitirlo es exactamente lo que el servidor lee como «sin configurar».
 */
export type PeticionDeVersion = {
  name: string;
  version?: string;
  summary?: string;
  description?: string;
  materials?: string;
  origin_country?: string;
  manufacturer?: string;
  price_minor?: number;
  currency?: string;
  /** Vive en el producto; `VersionRequest.category_id` desde el 24/09/2026. */
  category_id?: string;
  variants?: PeticionDeVariante[];
  /*
    SIN `gallery`. `VersionRequest` no lo tiene desde la 0073, y Pydantic
    descarta las claves que le sobran SIN ERROR: mandarlo devolvía un 200 que no
    guardaba nada. Las fotografías se suben por su propia ruta.
  */
};

/** Un texto listo para viajar, o `null` si no se escribió nada. */
function util(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  return limpio === '' ? null : limpio;
}

/** Lee un entero escrito. `null` es «no escrito»; `'x'` es un fallo. */
function enteroEscrito(texto: string | null | undefined): number | null | 'invalido' {
  const limpio = (texto ?? '').trim();
  if (limpio === '') return null;
  if (!FORMATO_DEL_ENTERO.test(limpio)) return 'invalido';
  const valor = Number(limpio);
  return Number.isSafeInteger(valor) ? valor : 'invalido';
}

function fueraDeRango(campo: string, valor: string, cota: readonly [number, number]) {
  const [minimo, maximo] = cota;
  if (valor.length < minimo || valor.length > maximo) {
    return { campo, codigo: 'product_field_out_of_range', min: minimo, max: maximo };
  }
  return null;
}

/**
 * El espejo exacto de `_exigir_textos`, `_exigir_variantes` y `_exigir_galeria`.
 *
 * En el mismo orden y con los mismos códigos. Lo único que no viene con nombre
 * del servidor son los tres de `CODIGOS_LOCALES`, que allí son un 422 de
 * Pydantic o un CHECK de la 0070.
 */
export function validarProducto(formulario: FormularioDeProducto): Fallo[] {
  const fallos: Fallo[] = [];

  const nombre = (formulario.nombre ?? '').trim();
  if (nombre === '') {
    fallos.push({ campo: 'nombre', codigo: 'product_name_required' });
  } else {
    const roto = fueraDeRango('nombre', nombre, LARGO_DEL_NOMBRE_DEL_PRODUCTO);
    if (roto !== null) fallos.push(roto);
  }

  const etiqueta = (formulario.version ?? '').trim();
  if (etiqueta.length > LARGO_DE_LA_VERSION) {
    fallos.push({
      campo: 'version',
      codigo: 'product_version_label_too_long',
      max: LARGO_DE_LA_VERSION,
    });
  }

  const resumen = (formulario.resumen ?? '').trim();
  if (resumen.length > LARGO_DEL_RESUMEN) {
    fallos.push({
      campo: 'resumen',
      codigo: 'product_field_out_of_range',
      min: 0,
      max: LARGO_DEL_RESUMEN,
    });
  }
  const descripcion = (formulario.descripcion ?? '').trim();
  if (descripcion.length > LARGO_DE_LA_DESCRIPCION) {
    fallos.push({
      campo: 'descripcion',
      codigo: 'product_field_out_of_range',
      min: 0,
      max: LARGO_DE_LA_DESCRIPCION,
    });
  }
  const materiales = (formulario.materiales ?? '').trim();
  if (materiales.length > LARGO_DE_LOS_MATERIALES) {
    fallos.push({
      campo: 'materiales',
      codigo: 'product_field_out_of_range',
      min: 0,
      max: LARGO_DE_LOS_MATERIALES,
    });
  }
  // EL FABRICANTE TIENE MÍNIMO 2, y vacío no es un fallo: es «no se dice».
  const fabricante = (formulario.fabricante ?? '').trim();
  if (fabricante !== '') {
    const roto = fueraDeRango('fabricante', fabricante, LARGO_DEL_FABRICANTE);
    if (roto !== null) fallos.push(roto);
  }

  const pais = (formulario.pais ?? '').trim();
  if (pais !== '' && !FORMATO_DEL_PAIS.test(pais)) {
    fallos.push({ campo: 'pais', codigo: 'product_country_invalid' });
  }

  // EL PRECIO VA CON SU MONEDA O NO VA.
  const moneda = (formulario.moneda ?? '').trim();
  const precio = importeEscrito(formulario.precio, moneda);
  if (precio === 'invalido' || (typeof precio === 'number' && precio < 0)) {
    fallos.push({ campo: 'precio', codigo: 'product_price_invalid' });
  }
  if (moneda !== '' && !FORMATO_DE_LA_MONEDA.test(moneda)) {
    fallos.push({ campo: 'moneda', codigo: 'product_currency_invalid' });
  }
  const hayPrecio = precio !== null;
  const hayMoneda = moneda !== '';
  if (hayPrecio !== hayMoneda) {
    fallos.push({
      campo: hayPrecio ? 'moneda' : 'precio',
      codigo: 'product_price_without_currency',
    });
  }

  const variantes = formulario.variantes ?? [];
  if (variantes.length > MAXIMO_DE_VARIANTES) {
    fallos.push({
      campo: 'producto',
      codigo: 'product_variants_too_many',
      max: MAXIMO_DE_VARIANTES,
    });
  }
  const skus = new Set<string>();
  variantes.forEach((variante, indice) => {
    const sku = (variante.sku ?? '').trim();
    const nombreDeVariante = (variante.nombre ?? '').trim();
    if (sku === '' || nombreDeVariante === '') {
      fallos.push({ campo: 'variante', codigo: 'product_variant_incomplete', indice });
    } else {
      if (!FORMATO_DEL_SKU.test(sku)) {
        fallos.push({ campo: 'variante', codigo: 'product_variant_sku_invalid', indice });
      }
      if (nombreDeVariante.length > LARGO_DEL_NOMBRE_DE_VARIANTE[1]) {
        fallos.push({
          campo: 'variante',
          codigo: 'product_variant_name_out_of_range',
          indice,
          min: LARGO_DEL_NOMBRE_DE_VARIANTE[0],
          max: LARGO_DEL_NOMBRE_DE_VARIANTE[1],
        });
      }
      if (skus.has(sku)) {
        fallos.push({ campo: 'variante', codigo: 'product_variant_sku_repeated', indice });
      }
      skus.add(sku);
    }
    if (importeEscrito(variante.diferencia, formulario.moneda, { conSigno: true }) === 'invalido') {
      fallos.push({ campo: 'variante', codigo: 'product_variant_delta_invalid', indice });
    }
  });

  /*
    AQUÍ SE VALIDABA LA GALERÍA: el tope de fotos, la ruta, las repetidas y el
    texto alternativo. Ya no hay nada que validar, porque ya no hay nada que
    escribir. Lo que se sube de verdad lo comprueba `porQueNoSePuedeSubir` en
    `fotosDeProducto.ts` —tipo, peso y texto alternativo— y luego el servidor,
    que abre la imagen y mira los bytes.
  */

  return fallos;
}

/**
 * Las opciones de una variante, listas para viajar.
 *
 * Las filas sin clave se caen: una clave vacía no nombra ninguna opción. Los
 * valores viajan como texto, que es lo que se escribió; `options` es un objeto
 * libre en el contrato y convertir «38» a número sería interpretar una talla.
 */
export function opcionesUtiles(opciones: OpcionEscrita[]): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const opcion of opciones ?? []) {
    const clave = (opcion.clave ?? '').trim();
    if (clave === '') continue;
    salida[clave] = (opcion.valor ?? '').trim();
  }
  return salida;
}

/**
 * La petición lista para viajar, o `null` si todavía no se puede mandar.
 *
 * UN CAMPO SIN ESCRIBIR NO APARECE EN EL CUERPO. Las listas vacías tampoco:
 * mandarlas o no mandarlas significa lo mismo para el servidor, y un cuerpo con
 * `{name}` y nada más se lee de un vistazo.
 */
export function peticionDeVersion(formulario: FormularioDeProducto): {
  peticion: PeticionDeVersion | null;
  fallos: Fallo[];
} {
  const fallos = validarProducto(formulario);
  if (fallos.length > 0) return { peticion: null, fallos };

  const peticion: PeticionDeVersion = { name: (formulario.nombre ?? '').trim() };

  const etiqueta = util(formulario.version);
  if (etiqueta !== null) peticion.version = etiqueta;
  const resumen = util(formulario.resumen);
  if (resumen !== null) peticion.summary = resumen;
  const descripcion = util(formulario.descripcion);
  if (descripcion !== null) peticion.description = descripcion;
  const materiales = util(formulario.materiales);
  if (materiales !== null) peticion.materials = materiales;
  const fabricante = util(formulario.fabricante);
  if (fabricante !== null) peticion.manufacturer = fabricante;
  const pais = util(formulario.pais);
  if (pais !== null) peticion.origin_country = pais.toUpperCase();

  // LOS DOS O NINGUNO. `validarProducto` ya lo ha exigido; esto lo hace
  // imposible también si alguien llamara solo a esta función.
  const moneda = util(formulario.moneda);
  const precio = importeEscrito(formulario.precio, moneda);
  if (typeof precio === 'number' && moneda !== null) {
    peticion.price_minor = precio;
    peticion.currency = moneda.toUpperCase();
  }
  const categoria = util(formulario.categoria);
  if (categoria !== null) peticion.category_id = categoria;

  const variantes = (formulario.variantes ?? []).map((variante) => {
    const diferencia = importeEscrito(variante.diferencia, moneda, { conSigno: true });
    return {
      sku: (variante.sku ?? '').trim(),
      name: (variante.nombre ?? '').trim(),
      options: opcionesUtiles(variante.opciones ?? []),
      // El servidor hace `v.get("price_delta_minor") or 0`: sin escribir es
      // cero, y aquí es lo mismo. No es un precio: es una diferencia.
      price_delta_minor: typeof diferencia === 'number' ? diferencia : 0,
    };
  });
  if (variantes.length > 0) peticion.variants = variantes;

  // NO SE AÑADE `gallery`. El servidor no lo lee, y mandarlo hacía que guardar
  // devolviera un 200 sobre unas rutas que se perdían por el camino.

  return { peticion, fallos: [] };
}

/** Si con lo escrito se puede guardar el borrador. */
export function sePuedeGuardarProducto(formulario: FormularioDeProducto): boolean {
  return validarProducto(formulario).length === 0;
}

/** Si con lo escrito se puede guardar la postulación. */
export function sePuedeGuardarPostulacion(formulario: FormularioDePostulacion): boolean {
  return validarPostulacion(formulario).length === 0;
}

/** Si hay algo escrito en el formulario del producto. */
export function hayAlgoEscrito(formulario: FormularioDeProducto): boolean {
  const textos = [
    formulario.version,
    formulario.nombre,
    formulario.resumen,
    formulario.descripcion,
    formulario.materiales,
    formulario.pais,
    formulario.fabricante,
    formulario.precio,
    formulario.moneda,
  ];
  if (textos.some((texto) => (texto ?? '').trim() !== '')) return true;
  // Las fotografías NO cuentan: no se escriben en este formulario, viven en su
  // propia pantalla y no se pierden si aquí no hay nada.
  return (formulario.variantes ?? []).length > 0;
}

/** Una ruta del almacenamiento, y nunca una URL. */
export function esRutaDeAlmacenamiento(ruta: string | null | undefined): boolean {
  const limpio = (ruta ?? '').trim();
  const [minimo, maximo] = LARGO_DE_LA_RUTA;
  if (limpio.length < minimo || limpio.length > maximo) return false;
  return !limpio.includes('://');
}

/* -------------------------------------------------------------------------- */
/* Cuando algo sale mal                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Los códigos de estas pantallas, traducidos.
 *
 * `null` es «no lo conozco»: entonces se usa el mensaje del servidor, que en
 * español es correcto. Inventar un texto genérico taparía uno mejor.
 */
export function claveDeErrorDeProveedor(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const conocidos: Record<string, string> = {
    /* Admisión del proveedor (`applications.py`). */
    seller_application_not_found: 'proveedorProductos.error.postulacionNoEncontrada',
    seller_application_not_editable: 'proveedorProductos.error.postulacionNoEditable',
    seller_application_changed: 'proveedorProductos.error.postulacionCambiada',
    seller_application_name_invalid: 'proveedorProductos.error.nombreInvalido',
    seller_application_proposal_invalid: 'proveedorProductos.error.propuestaInvalida',
    seller_application_documents_too_many: 'proveedorProductos.error.demasiadosDocumentos',
    seller_application_document_kind_invalid: 'proveedorProductos.error.tipoDeDocumentoInvalido',
    seller_application_document_empty: 'proveedorProductos.error.documentoVacio',
    seller_application_document_path_invalid: 'proveedorProductos.error.rutaDeDocumentoInvalida',
    seller_application_document_too_big: 'proveedorProductos.error.documentoPesado',
    seller_application_document_type_invalid: 'proveedorProductos.error.documentoTipo',
    seller_application_document_note_too_long: 'proveedorProductos.error.notaLarga',
    seller_application_reject_needs_reason: 'proveedorProductos.error.rechazoSinMotivo',
    seller_application_reason_too_long: 'proveedorProductos.error.motivoLargo',
    seller_application_self_review_forbidden: 'proveedorProductos.error.nadieSeDecideSolo',
    seller_already_active: 'proveedorProductos.error.yaEsProveedor',
    /* El producto y su versión (`service.py`). */
    product_name_required: 'proveedorProductos.error.faltaNombre',
    product_field_out_of_range: 'proveedorProductos.error.fueraDeRango',
    product_country_invalid: 'proveedorProductos.error.paisInvalido',
    product_price_invalid: 'proveedorProductos.error.precioInvalido',
    product_currency_invalid: 'proveedorProductos.error.monedaInvalida',
    product_price_without_currency: 'proveedorProductos.error.precioSinMoneda',
    product_variants_too_many: 'proveedorProductos.error.demasiadasVariantes',
    product_variant_incomplete: 'proveedorProductos.error.varianteIncompleta',
    product_variant_sku_repeated: 'proveedorProductos.error.skuRepetido',
    product_variant_options_invalid: 'proveedorProductos.error.opcionesInvalidas',
    product_variant_delta_invalid: 'proveedorProductos.error.diferenciaInvalida',
    // LOS CINCO CODIGOS DE LA GALERIA PEGADA A MANO SE FUERON CON ELLA. El
    // servidor ya no produce ninguno —se marcharon con `_exigir_galeria` en la
    // 0073— y dejarlos aqui hace creer a quien lea este mapa que todavia puede
    // llegar uno. Lo que puede fallar al subir una fotografia lo traduce
    // `lib/fotosDeProducto.ts`, que es quien la sube.
    product_category_invalid: 'proveedorProductos.error.categoriaInvalida',
    product_not_editable: 'proveedorProductos.error.noEditable',
    product_version_taken: 'proveedorProductos.error.versionTomada',
    product_version_not_editable: 'proveedorProductos.error.versionNoEditable',
    product_changed: 'proveedorProductos.error.productoCambiado',
    product_suspension_needs_reason: 'proveedorProductos.error.suspensionSinMotivo',
    /* Lo que falta para publicar (`por_que_no_se_publica`). */
    product_not_approved: 'proveedorProductos.bloqueo.product_not_approved',
    product_version_missing: 'proveedorProductos.bloqueo.product_version_missing',
    product_media_required: 'proveedorProductos.bloqueo.product_media_required',
    product_evaluation_required: 'proveedorProductos.bloqueo.product_evaluation_required',
    product_reasons_required: 'proveedorProductos.bloqueo.product_reasons_required',
    product_evaluation_not_available: 'proveedorProductos.error.informeNoDisponible',
    /* Permisos y máquina de estados. */
    product_not_found: 'proveedorProductos.error.noEncontrado',
    product_seller_not_active: 'proveedorProductos.error.sinCapacidadComercial',
    product_self_review_forbidden: 'proveedorProductos.error.nadieSeEvaluaSolo',
    product_review_forbidden: 'proveedorProductos.error.soloCuraduria',
    product_publish_forbidden: 'proveedorProductos.error.soloAdministracion',
    product_transition_invalid: 'proveedorProductos.error.saltoInexistente',
    product_transition_forbidden: 'proveedorProductos.error.saltoNoPermitido',
    /* Las migraciones que todavía no están aplicadas. */
    products_not_available: 'proveedorProductos.error.noDisponible',
    product_admission_not_available: 'proveedorProductos.error.admisionNoDisponible',
    product_saves_not_available: 'proveedorProductos.error.guardadosNoDisponibles',
    /* Los tres que aquí tienen nombre y allí son un 422 o un CHECK. */
    product_variant_sku_invalid: 'proveedorProductos.error.skuInvalido',
    product_variant_name_out_of_range: 'proveedorProductos.error.nombreDeVarianteInvalido',
    product_version_label_too_long: 'proveedorProductos.error.versionLarga',
  };
  if (typeof codigo !== 'string') return null;
  return conocidos[codigo] ?? null;
}

/** El mensaje de un fallo local, que es el mismo que el del servidor. */
export function claveDeFallo(fallo: Fallo): ClaveDeTraduccion {
  return claveDeErrorDeProveedor(fallo.codigo) ?? 'proveedorProductos.error.desconocido';
}

/** Si la función todavía no está desplegada en esta base. */
export function esProductosApagado(codigo: string | null | undefined): boolean {
  return codigo === 'products_not_available' || codigo === 'product_admission_not_available';
}

/** Lo que hay que enseñar según el estado HTTP, cuando no hay código mejor. */
export function claveDeErrorPorEstado(
  estado: number | null | undefined,
): ClaveDeTraduccion | null {
  if (estado === 401) return 'proveedorProductos.error.sinSesion';
  if (estado === 403) return 'proveedorProductos.error.sinPermiso';
  if (estado === 404) return 'proveedorProductos.error.noEncontrado';
  if (estado === 409) return 'proveedorProductos.error.conflicto';
  return null;
}

/**
 * Si esto se arregla recargando y volviendo a intentarlo.
 *
 * Un 409 aquí es «lo que tenías delante ya no es lo que hay»: alguien movió el
 * producto o la postulación mientras se decidía. No es un error que mostrar y
 * olvidar: se recarga y se deja decidir otra vez sobre lo que hay ahora.
 */
export function hayQueRecargar(
  estado: number | null | undefined,
  codigo: string | null | undefined,
): boolean {
  return (
    estado === 409 ||
    codigo === 'product_changed' ||
    codigo === 'product_not_editable' ||
    codigo === 'product_version_taken' ||
    codigo === 'seller_application_changed' ||
    codigo === 'seller_application_not_editable'
  );
}

/* -------------------------------------------------------------------------- */
/* Formato                                                                     */
/* -------------------------------------------------------------------------- */

/** La versión tal como se escribió. Sin «v» delante y sin convertirla a «1.0». */
export function etiquetaDeVersion(version: string | null | undefined): string {
  return (version ?? '').trim();
}

/** La fecha, en el idioma del sistema. Vacía si el servidor mandó algo raro. */
export function fechaLegible(iso: string | null | undefined): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
