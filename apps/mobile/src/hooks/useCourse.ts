import { useCallback, useEffect, useState } from 'react';

import { fetchCourseById } from '@/services/repositories/courses';
import type { Course } from '@/types';

/**
 * Carga un curso por id a través de la capa de repositorio (mock hoy, backend
 * mañana). La pantalla solo consume `{ course, loading, error, reload }` y no
 * sabe de dónde vienen los datos.
 */
export function useCourse(id?: string) {
  const [course, setCourse] = useState<Course | null>(null);
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
      const data = await fetchCourseById(id);
      if (!data) {
        setError('Curso no encontrado.');
      }
      setCourse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el curso.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  return { course, loading, error, reload: load };
}
