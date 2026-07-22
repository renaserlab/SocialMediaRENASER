import { mockDelay } from '@/services/repositories/_delay';
import { lessons } from '@/data/mockData';
import { AuthRepository } from '@/repositories/AuthRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import type { Lesson } from '@/types';

/**
 * Fuente única de la verdad para las lecciones.
 *
 * Antes se consultaba `supabase.from('lessons')`, una tabla que NO existe: la
 * real es `course_lessons`. Con Supabase configurado la pantalla siempre
 * fallaba. Ahora se pasa por el backend, que además resuelve el progreso.
 */
const backendEnabled = AuthRepository.enabled;

export async function fetchLessonsByCourse(courseId: string): Promise<Lesson[]> {
  if (!backendEnabled) {
    await mockDelay();
    return lessons.filter((lesson) => lesson.courseId === courseId);
  }

  // El detalle del curso ya trae sus lecciones en orden.
  const detail = await LearningRepository.getCourseDetail(courseId);
  return Promise.all(detail.lessons.map((item) => LearningRepository.getLesson(item.id)));
}

export async function fetchLessonById(id: string): Promise<Lesson | null> {
  if (!backendEnabled) {
    await mockDelay();
    // Demo: si el id no coincide (p. ej. desde la galería /dev), caemos a la
    // primera lección para que la pantalla siga siendo navegable.
    return lessons.find((lesson) => lesson.id === id) ?? lessons[0] ?? null;
  }

  return LearningRepository.getLesson(id);
}
