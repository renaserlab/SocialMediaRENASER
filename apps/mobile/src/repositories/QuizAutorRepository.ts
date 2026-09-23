import { apiRequest, API_V1 } from '@/services/api';

const LEARNING = `${API_V1}/learning`;

/**
 * El lado de QUIEN ESCRIBE la evaluacion. Aqui SI viaja `is_correct`: es lo
 * que se esta editando. El servidor solo lo entrega a quien puede administrar
 * el curso —autor o administracion con poder real, nunca moderacion— y no sale
 * jamas por el contrato del alumno.
 */
export type AlternativaDeAutor = {
  /** Sin id mientras no se ha guardado: el servidor los crea al escribir. */
  id?: string;
  texto: string;
  esCorrecta: boolean;
};

export type PreguntaDeAutor = {
  id?: string;
  enunciado: string;
  alternativas: AlternativaDeAutor[];
};

export type BorradorDeEvaluacion = {
  id: string;
  cursoId: string;
  titulo: string;
  notaMinima: number;
  estado: 'draft' | 'published';
  preguntas: PreguntaDeAutor[];
  /** Por que todavia no se puede publicar, o `null`. Lo decide el servidor. */
  motivoDeBloqueo: string | null;
};

type BorradorDto = {
  id: string;
  course_id: string;
  title?: string | null;
  pass_percent?: number | null;
  status?: string | null;
  questions?: Array<{
    id: string;
    prompt: string;
    options?: Array<{ id: string; body: string; is_correct?: boolean | null }> | null;
  }> | null;
  blocking_reason?: string | null;
};

function aBorrador(dto: BorradorDto): BorradorDeEvaluacion {
  return {
    id: dto.id,
    cursoId: dto.course_id,
    titulo: dto.title ?? '',
    notaMinima: dto.pass_percent ?? 70,
    estado: dto.status === 'published' ? 'published' : 'draft',
    preguntas: (dto.questions ?? []).map((p) => ({
      id: p.id,
      enunciado: p.prompt,
      alternativas: (p.options ?? []).map((o) => ({
        id: o.id,
        texto: o.body,
        esCorrecta: o.is_correct === true,
      })),
    })),
    motivoDeBloqueo: dto.blocking_reason ?? null,
  };
}

function cuerpoDelBorrador(borrador: {
  titulo: string;
  notaMinima: number;
  preguntas: PreguntaDeAutor[];
}): string {
  return JSON.stringify({
    title: borrador.titulo,
    pass_percent: borrador.notaMinima,
    questions: borrador.preguntas.map((p) => ({
      prompt: p.enunciado,
      options: p.alternativas.map((a) => ({ body: a.texto, is_correct: a.esCorrecta })),
    })),
  });
}

export const QuizAutorRepository = {
  /** El borrador CON las respuestas correctas. Solo quien administra el curso. */
  async borrador(cursoId: string): Promise<BorradorDeEvaluacion> {
    return aBorrador(
      await apiRequest<BorradorDto>(`${LEARNING}/courses/${cursoId}/quiz/draft`),
    );
  },

  /**
   * Guardar la evaluacion ENTERA.
   *
   * Se reemplaza completa a proposito: media evaluacion guardada —preguntas
   * nuevas con las alternativas viejas— es peor que ninguna. Y si estaba
   * publicada y lo que se guarda no se puede publicar, el servidor la devuelve
   * a borrador para que el curso no se quede sin poder terminarse.
   */
  async guardar(
    cursoId: string,
    borrador: { titulo: string; notaMinima: number; preguntas: PreguntaDeAutor[] },
  ): Promise<BorradorDeEvaluacion> {
    return aBorrador(
      await apiRequest<BorradorDto>(`${LEARNING}/courses/${cursoId}/quiz`, {
        method: 'PUT',
        body: cuerpoDelBorrador(borrador),
      }),
    );
  },

  /** Ponerla delante del alumno. El servidor vuelve a comprobar que se puede. */
  async publicar(cursoId: string): Promise<BorradorDeEvaluacion> {
    return aBorrador(
      await apiRequest<BorradorDto>(`${LEARNING}/courses/${cursoId}/quiz/publish`, {
        method: 'POST',
      }),
    );
  },
};
