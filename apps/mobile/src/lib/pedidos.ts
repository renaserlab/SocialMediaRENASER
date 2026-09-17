import { precioLegible, type ClaveDeTraduccion, type Precio } from '@/lib/productos';

/*
  POR EL ALIAS, como `carrito.ts`, y por lo mismo: este módulo importa VALORES
  de `productos.ts`. El ejecutor de pruebas de Node registra su propio resolutor
  para cargarlo; es maquinaria de la prueba, no del producto.
*/

/**
 * El pedido de un producto físico. LÓGICA PURA: sin React, sin red, sin pantalla.
 *
 * NINGÚN IMPORTE SE CALCULA AQUÍ. Ni el de una línea, ni el total. El servidor
 * los manda calculados y esto solo los escribe: si el cliente sumara, dos
 * versiones instaladas en dos teléfonos podrían enseñar dos totales del mismo
 * pedido, y el que se cobra es el del servidor.
 *
 * LA VUELTA DEL NAVEGADOR NO CONFIRMA DINERO. Volver de la pasarela con
 * `?estado=retorno` no dice que se haya pagado: el estado se lee del pedido,
 * que se vuelve a pedir al servidor. Un parámetro en una URL lo escribe
 * cualquiera.
 *
 * `null` SIGNIFICA DESCONOCIDO, NUNCA CERO. Un plazo sin decidir viaja nulo y
 * se enseña como «pendiente de configuración»; un cero en un plazo de
 * desistimiento sería afirmar que no existe ese derecho.
 *
 * NO HAY FORMULARIO DE TARJETA, y no puede haberlo: el cobro ocurre en la
 * página alojada de la pasarela. Esta capa solo sabe abrir una URL.
 */

/* -------------------------------------------------------------------------- */
/* El contrato                                                                 */
/* -------------------------------------------------------------------------- */

export type Condiciones = {
  policy_id: string;
  country_code: string;
  version: number;
  seller_entity: string;
  currency: string;
  terms: string;
  terms_sha256: string;
  /** Nulos mientras nadie los haya decidido. NULO NO ES CERO. */
  incident_report_hours: number | null;
  return_shipment_days: number | null;
  withdrawal_days: number | null;
  buyer_pays_return_for_remorse: boolean | null;
  seller_pays_return_for_defect: boolean | null;
  warranty_rules_url: string | null;
  effective_at: string | null;
};

export type GrupoDelCarrito = {
  seller_id: string;
  seller_name: string;
  item_ids: string[];
  units: number;
  currency: string | null;
  subtotal_minor: number | null;
  purchasable: boolean;
  issues: string[];
};

export type Preparacion = {
  disponible: boolean;
  /** Lo que falta del lado de la empresa. Es la respuesta honesta al «por qué». */
  pending_configuration: string[];
  countries_with_policy: string[];
  groups: GrupoDelCarrito[];
  open_order_id: string | null;
};

export type Direccion = {
  recipient_name: string;
  phone: string;
  country_code: string;
  region: string;
  city: string;
  district: string | null;
  address_line: string;
  reference: string | null;
  postal_code: string | null;
  instructions: string | null;
};

export type LineaDelPedido = {
  id: string;
  product_id: string;
  version_id: string;
  variant_id: string;
  sku: string;
  name: string;
  variant_name: string | null;
  unit_price_minor: number;
  quantity: number;
  subtotal_minor: number;
};

export type EventoDelPedido = {
  from_status: string | null;
  to_status: string;
  actor_role: string;
  reason: string | null;
  created_at: string;
};

export type Pedido = {
  id: string;
  status: string;
  seller_id: string;
  seller_name: string | null;
  currency: string;
  subtotal_minor: number;
  total_minor: number;
  reserved_until: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  expired_at: string | null;
  failed_at: string | null;
  review_reason: string | null;
  policy: Condiciones | null;
  address: Direccion | null;
  items: LineaDelPedido[];
  history: EventoDelPedido[];
  created_at: string;
};

export type ResumenDePedido = {
  id: string;
  status: string;
  seller_name: string | null;
  currency: string;
  total_minor: number;
  units: number;
  reserved_until: string | null;
  created_at: string;
};

export type Checkout = {
  order_id: string;
  checkout_url: string;
  provider: string;
  amount_minor: number;
  currency: string;
};

