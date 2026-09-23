/**
 * Las reglas de la evaluacion que se pueden EJECUTAR sin montar la pantalla.
 *
 * LO QUE NO ESTA AQUI, Y NO PUEDE ESTAR: corregir. El telefono no recibe cual
 * es la respuesta correcta, asi que aqui no hay forma de saber si alguien
 * acerto. La nota llega del servidor al enviar.
 *
 * Lo que si vive aqui es lo que decide la NAVEGACION del cuestionario —cuando
 * se puede enviar, en que pregunta se esta, cuanto se avanzo— y la traduccion
 * de los fallos.
 */

/**
 * El codigo de error que mando el servidor, si lo mando.
 *
 * Repetido y no importado: este modulo se EJECUTA en las pruebas con el runner
 * de Node, que no entiende el atajo `@/`, y un import de valor tendria que ser
 * relativo y con extension, cosa que este `tsconfig` no acepta.
 */
function codigoDeFallo(fallo: unknown): string | null {
  if (typeof fallo === 'object' && fallo !== null && 'code' in fallo) {
    const code = (fallo as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim() !== '') return code;
  }
  return null;
}

type Traductor = (clave: never, params?: Record<string, string | number>) => string;

/** Lo elegido hasta ahora: {pregunta: alternativa}. */
export type Elegidas = Record<string, string>;

/**
 * Cuantas van respondidas.
 *
 * Se cuenta sobre las PREGUNTAS, no sobre las claves del objeto: una respuesta
 * a una pregunta que ya no esta —porque el autor reescribio la evaluacion entre
 * dos cargas— no puede contar como avance.
 */
export function respondidas(preguntas: readonly { id: string }[], elegidas: Elegidas): number {
  return preguntas.filter((p) => typeof elegidas[p.id] === 'string').length;
}

/**
 * El avance del cuestionario, en entero.
 *
 * A diferencia del avance de un curso, aqui SI se dicen los extremos: cero
 * respondidas es cero, y todas respondidas es cien. No hay nada engañoso en
 * ninguna de las dos cifras.
 */
export function avance(total: number, hechas: number): number {
  if (total <= 0) return 0;
  return Math.round((Math.max(0, Math.min(hechas, total)) * 100) / total);
}

/**
 * Si se puede enviar ya.
 *
 * Hacen falta TODAS. Enviar a medias no es un borrador: el servidor cuenta las
 * no respondidas como falladas y el intento se cierra para siempre, asi que
 * dejar mandarlo por descuido es regalar una nota mas baja.
 */
export function sePuedeEnviar(
  preguntas: readonly { id: string }[],
  elegidas: Elegidas,
): boolean {
  return preguntas.length > 0 && respondidas(preguntas, elegidas) === preguntas.length;
}

/** Cuantas faltan por responder. */
export function faltan(
  preguntas: readonly { id: string }[],
  elegidas: Elegidas,
): number {
  return Math.max(0, preguntas.length - respondidas(preguntas, elegidas));
}

/**
 * Si esta pantalla no existe en esta instalacion (503).
 *
 * No es un error de nadie: la migracion 0058 no esta aplicada. La seccion no se
 * pinta y no se dice nada.
 */
export function evaluacionNoMontada(fallo: unknown): boolean {
  return codigoDeFallo(fallo) === 'course_quiz_not_available';
}

/** Si el curso simplemente no tiene evaluacion. Tampoco es un error. */
export function sinEvaluacion(fallo: unknown): boolean {
  return codigoDeFallo(fallo) === 'course_quiz_not_found';
}

/** Traduce el fallo del servidor a algo que se pueda leer y hacer. */
export function mensajeDeErrorDeEvaluacion(fallo: unknown, t: Traductor): string {
  switch (codigoDeFallo(fallo)) {
    case 'course_quiz_access_required':
      return t('evaluacion.necesitaAcceso' as never);
    case 'quiz_attempt_already_submitted':
      return t('evaluacion.yaEnviado' as never);
    case 'course_quiz_not_found':
      return t('evaluacion.sinEvaluacion' as never);
    case 'course_quiz_not_available':
      return t('evaluacion.noDisponible' as never);
    // Los rechazos del servidor al publicar. Sin esto salía su castellano fijo
    // en una aplicación en inglés, que es justo cuando ocurren: el borrador
    // cambió por debajo y el cálculo local ya no coincide con el suyo.
    case 'quiz_without_questions':
    case 'quiz_prompt_empty':
    case 'quiz_option_count_invalid':
    case 'quiz_option_empty':
    case 'quiz_answer_missing':
      return t(`editorEvaluacion.bloqueo.${codigoDeFallo(fallo)}` as never);
    case 'quiz_multiple_correct':
      return t('editorEvaluacion.bloqueo.quiz_answer_missing' as never);
    case 'quiz_pass_percent_invalid':
      return t('editorEvaluacion.notaInvalida' as never);
    default:
      break;
  }
  if (fallo instanceof Error && fallo.message.trim() !== '') return fallo.message;
  return t('common.tryAgain' as never);
}

/** Traduce el fallo al emitir un certificado. */
export function mensajeDeErrorDeCertificado(fallo: unknown, t: Traductor): string {
  switch (codigoDeFallo(fallo)) {
    case 'certificate_course_not_completed':
      return t('certificado.sinTerminar' as never);
    case 'certificate_access_required':
      return t('certificado.necesitaAcceso' as never);
    case 'certificate_not_found':
      return t('certificado.noEncontrado' as never);
    case 'course_certificates_not_available':
      return t('certificado.noDisponible' as never);
    default:
      break;
  }
  if (fallo instanceof Error && fallo.message.trim() !== '') return fallo.message;
  return t('common.tryAgain' as never);
}

/** Si esta instalacion no tiene certificados montados (503). */
export function certificadosNoMontados(fallo: unknown): boolean {
  return codigoDeFallo(fallo) === 'course_certificates_not_available';
}

/**
 * Que le falta a alguien para terminar el curso, en un codigo.
 *
 * `null` cuando ya esta terminado. Se devuelve un CODIGO y no un texto para
 * que la pantalla lo traduzca; y se mira el contenido ANTES que la evaluacion
 * porque es lo que hay que hacer primero.
 */
export function loQueFalta(estado: {
  terminado: boolean;
  leccionesTotales: number;
  leccionesHechas: number;
  exigeEvaluacion: boolean;
  evaluacionAprobada: boolean;
}): 'lecciones' | 'evaluacion' | null {
  if (estado.terminado) return null;
  if (estado.leccionesHechas < estado.leccionesTotales) return 'lecciones';
  if (estado.exigeEvaluacion && !estado.evaluacionAprobada) return 'evaluacion';
  // Un curso sin lecciones no esta terminado y no falta nada que se pueda
  // hacer: lo que falta es que el curso tenga contenido.
  return 'lecciones';
}
