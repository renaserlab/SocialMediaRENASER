import type { ClaveDeTraduccion } from '@/lib/productos';

/*
  POR EL ALIAS, como `pedidos.ts`, y por lo mismo: este módulo importa el TIPO
  de las claves de traducción. El ejecutor de pruebas de Node registra su propio
  resolutor para cargarlo; es maquinaria de la prueba, no del producto.
*/

/**
 * El envío de un pedido pagado. LÓGICA PURA: sin React, sin red, sin pantalla.
 *
 * NADA SE DECIDE AQUÍ. Qué salto es legal y quién puede darlo lo decide el
 * servidor con la fila bloqueada delante; esto solo sabe pintar lo que el
 * servidor ya contestó, y ofrecer los botones que el servidor dice que están
 * disponibles. Si esta capa decidiera, bastaría una versión vieja instalada en
 * un teléfono para intentar despachar algo dos veces.
 *
 * LO QUE ESTA CAPA TIENE PROHIBIDO INVENTAR, y es la mitad de su trabajo:
 *
 *   * NINGUNA FECHA DE LLEGADA. No hay transportista elegido ni plazos de
 *     transporte aprobados. Una fecha aquí se lee como un compromiso.
 *   * NINGÚN «ATRASADO». Ninguna política publicada fija un plazo de despacho,
 *     así que lo único honesto es decir cuánto tiempo ha pasado.
 *   * NINGÚN TRANSPORTISTA POR DEFECTO. Nulo es «no lo dijeron», y se pinta
 *     como eso, nunca como «N/A» ni como un hueco.
 *   * NINGÚN ENLACE DE SEGUIMIENTO. Construirlo exige saber el transportista;
 *     con uno inventado sería un enlace roto dentro de un pedido pagado.
 *   * NINGÚN «ENTREGADO» DEDUCIDO. Que algo llegó lo dice el servidor, y dice
 *     además quién lo afirmó.
 *
 * Y CONFIRMAR QUE LLEGÓ NO ES DAR LA CONFORMIDAD. Lo segundo libera el dinero
 * al proveedor y no existe: no hay transferencias, ni comisión, ni plazo
 * aprobado. Los textos de esta capa no pueden sugerir lo contrario.
 */

/* -------------------------------------------------------------------------- */
/* El contrato                                                                 */
/* -------------------------------------------------------------------------- */

export type LineaPreparada = {
  order_item_id: string;
  sku: string;
  name: string;
  variant_name: string | null;
  ordered_quantity: number;
  prepared_quantity: number;
};

export type EventoDelEnvio = {
  from_status: string | null;
  to_status: string;
  actor_role: string;
  reason: string | null;
  created_at: string;
};

export type Envio = {
  order_id: string;
  status: string;
  /** `false` = NADIE LO HA TOCADO. No es que falte nada. */
  exists: boolean;
  carrier_name: string | null;
  tracking_reference: string | null;
  prepared_at: string | null;
  ready_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  /** `seller` o `buyer`. Administración no puede afirmar una entrega. */
  delivered_source: string | null;
  buyer_confirmed_at: string | null;
  /**
   * LA CONFORMIDAD (Incremento 9). NO es lo mismo que la de arriba:
   * confirmar que llego no es decir que esta bien, y ESTO SI libera el
   * dinero. Son dos campos porque son dos afirmaciones distintas.
   */
  conformity_at?: string | null;
  failure_reason: string | null;
  cancellation_reason: string | null;
  items: LineaPreparada[];
  history: EventoDelEnvio[];
  /** Lo que ESTE actor puede hacer ahora, según el servidor. */
  available_transitions: string[];
};

/**
 * El pedido tal como lo ve quien tiene que preparar el paquete.
 *
 * NI EL COBRO NI QUIEN COMPRÓ. No hay `buyer_id`, ni referencia de pasarela, ni
 * más importe que el total del pedido, que es lo que va en el albarán. Quien
 * prepara necesita saber qué mandar y a dónde; con qué tarjeta se pagó no se
 * prepara nada, y tenerlo delante es tenerlo donde se puede filtrar.
 *
 * LA DIRECCIÓN SÍ, y solo aquí: es el único sitio de la aplicación donde quien
 * vende la ve, y solo de sus pedidos pagados.
 */
export type PedidoDelProveedor = {
  id: string;
  status: string;
  currency: string;
  total_minor: number;
  paid_at: string | null;
  address: DireccionDeEntrega | null;
  items: LineaComprada[];
  shipment: Envio | null;
  created_at: string;
};

