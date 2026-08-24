import { useCallback, useEffect, useState } from 'react';

import { AuthRepository } from '@/repositories/AuthRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { fetchCourseById, resolveCourseId } from '@/services/repositories/courses';
import type { LessonSummary } from '@/repositories/LearningRepository';
import type { Course } from '@/types';

/**
 * Carga un curso por id. La pantalla consume
 * `{ course, lessons, loading, error, reload }` y no sabe si los datos vienen
 * del backend o del modo demo.
 */
export function useCourse(id?: string) {
  const [course, setCourse] = useState<Course | null>(null);
  /** Lecciones en orden; permite abrir la primera real desde "Comenzar". */
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  /**
   * Si quien mira puede EDITAR el curso. Lo dice el servidor.
   *
   * Antes la pantalla usaba `isAdmin`, asi que quien creaba un curso no podia
   * gestionarlo: podia crear modulos por la base de datos pero no veia un solo
   * boton. Deducirlo aqui tampoco valia, porque el detalle no devolvia
   * `author_id`.
   */
  const [canManage, setCanManage] = useState(false);
  /** Si puede ver el contenido de pago. Tambien lo decide el servidor. */
  const [hasAccess, setHasAccess] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
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
        const detail = await LearningRepository.getCourseDetail(await resolveCourseId(id));
        setCourse(detail.course);
        setLessons(detail.lessons);
        setCanManage(detail.canManage);
        setHasAccess(detail.hasAccess);
        setProgressPercent(detail.progressPercent);
      } else {
        const data = await fetchCourseById(id);
        if (!data) setError('Curso no encontrado.');
        setCourse(data);
        setLessons([]);
        setCanManage(false);
        setHasAccess(true);
        setProgressPercent(0);
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

  return {
    course,
    lessons,
    canManage,
    hasAccess,
    progressPercent,
    loading,
    error,
    reload: load,
  };
}
