import { CLAVE_SIN_PRECIO, precioLegible, type ClaveDeTraduccion, type Precio } from '@/lib/productos';

/*
  POR EL ALIAS, Y NO POR RUTA RELATIVA CON EXTENSIÓN. Este módulo importa
  VALORES —no solo tipos— de `productos.ts`, y `import ... from './productos.ts'`
  lo rechaza TypeScript (TS5097) salvo con `allowImportingTsExtensions`, que es
  una opción global y cambiarla por un fichero no toca. `posventaAdmin.ts` sí usa
  la extensión, pero en un `import type`, que se borra al compilar.

  Consecuencia: el ejecutor de pruebas de Node no resuelve `@/`, así que
  `carrito.test.mts` registra un resolutor para cargar este módulo. Es
  maquinaria de la prueba, no del producto.
*/

/**
 * La bolsa de Productos. LÓGICA PURA: sin React, sin red y sin pantalla.
 *
 * NO ES «GUARDADOS», Y NO SE PARECE. Guardar es un marcador sin cantidad, sin
 * variante y sin precio; la bolsa tiene cantidad, variante, moneda y un total.
 * Por eso son DOS CONTADORES distintos en el encabezado: juntarlos haría que el
 * número no quisiera decir nada concreto.
 *
 * TODAVÍA NO SE COMPRA, Y LA PANTALLA LO DICE. `purchasable` llega siempre en
 * `false` desde el servidor y aquí no hay ninguna función que lo ignore: no
 * existe checkout, ni pedido, ni pago. Un botón que prometa pagar sin recorrido
 * detrás cuesta más confianza que su ausencia.
 *
 * NINGÚN IMPORTE SE CALCULA AQUÍ. Ni el de una línea, ni el total. El servidor
 * los manda calculados y esto solo los escribe: si el cliente sumara, dos
 * versiones instaladas en dos teléfonos podrían enseñar dos totales distintos
 * del mismo carrito.
 *
 * UN CARRITO VACÍO NO ENSEÑA «0.00». `subtotal_minor` llega nulo cuando no hay
 * nada comprable, y nulo no se convierte en cero en ningún sitio de este
 * fichero.
 */

/* -------------------------------------------------------------------------- */
/* El contrato                                                                 */
/* -------------------------------------------------------------------------- */

export type LineaDelCarrito = {
  item_id: string;
  product_id: string;
  version_id: string;
  variant_id: string;
  name: string;
  variant_name: string | null;
  sku: string | null;
  seller_id: string;
  seller_name: string;
  image_path: string | null;
  image_url: string | null;
  alt_text: string | null;
  quantity: number;
  /** El precio de AHORA. `null` es «sin precio configurado», nunca gratis. */
  unit_price_minor: number | null;
  currency: string | null;
  line_total_minor: number | null;
  /** Lo que se veía al añadir. SOLO PARA AVISAR de que cambió. */
  seen_price_minor: number;
  seen_currency: string;
  /** `null` cuando ese SKU no tiene inventario cargado. NO es cero. */
  available: number | null;
  issues: string[];
  purchasable: boolean;
  added_at?: string | null;
};

export type Carrito = {
  items: LineaDelCarrito[];
  currency: string | null;
  subtotal_minor: number | null;
  units: number;
  lines: number;
  blocked_lines: number;
  purchasable: boolean;
  disponible: boolean;
};

export type Contadores = {
  cart_units: number;
  saved_products: number;
};

/* -------------------------------------------------------------------------- */
/* Los avisos                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Lo que el servidor puede decir de una línea. SON CÓDIGOS, no frases.
 *
 * Tiene que coincidir con `products/carts.py`. Uno que llegue y no esté aquí se
 * enseña con un texto genérico en vez de callarse: una línea que no se puede
 * comprar y no dice por qué es peor que una explicación imprecisa.
 */
export const AVISOS_CONOCIDOS = [
  'price_changed',
  'version_changed',
  'product_unavailable',
  'variant_missing',
  'price_not_configured',
  'inventory_not_configured',
  'insufficient_stock',
] as const;
export type Aviso = (typeof AVISOS_CONOCIDOS)[number];

/**
 * Los que impiden comprar esa línea. `price_changed` NO está, a propósito: un
 * precio que cambió sigue siendo comprable, y lo que hay que hacer es decirlo.
 */
export const AVISOS_BLOQUEANTES: readonly string[] = [
  'product_unavailable',
  'variant_missing',
  'price_not_configured',
  'inventory_not_configured',
  'insufficient_stock',
];

/** La clave del texto de un aviso. Uno desconocido tiene la suya, no ninguna. */
export function claveDelAviso(aviso: string): ClaveDeTraduccion {
  return (AVISOS_CONOCIDOS as readonly string[]).includes(aviso)
    ? `carrito.aviso.${aviso}`
    : 'carrito.aviso.desconocido';
}

