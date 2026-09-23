import { apiRequest, API_V1 } from '@/services/api';
import type { Inventario, Existencias, Movimiento } from '@/lib/inventario';

/**
 * El inventario de quien vende. CINCO LLAMADAS.
 *
 * SOLO LO PROPIO. Todas cuelgan de `/products/seller/products/{id}`, y el
 * servidor contesta 404 para un producto ajeno: decir «existe pero no es tuyo»
 * ya cuenta que existe.
 *
 * NO HAY `reservar()`, `liberar()` NI `despachar()`. Esas operaciones existen
 * en el servidor, funcionan y están probadas, pero las provoca el checkout, que
 * todavía no existe: ponerlas aquí sería ofrecer un botón que no lleva a
 * ninguna parte.
 *
 * LA CLAVE DE IDEMPOTENCIA VA EN EL CUERPO y es obligatoria. Sin ella, un doble
 * toque carga el doble de existencias, y eso no se arregla con un `disabled`
 * en el botón: la petición ya salió dos veces.
 */
export const ProductInventoryRepository = {
  /** Las variantes con lo que hay de cada SKU. `stock` nulo NO es cero. */
  async leer(productoId: string): Promise<Inventario> {
    return apiRequest<Inventario>(
      `${API_V1}/products/seller/products/${productoId}/inventory`,
    );
  },

  /** Entran unidades. Es lo único que crea la fila de inventario de un SKU. */
  async cargar(
    productoId: string,
    peticion: { sku: string; quantity: number; reason?: string | null; idempotency_key: string },
  ): Promise<Existencias> {
    return apiRequest<Existencias>(
      `${API_V1}/products/seller/products/${productoId}/inventory/intake`,
      { method: 'POST', body: JSON.stringify(peticion) },
    );
  },

  /** Corrige la existencia, con signo y CON MOTIVO. */
  async ajustar(
    productoId: string,
    peticion: { sku: string; quantity: number; reason: string; idempotency_key: string },
  ): Promise<Existencias> {
    return apiRequest<Existencias>(
      `${API_V1}/products/seller/products/${productoId}/inventory/adjust`,
      { method: 'POST', body: JSON.stringify(peticion) },
    );
  },

  /** El historial de un SKU. SOLO SE AÑADE: nada de aquí se edita ni se borra. */
  async movimientos(productoId: string, sku: string, limite = 50): Promise<Movimiento[]> {
    return apiRequest<Movimiento[]>(
      `${API_V1}/products/seller/products/${productoId}/inventory/${encodeURIComponent(sku)}/movements?limit=${limite}`,
    );
  },
};