/* -------------------------------------------------------------------------- */
/* Los estados                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Los siete estados que el servidor puede escribir, y ninguno más.
 *
 * Tiene que coincidir con `products/models.py`. Uno que llegue y no esté aquí
 * se enseña con un texto genérico en vez de callarse.
 */
export const ESTADOS_DE_PEDIDO = [
  'PENDING_PAYMENT',
  'PAYMENT_PROCESSING',
  'PAID',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
  'UNDER_REVIEW',
] as const;
export type EstadoDePedido = (typeof ESTADOS_DE_PEDIDO)[number];

/** Los que todavía pueden pagarse, y por tanto los que siguen apartando. */
export const ESTADOS_EN_CURSO: readonly string[] = [
  'PENDING_PAYMENT',
  'PAYMENT_PROCESSING',
];

/** La clave del texto de un estado. Uno desconocido tiene la suya, no ninguna. */
export function claveDelEstado(estado: string): ClaveDeTraduccion {
  return (ESTADOS_DE_PEDIDO as readonly string[]).includes(estado)
    ? `pedidoDeProducto.estado.${estado}`
    : 'pedidoDeProducto.estado.desconocido';
}

/** El icono de un estado. `null` cuando no conocemos el código. */
export function iconoDelEstado(estado: string): string | null {
  const iconos: Record<string, string> = {
    PENDING_PAYMENT: 'clock',
    PAYMENT_PROCESSING: 'loader',
    PAID: 'check-circle',
    PAYMENT_FAILED: 'x-circle',
    EXPIRED: 'clock',
    CANCELLED: 'slash',
    UNDER_REVIEW: 'alert-triangle',
  };
  return iconos[estado] ?? null;
}

/** Si ese pedido todavía espera un pago. */
export function esperaPago(pedido: { status: string } | null): boolean {
  return pedido !== null && ESTADOS_EN_CURSO.includes(pedido.status);
}

/**
 * Si se puede cancelar. SOLO ANTES DE PAGAR.
 *
 * Después no: devolver el dinero es otra cosa, tiene sus plazos y todavía no
 * existe. Un botón de cancelar sobre un pedido pagado prometería un reembolso
 * que nadie ha definido.
 */
export function sePuedeCancelar(pedido: { status: string } | null): boolean {
  return esperaPago(pedido);
}

/** Si hay que ofrecer ir a pagar. */
export function sePuedePagar(pedido: { status: string } | null): boolean {
  if (pedido === null) return false;
  return ESTADOS_EN_CURSO.includes(pedido.status) || pedido.status === 'PAYMENT_FAILED';
}

/* -------------------------------------------------------------------------- */
/* Importes: se escriben, no se calculan                                       */
/* -------------------------------------------------------------------------- */

export function totalDelPedido(pedido: {
  total_minor: number;
  currency: string;
} | null): Precio {
  if (pedido === null) return { configurado: false };
  return precioLegible(pedido.total_minor, pedido.currency);
}

export function totalDeLaLinea(linea: LineaDelPedido, moneda: string): Precio {
  return precioLegible(linea.subtotal_minor, moneda);
}

export function precioUnitario(linea: LineaDelPedido, moneda: string): Precio {
  return precioLegible(linea.unit_price_minor, moneda);
}

/**
 * El subtotal de un grupo del carrito.
 *
 * `configurado: false` cuando no hay nada comprable en ese grupo. UN GRUPO
 * VACÍO NO ENSEÑA «0.00».
 */
export function subtotalDelGrupo(grupo: GrupoDelCarrito | null): Precio {
  if (grupo === null) return { configurado: false };
  return precioLegible(grupo.subtotal_minor, grupo.currency);
}

/**
 * IMPUESTOS Y ENVÍO NO SE ENSEÑAN COMO CERO.
 *
 * No están decididos: no hay entidad fiscal, ni transportista, ni tarifas. Una
 * línea «Envío: 0,00» es una promesa de envío gratuito que nadie ha hecho, y
 * una «Impuestos: 0,00» es una afirmación fiscal. Mientras no existan, no hay
 * línea: esta función lo dice en un solo sitio.
 */
export const HAY_IMPUESTOS = false;
export const HAY_ENVIO = false;

