import { mockDelay } from '@/services/repositories/_delay';
import { initialPosts } from '@/data/mockData';
import { isSupabaseConfigured, supabase } from '@/services/supabase';
import type { Post } from '@/types';

/**
 * Fuente única de la verdad para el feed de posts.
 *
 * HOY (sin backend): devuelve los datos mock tras una latencia simulada.
 * MAÑANA (backend en otra rama): al definir EXPO_PUBLIC_SUPABASE_URL y
 * EXPO_PUBLIC_SUPABASE_ANON_KEY, `isSupabaseConfigured` pasa a true y se consulta
 * Supabase — sin tocar ni una sola pantalla.
 *
 * Regla: ni las pantallas ni el store deben saber de dónde salen los posts.
 * Solo llaman a este repositorio.
 */
export async function fetchPosts(): Promise<Post[]> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    return initialPosts;
  }

  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  // TODO(backend): mapear la fila de Supabase (snake_case + joins de comments/likes)
  // al tipo `Post`. El shape exacto se acuerda con la rama de backend en src/types/index.ts.
  return (data ?? []) as unknown as Post[];
}
