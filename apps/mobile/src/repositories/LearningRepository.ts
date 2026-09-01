import { apiRequest, API_V1 } from '@/services/api';
import { signMediaUrls } from '@/services/storage';
import {
  CourseDetailDto,
  CourseDto,
  LessonDetailDto,
  MyCourseDto,
  toCourseFromDetail,
  toCourseFromSummary,
  toLesson,
  toMyCourse,
} from '@/mappers/learningMapper';
import type { Course, Lesson, MyCourse } from '@/types';

/** Una leccion dentro del temario, con lo que hace falta para retomarla. */
export type LessonSummary = {
  id: string;
  title: string;
  completed: boolean;
  /** Por donde iba. Es lo que permite abrir el video donde se dejo. */
  progressSeconds: number;
  durationSeconds: number;
};

/** Detalle del curso con su desglose, sin exponer los DTO a las vistas. */
export type CourseDetail = {
  course: Course;
  enrolled: boolean;
  /** Si puede ver el contenido de pago. Lo decide el servidor. */
  hasAccess: boolean;
  /**
   * Si puede editar el curso: su autor o la administracion.
   *
   * Viene del SERVIDOR y no se deduce aqui. Antes la pantalla usaba solo
   * `isAdmin`, asi que quien creaba un curso no podia gestionarlo. Y esconder
   * un boton no es seguridad: el servidor vuelve a comprobarlo en cada
   * escritura.
   */
  canManage: boolean;
  progressPercent: number;
  /**
   * La duracion del curso entero, en segundos y sumada por el SERVIDOR.
   *
   * La aplicacion podia sumarla sola, pero entonces la ficha y la vista previa
   * del asistente sumarian por su cuenta y un dia dirian cosas distintas.
   */
  durationSecondsTotal: number;
  /** Lecciones en orden, aplanadas de todos los modulos. */
  lessons: LessonSummary[];
};

/**
 * El acceso gratuito de la BETA para un curso concreto, segun el SERVIDOR.
 *
 * El interruptor vive en el backend (`BETA_FREE_ACCESS_ENABLED`) y no aqui: asi
 * apagarlo hace desaparecer el boton sin publicar una version nueva de la
 * aplicacion, y ninguna pantalla puede conceder por su cuenta lo que el
 * servidor ya no concede.
 */
export type AccesoDeBeta = {
  /** Si el modo esta encendido en el servidor. */
  enabled: boolean;
  /** Si a ESTE curso se le puede pedir ahora mismo. */
  available: boolean;
  /** Si ya se tiene acceso, por la beta o por lo que sea. */
  hasAccess: boolean;
};

/** Lo que devuelve guardar progreso. */
export type ProgresoGuardado = {
  lessonId: string;
  progressSeconds: number;
  completed: boolean;
  courseCompleted: boolean;
  courseProgressPercent: number;
};

/** Lo que el creador manda al guardar la ficha de un curso. */
export type DatosDeCurso = {
  title?: string;
  description?: string;
  /** SIEMPRE en la unidad menor. Ver `lib/dinero.ts`. */
  priceMinor?: number;
  currency?: string;
  coverPath?: string | null;
  topicIds?: string[];
  comingSoon?: boolean;

  // --- Ficha ampliada (0034). El servidor los acepta siempre; si la migración
  // no está aplicada NO los guarda, y el resto del curso se guarda igual.
  subtitle?: string | null;
  promoVideoPath?: string | null;
  /** Categoría principal. Cuenta también como tema, y va la primera. */
  primaryTopicId?: string | null;
  language?: string;
  level?: string | null;
  /** Lo que aprenderás: es `courses.highlights`, no una columna nueva. */
  highlights?: string[];
  targetAudience?: string[];
  prerequisites?: string[];
};

