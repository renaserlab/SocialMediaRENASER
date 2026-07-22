/**
 * Categorías temáticas del contenido (filtros del podcast).
 *
 * Se definen aquí y solo aquí: el backend guarda el `id` como texto libre a
 * propósito, para que cambiar esta lista no exija una migración. Añadir una
 * categoría es añadir una línea.
 */
export type CategoryId = 'mente' | 'cuerpo' | 'dinero';

export const CATEGORIES: Array<{ id: CategoryId; label: string }> = [
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

/** Etiqueta legible de una categoría; vacío si no tiene o no se reconoce. */
export function categoryLabel(id?: string | null): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? '';
}
