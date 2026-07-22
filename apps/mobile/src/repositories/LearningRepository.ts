import { apiRequest, API_V1 } from '@/services/api';
import {
  CourseDetailDto,
  CourseDto,
  LessonDetailDto,
  toCourseFromDetail,
  toCourseFromSummary,
  toLesson,
} from '@/mappers/learningMapper';
import type { Course, Lesson } from '@/types';

/** Detalle del curso con su desglose, sin exponer los DTO a las vistas. */
export type CourseDetail = {
  course: Course;
  enrolled: boolean;
  progressPercent: number;
  /** Lecciones en orden, aplanadas de todos los modulos. */
  lessons: Array<{ id: string; title: string; completed: boolean }>;
};

/**
 * Cursos y lecciones a traves del backend FastAPI.
 *
 * Sustituye a las consultas sueltas contra Supabase de
 * `services/repositories/*`, que apuntaban a una tabla `lessons` inexistente
 * (se llama `course_lessons`) y devolvian la fila sin mapear.
 */
export const LearningRepository = {
  async listCourses(): Promise<Course[]> {
    const dtos = await apiRequest<CourseDto[]>(`${API_V1}/catalog/courses`, {
      auth: false,
    });
    return dtos.map(toCourseFromSummary);
  },

  /** Publica un curso. Solo administradores (lo comprueba el backend). */
  async createCourse(input: {
    title: string;
    description: string;
    price: number;
    currency: string;
    coverPath?: string | null;
  }): Promise<Course> {
    const dto = await apiRequest<CourseDto>(`${API_V1}/catalog/courses`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        price: input.price,
        currency: input.currency,
        cover_path: input.coverPath ?? null,
      }),
    });
    return toCourseFromSummary(dto);
  },

  async getCourseDetail(courseId: string): Promise<CourseDetail> {
    const dto = await apiRequest<CourseDetailDto>(
      `${API_V1}/learning/courses/${courseId}`,
    );
    const lessons = (dto.modules ?? [])
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
          })),
      );
    return {
      course: toCourseFromDetail(dto),
      enrolled: dto.enrolled ?? false,
      progressPercent: dto.progress_percent ?? 0,
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

  async completeLesson(lessonId: string): Promise<void> {
    await apiRequest(`${API_V1}/learning/lessons/${lessonId}/complete`, {
      method: 'POST',
    });
  },
};
