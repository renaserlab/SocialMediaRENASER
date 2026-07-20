import { mockDelay } from '@/services/repositories/_delay';
import { lessons } from '@/data/mockData';
import { isSupabaseConfigured, supabase } from '@/services/supabase';
import type { Lesson } from '@/types';

/**
 * Fuente única de la verdad para las lecciones.
 *
 * HOY (sin backend): datos mock tras una latencia simulada.
 * MAÑANA (backend): al configurar Supabase se consulta la tabla `lessons`.
 */
export async function fetchLessonsByCourse(courseId: string): Promise<Lesson[]> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    return lessons.filter((lesson) => lesson.courseId === courseId);
  }

  const { data, error } = await supabase
    .from('lessons')
    .select('*')
    .eq('course_id', courseId)
    .order('order', { ascending: true });
  if (error) {
    throw new Error(error.message);
  }

  // TODO(backend): mapear la fila de Supabase (incluye join de resources) al tipo `Lesson`.
  return (data ?? []) as unknown as Lesson[];
}

export async function fetchLessonById(id: string): Promise<Lesson | null> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    // Demo: si el id no coincide (p. ej. desde la galería /dev), caemos a la
    // primera lección para que la pantalla siga siendo navegable.
    return lessons.find((lesson) => lesson.id === id) ?? lessons[0] ?? null;
  }

  const { data, error } = await supabase
    .from('lessons')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }

  return data ? (data as unknown as Lesson) : null;
}
