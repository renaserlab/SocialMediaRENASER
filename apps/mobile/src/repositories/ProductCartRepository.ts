import { apiRequest, API_V1 } from '@/services/api';
import type { Carrito, Contadores } from '@/lib/carrito';

/**
 * La bolsa de Productos. SEIS LLAMADAS, y ninguna lleva a pagar.
 *
 * NO HAY `checkout()`, NI `pagar()`, NI `crearPedido()`, y no es un olvido: la
 * API no tiene esas rutas —ni siquiera vacías devolviendo 501, porque eso ya
 * sería una promesa— y ponerlas aquí acabaría en un 404 después de haber
 * pintado un botón que promete algo que Z todavía no hace.
 *
 * TODOS LOS IMPORTES VIENEN CALCULADOS. Esta capa no suma nada: manda qué
 * producto, qué variante y cuántas, y escribe lo que el servidor conteste.
 *
 * CADA RESPUESTA ES LA BOLSA ENTERA, a propósito. Devolver solo la línea
 * tocada obligaría a recomponer el total en el cliente, y ahí es donde el
 * número que se ve deja de ser el que el servidor calculó.
 *
 * LA CLAVE DE IDEMPOTENCIA VIAJA EN `Idempotency-Key`. Es lo que distingue un
 * doble toque —que no debe sumar dos— de dos toques, que sí.
 */
export const ProductCartRepository = {
  /** La bolsa, con los avisos de lo que cambió desde que se metió. */
  async leer(): Promise<Carrito> {
    return apiRequest<Carrito>(`${API_V1}/products/cart`);
  },

  /**
   * Añade unidades. AÑADIR DOS VECES AJUSTA LA LÍNEA, no la duplica.
   *
   * `clave` se genera una vez por pulsación y se reenvía en los reintentos.
   */
  async anadir(opciones: {
    productoId: string;
    varianteId: string;
    cantidad?: number;
    clave?: string;
  }): Promise<Carrito> {
    return apiRequest<Carrito>(`${API_V1}/products/cart/items`, {
      method: 'POST',
      body: JSON.stringify({
        product_id: opciones.productoId,
        variant_id: opciones.varianteId,
        quantity: opciones.cantidad ?? 1,
      }),
      headers: opciones.clave ? { 'Idempotency-Key': opciones.clave } : undefined,
    });
  },

  /** Deja la línea en esa cantidad. CERO LA QUITA, y repetirlo deja lo mismo. */
  async cambiarCantidad(itemId: string, cantidad: number): Promise<Carrito> {
    return apiRequest<Carrito>(`${API_V1}/products/cart/items/${itemId}`, {
      method: 'PUT',
      body: JSON.stringify({ quantity: cantidad }),
    });
  },

  /** Quita la línea. Quitar lo que ya no está tampoco es un error. */
  async quitar(itemId: string): Promise<Carrito> {
    return apiRequest<Carrito>(`${API_V1}/products/cart/items/${itemId}`, {
      method: 'DELETE',
    });
  },

  /** Deja la bolsa vacía. */
  async vaciar(): Promise<Carrito> {
    return apiRequest<Carrito>(`${API_V1}/products/cart`, { method: 'DELETE' });
  },

  /**
   * Los dos contadores del encabezado, SEPARADOS.
   *
   * Uno cuenta unidades del carrito y el otro productos guardados. Son cosas
   * distintas y por eso son dos números: un solo contador no querría decir
   * nada concreto.
   */
  async contadores(): Promise<Contadores> {
    return apiRequest<Contadores>(`${API_V1}/products/counts`);
  },
};
