import { useCallback, useEffect, useState } from 'react';

import { fetchPosts } from '@/services/repositories/posts';
import { isSupabaseConfigured } from '@/services/supabase';
import { useAppStore } from '@/store/useAppStore';

/**
 * Feed de posts para HomeScreen.
 *
 * Encapsula la carga (loading / error / reload) y deja el estado interactivo
 * (likes, comentarios, crear post) donde ya vive: en el store.
 *
 * - Backend activo: el servidor es la fuente de verdad → reemplaza el store.
 * - Modo mock: conserva los posts del store (persistencia + posts creados en la
 *   demo) y solo simula la latencia de red para mostrar el skeleton.
 *
 * La pantalla solo consume `{ posts, loading, error, reload }`; no sabe nada de
 * mock ni de Supabase.
 */
export function usePostsFeed() {
  const posts = useAppStore((state) => state.posts);
  const setPosts = useAppStore((state) => state.setPosts);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await fetchPosts();
      // Solo reemplazamos el estado local cuando la fuente es remota (servidor
      // como verdad). En mock preservamos lo persistido para no borrar posts
      // creados durante la demo.
      if (isSupabaseConfigured) {
        setPosts(fresh);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el feed.');
    } finally {
      setLoading(false);
    }
  }, [setPosts]);

  useEffect(() => {
    load();
  }, [load]);

  return { posts, loading, error, reload: load };
}
