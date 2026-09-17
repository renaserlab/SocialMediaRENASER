import type { ClaveDeTraduccion } from '@/lib/productos';

/**
 * Las fotografías de un producto. LÓGICA PURA: sin React, sin red y sin
 * pantalla.
 *
 * SUBIR NO ES PUBLICAR, y esta es la regla que hay que ver en la pantalla. Una
 * fotografía nace PENDIENTE; quien evalúa la aprueba o la rechaza con motivo, y
 * el catálogo solo enseña las aprobadas. Sin ese estado, aprobar un producto
 * aprobaría también cualquier imagen que le añadieran después.
 *
 * LA APLICACIÓN NO FIRMA NADA. El depósito es privado y no tiene políticas: la
 * URL llega firmada del servidor, con vencimiento, y no se guarda en ningún
 * sitio. Que llegue nula no es un error: es que no se pudo firmar, y entonces
 * se enseña el texto alternativo.
 *
 * Y EL TEXTO ALTERNATIVO ES OBLIGATORIO. No es un adorno de accesibilidad: es
 * lo único que queda cuando la imagen no carga, y es lo que lee quien no ve.
 */

/* -------------------------------------------------------------------------- */
/* El contrato                                                                 */
/* -------------------------------------------------------------------------- */

export type EstadoDeLaFoto = 'pending' | 'approved' | 'rejected';

export type FotoDelProveedor = {
  id: string;
  kind: string;
  storage_path: string;
  alt_text: string | null;
  position: number;
  status: EstadoDeLaFoto | string;
  content_type: string | null;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  url: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string | null;
};

export type FotoPendiente = {
  id: string;
  product_id: string;
  version_id: string;
  product_name: string;
  alt_text: string | null;
  storage_path: string;
  url: string | null;
  width: number | null;
  height: number | null;
  byte_size: number | null;
  content_type: string | null;
  created_at: string | null;
};

/* -------------------------------------------------------------------------- */
/* Lo que el depósito admite                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Los tres tipos que acepta `product-media`. LISTA CERRADA, y sin `image/svg`:
 * un SVG es un documento con scripts, no una fotografía.
 *
 * Tiene que coincidir con la 0073 y con `products/models.py`. Comprobarlo aquí
 * no sustituye al servidor —que mira los bytes de verdad— pero evita subir
 * cuarenta megas para que los rechace.
 */
export const TIPOS_ADMITIDOS = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Tope por archivo, el mismo que declara el depósito. */
export const MAXIMO_BYTES = 10 * 1024 * 1024;

/**
 * Cuántas fotografías admite una versión.
 *
 * EL BLUEPRINT NO FIJA EL NÚMERO: la captura 6 enseña una galería «1/5», así
 * que cinco es lo que la referencia visual sostiene. El servidor lo vuelve a
 * contar, porque un tope que solo vive en la pantalla no es un tope.
 */
export const MAXIMO_DE_FOTOS = 5;

/** Largo mínimo del texto alternativo. Tres letras no describen nada, pero
 * menos tampoco, y es lo mismo que exige el servidor. */
export const LARGO_MINIMO_DEL_ALTERNATIVO = 3;
export const LARGO_MAXIMO_DEL_ALTERNATIVO = 300;

/* -------------------------------------------------------------------------- */
/* Antes de subir                                                              */
/* -------------------------------------------------------------------------- */

export type MotivoDeRechazo =
  | 'tipo'
  | 'peso'
  | 'vacio'
  | 'alternativo'
  | 'demasiadas';

/**
 * Por qué NO se puede subir este archivo, o `null` si se puede.
 *
 * Es una comprobación de cortesía: la de verdad la hace el servidor, que abre
 * la imagen y comprueba que los bytes son lo que dicen ser. Renombrar un `.exe`
 * a `.jpg` pasa por aquí y lo para el servidor.
 */
export function porQueNoSePuedeSubir(opciones: {
  tipo: string | null | undefined;
  bytes: number | null | undefined;
  altText: string;
  yaHay: number;
}): MotivoDeRechazo | null {
  if (opciones.yaHay >= MAXIMO_DE_FOTOS) return 'demasiadas';
  const limpio = (opciones.altText ?? '').trim();
  if (
    limpio.length < LARGO_MINIMO_DEL_ALTERNATIVO ||
    limpio.length > LARGO_MAXIMO_DEL_ALTERNATIVO
  ) {
    return 'alternativo';
  }
  //: `?? ''` porque con `noUncheckedIndexedAccess` el primer trozo de un
  //: `split` es `string | undefined`, aunque nunca lo sea de verdad.
  const tipo = ((opciones.tipo ?? '').split(';')[0] ?? '').trim().toLowerCase();
  if (!(TIPOS_ADMITIDOS as readonly string[]).includes(tipo)) return 'tipo';
  if (typeof opciones.bytes !== 'number' || !Number.isFinite(opciones.bytes)) return null;
  if (opciones.bytes <= 0) return 'vacio';
  if (opciones.bytes > MAXIMO_BYTES) return 'peso';
  return null;
}

/** La clave del texto de ese motivo. */
export function claveDelMotivo(motivo: MotivoDeRechazo): ClaveDeTraduccion {
  return `fotos.noSePuede.${motivo}`;
}

