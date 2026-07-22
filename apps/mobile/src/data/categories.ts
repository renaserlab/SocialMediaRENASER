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

/** Etiqueta legible de una categoría; vacío si no tiene o no se reconoce. */
export function categoryLabel(id?: string | null): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? '';
}
