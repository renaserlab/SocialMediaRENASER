/** Qué lección va antes y cuál después, dentro del temario del curso. */

export type LeccionDelTemario = { id: string };

export type Vecinas = {
  anterior: string | null;
  siguiente: string | null;
};

/**
 * Las vecinas de una lección en la lista aplanada del curso.
 *
 * Devuelve `null` en los extremos y también cuando la lección no está en la
 * lista: no se adivina un vecino con la posición 0 ni con la última, que es
 * como se acaba mandando a alguien a la lección de otro módulo.
 */
export function vecinasDe(
  lecciones: readonly LeccionDelTemario[],
  actual: string,
): Vecinas {
  const posicion = lecciones.findIndex((l) => l.id === actual);
  if (posicion === -1) return { anterior: null, siguiente: null };
  return {
    anterior: posicion > 0 ? lecciones[posicion - 1]!.id : null,
    siguiente:
      posicion < lecciones.length - 1 ? lecciones[posicion + 1]!.id : null,
  };
}