/* -------------------------------------------------------------------------- */
/* Las condiciones                                                             */
/* -------------------------------------------------------------------------- */

/** Un plazo que todavía nadie ha decidido no se enseña como un número. */
export function plazoConfigurado(valor: number | null | undefined): boolean {
  return typeof valor === 'number' && Number.isFinite(valor);
}

/**
 * Si se puede decir «compra protegida».
 *
 * SOLO CON POLÍTICA. Sin plazo para reportar una incidencia no hay ninguna
 * protección que ofrecer, y decirlo igualmente sería la clase de frase que
 * hace que alguien compre creyendo que tiene un recurso que no tiene.
 */
export function sePuedeDecirCompraProtegida(condiciones: Condiciones | null): boolean {
  return condiciones !== null && plazoConfigurado(condiciones.incident_report_hours);
}

/* -------------------------------------------------------------------------- */
/* La preparación del checkout                                                 */
/* -------------------------------------------------------------------------- */

/** Si hoy se puede comprar de verdad. */
export function sePuedeComprar(preparacion: Preparacion | null): boolean {
  return preparacion?.disponible === true;
}

/** Los grupos que se pueden convertir en pedido. */
export function gruposComprables(preparacion: Preparacion | null): GrupoDelCarrito[] {
  if (preparacion === null) return [];
  return preparacion.groups.filter((g) => g.purchasable);
}

/**
 * Si el carrito mezcla proveedores.
 *
 * NO SE COBRA EN SILENCIO A VARIOS. Repartir un cobro entre proveedores exige
 * saber quién responde de qué y cómo se liquida, y eso no está decidido: se
 * pide elegir uno.
 */
export function mezclaProveedores(preparacion: Preparacion | null): boolean {
  return (preparacion?.groups.length ?? 0) > 1;
}

/** Lo que falta, para poder decirlo con palabras y no con un código. */
export function claveDeLoQueFalta(pendiente: string): ClaveDeTraduccion {
  const conocidas = [
    'feature_product_sales',
    'payments_enabled',
    'stripe_payments_enabled',
    'product_reservation_minutes',
    'stripe_secret_key',
    'product_policy',
    'migration_0077',
    'migration_0078',
  ];
  return conocidas.includes(pendiente)
    ? `pedidoDeProducto.falta.${pendiente}`
    : 'pedidoDeProducto.falta.desconocido';
}

/* -------------------------------------------------------------------------- */
/* La dirección                                                                */
/* -------------------------------------------------------------------------- */

/** Países donde la dirección no se entiende sin distrito. Igual que el servidor. */
export const PAISES_CON_DISTRITO: readonly string[] = ['PE'];

export type CampoDeDireccion =
  | 'recipient_name'
  | 'phone'
  | 'country_code'
  | 'region'
  | 'city'
  | 'district'
  | 'address_line';

/**
 * Qué campos faltan o no valen. LISTA, no el primero.
 *
 * Decir de uno en uno lo que falta obliga a mandar el formulario tantas veces
 * como errores haya. El servidor vuelve a validarlo todo: esto es para no
 * hacerle dar el viaje.
 */
export function camposIncompletos(
  direccion: Partial<Direccion>,
): CampoDeDireccion[] {
  const pais = (direccion.country_code ?? '').trim().toUpperCase();
  const largos: Array<[CampoDeDireccion, number, number]> = [
    ['recipient_name', 2, 150],
    ['phone', 5, 30],
    ['region', 1, 120],
    ['city', 1, 120],
    ['address_line', 5, 300],
  ];
  const faltan: CampoDeDireccion[] = [];
  if (pais.length !== 2 || !/^[A-Z]{2}$/.test(pais)) faltan.push('country_code');
  for (const [campo, minimo, maximo] of largos) {
    const valor = (direccion[campo] ?? '').toString().trim();
    if (valor.length < minimo || valor.length > maximo) faltan.push(campo);
  }
  if (PAISES_CON_DISTRITO.includes(pais)) {
    const distrito = (direccion.district ?? '').toString().trim();
    if (distrito.length < 1 || distrito.length > 120) faltan.push('district');
  }
  return faltan;
}

