import { useCallback, useEffect, useState } from 'react';

import { fetchLessonById } from '@/services/repositories/lessons';
import type { Lesson } from '@/types';

/**
 * Carga una lección por id a través de la capa de repositorio (mock hoy, backend
 * mañana). La pantalla solo consume `{ lesson, loading, error, reload }`.
 */
export function useLesson(id?: string) {
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setError('Lección no encontrada.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLessonById(id);
      if (!data) {
        setError('Lección no encontrada.');
      }
      setLesson(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la lección.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  return { lesson, loading, error, reload: load };
}
