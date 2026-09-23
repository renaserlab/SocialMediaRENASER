import type { ClaveDeTraduccion } from '@/lib/productos';

/**
 * El inventario de quien vende. LÓGICA PURA: sin React, sin red y sin pantalla.
 *
 * LA REGLA QUE MÁS PESA AQUÍ: **`null` no es cero**. Una variante sin
 * inventario cargado no tiene cero unidades: tiene un inventario que nadie ha
 * cargado. Son dos cosas distintas y se enseñan distinto, porque poner
 * «agotado» donde falta cargar manda a quien vende a buscar un problema que no
 * existe. Este fichero no convierte `null` en cero en ningún sitio.
 *
 * LO DISPONIBLE LO CALCULA EL SERVIDOR. `available` llega en el contrato; aquí
 * NO se resta `on_hand - reserved`. Si se restara, el día que el servidor
 * cambiara la definición —por ejemplo para descontar algo más— la pantalla
 * seguiría enseñando la resta vieja sin que nada fallara.
 *
 * EL HISTORIAL SOLO SE AÑADE. No hay ninguna función que edite o borre un
 * movimiento: ni aquí ni en el servidor, donde lo impide un disparador.
 */

/* -------------------------------------------------------------------------- */
/* El contrato                                                                 */
/* -------------------------------------------------------------------------- */

export type Existencias = {
  sku: string;
  on_hand: number;
  reserved: number;
  /** Lo que se puede vender. LO MANDA EL SERVIDOR: no se recalcula. */
  available: number;
};

export type UnidadDeInventario = {
  variant_id: string;
  sku: string;
  name: string;
  options: Record<string, unknown>;
  price_delta_minor: number;
  /** `null` es SIN INVENTARIO CARGADO. Nunca cero. */
  stock: Existencias | null;
};

export type Inventario = {
  product_id: string;
  version_id: string | null;
  units: UnidadDeInventario[];
  /** `false` significa que la 0074 no está aplicada en esa base. */
  disponible: boolean;
};

export type Movimiento = {
  id: string;
  sku: string;
  kind: string;
  quantity: number;
  on_hand_after: number;
  reserved_after: number;
  available_after: number;
  reason: string | null;
  actor_id: string | null;
  actor_role: string;
  created_at: string;
};

/* -------------------------------------------------------------------------- */
/* Los cinco movimientos                                                       */
/* -------------------------------------------------------------------------- */

/** Tiene que coincidir con `products/models.py`. */
export const MOVIMIENTOS = [
  'intake',
  'adjustment',
  'reservation',
  'release',
  'dispatch',
] as const;
export type TipoDeMovimiento = (typeof MOVIMIENTOS)[number];

/**
 * Los que quien vende puede provocar HOY desde la aplicación.
 *
 * `reservation`, `release` y `dispatch` existen en el servidor, funcionan y
 * están probados, pero los provoca el checkout, que todavía no existe. Ponerlos
 * en un botón sería ofrecer una operación que no lleva a ninguna parte.
 */
export const MOVIMIENTOS_DEL_PROVEEDOR: readonly TipoDeMovimiento[] = ['intake', 'adjustment'];

/** La clave del nombre de un movimiento. Uno desconocido tiene la suya. */
export function claveDelMovimiento(tipo: string): ClaveDeTraduccion {
  return (MOVIMIENTOS as readonly string[]).includes(tipo)
    ? `inventario.movimiento.${tipo}`
    : 'inventario.movimiento.desconocido';
}

/** El icono de un movimiento. `null` si no lo conocemos. */
export function iconoDelMovimiento(tipo: string): string | null {
  const iconos: Record<string, string> = {
    intake: 'download',
    adjustment: 'edit-3',
    reservation: 'lock',
    release: 'unlock',
    dispatch: 'upload',
  };
  return iconos[tipo] ?? null;
}

/**
 * Cómo se escribe la cantidad de un movimiento, con su signo.
 *
 * El ajuste es el único que puede restar, así que es el único que puede llevar
 * `−`. Los demás llegan siempre positivos del servidor y se escriben con `+`
 * para que la columna se lea de un vistazo.
 */
export function cantidadDelMovimiento(movimiento: Movimiento): string {
  const valor = Math.trunc(movimiento.quantity);
  if (valor < 0) return `−${Math.abs(valor)}`;
  return `+${valor}`;
}

/* -------------------------------------------------------------------------- */
/* Lo que hay                                                                  */
/* -------------------------------------------------------------------------- */

/** Si ese SKU tiene inventario cargado. `false` NO significa «cero». */
export function tieneInventario(unidad: UnidadDeInventario): boolean {
  return unidad.stock !== null && unidad.stock !== undefined;
}

/**
 * Lo disponible de una unidad, o `null` si no se sabe.
 *
 * `null` se enseña con palabras —«sin existencias cargadas»— y no con un cero.
 */
export function disponibleDe(unidad: UnidadDeInventario): number | null {
  return unidad.stock ? unidad.stock.available : null;
}

/**
 * El estado de una unidad, para elegir qué se pinta.
 *
 * `sinCargar` y `agotado` SON DISTINTOS a propósito: el primero es que falta
 * hacer algo, el segundo es que se vendió o se ajustó todo.
 */
export type EstadoDeLaUnidad = 'sinCargar' | 'agotado' | 'comprometido' | 'disponible';