/** El icono de un aviso. `null` cuando no conocemos el código. */
export function iconoDelAviso(aviso: string): string | null {
  const iconos: Record<string, string> = {
    price_changed: 'tag',
    version_changed: 'refresh-cw',
    product_unavailable: 'slash',
    variant_missing: 'slash',
    price_not_configured: 'help-circle',
    inventory_not_configured: 'help-circle',
    insufficient_stock: 'alert-triangle',
  };
  return iconos[aviso] ?? null;
}

/** Si esa línea se puede comprar el día que se pueda comprar algo. */
export function lineaBloqueada(linea: LineaDelCarrito): boolean {
  return linea.issues.some((a) => AVISOS_BLOQUEANTES.includes(a));
}

/** Los avisos de una línea, los bloqueantes primero: son los que hay que leer. */
export function avisosOrdenados(linea: LineaDelCarrito): string[] {
  const bloqueantes = linea.issues.filter((a) => AVISOS_BLOQUEANTES.includes(a));
  const resto = linea.issues.filter((a) => !AVISOS_BLOQUEANTES.includes(a));
  return [...bloqueantes, ...resto];
}

/* -------------------------------------------------------------------------- */
/* Los importes: se escriben, no se calculan                                   */
/* -------------------------------------------------------------------------- */

/** El precio unitario de una línea, o la constancia de que no hay ninguno. */
export function precioDeLaLinea(linea: LineaDelCarrito): Precio {
  return precioLegible(linea.unit_price_minor, linea.currency);
}

/** El importe de la línea entera, tal y como lo mandó el servidor. */
export function totalDeLaLinea(linea: LineaDelCarrito): Precio {
  return precioLegible(linea.line_total_minor, linea.currency);
}

/**
 * El subtotal de la bolsa.
 *
 * `configurado: false` cuando no hay nada comprable. UN CARRITO VACÍO NO ENSEÑA
 * «0.00»: un cero con moneda se lee como una compra de cero.
 */
export function subtotalDelCarrito(carrito: Carrito | null): Precio {
  if (carrito === null) return { configurado: false };
  return precioLegible(carrito.subtotal_minor, carrito.currency);
}

/** Lo que se enseña donde iría un precio que no existe. Nunca un número. */
export const CLAVE_SIN_IMPORTE: ClaveDeTraduccion = CLAVE_SIN_PRECIO;

/**
 * Lo que se veía al añadir, para enseñarlo tachado junto al precio de ahora.
 *
 * Solo tiene sentido si el precio CAMBIÓ: enseñar el anterior cuando es el
 * mismo es ruido, y encima hace dudar de si cambió.
 */
export function precioAnterior(linea: LineaDelCarrito): Precio {
  if (!linea.issues.includes('price_changed')) return { configurado: false };
  return precioLegible(linea.seen_price_minor, linea.seen_currency);
}

/* -------------------------------------------------------------------------- */
/* Cantidades                                                                  */
/* -------------------------------------------------------------------------- */

/** Tope técnico de una línea, el mismo que impone la 0075. */
export const MAXIMO_POR_LINEA = 1000;

/**
 * Hasta cuánto se puede subir esa línea AHORA MISMO.
 *
 * `null` cuando no se sabe —el SKU no tiene inventario cargado— y `null` NO ES
 * CERO: la pantalla desactiva el «+» y dice que no hay existencias cargadas, en
 * vez de decir «agotado», que mandaría a quien vende a buscar otro problema.
 */
export function topeDeLaLinea(linea: LineaDelCarrito): number | null {
  if (linea.available === null || linea.available === undefined) return null;
  if (!Number.isFinite(linea.available)) return null;
  return Math.max(0, Math.min(Math.trunc(linea.available), MAXIMO_POR_LINEA));
}

/** Si se puede pedir una unidad más de esa línea. */
export function sePuedeSumar(linea: LineaDelCarrito): boolean {
  const tope = topeDeLaLinea(linea);
  if (tope === null) return false;
  return linea.quantity < tope;
}

/** Si se puede pedir una menos. En 1 no: bajar de 1 es quitar la línea. */
export function sePuedeRestar(linea: LineaDelCarrito): boolean {
  return linea.quantity > 1;
}

/**
 * La cantidad que hay que mandar al servidor tras tocar `+` o `−`.
 *
 * `0` significa QUITAR la línea, y es lo que devuelve bajar desde 1: es lo que
 * la persona está pidiendo, y esconderlo detrás de otro botón obliga a pensar.
 */
export function cantidadTrasTocar(linea: LineaDelCarrito, paso: 1 | -1): number {
  const destino = linea.quantity + paso;
  if (destino <= 0) return 0;
  const tope = topeDeLaLinea(linea);
  //: NO SE SUBE A CIEGAS. Con el tope desconocido —ese SKU no tiene inventario
  //: cargado— esta función devolvía `quantity + 1`, y solo la pantalla impedía
  //: el toque. Una función que sola se comporta mal es una que el día que se
  //: llame desde otro sitio pide unidades que nadie sabe si existen.
  if (tope === null) return linea.quantity;
  if (destino > tope) return linea.quantity;
  return Math.min(destino, MAXIMO_POR_LINEA);
}

