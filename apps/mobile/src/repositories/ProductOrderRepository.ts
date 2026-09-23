import { apiRequest, API_V1 } from '@/services/api';
import type {
  Checkout,
  Condiciones,
  Pedido,
  Preparacion,
  ResumenDePedido,
} from '@/lib/pedidos';

/**
 * El pedido de un producto físico.
 *
 * NO HAY `pagar()`, y no es un olvido: aquí no se cobra nada. `iniciarPago`
 * pide una URL alojada de la pasarela y lo único que se hace con ella es
 * abrirla fuera. NO EXISTE NINGÚN FORMULARIO DE TARJETA en esta aplicación y no
 * puede existir: los datos de la tarjeta no pasan por Z.
 *
 * NINGÚN IMPORTE VIAJA HACIA ARRIBA. `crear` manda proveedor, dirección y qué
 * condiciones se aceptaron; el subtotal y el total los calcula el servidor con
 * los precios de ese momento. Un campo `total` en esta petición sería el
 * cliente diciendo cuánto paga.
 *
 * LA ACEPTACIÓN VIAJA CON LA HUELLA del texto que se enseñó. Si entre leerlo y
 * pulsar comprar se publicó otra versión, el servidor lo nota y para: una
 * aceptación de un texto que ya no rige no es una aceptación.
 *
 * LA CLAVE DE IDEMPOTENCIA VIAJA EN `Idempotency-Key`. Es lo que impide que un
 * doble toque cree dos pedidos y aparte el doble de existencias.
 *
 * Y EL ESTADO SE PREGUNTA, NO SE DEDUCE. Al volver de la pasarela se llama a
 * `leer`: un parámetro en la URL de retorno lo escribe cualquiera.
 */
export const ProductOrderRepository = {
  /**
   * Si hoy se puede comprar, y QUÉ FALTA si no.
   *
   * No falla cuando la venta está apagada: contesta con la lista de lo que
   * falta, que es lo que la pantalla necesita para explicarlo.
   */
  async preparacion(): Promise<Preparacion> {
    return apiRequest<Preparacion>(`${API_V1}/products/checkout/preparation`);
  },

  /** Las condiciones que rigen hoy en ese país. */
  async condiciones(pais: string): Promise<Condiciones> {
    return apiRequest<Condiciones>(
      `${API_V1}/products/policies?country=${encodeURIComponent(pais)}`,
    );
  },

  /** Mis pedidos, los más nuevos primero. */
  async mios(): Promise<ResumenDePedido[]> {
    return apiRequest<ResumenDePedido[]>(`${API_V1}/products/orders`);
  },

  /** Un pedido mío. El ajeno es un 404. */
  async leer(orderId: string): Promise<Pedido> {
    return apiRequest<Pedido>(`${API_V1}/products/orders/${orderId}`);
  },

  /**
   * Convierte lo que hay en la bolsa de UN proveedor en un pedido reservado.
   *
   * NO COBRA NADA: reserva las unidades y deja el pedido esperando pago.
   */
  async crear(opciones: {
    sellerId: string;
    direccion: Record<string, string | null>;
    policyId: string;
    policySha256: string;
    clave: string;
  }): Promise<Pedido> {
    return apiRequest<Pedido>(`${API_V1}/products/orders`, {
      method: 'POST',
      body: JSON.stringify({
        seller_id: opciones.sellerId,
        address: opciones.direccion,
        policy_id: opciones.policyId,
        policy_terms_sha256: opciones.policySha256,
      }),
      headers: { 'Idempotency-Key': opciones.clave },
    });
  },

  /** Pide la URL alojada de la pasarela. NO marca nada como pagado. */
  async iniciarPago(orderId: string): Promise<Checkout> {
    return apiRequest<Checkout>(`${API_V1}/products/orders/${orderId}/checkout`, {
      method: 'POST',
    });
  },

  /** Cancela antes de pagar y suelta lo que apartaba. */
  async cancelar(orderId: string): Promise<Pedido> {
    return apiRequest<Pedido>(`${API_V1}/products/orders/${orderId}/cancel`, {
      method: 'POST',
    });
  },

  /**
   * Confirmo que recibí mi pedido. NO ES DAR LA CONFORMIDAD.
   *
   * La diferencia importa y no es sutil: confirmar que llegó es un hecho de
   * logística; dar la conformidad es decir que el producto está bien, y eso
   * libera el dinero al proveedor. Lo segundo no existe todavía —no hay
   * transferencias, ni comisión, ni plazo aprobado— y esta llamada no mueve
   * ni un céntimo.
   *
   * IDEMPOTENTE: confirmarlo dos veces no cambia nada ni vuelve a escribir en
   * el historial.
   */
  async confirmarRecepcion(orderId: string): Promise<Pedido> {
    return apiRequest<Pedido>(
      `${API_V1}/products/orders/${orderId}/shipment/confirm-receipt`,
      { method: 'POST' },
    );
  },
};