export type DireccionDeEntrega = {
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

export type LineaComprada = {
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

/**
 * Una fila de la cola de administración. SIN NINGÚN DATO PERSONAL.
 *
 * NI EL MOTIVO DE UNA ENTREGA FALLIDA, y lo encontró la revisión independiente:
 * ese motivo es texto libre que escribe quien vende, y lo primero que escribe
 * cualquiera al reportar una entrega fallida es dónde fue y a quién buscaba.
 * Que la entrega falló se sabe por `status`, que es lo que hace falta para
 * decidir si ese paquete necesita a alguien.
 */
export type EnvioPendiente = {
  order_id: string;
  seller_id: string;
  seller_name: string | null;
  status: string;
  paid_at: string | null;
  dispatched_at: string | null;
  units: number;
  /** HORAS TRANSCURRIDAS. Es un hecho, no un juicio: no hay plazo que incumplir. */
  waiting_hours: number | null;
};

/* -------------------------------------------------------------------------- */
/* Los estados                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Los siete estados que el servidor puede escribir, y ninguno más.
 *
 * Tiene que coincidir con `products/estados_de_envio.py`. Uno que llegue y no
 * esté aquí se enseña con un texto genérico en vez de callarse: un estado sin
 * nombre es peor que un nombre feo.
 */
export const ESTADOS_DE_ENVIO = [
  'PENDING',
  'PREPARING',
  'READY',
  'DISPATCHED',
  'DELIVERED',
  'DELIVERY_FAILED',
  'CANCELLED',
] as const;
export type EstadoDeEnvio = (typeof ESTADOS_DE_ENVIO)[number];

/** Los que todavía no han salido del almacén. */
export const ANTES_DE_SALIR: readonly string[] = ['PENDING', 'PREPARING', 'READY'];

/** Los que ya salieron: las unidades no están en el almacén. */
export const DESPUES_DE_SALIR: readonly string[] = [
  'DISPATCHED',
  'DELIVERED',
  'DELIVERY_FAILED',
];

export function esEstadoConocido(estado: string): estado is EstadoDeEnvio {
  return (ESTADOS_DE_ENVIO as readonly string[]).includes(estado);
}

/** La clave del texto de un estado. Uno desconocido tiene la suya, no ninguna. */
export function claveDelEstadoDeEnvio(estado: string): ClaveDeTraduccion {
  return esEstadoConocido(estado)
    ? `envio.estado.${estado}`
    : 'envio.estado.desconocido';
}

/**
 * El icono de un estado. `null` cuando no conocemos el código.
 *
 * EL COLOR NUNCA ES EL ÚNICO PORTADOR: el icono acompaña siempre al texto, que
 * es lo que lee quien no distingue los tonos y lo que lee un lector de
 * pantalla.
 */
export function iconoDelEstadoDeEnvio(estado: string): string | null {
  const iconos: Record<string, string> = {
    PENDING: 'clock',
    PREPARING: 'package',
    READY: 'box',
    DISPATCHED: 'truck',
    DELIVERED: 'check-circle',
    DELIVERY_FAILED: 'alert-triangle',
    CANCELLED: 'slash',
  };
  return iconos[estado] ?? null;
}

/** Si el paquete ya salió del almacén. */
export function yaSalio(envio: Envio | null): boolean {
  return envio !== null && DESPUES_DE_SALIR.includes(envio.status);
}

/** Si el envío llegó a su destino. */
export function yaLlego(envio: Envio | null): boolean {
  return envio !== null && envio.status === 'DELIVERED';
}

/* -------------------------------------------------------------------------- */
/* Lo que puede hacer cada quien                                               */
/* -------------------------------------------------------------------------- */

/**
 * Si se puede ofrecer «confirmo que lo recibí».
 *
 * SOLO SOBRE ALGO QUE YA SALIÓ Y QUE ESA PERSONA NO HA CONFIRMADO. Ofrecerlo
 * sobre un paquete que no ha salido invitaría a confirmar una entrega que no
 * ocurrió; ofrecerlo dos veces haría dudar de si la primera se guardó.
 *
 * Y LA LISTA DE TRANSICIONES MANDA. Si el servidor no ofrece el salto, aquí no
 * se pinta, aunque el estado lo permitiera sobre el papel.
 */
export function sePuedeConfirmarRecepcion(envio: Envio | null): boolean {
  if (envio === null) return false;
  if (envio.buyer_confirmed_at !== null) return false;
  if (!yaSalio(envio)) return false;
  return envio.available_transitions.includes('DELIVERED');
}

/** Si el servidor ofrece ese salto a quien pregunta. */
export function ofrece(envio: Envio | null, salto: string): boolean {
  return envio !== null && envio.available_transitions.includes(salto);
}

/* -------------------------------------------------------------------------- */
/* La preparación                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Si todavía se puede contar la caja.
 *
 * EL SERVIDOR SOLO ACEPTA APUNTAR CANTIDADES MIENTRAS SE PREPARA. Con el
 * paquete ya cerrado contesta 409 `product_shipment_not_preparing`, y con el
 * paquete fuera ni eso.
 *
 * LO ENCONTRÓ LA REVISIÓN INDEPENDIENTE: la pantalla escondía los controles
 * solo cuando el paquete YA HABÍA SALIDO, así que en «listo» seguía pintando el
 * botón de quitar una unidad —activo— sobre una llamada que siempre falla. El
 * camino correcto, reabrir con motivo, estaba en la misma pantalla; el botón
 * que se ofrecía primero era el que no funciona.
 */
export function sePuedeContarLaCaja(envio: Envio | null): boolean {
  if (envio === null) return false;
  return envio.status === 'PENDING' || envio.status === 'PREPARING';
}

/** Cuántas unidades faltan por meter en la caja de una línea. */
export function faltanDeLaLinea(linea: LineaPreparada): number {
  return Math.max(0, linea.ordered_quantity - linea.prepared_quantity);
}

/** Si esa línea ya está completa. */
export function lineaCompleta(linea: LineaPreparada): boolean {
  return faltanDeLaLinea(linea) === 0;
}

/**
 * Si el paquete se puede cerrar. TODO DENTRO O NADA.
 *
 * UN ENVÍO SIN LÍNEAS NO ESTÁ LISTO. Un pedido sin artículos no existe, y
 * contestar «listo» sobre una lista vacía dejaría cerrar una caja vacía.
 */
export function sePuedeCerrar(envio: Envio | null): boolean {
  if (envio === null || envio.items.length === 0) return false;
  return envio.items.every(lineaCompleta);
}

/** Lo que falta, línea por línea, para poder decirlo sin un código. */
export function loQueFalta(envio: Envio | null): LineaPreparada[] {
  if (envio === null) return [];
  return envio.items.filter((l) => !lineaCompleta(l));
}

/** Cuántas unidades van ya en la caja, de cuántas. */
export function avanceDeLaPreparacion(
  envio: Envio | null,
): { hechas: number; total: number } {
  if (envio === null) return { hechas: 0, total: 0 };
  return envio.items.reduce(
    (suma, l) => ({
      hechas: suma.hechas + Math.min(l.prepared_quantity, l.ordered_quantity),
      total: suma.total + l.ordered_quantity,
    }),
    { hechas: 0, total: 0 },
  );
}

/* -------------------------------------------------------------------------- */
/* El transportista                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Si hay algo que enseñar del transporte.
 *
 * NULO NO SE PINTA COMO «N/A». Cuando quien despachó no escribió transportista
 * ni referencia, lo que se dice es que no lo indicó, que es la verdad y no
 * suena a un dato roto.
 */
export function hayDatosDeTransporte(envio: Envio | null): boolean {
  if (envio === null) return false;
  return (
    (envio.carrier_name ?? '').trim() !== '' ||
    (envio.tracking_reference ?? '').trim() !== ''
  );
}

/**
 * NO HAY ENLACE DE SEGUIMIENTO, Y NO PUEDE HABERLO.
 *
 * Construir una URL exige saber el transportista, y la empresa no ha elegido
 * ninguno. Un enlace inventado dentro de la ficha de un pedido pagado es un
 * enlace roto en el peor sitio posible. Esta constante existe para que la
 * decisión esté escrita en un único lugar y no repartida por las pantallas.
 */
export const HAY_ENLACE_DE_SEGUIMIENTO = false;

/**
 * NO HAY FECHA PREVISTA DE LLEGADA, Y NO PUEDE HABERLA.
 *
 * Calcularla exige plazos de transporte que nadie ha fijado. Una fecha en una
 * pantalla se lee como un compromiso.
 */
export const HAY_FECHA_PREVISTA = false;

/* -------------------------------------------------------------------------- */
/* La línea de tiempo                                                          */
/* -------------------------------------------------------------------------- */

export type PasoDeLaLinea = {
  clave: ClaveDeTraduccion;
  icono: string | null;
  fecha: string;
  actor: string;
  motivo: string | null;
  /** `pago` o `envio`: son dos máquinas distintas y se dice de cuál viene. */
  origen: 'pago' | 'envio';
};

/**
 * El historial del pago y el del envío, en una sola lista ordenada.
 *
 * SE MEZCLAN AL PINTAR Y NO EN LA BASE. Son dos máquinas distintas y ahí tienen
 * que seguir separadas: juntarlas en una tabla haría que escribir un estado de
 * envío pudiera perder el del pago. Aquí solo se ordenan para que quien compró
 * lea su pedido de arriba abajo, que es como se lee una cosa que pasó.
 *
 * EL ORIGEN VIAJA CON CADA PASO para que la pantalla pueda decir de qué habla:
 * «pagado» y «despachado» no son el mismo tipo de hecho.
 */
export function lineaDeTiempo(
  historialDelPago: EventoDelEnvio[],
  envio: Envio | null,
): PasoDeLaLinea[] {
  const pasos: PasoDeLaLinea[] = historialDelPago.map((e) => ({
    clave: `pedidoDeProducto.estado.${e.to_status}` as ClaveDeTraduccion,
    icono: null,
    fecha: e.created_at,
    actor: e.actor_role,
    motivo: e.reason,
    origen: 'pago' as const,
  }));
  for (const e of envio?.history ?? []) {
    pasos.push({
      clave: claveDelEstadoDeEnvio(e.to_status),
      icono: iconoDelEstadoDeEnvio(e.to_status),
      fecha: e.created_at,
      actor: e.actor_role,
      motivo: e.reason,
      origen: 'envio',
    });
  }
  //: ORDEN ESTABLE. Dos hechos del mismo instante —los hay: pagar vacía la
  //: bolsa y anota— no pueden bailar entre dos renders.
  return pasos
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ta = Date.parse(a.p.fecha);
      const tb = Date.parse(b.p.fecha);
      if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return a.i - b.i;
      return ta - tb;
    })
    .map(({ p }) => p);
}

