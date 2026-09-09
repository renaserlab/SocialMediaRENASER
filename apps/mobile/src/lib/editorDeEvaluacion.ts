/**
 * Las reglas del editor de la evaluación, ejecutables sin montar la pantalla.
 *
 * QUIEN DECIDE SI SE PUEDE PUBLICAR ES EL SERVIDOR: vuelve a comprobarlo y
 * responde 422 con su código. Lo de aquí es para no mandar a nadie contra un
 * botón que va a fallar, y para poder decir QUÉ falta antes de tocarlo.
 *
 * Las condiciones son las mismas que `learning/evaluacion.py`, y eso NO es
 * duplicar la regla: es la misma frase escrita en los dos lados de una
 * frontera. La del servidor manda; si divergen, gana la suya y aquí se ve un
 * mensaje de más, nunca un permiso de más.
 */

/** Alternativas por pregunta. Los mismos números que la base. */
export const MINIMO_DE_ALTERNATIVAS = 2;
export const MAXIMO_DE_ALTERNATIVAS = 5;

export const LARGO_DEL_ENUNCIADO = 500;
export const LARGO_DE_LA_ALTERNATIVA = 300;

export type AlternativaEditable = { texto: string; esCorrecta: boolean };
export type PreguntaEditable = { enunciado: string; alternativas: AlternativaEditable[] };

/**
 * Por qué esta evaluación todavía no se puede publicar, o `null`.
 *
 * Devuelve un CÓDIGO, y son los mismos que usa el servidor, para que el texto
 * traducido sirva venga de donde venga el rechazo.
 */
export function motivoParaNoPublicar(
  preguntas: readonly PreguntaEditable[],
): string | null {
  if (preguntas.length === 0) return 'quiz_without_questions';
  for (const pregunta of preguntas) {
    if (pregunta.enunciado.trim() === '') return 'quiz_prompt_empty';
    if (
      pregunta.alternativas.length < MINIMO_DE_ALTERNATIVAS ||
      pregunta.alternativas.length > MAXIMO_DE_ALTERNATIVAS
    ) {
      return 'quiz_option_count_invalid';
    }
    if (pregunta.alternativas.some((a) => a.texto.trim() === '')) {
      return 'quiz_option_empty';
    }
    if (pregunta.alternativas.filter((a) => a.esCorrecta).length !== 1) {
      return 'quiz_answer_missing';
    }
  }
  return null;
}

/**
 * Marcar una alternativa como correcta APAGA las demás de esa pregunta.
 *
 * Una pregunta con dos correctas no se puede guardar —la base lo rechaza con
 * un índice único parcial—, así que la interfaz no debe dejar llegar ahí: se
 * comporta como un grupo de opción única, no como casillas.
 */
export function marcarCorrecta(
  alternativas: readonly AlternativaEditable[],
  indice: number,
): AlternativaEditable[] {
  return alternativas.map((a, i) => ({ ...a, esCorrecta: i === indice }));
}

/**
 * Una alternativa nueva al final. Nunca marcada: la correcta se elige a
 * propósito, y heredarla del vecino sería marcarla por descuido.
 */
export function conAlternativaNueva(
  alternativas: readonly AlternativaEditable[],
): AlternativaEditable[] {
  if (alternativas.length >= MAXIMO_DE_ALTERNATIVAS) return [...alternativas];
  return [...alternativas, { texto: '', esCorrecta: false }];
}

/**
 * Quitar una alternativa.
 *
 * Si la que se quita era la correcta, la pregunta se queda SIN correcta: no se
 * pasa la marca a la vecina. Elegir por su cuenta cuál es la respuesta buena de
 * un examen es justo lo que no puede hacer una interfaz.
 */
export function sinAlternativa(
  alternativas: readonly AlternativaEditable[],
  indice: number,
): AlternativaEditable[] {
  if (alternativas.length <= MINIMO_DE_ALTERNATIVAS) return [...alternativas];
  return alternativas.filter((_, i) => i !== indice);
}

/** Mover una pregunta arriba o abajo. El orden se guarda como se ve. */
export function moverPregunta<T>(
  preguntas: readonly T[],
  desde: number,
  hacia: number,
): T[] {
  if (
    desde < 0 ||
    hacia < 0 ||
    desde >= preguntas.length ||
    hacia >= preguntas.length ||
    desde === hacia
  ) {
    return [...preguntas];
  }
  const copia = [...preguntas];
  const [movida] = copia.splice(desde, 1);
  copia.splice(hacia, 0, movida as T);
  return copia;
}

/** Una pregunta nueva, con el mínimo de alternativas vacías. */
export function preguntaNueva(): PreguntaEditable {
  return {
    enunciado: '',
    alternativas: Array.from({ length: MINIMO_DE_ALTERNATIVAS }, () => ({
      texto: '',
      esCorrecta: false,
    })),
  };
}

/**
 * Si lo que hay en pantalla difiere de lo último guardado.
 *
 * Sirve para avisar antes de salir. Se compara el CONTENIDO, no la identidad:
 * volver a escribir el mismo texto no es un cambio pendiente.
 */
export function hayCambiosSinGuardar(
  actual: { titulo: string; notaMinima: number; preguntas: readonly PreguntaEditable[] },
  guardado: { titulo: string; notaMinima: number; preguntas: readonly PreguntaEditable[] },
): boolean {
  const huella = (x: typeof actual) =>
    JSON.stringify([
      x.titulo.trim(),
      x.notaMinima,
      x.preguntas.map((p) => [
        p.enunciado.trim(),
        p.alternativas.map((a) => [a.texto.trim(), a.esCorrecta]),
      ]),
    ]);
  return huella(actual) !== huella(guardado);
}

/** La nota mínima que se puede guardar. La misma que acepta la base. */
export function notaMinimaValida(valor: number): boolean {
  return Number.isInteger(valor) && valor >= 1 && valor <= 100;
}
