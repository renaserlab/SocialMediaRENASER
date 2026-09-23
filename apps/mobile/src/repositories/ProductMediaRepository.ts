import { apiRequest, API_V1 } from '@/services/api';
import type { FotoDelProveedor, FotoPendiente } from '@/lib/fotosDeProducto';

/**
 * Las fotografías de un producto: subir, ordenar, quitar y —quien evalúa—
 * aprobar o rechazar.
 *
 * EL ARCHIVO VIAJA A LA API, NO AL ALMACENAMIENTO. El depósito `product-media`
 * es privado y no tiene ninguna política: la aplicación no puede escribir en él
 * ni leerlo. Por eso aquí no hay ningún cliente de Storage ni ninguna clave: se
 * manda el archivo y el servidor decide el nombre, mira los bytes y guarda.
 *
 * Y NO SE MANDA NINGUNA RUTA. Antes quien vendía escribía a mano la ruta del
 * almacenamiento, lo que permitía apuntar a un archivo ajeno o a ninguno. Ese
 * camino ya no existe: `PUT .../draft` no lleva galería.
 *
 * LAS URL LLEGAN FIRMADAS Y CADUCAN. No se guardan en ningún sitio: se piden
 * cada vez que se pinta la pantalla.
 */
export const ProductMediaRepository = {
  /** Las fotografías del borrador, CON su estado y el motivo del rechazo. */
  async mias(productoId: string): Promise<FotoDelProveedor[]> {
    return apiRequest<FotoDelProveedor[]>(
      `${API_V1}/products/seller/products/${productoId}/media`,
    );
  },

  /**
   * Sube una fotografía. NACE PENDIENTE de aprobación.
   *
   * `clave` viaja en `Idempotency-Key` y se genera una vez por pulsación: es lo
   * que impide que un doble toque suba la misma foto dos veces.
   */
  async subir(
    productoId: string,
    opciones: { archivo: Blob | File; nombre: string; altText: string; clave?: string },
  ): Promise<FotoDelProveedor> {
    const formulario = new FormData();
    formulario.append('file', opciones.archivo as Blob, opciones.nombre);
    formulario.append('alt_text', opciones.altText);
    return apiRequest<FotoDelProveedor>(
      `${API_V1}/products/seller/products/${productoId}/media`,
      {
        method: 'POST',
        body: formulario,
        headers: opciones.clave ? { 'Idempotency-Key': opciones.clave } : undefined,
        // Un archivo tarda más que una respuesta normal, y cortarlo a los
        // veinte segundos dejaría a medias una subida que iba bien.
        timeoutMs: 120_000,
      },
    );
  },

  /** Deja la galería en ese orden. TODAS o ninguna. */
  async ordenar(productoId: string, mediaIds: string[]): Promise<FotoDelProveedor[]> {
    return apiRequest<FotoDelProveedor[]>(
      `${API_V1}/products/seller/products/${productoId}/media/order`,
      { method: 'PUT', body: JSON.stringify({ media_ids: mediaIds }) },
    );
  },

  /** Quita una fotografía del borrador. */
  async quitar(productoId: string, mediaId: string): Promise<void> {
    await apiRequest<void>(
      `${API_V1}/products/seller/products/${productoId}/media/${mediaId}`,
      { method: 'DELETE' },
    );
  },

  /** La bandeja de quien revisa: lo pendiente, LO MÁS VIEJO PRIMERO. */
  async pendientes(limite = 50): Promise<FotoPendiente[]> {
    return apiRequest<FotoPendiente[]>(
      `${API_V1}/admin/products/media/pending?limit=${limite}`,
    );
  },

  /** Aprueba o rechaza. UN RECHAZO LLEVA MOTIVO: es lo que permite corregirlo. */
  async decidir(
    mediaId: string,
    decision: { approved: boolean; reason?: string | null },
  ): Promise<FotoPendiente> {
    return apiRequest<FotoPendiente>(
      `${API_V1}/admin/products/media/${mediaId}/decide`,
      { method: 'POST', body: JSON.stringify(decision) },
    );
  },
};
