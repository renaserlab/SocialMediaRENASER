import { apiRequest, API_V1 } from '@/services/api';
import type { EnvioPendiente, PedidoDelProveedor } from '@/lib/envios';

/**
 * El envío de un pedido pagado: prepararlo, despacharlo y registrar su entrega.
 *
 * NINGÚN IMPORTE Y NINGÚN COMPRADOR VIAJAN POR AQUÍ. Lo que hace falta para
 * preparar un paquete es qué mandar y a dónde; el cobro y la identidad de quien
 * compró no aparecen en ninguna de estas respuestas, y eso lo decide el
 * servidor, no esta capa.
 *
 * NO HAY `cancelar()`, y no es un olvido: cancelar un pedido ya pagado obliga a
 * devolver el dinero, y ninguna política publicada dice con qué plazo, en qué
 * casos ni quién paga el porte de vuelta. El servidor lo para con su propio
 * código; poner aquí un método que siempre falla sería ofrecerlo.
 *
 * NO HAY `despachar()` PARA ADMINISTRACIÓN. Sacar la caja del almacén solo
 * puede afirmarlo quien la saca. Y no hay forma de escribir «entregado» desde
 * administración: fabricar una entrega arrancaría plazos de posventa que nadie
 * ha cumplido.
 *
 * LOS MOTIVOS SON OBLIGATORIOS donde el servidor los exige, y esta capa no los
 * rellena con nada. Un motivo por defecto es un motivo que nadie escribió.
 */
export const ProductShipmentRepository = {
  /** Los pedidos pagados de mi tienda, con el estado de cada paquete. */
  async mios(): Promise<PedidoDelProveedor[]> {
    return apiRequest<PedidoDelProveedor[]>(`${API_V1}/products/seller/orders`);
  },

  /** Uno de mis pedidos pagados, con lo que hace falta para prepararlo. */
  async leer(orderId: string): Promise<PedidoDelProveedor> {
    return apiRequest<PedidoDelProveedor>(
      `${API_V1}/products/seller/orders/${orderId}`,
    );
  },

  /**
   * Apunta cuántas unidades de cada línea llevo metidas en la caja.
   *
   * SE MANDA SOLO LO QUE CAMBIÓ. Quien empaqueta cuenta una caja cada vez, y
   * las líneas que no viajen se quedan como estaban.
   */
  async preparar(
    orderId: string,
    items: Array<{ order_item_id: string; prepared_quantity: number }>,
  ): Promise<PedidoDelProveedor> {
    return apiRequest<PedidoDelProveedor>(
      `${API_V1}/products/seller/orders/${orderId}/shipment/prepare`,
      { method: 'POST', body: JSON.stringify({ items }) },
    );
  },

  /** Cierra el paquete. El servidor exige que esté todo dentro. */
  async cerrar(orderId: string): Promise<PedidoDelProveedor> {
    return apiRequest<PedidoDelProveedor>(
      `${API_V1}/products/seller/orders/${orderId}/shipment/ready`,
      { method: 'POST' },
    );
  },

  /** Vuelve a abrirlo. Solo antes de que salga, y con motivo. */
  async reabrir(orderId: string, reason: string): Promise<PedidoDelProveedor> {
    return apiRequest<PedidoDelProveedor>(
      `${API_V1}/products/seller/orders/${orderId}/shipment/reopen`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
  },

  /**
   * Saca el paquete del almacén. AQUÍ SE CONSUME LA RESERVA.
   *
   * Transportista y referencia son OPCIONALES: mientras la empresa no elija
   * transportista, lo único honesto es dejar escribir lo que se tenga, y que
   * si no hay nada no se escriba nada.
   */
  async despachar(
    orderId: string,
    datos: { carrier_name?: string | null; tracking_reference?: string | null } = {},
  ): Promise<PedidoDelProveedor> {
    return apiRequest<PedidoDelProveedor>(
      `${API_V1}/products/seller/orders/${orderId}/shipment/dispatch`,
      { method: 'POST', body: JSON.stringify(datos) },
    );
  },

  /** Registra que llegó, según quien vende. Se guarda quién lo afirma. */
  async registrarEntrega(orderId: string): Promise<PedidoDelProveedor> {
    return apiRequest<PedidoDelProveedor>(
      `${API_V1}/products/seller/orders/${orderId}/shipment/delivered`,
      { method: 'POST' },
    );
  },

  /** El intento de entrega no salió. CON MOTIVO, siempre. */
  async registrarFallo(
    orderId: string,
    reason: string,
  ): Promise<PedidoDelProveedor> {
    return apiRequest<PedidoDelProveedor>(
      `${API_V1}/products/seller/orders/${orderId}/shipment/failed`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
  },

  /** El transportista vuelve a intentarlo. No devuelve nada al almacén. */
  async reintentarEntrega(
    orderId: string,
    reason: string,
  ): Promise<PedidoDelProveedor> {
    return apiRequest<PedidoDelProveedor>(
      `${API_V1}/products/seller/orders/${orderId}/shipment/retry`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
  },
};

/**
 * Lo que administración puede MIRAR de los envíos.
 *
 * LA COLA NO LLEVA DATOS PERSONALES. Ni dirección, ni nombre de quien compró,
 * ni importe, ni el motivo de una entrega fallida —que es texto libre y suele
 * llevar la calle dentro—: para saber si un paquete está parado hace falta de
 * quién es, en qué estado está y cuánto lleva así.
 *
 * NO HAY `mover()`, Y NO ES UN OLVIDO. La ruta de intervención existe en el
 * servidor, está probada y exige motivo, pero NO TIENE PANTALLA todavía: lo
 * único que administración puede hacer con ella —reabrir un paquete que no ha
 * salido, registrar que la entrega falló, registrar un reintento— también lo
 * hace quien vende desde la suya, y cuándo escala una cosa a la otra es una
 * decisión operativa que nadie ha tomado.
 *
 * UN MÉTODO AQUÍ SIN PANTALLA DETRÁS ES CÓDIGO MUERTO que parece una función.
 * Cuando esa decisión exista, se añaden la pantalla y el método juntos.
 */
export const ProductShipmentAdminRepository = {
  /** Los pedidos pagados cuyo paquete todavía no ha llegado. */
  async pendientes(): Promise<EnvioPendiente[]> {
    return apiRequest<EnvioPendiente[]>(`${API_V1}/admin/products/shipments`);
  },
};