export function estadoDeLaUnidad(unidad: UnidadDeInventario): EstadoDeLaUnidad {
  if (!unidad.stock) return 'sinCargar';
  if (unidad.stock.available <= 0 && unidad.stock.on_hand <= 0) return 'agotado';
  if (unidad.stock.available <= 0) return 'comprometido';
  return 'disponible';
}

/** La clave del texto de ese estado. */
export function claveDelEstado(estado: EstadoDeLaUnidad): ClaveDeTraduccion {
  return `inventario.estado.${estado}`;
}

/** Cuántas unidades tienen inventario cargado. */
export function unidadesCargadas(inventario: Inventario | null): number {
  if (inventario === null) return 0;
  return inventario.units.filter((u) => tieneInventario(u)).length;
}

/** Si no hay ni una sola variante que inventariar. */
export function inventarioVacio(inventario: Inventario | null): boolean {
  return inventario === null || inventario.units.length === 0;
}

/** Si el inventario no está disponible porque falta la migración. */
export function inventarioDisponible(inventario: Inventario | null): boolean {
  return inventario?.disponible === true;
}

/**
 * El total de unidades a la venta del producto.
 *
 * `null` si NINGUNA variante tiene inventario cargado: sumar ceros de cosas que
 * nadie cargó da un total que parece medido y no lo es. Las que sí están se
 * suman aunque falten otras, y la pantalla dice cuántas faltan.
 */
export function totalDisponible(inventario: Inventario | null): number | null {
  if (inventario === null) return null;
  const cargadas = inventario.units.filter((u) => u.stock);
  if (cargadas.length === 0) return null;
  return cargadas.reduce((suma, u) => suma + (u.stock?.available ?? 0), 0);
}

/* -------------------------------------------------------------------------- */
/* Lo que se puede pedir                                                       */
/* -------------------------------------------------------------------------- */

/** Tope técnico de un movimiento, el mismo que impone la 0074. */
export const MAXIMO_DEL_MOVIMIENTO = 1_000_000;

/** Si esa cantidad de entrada es aceptable. Una entrada SUMA: nunca cero ni menos. */
export function entradaValida(cantidad: number): boolean {
  return (
    Number.isFinite(cantidad) &&
    Number.isInteger(cantidad) &&
    cantidad > 0 &&
    cantidad <= MAXIMO_DEL_MOVIMIENTO
  );
}

/**
 * Si ese ajuste es aceptable.
 *
 * Puede ser negativo —es el único que resta— pero nunca cero: un movimiento de
 * cero no es un movimiento, y guardarlo dejaría una línea de historial que no
 * cuenta nada.
 */
export function ajusteValido(cantidad: number, motivo: string): boolean {
  return (
    Number.isFinite(cantidad) &&
    Number.isInteger(cantidad) &&
    cantidad !== 0 &&
    Math.abs(cantidad) <= MAXIMO_DEL_MOVIMIENTO &&
    motivo.trim().length >= 3
  );
}

/**
 * Si un ajuste dejaría la existencia negativa, según lo que se sabe AHORA.
 *
 * Es una comprobación de cortesía para poder desactivar el botón: la de verdad
 * la hace el servidor con la fila bloqueada, porque entre que se pinta esta
 * pantalla y se pulsa pueden haber pasado cosas.
 */
export function ajusteImposible(unidad: UnidadDeInventario, cantidad: number): boolean {
  if (!unidad.stock) return false;
  return unidad.stock.on_hand + cantidad < 0;
}

/* -------------------------------------------------------------------------- */
/* Errores                                                                     */
/* -------------------------------------------------------------------------- */

const ERRORES: Record<string, ClaveDeTraduccion> = {
  product_inventory_not_available: 'inventario.error.noDisponible',
  product_inventory_not_configured: 'inventario.error.sinCargar',
  product_inventory_insufficient: 'inventario.error.noAlcanza',
  // UNA CLAVE SIGNIFICA UNA OPERACION. Repetirla con otra cosa no es un
  // reintento: sin este texto, quien vende veria un error sin explicacion
  // justo cuando su cliente reusa la cadena «1» para todo.
  product_inventory_key_reused: 'inventario.error.claveReutilizada',
  product_inventory_movement_invalid: 'inventario.error.movimientoInvalido',
  product_variant_not_found: 'inventario.error.varianteNoEncontrada',
  /*
    CARGAR Y AJUSTAR EXISTENCIAS EXIGEN CAPACIDAD COMERCIAL ACTIVA
    (`exigir_vendedor_activo`), así que este 403 llega por estas rutas. Sin
    traducir parecía un fallo del movimiento, cuando lo que está parado es la
    cuenta: quien lo lea tiene que saber que reintentar no arregla nada.
  */
  product_seller_not_active: 'inventario.error.sinCapacidadComercial',
};

export function claveDeErrorDeInventario(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const limpio = (codigo ?? '').trim();
  return limpio === '' ? null : (ERRORES[limpio] ?? null);
}

/** Si el fallo es que la 0074 no está aplicada en esa base. */
export function esInventarioApagado(codigo: string | null | undefined): boolean {
  return (codigo ?? '').trim() === 'product_inventory_not_available';
}

/**
 * La clave de idempotencia de un movimiento.
 *
 * UNA POR PULSACIÓN, y se reenvía en los reintentos: es lo que impide que un
 * doble toque cargue el doble de existencias. El servidor deriva de ella el
 * identificador de la fila, así que la segunda petición choca contra la clave
 * primaria en vez de mover nada.
 */
export function claveDelMovimientoNuevo(sku: string, momento: number): string {
  return `${sku}:${Math.trunc(momento)}`;
}
