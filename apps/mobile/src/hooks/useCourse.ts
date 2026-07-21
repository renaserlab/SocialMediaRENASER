import { useCallback, useEffect, useState } from 'react';

import { AuthRepository } from '@/repositories/AuthRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { fetchCourseById } from '@/services/repositories/courses';
import type { Course } from '@/types';

/**
 * Carga un curso por id. La pantalla consume
 * `{ course, lessons, loading, error, reload }` y no sabe si los datos vienen
 * del backend o del modo demo.
 */
export function useCourse(id?: string) {
  const [course, setCourse] = useState<Course | null>(null);
  /** Lecciones en orden; permite abrir la primera real desde "Comenzar". */
  const [lessons, setLessons] = useState<
    Array<{ id: string; title: string; completed: boolean }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setError('Curso no encontrado.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (AuthRepository.enabled) {
        // Una sola llamada trae el curso y su desglose de lecciones.
        const detail = await LearningRepository.getCourseDetail(id);
        setCourse(detail.course);
        setLessons(detail.lessons);
      } else {
        const data = await fetchCourseById(id);
        if (!data) setError('Curso no encontrado.');
        setCourse(data);
        setLessons([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el curso.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  return { course, lessons, loading, error, reload: load };
}
