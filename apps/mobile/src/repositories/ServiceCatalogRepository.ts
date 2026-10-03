import { apiRequest, API_V1 } from '@/services/api';
import { ESPERA_DE_SUBIDA_MS } from '@/lib/serviciosAdmision';
import type {
  Categoria,
  EventoVisible,
  Pagina,
  ServicioPrivado,
  ServicioResumen,
} from '@/lib/serviciosCatalogo';
import type { FichaPublica } from '@/lib/serviciosDescubrimiento';

/**
 * Z Servicios: el catálogo de quien ofrece servicios, y la ficha pública.
 *
 * CADA RESPUESTA DEL PRESTADOR ES EL SERVICIO ENTERO recién leído: la pantalla
 * pinta lo que dice el servidor, nunca lo que cree que pasó. Un servicio ajeno
 * es el mismo 404 que uno inexistente.
 *
 * NINGUNA PETICIÓN LLEVA UN ESTADO: los saltos son rutas (`submit`,
 * `withdraw`), y el borrador solo recibe contenido.
 *
 * Crear, subir una imagen, enviar y retirar llevan `Idempotency-Key`: un
 * segundo toque, o un reintento tras perder la conexión, no hace dos veces.
 *
 * LAS IMÁGENES VAN A LA API, NO AL ALMACENAMIENTO: el depósito es privado y la
 * ruta la pone el servidor. Aquí no hay cliente de Storage ni rutas.
 */
const BASE = `${API_V1}/services`;
const MIOS = `${BASE}/provider/services`;

function json(body: unknown, method = 'POST', clave?: string): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    ...(clave ? { headers: { 'Idempotency-Key': clave } } : {}),
  };
}

export const ServiceCatalogRepository = {
  /** Las categorías ACTIVAS, en su orden. */
  async categorias(): Promise<Categoria[]> {
    return apiRequest<Categoria[]>(`${BASE}/categories`);
  },

  /** Los propios, del más nuevo al más viejo. 403 si aún no eres prestador activo. */
  async mios(cursor: string | null): Promise<Pagina<ServicioResumen>> {
    const q = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : '?limit=20';
    return apiRequest<Pagina<ServicioResumen>>(`${MIOS}${q}`);
  },

  /** Un servicio nuevo, con su primer borrador. Con la misma clave, el mismo. */
  async crear(categoriaId: string, clave: string): Promise<ServicioPrivado> {
    return apiRequest<ServicioPrivado>(MIOS, json({ category_id: categoriaId }, 'POST', clave));
  },

  async servicio(id: string): Promise<ServicioPrivado> {
    return apiRequest<ServicioPrivado>(`${MIOS}/${encodeURIComponent(id)}`);
  },

  /** El borrador abierto, o uno nuevo que sale de la última versión. */
  async abrirBorrador(id: string): Promise<ServicioPrivado> {
    return apiRequest<ServicioPrivado>(`${MIOS}/${encodeURIComponent(id)}/draft`, { method: 'POST' });
  },

  /** Solo lo que cambió. Nunca el estado. */
  async guardarBorrador(id: string, cambios: Record<string, unknown>): Promise<ServicioPrivado> {
    return apiRequest<ServicioPrivado>(`${MIOS}/${encodeURIComponent(id)}/draft`, json(cambios, 'PATCH'));
  },

  /** Qué le falta al borrador para enviarse, recién calculado por el servidor. */
  async requisitos(id: string): Promise<{ missing: string[] }> {
    return apiRequest<{ missing: string[] }>(`${MIOS}/${encodeURIComponent(id)}/draft/requirements`);
  },

  /** Sube una imagen del borrador. La primera es la portada. */
  async subirImagen(
    id: string,
    opciones: { archivo: Blob; nombre: string; alternativo: string; clave: string },
  ): Promise<ServicioPrivado> {
    const formulario = new FormData();
    formulario.append('file', opciones.archivo, opciones.nombre);
    formulario.append('alt_text', opciones.alternativo);
    return apiRequest<ServicioPrivado>(`${MIOS}/${encodeURIComponent(id)}/draft/images`, {
      method: 'POST',
      body: formulario,
      headers: { 'Idempotency-Key': opciones.clave },
      timeoutMs: ESPERA_DE_SUBIDA_MS,
    });
  },

  /** El orden de TODAS las imágenes y, si se indica, la portada. */
  async ordenarImagenes(id: string, orden: string[], portada: string | null): Promise<ServicioPrivado> {
    return apiRequest<ServicioPrivado>(
      `${MIOS}/${encodeURIComponent(id)}/draft/images/order`,
      json({ image_ids: orden, ...(portada ? { cover_id: portada } : {}) }, 'PUT'),
    );
  },

  async quitarImagen(id: string, imagenId: string): Promise<ServicioPrivado> {
    return apiRequest<ServicioPrivado>(
      `${MIOS}/${encodeURIComponent(id)}/draft/images/${encodeURIComponent(imagenId)}`,
      { method: 'DELETE' },
    );
  },

  /** Envía el borrador a revisión. Incompleto: 422 con la lista de lo que falta. */
  async enviar(id: string, clave: string): Promise<ServicioPrivado> {
    return apiRequest<ServicioPrivado>(`${MIOS}/${encodeURIComponent(id)}/draft/submit`, json({}, 'POST', clave));
  },

  /** Retira la versión abierta antes de publicarse. La publicada, si hay, sigue. */
  async retirarVersion(id: string, clave: string): Promise<ServicioPrivado> {
    return apiRequest<ServicioPrivado>(
      `${MIOS}/${encodeURIComponent(id)}/draft/withdraw`,
      json({ confirm: true }, 'POST', clave),
    );
  },

  /** El historial VISIBLE: sin quién de Z actuó ni notas internas. */
  async historial(id: string): Promise<EventoVisible[]> {
    return apiRequest<EventoVisible[]>(`${MIOS}/${encodeURIComponent(id)}/history`);
  },

  /**
   * La ficha pública: solo lo publicado de un prestador activo en una categoría
   * activa. Desde el Incremento 3 trae también la confianza que Z comprobó, las
   * reseñas (todavía ninguna), si la tienes guardada y otros servicios con su razón.
   */
  async ficha(id: string): Promise<FichaPublica> {
    return apiRequest<FichaPublica>(`${BASE}/catalog/${encodeURIComponent(id)}`);
  },
};
