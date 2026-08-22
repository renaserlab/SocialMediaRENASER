import { apiRequest, API_V1 } from '@/services/api';

/**
 * Categorias con las que cada creador organiza sus audios.
 *
 * Sustituyen a las tres que estaban escritas en el codigo del movil («Mente y
 * Emociones», «Cuerpo», «Dinero»). Aquellas servian para un podcast de una
 * sola persona; no dicen nada del carpintero que quiere «Mis experiencias»,
 * «Carpinteria» e «Historias».
 *
 * La categoria de un episodio se sigue guardando en `posts.category`, que es
 * texto libre: ahi va el ID de una de estas filas. Por eso las etiquetas
 * antiguas siguen funcionando y el contenido ya publicado no necesito ninguna
 * conversion.
 */

type CategoriaDto = {
  id: string;
  owner_id: string;
  name: string;
  position: number;
  episodes_count: number;
};

export type CategoriaDePodcast = {
  id: string;
  ownerId: string;
  nombre: string;
  posicion: number;
  /** Cuantos audios tiene asignados. */
  episodios: number;
};

function aCategoria(dto: CategoriaDto): CategoriaDePodcast {
  return {
    id: dto.id,
    ownerId: dto.owner_id,
    nombre: dto.name,
    posicion: dto.position ?? 0,
    episodios: dto.episodes_count ?? 0,
  };
}

export const PodcastCategoryRepository = {
  /** Las de un perfil, en su orden. Publico: se ven al visitarlo. */
  async list(ownerId: string): Promise<CategoriaDePodcast[]> {
    const dtos = await apiRequest<CategoriaDto[]>(
      `${API_V1}/podcast-categories?owner_id=${encodeURIComponent(ownerId)}`,
    );
    return dtos.map(aCategoria);
  },

  /**
   * Crea una en el perfil propio.
   *
   * No lleva `ownerId`: el dueno lo resuelve el backend desde el token. Si
   * viajara en el cuerpo, cualquiera podria crear categorias en el perfil de
   * otra persona.
   */
  async create(nombre: string): Promise<CategoriaDePodcast> {
    const dto = await apiRequest<CategoriaDto>(`${API_V1}/podcast-categories`, {
      method: 'POST',
      body: JSON.stringify({ name: nombre }),
    });
    return aCategoria(dto);
  },

  /** Renombra o reordena. Renombrar no toca los episodios: guardan el ID. */
  async update(
    id: string,
    cambios: { nombre?: string; posicion?: number },
  ): Promise<CategoriaDePodcast> {
    const cuerpo: Record<string, unknown> = {};
    if (cambios.nombre !== undefined) cuerpo.name = cambios.nombre;
    if (cambios.posicion !== undefined) cuerpo.position = cambios.posicion;
    const dto = await apiRequest<CategoriaDto>(
      `${API_V1}/podcast-categories/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(cuerpo) },
    );
    return aCategoria(dto);
  },

  /**
   * La borra SIN borrar sus audios: los episodios se quedan sin categoria y
   * vuelven a aparecer en «Todos». Borrarlos con ella seria destruir contenido
   * por reorganizar una estanteria.
   */
  async remove(id: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/podcast-categories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};
