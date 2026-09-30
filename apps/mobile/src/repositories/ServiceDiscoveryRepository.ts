import { apiRequest, API_V1 } from '@/services/api';
import {
  TAMANO_DE_PAGINA,
  consultaDelCatalogo,
  type CategoriaDelCatalogo,
  type Filtros,
  type Guardado,
  type PaginaDelCatalogo,
  type PerfilDePrestador,
  type SeccionDeSugerencias,
} from '@/lib/serviciosDescubrimiento';
import type { Pagina } from '@/lib/serviciosCatalogo';

/**
 * Z Servicios, Incremento 3: descubrir servicios.
 *
 * TODO LO FILTRA Y ORDENA EL SERVIDOR: aquí se piden páginas por cursor y se
 * pintan tal cual. No se descarga el catálogo para recortarlo en el teléfono.
 *
 * LA FICHA sigue en `ServiceCatalogRepository.ficha` (la del Incremento 2,
 * ampliada): no hay dos formas de pedir lo mismo.
 *
 * GUARDAR es idempotente en el servidor: un doble toque o un reintento dejan
 * el mismo resultado. No reserva nada ni avisa a nadie.
 */
const BASE = `${API_V1}/services`;

export const ServiceDiscoveryRepository = {
  /** Lo público, buscado, filtrado y ordenado en el servidor. */
  async catalogo(filtros: Filtros, cursor: string | null): Promise<PaginaDelCatalogo> {
    return apiRequest<PaginaDelCatalogo>(`${BASE}/catalog?${consultaDelCatalogo(filtros, cursor)}`);
  },

  /** Las categorías con algo publicado (y sus madres). */
  async categorias(): Promise<CategoriaDelCatalogo[]> {
    return apiRequest<CategoriaDelCatalogo[]>(`${BASE}/public-categories`);
  },

  /** Secciones con su razón. Puede venir vacía, y entonces no se enseña nada. */
  async sugerencias(): Promise<{ sections: SeccionDeSugerencias[] }> {
    return apiRequest<{ sections: SeccionDeSugerencias[] }>(`${BASE}/suggestions`);
  },

  async prestador(id: string): Promise<PerfilDePrestador> {
    return apiRequest<PerfilDePrestador>(`${BASE}/providers/${encodeURIComponent(id)}`);
  },

  async serviciosDelPrestador(id: string, cursor: string | null): Promise<PaginaDelCatalogo> {
    const q = `limit=${TAMANO_DE_PAGINA}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    return apiRequest<PaginaDelCatalogo>(`${BASE}/providers/${encodeURIComponent(id)}/services?${q}`);
  },

  async guardar(id: string): Promise<{ saved: boolean }> {
    return apiRequest<{ saved: boolean }>(`${BASE}/catalog/${encodeURIComponent(id)}/save`, { method: 'POST' });
  },

  async quitar(id: string): Promise<{ saved: boolean }> {
    return apiRequest<{ saved: boolean }>(`${BASE}/catalog/${encodeURIComponent(id)}/save`, { method: 'DELETE' });
  },

  /** Lo guardado, lo más reciente primero; lo no disponible, sin contenido. */
  async guardados(cursor: string | null): Promise<Pagina<Guardado>> {
    const q = `limit=${TAMANO_DE_PAGINA}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    return apiRequest<Pagina<Guardado>>(`${BASE}/saved?${q}`);
  },
};