/* -------------------------------------------------------------------------- */
/* La espera, dicha como un hecho                                              */
/* -------------------------------------------------------------------------- */

/**
 * Cómo se dice cuánto lleva esperando un pedido. NUNCA «atrasado».
 *
 * NO HAY PLAZO DE DESPACHO EN NINGUNA POLÍTICA PUBLICADA, así que no hay contra
 * qué comparar. Llamarle tarde a algo sin plazo es inventarse el plazo, y quien
 * lo lea actuaría sobre un incumplimiento que nadie definió.
 */
export function claveDeLaEspera(horas: number | null): ClaveDeTraduccion {
  if (horas === null) return 'envio.espera.desconocida';
  return horas < 24 ? 'envio.espera.horas' : 'envio.espera.dias';
}

/** El número que acompaña a esa clave. */
export function numeroDeLaEspera(horas: number | null): number {
  if (horas === null) return 0;
  return horas < 24 ? horas : Math.floor(horas / 24);
}

/* -------------------------------------------------------------------------- */
/* Los errores                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Cada código del servidor con su texto. AL MARGEN Y NO DENTRO DE LA FUNCIÓN,
 * igual que en `pedidos.ts`: hay una prueba que lee ESTE fichero y comprueba
 * que ningún código de envíos llegue a una pantalla sin nada detrás, y para
 * poder leerlo la tabla tiene que estar donde se puede leer.
 */
