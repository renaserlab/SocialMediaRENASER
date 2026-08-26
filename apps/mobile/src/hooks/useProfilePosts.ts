import { useCallback, useEffect, useState } from 'react';

import { galeriaEnCache, pedirGaleria } from '@/services/cachePerfil';
import { AuthRepository } from '@/repositories/AuthRepository';
import type { Post } from '@/types';

function repartir(posts: Post[]) {
  return {
    gallery: posts.filter((p) => p.mediaType === 'image' || p.mediaType === 'video'),
    audios: posts.filter((p) => p.mediaType === 'audio'),
  };
}

/**
 * Publicaciones de un perfil, separadas para su galeria: la cuadricula muestra
 * fotos y videos, y los audios van en su propia lista (una miniatura cuadrada
 * no dice nada de un audio).
 *
 * Se piden en una sola llamada y se reparten aqui, en vez de dos peticiones.
 *
 * Y se piden a `cachePerfil`, no al repositorio directamente. Dos motivos:
 *
 *  - Lo ya visto se pinta SIN ESPERAR. Volver a un perfil no puede costar otra
 *    ronda contra la base de datos para enseñar exactamente lo mismo.
 *  - Al tocar el perfil ya se lanzo esta misma peticion. Compartiendo la que
 *    esta EN VUELO, la pantalla se engancha a ella en vez de abrir una segunda:
 *    con la latencia que tiene hoy la base, lo que importa es cuantas
 *    peticiones hay, no cuanto tarda cada una.
 */
export function useProfilePosts(userId?: string | null) {
  // El primer render ya trae lo guardado: si hay algo, no hay estado de carga
  // ni cuadricula vacia que enseñar.
  const guardadas = galeriaEnCache(userId);
  const inicial = repartir(guardadas ?? []);

  const [gallery, setGallery] = useState<Post[]>(inicial.gallery);
  const [audios, setAudios] = useState<Post[]>(inicial.audios);
  const [loading, setLoading] = useState(!guardadas);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async ({ refrescar = false }: { refrescar?: boolean } = {}) => {
      if (!userId || !AuthRepository.enabled) {
        setGallery([]);
        setAudios([]);
        setLoading(false);
        return;
      }
      /*
        PINTAR LO GUARDADO Y COMPROBAR DETRAS.

        Si hay algo guardado no se enseña indicador de carga —quitar lo que ya
        se ve para poner un giro es un parpadeo gratis— pero SI se vuelve a
        preguntar. Servir la cache sin comprobar tenia un precio inaceptable:
        publicar una foto y entrar en tu perfil no la habria enseñado hasta un
        par de minutos despues, y eso se lee como que la publicacion se perdio.

        La primera visita es la contraria: ahi no se fuerza nada, para
        engancharse a la peticion que ya lanzo la precarga al tocar el perfil en
        vez de abrir una segunda.
      */
      const yaHay = galeriaEnCache(userId);
      if (!yaHay) setLoading(true);
      setError(null);
      try {
        const posts = await pedirGaleria(userId, { refrescar: refrescar || !!yaHay });
        const repartido = repartir(posts);
        setGallery(repartido.gallery);
        setAudios(repartido.audios);
      } catch (err) {
        // Un refresco fallido NO borra lo que ya se esta viendo. Cambiar una
        // cuadricula correcta por «no se pudieron cargar» porque se cayo la red
        // un segundo es perder informacion buena a cambio de nada.
        if (!yaHay) {
          setError(err instanceof Error ? err.message : 'No se pudieron cargar las publicaciones.');
        }
      } finally {
        setLoading(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    // Al cambiar de perfil se parte de lo que se sepa de ESE, no de lo anterior.
    const previas = galeriaEnCache(userId);
    const repartido = repartir(previas ?? []);
    setGallery(repartido.gallery);
    setAudios(repartido.audios);
    void load();
  }, [load, userId]);

  return { gallery, audios, loading, error, reload: () => load({ refrescar: true }) };
}