/** Si la dirección está lista para mandarla. */
export function direccionCompleta(direccion: Partial<Direccion>): boolean {
  return camposIncompletos(direccion).length === 0;
}

/** La clave del texto de un campo, para nombrarlo en el error. */
export function claveDelCampo(campo: string): ClaveDeTraduccion {
  return `pedidoDeProducto.direccion.${campo}` as ClaveDeTraduccion;
}

/**
 * La dirección en una línea, para enseñarla en el resumen.
 *
 * SIN TELÉFONO. En el resumen no hace falta y es el dato que más se lee por
 * encima del hombro; está en el detalle, donde hay que entrar a propósito.
 */
export function direccionEnUnaLinea(direccion: Direccion | null): string {
  if (direccion === null) return '';
  return [
    direccion.address_line,
    direccion.district,
    direccion.city,
    direccion.region,
    direccion.country_code,
  ]
    .filter((p) => typeof p === 'string' && p.trim() !== '')
    .join(', ');
}

/* -------------------------------------------------------------------------- */
/* La reserva                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cuántos minutos enteros quedan de reserva. `null` si no hay ninguna.
 *
 * SE REDONDEA HACIA ABAJO. Decir «queda 1 minuto» cuando quedan 20 segundos es
 * lo que hace que alguien se confíe; decir 0 es lo que hay.
 */
export function minutosDeReserva(
  reservadoHasta: string | null | undefined,
  ahora: number = Date.now(),
): number | null {
  if (typeof reservadoHasta !== 'string' || reservadoHasta.trim() === '') return null;
  const limite = Date.parse(reservadoHasta);
  if (!Number.isFinite(limite)) return null;
  return Math.max(0, Math.floor((limite - ahora) / 60000));
}

/** Si la reserva ya venció según el reloj del cliente. */
export function reservaVencida(
  reservadoHasta: string | null | undefined,
  ahora: number = Date.now(),
): boolean {
  const quedan = minutosDeReserva(reservadoHasta, ahora);
  return quedan !== null && quedan <= 0;
}

/* -------------------------------------------------------------------------- */
/* Errores                                                                     */
/* -------------------------------------------------------------------------- */

const ERRORES: Record<string, ClaveDeTraduccion> = {
  product_orders_not_available: 'pedidoDeProducto.error.noDisponible',
  product_policies_not_available: 'pedidoDeProducto.error.sinCondiciones',
  product_policy_not_configured: 'pedidoDeProducto.error.sinPolitica',
  product_policy_changed: 'pedidoDeProducto.error.politicaCambio',
  product_policy_currency_mismatch: 'pedidoDeProducto.error.monedaFuera',
  product_sales_not_enabled: 'pedidoDeProducto.error.ventaApagada',
  product_cart_not_purchasable: 'pedidoDeProducto.error.bolsaNoComprable',
  product_cart_multiple_sellers: 'pedidoDeProducto.error.variosProveedores',
  product_order_key_reused: 'pedidoDeProducto.error.claveReutilizada',
  product_order_already_open: 'pedidoDeProducto.error.yaHayPedido',
  product_order_not_payable: 'pedidoDeProducto.error.noSePuedePagar',
  product_order_not_found: 'pedidoDeProducto.error.noEncontrado',
  product_order_payment_mismatch: 'pedidoDeProducto.error.noCuadra',
  product_address_invalid: 'pedidoDeProducto.error.direccionInvalida',
  product_seller_not_found: 'pedidoDeProducto.error.proveedorNoEncontrado',
};

/** La clave del error, o `null` si no es uno de pedidos. */
export function claveDeErrorDePedidos(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const limpio = (codigo ?? '').trim();
  return limpio === '' ? null : (ERRORES[limpio] ?? null);
}

/** Si el fallo es que la 0078 no está aplicada en esa base. */
export function esPedidoApagado(codigo: string | null | undefined): boolean {
  return (codigo ?? '').trim() === 'product_orders_not_available';
}

/**
 * Una clave de idempotencia para el toque de «comprar».
 *
 * Se genera UNA por pulsación y se reenvía en los reintentos: es lo que impide
 * que un doble toque cree dos pedidos y aparte el doble de existencias.
 */
export function claveDeLaCompra(sellerId: string, momento: number): string {
  return `po:${sellerId}:${Math.trunc(momento)}`;
}
