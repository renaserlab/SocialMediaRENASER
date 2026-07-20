import { useCallback, useEffect, useState } from 'react';

import { fetchEvents } from '@/services/repositories/events';
import type { EventItem } from '@/types';

/**
 * Lista de eventos a través de la capa de repositorio (mock hoy, backend
 * mañana). Las reservas siguen viviendo en el store; este hook solo se encarga
 * de traer la lista y sus estados de carga.
 */
export function useEvents() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchEvents();
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los eventos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { events, loading, error, reload: load };
}
