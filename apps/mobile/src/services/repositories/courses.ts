import { mockDelay } from '@/services/repositories/_delay';
import { course } from '@/data/mockData';
import { AuthRepository } from '@/repositories/AuthRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import type { Course } from '@/types';

/**
 * Fuente única de la verdad para los cursos.
 *
 * Antes se consultaba Supabase directamente y la fila se devolvía con un
 * `as unknown as Course[]`: ese cast desactivaba el chequeo de tipos, así que
 * llegaba snake_case (price_minor, ...) donde la vista esperaba camelCase.
 * Ahora se pasa por el backend, que ya entrega el modelo mapeado.
 *
 * Sin backend configurado se mantiene el curso de demo para no romper la
 * navegación.
 */
const backendEnabled = AuthRepository.enabled;

export async function fetchCourses(): Promise<Course[]> {
  if (!backendEnabled) {
    await mockDelay();
    return [course];
  }
  return LearningRepository.listCourses();
}

export async function fetchCourseById(id: string): Promise<Course | null> {
  if (!backendEnabled) {
    await mockDelay();
    const all = [course];
    // Demo: si el id no coincide (p. ej. desde la galería /dev), caemos al único
    // curso mock para que la pantalla siga siendo navegable.
    return all.find((c) => c.id === id) ?? all[0] ?? null;
  }

  const detail = await LearningRepository.getCourseDetail(id);
  return detail.course;
}
