import { apiRequest, API_V1 } from '@/services/api';

/**
 * La evaluacion final de un curso, contra `/api/v1/learning`.
 *
 * LO QUE ESTE FICHERO NO SABE, y no puede saber: cual es la respuesta correcta.
 * El servidor no la manda mientras el intento esta abierto, asi que aqui no hay
 * forma de corregir nada ni de adelantar el resultado. La nota llega al enviar,
 * calculada alli.
 *
 * TAMPOCO decide quien puede: hace falta acceso vigente al curso, y eso lo
 * comprueba el servidor en cada llamada.
 *
 * SIN LA MIGRACION 0058 APLICADA todo esto responde 503 con
 * `course_quiz_not_available`. No se traga aqui: quien pinta necesita
 * distinguirlo para no ensenar la seccion.
 */

const LEARNING = `${API_V1}/learning`;

/** Una alternativa. NO lleva si es la correcta: el servidor no la manda. */
export type AlternativaDeEvaluacion = {
  id: string;
  texto: string;
};

export type PreguntaDeEvaluacion = {
  id: string;
  enunciado: string;
  alternativas: AlternativaDeEvaluacion[];
};

/** Un intento. La nota y el aprobado los pone el SERVIDOR. */
export type IntentoDeEvaluacion = {
  id: string;
  estado: 'in_progress' | 'submitted';
  /** `null` mientras no se envia: un 0 diria «lo hizo y saco cero». */
  nota: number | null;
  aprobado: boolean | null;
  empezadoEnIso: string;
  enviadoEnIso: string | null;
  versionDelCurso: number | null;
};

export type EvaluacionDeCurso = {
  id: string;
  cursoId: string;
  titulo: string;
  notaMinima: number;
  preguntas: PreguntaDeEvaluacion[];
  /** El intento a medias, si lo hay. Es lo que permite retomar. */
  intentoAbierto: IntentoDeEvaluacion | null;
  /** El mejor enviado. Es el que cuenta para terminar el curso. */
  mejorIntento: IntentoDeEvaluacion | null;
};

type IntentoDto = {
  id: string;
  status: string;
  score_percent?: number | null;
  passed?: boolean | null;
  started_at: string;
  submitted_at?: string | null;
  course_version?: number | null;
};

type EvaluacionDto = {
  id: string;
  course_id: string;
  title?: string | null;
  pass_percent?: number | null;
  questions?: Array<{
    id: string;
    prompt: string;
    options?: Array<{ id: string; body: string }> | null;
  }> | null;
  open_attempt?: IntentoDto | null;
  best_attempt?: IntentoDto | null;
};

function aIntento(dto: IntentoDto): IntentoDeEvaluacion {
  return {
    id: dto.id,
    estado: dto.status === 'submitted' ? 'submitted' : 'in_progress',
    // `?? null` y no `?? 0`: cero es una nota real y no es lo mismo que «sin
    // nota todavia».
    nota: dto.score_percent ?? null,
    aprobado: dto.passed ?? null,
    empezadoEnIso: dto.started_at,
    enviadoEnIso: dto.submitted_at ?? null,
    versionDelCurso: dto.course_version ?? null,
  };
}

function aEvaluacion(dto: EvaluacionDto): EvaluacionDeCurso {
  return {
    id: dto.id,
    cursoId: dto.course_id,
    titulo: dto.title ?? '',
    notaMinima: dto.pass_percent ?? 70,
    preguntas: (dto.questions ?? []).map((p) => ({
      id: p.id,
      enunciado: p.prompt,
      alternativas: (p.options ?? []).map((o) => ({ id: o.id, texto: o.body })),
    })),
    intentoAbierto: dto.open_attempt ? aIntento(dto.open_attempt) : null,
    mejorIntento: dto.best_attempt ? aIntento(dto.best_attempt) : null,
  };
}

export const QuizRepository = {
  /** La evaluacion publicada, sin soluciones. */
  async obtener(cursoId: string): Promise<EvaluacionDeCurso> {
    return aEvaluacion(
      await apiRequest<EvaluacionDto>(`${LEARNING}/courses/${cursoId}/quiz`),
    );
  },

  /**
   * Empezar, o retomar el que ya estaba abierto.
   *
   * Dos toques no abren dos intentos: el servidor devuelve el mismo, y lo
   * sostiene un indice unico parcial.
   */
  async empezar(cursoId: string): Promise<IntentoDeEvaluacion> {
    return aIntento(
      await apiRequest<IntentoDto>(`${LEARNING}/courses/${cursoId}/quiz/attempts`, {
        method: 'POST',
      }),
    );
  },

  /**
   * Enviar. La nota llega de vuelta; no se calcula aqui.
   *
   * Un intento ya enviado responde 409 `quiz_attempt_already_submitted`: no se
   * puede reenviar para ir probando respuestas.
   */
  async enviar(
    intentoId: string,
    respuestas: Array<{ preguntaId: string; alternativaId: string }>,
  ): Promise<IntentoDeEvaluacion> {
    return aIntento(
      await apiRequest<IntentoDto>(`${LEARNING}/quiz-attempts/${intentoId}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          answers: respuestas.map((r) => ({
            question_id: r.preguntaId,
            option_id: r.alternativaId,
          })),
        }),
      }),
    );
  },

  /** Mis intentos, del mas reciente al mas viejo. */
  async historial(cursoId: string): Promise<IntentoDeEvaluacion[]> {
    const dtos = await apiRequest<IntentoDto[]>(
      `${LEARNING}/courses/${cursoId}/quiz/attempts`,
    );
    return (dtos ?? []).map(aIntento);
  },
};