function cuerpoDeCurso(datos: DatosDeCurso): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (datos.title !== undefined) payload.title = datos.title;
  if (datos.description !== undefined) payload.description = datos.description;
  // `price_minor` y no `price`: el contrato viejo no podia expresar 49.90.
  if (datos.priceMinor !== undefined) payload.price_minor = datos.priceMinor;
  if (datos.currency !== undefined) payload.currency = datos.currency;
  if (datos.coverPath !== undefined) payload.cover_path = datos.coverPath;
  if (datos.topicIds !== undefined) payload.topic_ids = datos.topicIds;
  if (datos.comingSoon !== undefined) payload.coming_soon = datos.comingSoon;
  if (datos.subtitle !== undefined) payload.subtitle = datos.subtitle;
  if (datos.promoVideoPath !== undefined) payload.promo_video_path = datos.promoVideoPath;
  if (datos.primaryTopicId !== undefined) payload.primary_topic_id = datos.primaryTopicId;
  if (datos.language !== undefined) payload.language = datos.language;
  if (datos.level !== undefined) payload.level = datos.level;
  if (datos.highlights !== undefined) payload.highlights = datos.highlights;
  if (datos.targetAudience !== undefined) payload.target_audience = datos.targetAudience;
  if (datos.prerequisites !== undefined) payload.prerequisites = datos.prerequisites;
  return payload;
}

/** Lo que le falta a un curso para poder publicarse. Lo decide el SERVIDOR. */
export type RequisitosDeCurso = {
  status: string;
  reviewStatus: string;
  ready: boolean;
  /** Frases para enseñar tal cual. Vacío cuando no falta nada. */
  missing: string[];
  /**
   * Si esta base sabe de revisión.
   *
   * Sin la 0034 no hay a quién enviar nada, así que la pantalla ofrece
   * «Publicar» y no «Enviar a revisión». Nunca un botón que responda 503.
   */
  reviewAvailable: boolean;
};

async function firmarPortadas(courses: Course[]): Promise<Course[]> {
  const paths = courses.map((c) => c.coverPath).filter((p): p is string => !!p);
  if (paths.length > 0) {
    const urls = await signMediaUrls(paths);
    courses.forEach((course) => {
      if (course.coverPath) course.coverUrl = urls[course.coverPath];
    });
  }
  return courses;
}

/**
 * Cursos y lecciones a traves del backend FastAPI.
 *
 * Sustituye a las consultas sueltas contra Supabase de
 * `services/repositories/*`, que apuntaban a una tabla `lessons` inexistente
 * (se llama `course_lessons`) y devolvian la fila sin mapear.
 */
