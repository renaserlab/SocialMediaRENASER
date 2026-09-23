import { apiRequest, API_V1 } from '@/services/api';

/**
 * Finalizacion de un curso y certificado, contra `/api/v1/learning`.
 *
 * QUIEN DECIDE QUE UN CURSO ESTA TERMINADO ES EL SERVIDOR. Aqui no se calcula
 * ningun porcentaje ni se compara nada: se pregunta. Un cliente que pudiera
 * afirmarlo estaria firmando su propio certificado.
 *
 * SIN LA MIGRACION 0059 APLICADA la emision responde 503 con
 * `course_certificates_not_available`, y la finalizacion se sigue calculando
 * pero llega sin fecha.
 */

const LEARNING = `${API_V1}/learning`;

export type EstadoDeFinalizacion = {
  cursoId: string;
  cursoTitulo: string;
  leccionesTotales: number;
  leccionesHechas: number;
  porcentaje: number;
  /** Si el curso tiene evaluacion final publicada. */
  exigeEvaluacion: boolean;
  mejorNota: number | null;
  evaluacionAprobada: boolean;
  terminado: boolean;
  /** `null` si no esta terminado, o si falta la 0059. */
  terminadoEnIso: string | null;
  /** El codigo del certificado, si ya se emitio. */
  certificadoPublicoId: string | null;
};

export type Certificado = {
  codigo: string;
  cursoId: string;
  cursoTitulo: string;
  nombre: string;
  autor: string;
  versionDelCurso: number | null;
  terminadoEnIso: string;
  emitidoEnIso: string;
  /** 'valid' o 'revoked'. Un revocado SIGUE saliendo: desaparecer sin decir
   * nada es peor que decir que no esta vigente. */
  estado: 'valid' | 'revoked';
  /** La direccion publica de verificacion. La compone el servidor. */
  urlDeVerificacion: string;
};

/** Lo que ve cualquiera con el codigo. Sin sesion y sin datos personales. */
export type VerificacionPublica = {
  codigo: string;
  nombre: string;
  cursoTitulo: string;
  autor: string;
  versionDelCurso: number | null;
  terminadoEnIso: string;
  emitidoEnIso: string;
  estado: 'valid' | 'revoked';
};

type FinalizacionDto = {
  course_id: string;
  course_title?: string | null;
  lessons_total?: number | null;
  lessons_completed?: number | null;
  progress_percent?: number | null;
  quiz_required?: boolean | null;
  quiz_best_score?: number | null;
  quiz_passed?: boolean | null;
  completed?: boolean | null;
  completed_at?: string | null;
  certificate_public_id?: string | null;
};

type CertificadoDto = {
  public_id: string;
  course_id: string;
  course_title: string;
  display_name: string;
  author_name?: string | null;
  course_version?: number | null;
  completed_at: string;
  issued_at: string;
  status?: string | null;
  verify_url: string;
};

type VerificacionDto = Omit<CertificadoDto, 'course_id' | 'verify_url'>;

function aFinalizacion(dto: FinalizacionDto): EstadoDeFinalizacion {
  return {
    cursoId: dto.course_id,
    cursoTitulo: dto.course_title ?? '',
    leccionesTotales: dto.lessons_total ?? 0,
    leccionesHechas: dto.lessons_completed ?? 0,
    porcentaje: dto.progress_percent ?? 0,
    exigeEvaluacion: dto.quiz_required === true,
    mejorNota: dto.quiz_best_score ?? null,
    evaluacionAprobada: dto.quiz_passed === true,
    // `=== true` y no `?? false`: un campo ausente NO es un curso terminado.
    terminado: dto.completed === true,
    terminadoEnIso: dto.completed_at ?? null,
    certificadoPublicoId: dto.certificate_public_id ?? null,
  };
}

const revocado = (estado?: string | null) =>
  estado === 'revoked' ? ('revoked' as const) : ('valid' as const);

function aCertificado(dto: CertificadoDto): Certificado {
  return {
    codigo: dto.public_id,
    cursoId: dto.course_id,
    cursoTitulo: dto.course_title,
    nombre: dto.display_name,
    autor: dto.author_name ?? '',
    versionDelCurso: dto.course_version ?? null,
    terminadoEnIso: dto.completed_at,
    emitidoEnIso: dto.issued_at,
    estado: revocado(dto.status),
    urlDeVerificacion: dto.verify_url,
  };
}

export const CertificateRepository = {
  /** Si este curso esta terminado, y que falta si no lo esta. */
  async finalizacion(cursoId: string): Promise<EstadoDeFinalizacion> {
    return aFinalizacion(
      await apiRequest<FinalizacionDto>(`${LEARNING}/courses/${cursoId}/completion`),
    );
  },

  /**
   * Emitir el certificado. Idempotente: la segunda llamada devuelve el mismo.
   *
   * Responde 422 `certificate_course_not_completed` si el curso no esta
   * terminado, y 403 si el acceso ya no esta vigente.
   */
  async emitir(cursoId: string): Promise<Certificado> {
    return aCertificado(
      await apiRequest<CertificadoDto>(`${LEARNING}/courses/${cursoId}/certificate`, {
        method: 'POST',
      }),
    );
  },

  /** Los mios, del mas reciente al mas viejo. Los revocados tambien. */
  async mios(): Promise<Certificado[]> {
    const dtos = await apiRequest<CertificadoDto[]>(`${LEARNING}/me/certificates`);
    return (dtos ?? []).map(aCertificado);
  },

  /** Verificacion publica por codigo. NO pide sesion. */
  async verificar(codigo: string): Promise<VerificacionPublica> {
    const dto = await apiRequest<VerificacionDto>(
      `${LEARNING}/certificates/${encodeURIComponent(codigo)}`,
      { auth: false },
    );
    return {
      codigo: dto.public_id,
      nombre: dto.display_name,
      cursoTitulo: dto.course_title,
      autor: dto.author_name ?? '',
      versionDelCurso: dto.course_version ?? null,
      terminadoEnIso: dto.completed_at,
      emitidoEnIso: dto.issued_at,
      estado: revocado(dto.status),
    };
  },
};