/* -------------------------------------------------------------------------- */
/* La bolsa entera                                                             */
/* -------------------------------------------------------------------------- */

/** Si la bolsa no tiene nada. */
export function carritoVacio(carrito: Carrito | null): boolean {
  return carrito === null || carrito.items.length === 0;
}

/** Si el carrito no está disponible porque falta la migración. */
export function carritoDisponible(carrito: Carrito | null): boolean {
  return carrito?.disponible === true;
}

/**
 * El número de la bolsa en el encabezado: UNIDADES del carrito.
 *
 * `null` mientras esté vacía, para no pintar un «0» colgando de un icono, que
 * es ruido y encima parece un error. Es el mismo criterio que tenía el contador
 * de guardados, aplicado a otro número.
 */
export function contadorDeLaBolsa(unidades: number | null | undefined): number | null {
  if (typeof unidades !== 'number' || !Number.isFinite(unidades)) return null;
  const entero = Math.trunc(unidades);
  return entero > 0 ? entero : null;
}

/** El contador de guardados, SEPARADO. Cuenta productos marcados, no unidades. */
export function contadorDeGuardados(cuantos: number | null | undefined): number | null {
  if (typeof cuantos !== 'number' || !Number.isFinite(cuantos)) return null;
  const entero = Math.trunc(cuantos);
  return entero > 0 ? entero : null;
}

/** Cuántas líneas no se pueden comprar. Cero cuando está todo bien. */
export function lineasBloqueadas(carrito: Carrito | null): number {
  if (carrito === null) return 0;
  return carrito.items.filter((l) => lineaBloqueada(l)).length;
}

/**
 * El aviso de cabecera de la bolsa, si hace falta alguno.
 *
 * Uno solo: repetir en el encabezado lo que ya dice cada línea convierte la
 * pantalla en una lista de advertencias que nadie lee.
 */
export function avisoDelCarrito(carrito: Carrito | null): ClaveDeTraduccion | null {
  if (carrito === null || carrito.items.length === 0) return null;
  const bloqueadas = lineasBloqueadas(carrito);
  if (bloqueadas === carrito.items.length) return 'carrito.nadaComprable';
  if (bloqueadas > 0) return 'carrito.algoNoSePuede';
  return null;
}

/**
 * El texto fijo del pie: TODAVÍA NO SE COMPRA.
 *
 * Es una clave y no una frase escrita en la pantalla para que diga lo mismo en
 * los tres idiomas y en un solo sitio. Y no hay ninguna función que devuelva
 * «se puede comprar»: mientras `purchasable` sea `false`, esto es lo que hay.
 */
export const CLAVE_TODAVIA_NO_SE_COMPRA: ClaveDeTraduccion = 'carrito.todaviaNoSeCompra';

/** Si la pantalla debe pintar algún botón que lleve a pagar. HOY: nunca. */
export function sePuedeComprar(carrito: Carrito | null): boolean {
  return carrito?.purchasable === true;
}

/* -------------------------------------------------------------------------- */
/* Errores                                                                     */
/* -------------------------------------------------------------------------- */

/** Los códigos que devuelven las rutas del carrito, con su texto. */
const ERRORES: Record<string, ClaveDeTraduccion> = {
  product_cart_not_available: 'carrito.error.noDisponible',
  product_cart_item_not_found: 'carrito.error.lineaNoEncontrada',
  product_cart_currency_mismatch: 'carrito.error.otraMoneda',
  product_cart_quantity_invalid: 'carrito.error.cantidadInvalida',
  product_price_not_configured: 'carrito.error.sinPrecio',
  product_inventory_not_configured: 'carrito.error.sinInventario',
  product_inventory_insufficient: 'carrito.error.noAlcanza',
  product_variant_not_found: 'carrito.error.varianteNoValida',
  product_not_found: 'carrito.error.productoNoDisponible',
};

/** La clave del error, o `null` si no es uno del carrito. */
export function claveDeErrorDelCarrito(codigo: string | null | undefined): ClaveDeTraduccion | null {
  const limpio = (codigo ?? '').trim();
  return limpio === '' ? null : (ERRORES[limpio] ?? null);
}

/** Si el fallo es que la 0075 no está aplicada en esa base. */
export function esCarritoApagado(codigo: string | null | undefined): boolean {
  return (codigo ?? '').trim() === 'product_cart_not_available';
}

/**
 * Una clave de idempotencia para el toque de «añadir».
 *
 * Se genera UNA por pulsación y se reenvía en los reintentos: es lo que
 * distingue un doble toque —que no debe sumar dos— de dos toques, que sí.
 */
export function claveDeLaPulsacion(productoId: string, varianteId: string, momento: number): string {
  return `${productoId}:${varianteId}:${Math.trunc(momento)}`;
}