export const LearningRepository = {
  /** El catalogo publico: SOLO cursos publicados. */
  /**
   * El catálogo público.
   *
   * @param limite cuántos traer. Sin indicarlo NO se manda el parámetro y el
   *   servidor decide, que es lo que pasaba antes: hay quien lo llama para
   *   filtrar por autor en el cliente y necesita la lista entera.
   */
  async listCourses(limite?: number): Promise<Course[]> {
    const consulta = limite ? `?limit=${limite}` : '';
    const dtos = await apiRequest<CourseDto[]>(`${API_V1}/catalog/courses${consulta}`, {
      auth: false,
    });
    return firmarPortadas(dtos.map(toCourseFromSummary));
  },

  /**
   * Los cursos de quien pregunta, en cualquier estado.
   *
   * Es la contraparte de que crear ya no publique: sin este listado un curso
   * recien creado no aparecia en ninguna pantalla y parecia no haberse
   * guardado.
   */
  async listMine(): Promise<Course[]> {
    const dtos = await apiRequest<CourseDto[]>(`${API_V1}/catalog/courses/mine`);
    return firmarPortadas(dtos.map(toCourseFromSummary));
  },

  /** Crea la ficha de un curso. Nace como BORRADOR. */
  async createCourse(datos: DatosDeCurso): Promise<Course> {
    const dto = await apiRequest<CourseDto>(`${API_V1}/catalog/courses`, {
      method: 'POST',
      body: JSON.stringify(cuerpoDeCurso(datos)),
    });
    return toCourseFromSummary(dto);
  },

  /** Edita un curso. Solo su autor o la administracion (lo verifica el backend). */
  async updateCourse(courseId: string, cambios: DatosDeCurso): Promise<Course> {
    const dto = await apiRequest<CourseDto>(`${API_V1}/catalog/courses/${courseId}`, {
      method: 'PATCH',
      body: JSON.stringify(cuerpoDeCurso(cambios)),
    });
    return toCourseFromSummary(dto);
  },

  /**
   * Publica el curso, si esta terminado.
   *
   * No lanza cuando falta algo: devuelve `published: false` y la lista de lo
   * que falta, que es lo unico util que se le puede ensenar a quien publica.
   */
  async publish(
    courseId: string,
  ): Promise<{ published: boolean; status: string; missing: string[] }> {
    return apiRequest(`${API_V1}/catalog/courses/${courseId}/publish`, {
      method: 'POST',
    });
  },

  /**
   * Que le falta al curso, SIN cambiar nada.
   *
   * Las reglas viven en el servidor y esta llamada solo las lee: repetirlas
   * aqui garantiza que un dia la pantalla diga que todo esta listo y el
   * servidor diga que no.
   */
  async requirements(courseId: string): Promise<RequisitosDeCurso> {
    const dto = await apiRequest<{
      status: string;
      review_status: string;
      ready: boolean;
      missing: string[];
      review_available: boolean;
    }>(`${API_V1}/catalog/courses/${courseId}/requirements`);
    return {
      status: dto.status,
      reviewStatus: dto.review_status,
      ready: dto.ready,
      missing: dto.missing ?? [],
      reviewAvailable: dto.review_available ?? false,
    };
  },

  /**
   * Pide que administración mire el curso.
   *
   * Como al publicar, cuando falta algo NO lanza: devuelve `submitted: false` y
   * la lista entera de lo que falta, que es lo único útil.
   */
  async submitForReview(
    courseId: string,
  ): Promise<{ submitted: boolean; reviewStatus: string; missing: string[] }> {
    const dto = await apiRequest<{
      submitted: boolean;
      review_status: string;
      missing: string[];
    }>(`${API_V1}/catalog/courses/${courseId}/submit`, { method: 'POST' });
    return {
      submitted: dto.submitted,
      reviewStatus: dto.review_status,
      missing: dto.missing ?? [],
    };
  },

  /** La bandeja de administración: cursos esperando revisión. */
  async reviewQueue(): Promise<Course[]> {
    const dtos = await apiRequest<CourseDto[]>(
      `${API_V1}/catalog/courses/review-queue?limit=50`,
    );
    return firmarPortadas(dtos.map(toCourseFromSummary));
  },

  /**
   * Aprueba o rechaza. Solo administración, y lo impone el backend contra
   * `profiles.role`: esconder el botón no es el permiso.
   *
   * Aprobar NO publica. La decisión de estar en el catálogo sigue siendo de
   * quien creó el curso.
   */
  async review(courseId: string, decision: 'approve' | 'reject', reason?: string): Promise<Course> {
    const dto = await apiRequest<CourseDto>(
      `${API_V1}/catalog/courses/${courseId}/review`,
      { method: 'POST', body: JSON.stringify({ decision, reason: reason ?? null }) },
    );
    return toCourseFromSummary(dto);
  },

  /** Retira el curso del catalogo sin borrar nada. */
  async unpublish(courseId: string): Promise<Course> {
    const dto = await apiRequest<CourseDto>(
      `${API_V1}/catalog/courses/${courseId}/unpublish`,
      { method: 'POST' },
    );
    return toCourseFromSummary(dto);
  },

  async getCourseDetail(courseId: string): Promise<CourseDetail> {
    const dto = await apiRequest<CourseDetailDto>(
      `${API_V1}/learning/courses/${courseId}`,
    );
    const lessons: LessonSummary[] = (dto.modules ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .flatMap((module) =>
        (module.lessons ?? [])
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((lesson) => ({
            id: lesson.id,
            title: lesson.title,
            completed: lesson.completed,
            progressSeconds: lesson.progress_seconds ?? 0,
            durationSeconds: lesson.duration_seconds ?? 0,
          })),
      );
    const course = toCourseFromDetail(dto);
    // La portada se guarda como RUTA en el bucket privado post-media (es donde
    // la sube CreateCatalogSheet), asi que hay que firmarla para poder verla.
    if (course.coverPath) {
      const urls = await signMediaUrls([course.coverPath]);
      course.coverUrl = urls[course.coverPath];
    }

    return {
      course,
      enrolled: dto.enrolled ?? false,
      hasAccess: dto.has_access ?? false,
      canManage: dto.can_manage ?? false,
      progressPercent: dto.progress_percent ?? 0,
      durationSecondsTotal:
        dto.duration_seconds_total ??
        // Respaldo para un backend anterior a la 0034: si el servidor no la
        // manda, se suma lo que hay. Es la misma cuenta, hecha aqui.
        lessons.reduce((total, l) => total + (l.durationSeconds ?? 0), 0),
      lessons,
    };
  },

  async getLesson(lessonId: string): Promise<Lesson> {
    const dto = await apiRequest<LessonDetailDto>(
      `${API_V1}/learning/lessons/${lessonId}`,
    );
    return toLesson(dto);
  },

  async enroll(courseId: string): Promise<void> {
    await apiRequest(`${API_V1}/learning/courses/${courseId}/enroll`, {
      method: 'POST',
    });
  },

  /** Si este curso se puede pedir gratis durante la Beta. Lo decide el servidor. */
  async betaAccess(courseId: string): Promise<AccesoDeBeta> {
    const dto = await apiRequest<{
      enabled?: boolean;
      available?: boolean;
      has_access?: boolean;
    }>(`${API_V1}/learning/courses/${courseId}/beta-access`);
    return {
      enabled: dto.enabled ?? false,
      available: dto.available ?? false,
      hasAccess: dto.has_access ?? false,
    };
  },

  /**
   * Pide el acceso gratuito de la Beta. NO ES UNA COMPRA: no hay cobro, no hay
   * transaccion y el precio del curso no cambia.
   *
   * Repetirlo no concede dos veces: el servidor lo asegura con un indice unico,
   * asi que reintentar cuando se cae la red es seguro.
   */
  async grantBetaAccess(courseId: string): Promise<void> {
    await apiRequest(`${API_V1}/learning/courses/${courseId}/beta-access`, {
      method: 'POST',
    });
  },

  /**
   * Guarda por donde va esta persona.
   *
   * Es idempotente a proposito: mandarlo dos veces deja el mismo estado, que
   * es lo que permite reintentar sin miedo cuando se cae la red.
   */
  async saveProgress(
    lessonId: string,
    progressSeconds: number,
    completed = false,
  ): Promise<ProgresoGuardado> {
    const dto = await apiRequest<{
      lesson_id: string;
      progress_seconds: number;
      completed: boolean;
      course_completed: boolean;
      course_progress_percent: number;
    }>(`${API_V1}/learning/lessons/${lessonId}/progress`, {
      method: 'PUT',
      body: JSON.stringify({
        progress_seconds: Math.max(0, Math.round(progressSeconds)),
        completed,
      }),
    });
    return {
      lessonId: dto.lesson_id,
      progressSeconds: dto.progress_seconds,
      completed: dto.completed,
      courseCompleted: dto.course_completed,
      courseProgressPercent: dto.course_progress_percent,
    };
  },

  /**
   * La biblioteca, desde el SERVIDOR.
   *
   * Antes salia de `purchasedCourseIds`, una lista guardada en el telefono:
   * se vaciaba al reinstalar, no se compartia entre dispositivos y podia
   * ensenar un curso al que ya no se tiene acceso.
   */
  async myCourses(): Promise<MyCourse[]> {
    const dtos = await apiRequest<MyCourseDto[]>(`${API_V1}/learning/me/courses`);
    const cursos = dtos.map(toMyCourse);
    const paths = cursos.map((c) => c.coverPath).filter((p): p is string => !!p);
    if (paths.length > 0) {
      const urls = await signMediaUrls(paths);
      cursos.forEach((curso) => {
        if (curso.coverPath) curso.coverUrl = urls[curso.coverPath];
      });
    }
    return cursos;
  },
};
