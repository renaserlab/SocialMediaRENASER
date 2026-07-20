import { mockDelay } from '@/services/repositories/_delay';
import { circle } from '@/data/mockData';
import { isSupabaseConfigured, supabase } from '@/services/supabase';
import type { Circle } from '@/types';

/**
 * Fuente única de la verdad para los círculos.
 *
 * HOY (sin backend): datos mock tras una latencia simulada.
 * MAÑANA (backend): al configurar Supabase se consulta la tabla `circles`.
 */
export async function fetchCircles(): Promise<Circle[]> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    return [circle];
  }

  const { data, error } = await supabase.from('circles').select('*');
  if (error) {
    throw new Error(error.message);
  }

  // TODO(backend): mapear la fila de Supabase al tipo `Circle` (acordar shape en src/types).
  return (data ?? []) as unknown as Circle[];
}

export async function fetchCircleById(id: string): Promise<Circle | null> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    const all = [circle];
    // Demo: si el id no coincide (p. ej. desde la galería /dev), caemos al único
    // círculo mock para que la pantalla siga siendo navegable.
    return all.find((c) => c.id === id) ?? all[0] ?? null;
  }

  const { data, error } = await supabase
    .from('circles')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }

  return data ? (data as unknown as Circle) : null;
}
