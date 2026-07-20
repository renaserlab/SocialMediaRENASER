import { mockDelay } from '@/services/repositories/_delay';
import { course } from '@/data/mockData';
import { isSupabaseConfigured, supabase } from '@/services/supabase';
import type { Course } from '@/types';

/**
 * Fuente única de la verdad para los cursos.
 *
 * HOY (sin backend): datos mock tras una latencia simulada.
 * MAÑANA (backend): al configurar Supabase se consulta la tabla `courses`.
 *
 * Ni las pantallas ni el store deben saber de dónde salen los cursos.
 */
export async function fetchCourses(): Promise<Course[]> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    return [course];
  }

  const { data, error } = await supabase.from('courses').select('*');
  if (error) {
    throw new Error(error.message);
  }

  // TODO(backend): mapear la fila de Supabase al tipo `Course` (acordar shape en src/types).
  return (data ?? []) as unknown as Course[];
}

export async function fetchCourseById(id: string): Promise<Course | null> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    const all = [course];
    // Demo: si el id no coincide (p. ej. desde la galería /dev), caemos al único
    // curso mock para que la pantalla siga siendo navegable.
    return all.find((c) => c.id === id) ?? all[0] ?? null;
  }

  const { data, error } = await supabase
    .from('courses')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }

  return data ? (data as unknown as Course) : null;
}
