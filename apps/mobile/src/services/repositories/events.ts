import { mockDelay } from '@/services/repositories/_delay';
import { events as mockEvents } from '@/data/mockData';
import { isSupabaseConfigured, supabase } from '@/services/supabase';
import type { EventItem } from '@/types';

/**
 * Fuente única de la verdad para los eventos.
 *
 * HOY (sin backend): datos mock tras una latencia simulada.
 * MAÑANA (backend): al configurar Supabase se consulta la tabla `events`.
 *
 * Ni las pantallas ni el store deben saber de dónde salen los eventos.
 */
export async function fetchEvents(): Promise<EventItem[]> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    return mockEvents;
  }

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .order('date', { ascending: true });
  if (error) {
    throw new Error(error.message);
  }

  // TODO(backend): mapear la fila de Supabase al tipo `EventItem` (acordar shape en src/types).
  return (data ?? []) as unknown as EventItem[];
}