/* -------------------------------------------------------------------------- */
/* Lo que ya está subido                                                       */
/* -------------------------------------------------------------------------- */

/** Las fotografías en su orden. El servidor manda `position`; aquí se respeta. */
export function enOrden(fotos: FotoDelProveedor[]): FotoDelProveedor[] {
  return [...fotos].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/** Las aprobadas, que son las únicas que verá quien compre. */
export function aprobadas(fotos: FotoDelProveedor[]): FotoDelProveedor[] {
  return enOrden(fotos).filter((foto) => foto.status === 'approved');
}

/** Si con estas fotografías el producto se podría publicar. */
export function hayAlgunaAprobada(fotos: FotoDelProveedor[]): boolean {
  return fotos.some((foto) => foto.status === 'approved');
}

/**
 * El aviso que hay que enseñarle a quien vende, si hay alguno.
 *
 * UNO SOLO, y el más accionable primero: si le rechazaron una, eso es lo que
 * tiene que leer; si no hay ninguna, que suba; si están todas pendientes, que
 * espere. Tres avisos a la vez es una pantalla que nadie lee.
 */
export function avisoDeLaGaleria(fotos: FotoDelProveedor[]): ClaveDeTraduccion | null {
  if (fotos.some((foto) => foto.status === 'rejected')) return 'fotos.aviso.rechazada';
  if (fotos.length === 0) return 'fotos.aviso.ninguna';
  if (!hayAlgunaAprobada(fotos)) return 'fotos.aviso.pendientes';
  return null;
}

/** La clave del nombre de un estado. */
export function claveDelEstadoDeLaFoto(estado: string): ClaveDeTraduccion {
  return ['pending', 'approved', 'rejected'].includes(estado)
    ? `fotos.estado.${estado}`
    : 'fotos.estado.desconocido';
}

/** El icono de un estado. `null` si no lo conocemos. */
export function iconoDelEstadoDeLaFoto(estado: string): string | null {
  const iconos: Record<string, string> = {
    pending: 'clock',
    approved: 'check-circle',
    rejected: 'x-circle',
  };
  return iconos[estado] ?? null;
}

/** Si se puede subir una más. */
export function cabeOtraFoto(fotos: FotoDelProveedor[]): boolean {
  return fotos.length < MAXIMO_DE_FOTOS;
}

/**
 * El orden resultante de mover una fotografía una posición.
 *
 * Devuelve la lista COMPLETA de identificadores, que es lo que exige el
 * servidor: una lista parcial dejaría las que faltan en una posición que nadie
 * eligió, y el orden final no sería ni el viejo ni el nuevo.
 */
export function moverFoto(
  fotos: FotoDelProveedor[],
  id: string,
  paso: 1 | -1,
): string[] {
  const lista = enOrden(fotos).map((foto) => foto.id);
  const desde = lista.indexOf(id);
  if (desde === -1) return lista;
  const hasta = desde + paso;
  if (hasta < 0 || hasta >= lista.length) return lista;
  const copia = [...lista];
  //: Los dos índices ya están comprobados arriba; los `?? ''` son para el
  //: compilador, que no lo ve, y no cambian nada en tiempo de ejecución.
  copia[desde] = lista[hasta] ?? '';
  copia[hasta] = lista[desde] ?? '';
  return copia;
}

/* -------------------------------------------------------------------------- */
/* Errores                                                                     */
/* -------------------------------------------------------------------------- */

const ERRORES: Record<string, ClaveDeTraduccion> = {
  product_media_not_available: 'fotos.error.noDisponible',
  product_media_not_found: 'fotos.error.noEncontrada',
  product_media_invalid: 'fotos.error.invalida',
  product_media_limit_reached: 'fotos.error.demasiadas',
  product_media_without_file: 'fotos.error.sinArchivo',
  product_media_not_approved: 'fotos.error.sinAprobar',
  product_media_required: 'fotos.error.ninguna',
  product_not_editable: 'fotos.error.noEditable',
  product_version_missing: 'fotos.error.sinBorrador',
  /*
    SUBIR, ORDENAR Y QUITAR EXIGEN CAPACIDAD COMERCIAL ACTIVA
    (`exigir_vendedor_activo`), así que este 403 llega por estas rutas. Sin
    traducir, quien tenga la capacidad suspendida veía el mensaje crudo del
    servidor y no la única frase que le sirve: que no es un fallo de la
    fotografía, sino de su cuenta.
  */
  product_seller_not_active: 'fotos.error.sinCapacidadComercial',
};

export function claveDeErrorDeFotos(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const limpio = (codigo ?? '').trim();
  return limpio === '' ? null : (ERRORES[limpio] ?? null);
}

/** Si el fallo es que la 0073 no está aplicada en esa base. */
export function esFotosApagado(codigo: string | null | undefined): boolean {
  return (codigo ?? '').trim() === 'product_media_not_available';
}

/** La clave de idempotencia de una subida. UNA POR PULSACIÓN. */
export function claveDeLaSubida(productoId: string, momento: number): string {
  return `${productoId}:${Math.trunc(momento)}`;
}
