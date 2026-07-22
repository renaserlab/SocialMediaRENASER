import { useCallback, useEffect, useState } from 'react';

import { PostRepository } from '@/repositories/PostRepository';
import { AuthRepository } from '@/repositories/AuthRepository';
import type { Post } from '@/types';

/**
 * Publicaciones de un perfil, separadas para su galeria: la cuadricula muestra
 * fotos y videos, y los audios van en su propia lista (una miniatura cuadrada
 * no dice nada de un audio).
 *
 * Se piden en una sola llamada y se reparten aqui, en vez de dos peticiones.
 */
export function useProfilePosts(userId?: string | null) {
  const [gallery, setGallery] = useState<Post[]>([]);
  const [audios, setAudios] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId || !AuthRepository.enabled) {
      setGallery([]);
      setAudios([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const posts = await PostRepository.listByAuthor(userId, { limit: 60 }, userId);
      setGallery(posts.filter((p) => p.mediaType === 'image' || p.mediaType === 'video'));
      setAudios(posts.filter((p) => p.mediaType === 'audio'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las publicaciones.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { gallery, audios, loading, error, reload: load };
}
