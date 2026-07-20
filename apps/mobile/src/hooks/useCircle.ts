import { useCallback, useEffect, useState } from 'react';

import { fetchCircleById } from '@/services/repositories/circles';
import type { Circle } from '@/types';

/**
 * Carga un círculo por id a través de la capa de repositorio (mock hoy, backend
 * mañana). La pantalla solo consume `{ circle, loading, error, reload }`.
 */
export function useCircle(id?: string) {
  const [circle, setCircle] = useState<Circle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setError('Círculo no encontrado.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCircleById(id);
      if (!data) {
        setError('Círculo no encontrado.');
      }
      setCircle(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el círculo.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  return { circle, loading, error, reload: load };
}
