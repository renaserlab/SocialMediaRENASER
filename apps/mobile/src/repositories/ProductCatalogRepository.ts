import { apiRequest, API_V1 } from '@/services/api';
import type {
  Busqueda,
  Categorias,
  Ficha,
  Guardado,
  Informe,
  Portada,
  TarjetaDeProducto,
} from '@/lib/productos';

/**
 * El catálogo público de Productos Z. SIETE LLAMADAS, y ninguna más.
 *
 * NO HAY NINGÚN MÉTODO DE COMPRA, y no puede haberlo: la API no tiene carrito,
 * ni checkout, ni pedido —el router lo dice y ni siquiera deja una ruta vacía
 * que devolviera 501, porque eso ya sería una promesa—. Un `comprar()` aquí
 * acabaría en 404, pero antes ya habría hecho pintar un botón que promete algo
 * que Z todavía no hace.
 *
 * TAMPOCO ESTÁ LO DEL PROVEEDOR NI LO DE ADMINISTRACIÓN. `/products/seller/...`
 * y `/admin/products/...` son otras pantallas y otros roles; separarlos es lo
 * que impide que la portada acabe llamando a una ruta que exige ser evaluador.
 *
 * LO QUE SE FILTRA LO FILTRA EL SERVIDOR. La búsqueda manda `q`, `category_id`,
 * `cursor` y `limit` y se queda con lo que conteste: decidir aquí qué está
 * publicado dejaría que una versión vieja instalada en un teléfono enseñara
 * algo que Z retiró.
 */
export const ProductCatalogRepository = {
  /** La portada. ANÓNIMA: el catálogo se puede mirar sin entrar. */
  async portada(): Promise<Portada> {
    return apiRequest<Portada>(`${API_V1}/products`);
  },

  /**
   * Busca en lo publicado, con paginación POR CURSOR.
   *
   * El cursor es el identificador del último producto de la página anterior, no
   * un número de página: paginar por desplazamiento repite filas y se salta
   * otras cuando alguien publica a mitad.
   */
  async buscar(opciones: {
    q?: string | null;
    categoryId?: string | null;
    cursor?: string | null;
    limit?: number;
  }): Promise<Busqueda> {
    const parametros = new URLSearchParams();
    if (opciones.q) parametros.set('q', opciones.q);
    if (opciones.categoryId) parametros.set('category_id', opciones.categoryId);
    if (opciones.cursor) parametros.set('cursor', opciones.cursor);
    if (opciones.limit) parametros.set('limit', String(opciones.limit));
    const cola = parametros.toString();
    return apiRequest<Busqueda>(
      `${API_V1}/products/search${cola === '' ? '' : `?${cola}`}`,
    );
  },

  /** Las categorías activas. VACÍO = la empresa no las ha definido. */
  async categorias(): Promise<Categorias> {
    return apiRequest<Categorias>(`${API_V1}/products/categories`);
  },

  /** Lo que guardé, y que sigue publicado. Exige sesión. */
  async guardados(): Promise<TarjetaDeProducto[]> {
    return apiRequest<TarjetaDeProducto[]>(`${API_V1}/products/saved`);
  },

  /** El detalle. 404 si no está publicado: no se enseña un borrador. */
  async ficha(productoId: string): Promise<Ficha> {
    return apiRequest<Ficha>(`${API_V1}/products/${productoId}`);
  },

  /** El informe que abre el sello. Sin la nota interna del evaluador. */
  async informe(productoId: string): Promise<Informe> {
    return apiRequest<Informe>(`${API_V1}/products/${productoId}/evaluation`);
  },

  /** Guarda. IDEMPOTENTE, y NO RESERVA NADA: no es un carrito. */
  async guardar(productoId: string): Promise<Guardado> {
    return apiRequest<Guardado>(`${API_V1}/products/${productoId}/save`, {
      method: 'POST',
    });
  },

  /** Lo quita de guardados. Quitar lo que no está tampoco es un error. */
  async quitar(productoId: string): Promise<Guardado> {
    return apiRequest<Guardado>(`${API_V1}/products/${productoId}/save`, {
      method: 'DELETE',
    });
  },
};