const ERRORES: Record<string, ClaveDeTraduccion> = {
  product_shipments_not_available: 'envio.error.noDisponible',
  product_shipment_not_found: 'envio.error.noEncontrado',
  product_shipment_order_not_paid: 'envio.error.sinPagar',
  product_shipment_not_fully_prepared: 'envio.error.incompleto',
  product_shipment_not_preparing: 'envio.error.yaNoSePrepara',
  product_shipment_item_not_in_order: 'envio.error.lineaAjena',
  product_shipment_quantity_invalid: 'envio.error.cantidad',
  product_shipment_transition_invalid: 'envio.error.saltoInvalido',
  product_shipment_transition_forbidden: 'envio.error.saltoProhibido',
  product_shipment_reason_required: 'envio.error.motivo',
  product_shipment_intervene_forbidden: 'envio.error.intervenirProhibido',
  product_shipment_cancellation_not_configured: 'envio.error.sinPoliticaDeCancelacion',
  //: DESDE EL INCREMENTO 7: no se confirma una recepcion mientras se discute
  //: si el paquete llego. Quien dice que no lo recibio no puede a la vez decir
  //: que si.
  product_shipment_incident_open: 'envio.error.casoAbierto',
};

/** La clave del texto de un fallo del envío, o `null` si no es de aquí. */
export function claveDeErrorDeEnvios(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const limpio = (codigo ?? '').trim();
  return limpio === '' ? null : (ERRORES[limpio] ?? null);
}

/** Si el fallo es que la 0079 no está aplicada en esa base. */
export function esEnvioApagado(codigo: string | null | undefined): boolean {
  return (codigo ?? '').trim() === 'product_shipments_not_available';
}
