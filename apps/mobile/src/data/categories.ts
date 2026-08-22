/**
 * Etiquetas ANTIGUAS del podcast.
 *
 * Ya no se ofrecen al publicar ni al filtrar: cada creador define ahora sus
 * propias categorías (tabla `podcast_categories`, ver
 * `PodcastCategoryRepository`). Estas tres describían el podcast de una
 * persona concreta y no le sirven de nada a quien quiere ordenar lo suyo en
 * «Mis experiencias» o «Carpintería».
 *
 * La lista SE QUEDA aquí, y no se borra, porque `posts.category` es texto
 * libre y hay audios ya publicados que guardan uno de estos valores. Sin este
 * mapa se verían con la etiqueta en crudo («dinero») o sin nombre. Los
 * episodios que la tengan aparecen en «Todos» hasta que su dueño les asigne
 * una categoría suya.
 */
export type CategoryId = 'mente' | 'cuerpo' | 'dinero';

export const CATEGORIAS_ANTIGUAS: Array<{ id: CategoryId; label: string }> = [
  { id: 'mente', label: 'Mente y Emociones' },
  { id: 'cuerpo', label: 'Cuerpo' },
  { id: 'dinero', label: 'Dinero' },
];

/**
 * Categoría reservada del audio privado.
 *
 * No aparece entre los filtros ni se puede elegir al publicar un episodio: es
 * la marca que distingue "el audio privado" del resto de audios, y se excluye
 * de la lista del podcast para que no salga dos veces.
 */
export const PRIVATE_AUDIO_CATEGORY = 'privado';

/**
 * Etiqueta legible de una categoría ANTIGUA; vacío si no es una de ellas.
 *
 * Las categorías propias de cada creador no pasan por aquí: su nombre viene de
 * la base de datos y lo resuelve quien pinta la lista.
 */
export function categoryLabel(id?: string | null): string {
  return CATEGORIAS_ANTIGUAS.find((c) => c.id === id)?.label ?? '';
}
