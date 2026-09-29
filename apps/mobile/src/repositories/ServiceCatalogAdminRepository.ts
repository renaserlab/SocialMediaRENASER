import { apiRequest, API_V1 } from '@/services/api';
import {
  consultaDelCatalogo,
  esDeLaVersion,
  type Categoria,
  type Cola,
  type EventoAdmin,
  type Pagina,
  type ServicioAdmin,
  type ServicioAdminResumen,
  type Version,
} from '@/lib/serviciosCatalogo';

/**
 * Z Servicios: el catálogo, visto por el equipo de Z.
 *
 * LAS DECISIONES SON RUTAS, no un campo `status`: iniciar la revisión, pedir
 * cambios, aprobar y publicar van sobre la VERSIÓN propuesta; suspender,
 * reactivar y retirar, sobre el SERVICIO. Cada una lleva `Idempotency-Key` y
 * devuelve el servicio entero recién leído.
 *
 * Quién puede qué lo decide el servidor (`actions`); aquí no se filtra nada.
 */
const BASE = `${API_V1}/admin/services`;
const CATALOGO = `${BASE}/catalog`;

const RUTA_DE_LA_ACCION: Record<string, string> = {
  start_review: 'start-review',
  request_changes: 'request-changes',
  approve: 'approve',
  publish: 'publish',
  suspend: 'suspend',
  reinstate: 'reinstate',
  retire: 'retire',
};

export const ServiceCatalogAdminRepository = {
  async bandeja(opciones: {
    cola: Cola;
    estadoDeVersion: string | null;
    modalidad: string | null;
    categoria: string | null;
    cursor: string | null;
  }): Promise<Pagina<ServicioAdminResumen>> {
    return apiRequest<Pagina<ServicioAdminResumen>>(`${CATALOGO}?${consultaDelCatalogo(opciones)}`);
  },

  async servicio(id: string): Promise<ServicioAdmin> {
    return apiRequest<ServicioAdmin>(`${CATALOGO}/${encodeURIComponent(id)}`);
  },

  /** Cualquier versión del servicio, para compararla. */
  async version(id: string, versionId: string): Promise<Version> {
    return apiRequest<Version>(`${CATALOGO}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`);
  },

  /** El historial COMPLETO, con notas internas y en calidad de qué se actuó. */
  async historial(id: string): Promise<EventoAdmin[]> {
    return apiRequest<EventoAdmin[]>(`${CATALOGO}/${encodeURIComponent(id)}/history`);
  },

  /**
   * Una decisión. `versionId` es la versión PROPUESTA en las cuatro que van
   * sobre la versión; en las del servicio no se usa.
   */
  async decidir(
    id: string,
    accion: string,
    versionId: string | null,
    cuerpo: Record<string, unknown>,
    clave: string,
  ): Promise<ServicioAdmin> {
    const tramo = RUTA_DE_LA_ACCION[accion];
    if (!tramo) throw new Error(`acción desconocida: ${accion}`);
    const servicio = `${CATALOGO}/${encodeURIComponent(id)}`;
    const url = esDeLaVersion(accion)
      ? `${servicio}/versions/${encodeURIComponent(versionId ?? '')}/${tramo}`
      : `${servicio}/${tramo}`;
    return apiRequest<ServicioAdmin>(url, {
      method: 'POST',
      body: JSON.stringify(cuerpo),
      headers: { 'Idempotency-Key': clave },
    });
  },

  /** Todas las categorías, activas e inactivas. */
  async categorias(): Promise<Categoria[]> {
    return apiRequest<Categoria[]>(`${BASE}/categories`);
  },

  async crearCategoria(peticion: Record<string, unknown>): Promise<Categoria> {
    return apiRequest<Categoria>(`${BASE}/categories`, { method: 'POST', body: JSON.stringify(peticion) });
  },

  /** Solo lo que cambió. Ni el slug ni el estado. */
  async editarCategoria(id: string, cambios: Record<string, unknown>): Promise<Categoria> {
    return apiRequest<Categoria>(`${BASE}/categories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(cambios),
    });
  },

  async activarCategoria(id: string): Promise<Categoria> {
    return apiRequest<Categoria>(`${BASE}/categories/${encodeURIComponent(id)}/activate`, { method: 'POST' });
  },

  /** No acepta servicios nuevos; los que ya la usan la siguen nombrando. */
  async desactivarCategoria(id: string): Promise<Categoria> {
    return apiRequest<Categoria>(`${BASE}/categories/${encodeURIComponent(id)}/deactivate`, { method: 'POST' });
  },
};
