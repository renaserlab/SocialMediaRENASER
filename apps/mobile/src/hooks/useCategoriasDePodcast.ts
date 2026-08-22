import { useCallback, useEffect, useState } from 'react';

import { describeError } from '@/lib/describeError';
import { AuthRepository } from '@/repositories/AuthRepository';
import {
  PodcastCategoryRepository,
  type CategoriaDePodcast,
} from '@/repositories/PodcastCategoryRepository';

/**
 * Las categorias de un perfil, y lo que se puede hacer con ellas.
 *
 * Vive aparte porque hay TRES pantallas que las necesitan —el filtro del
 * podcast, el alta de un episodio y la edicion de una publicacion—, y las tres
 * tienen que ver exactamente la misma lista. Con una copia en cada sitio,
 * crear una categoria al publicar no aparecia en el filtro hasta recargar.
 */
export function useCategoriasDePodcast(ownerId: string | null | undefined) {
  const [categorias, setCategorias] = useState<CategoriaDePodcast[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recargar = useCallback(async () => {
    if (!ownerId || !AuthRepository.enabled) {
      setCategorias([]);
      return;
    }
    setCargando(true);
    setError(null);
    try {
      setCategorias(await PodcastCategoryRepository.list(ownerId));
    } catch (e) {
      /*
        Un fallo aqui NO puede tumbar el podcast: sin categorias los episodios
        se siguen viendo, simplemente sin agrupar. Se guarda el motivo para
        poder ofrecer reintentar donde corresponda.
      */
      console.warn('[podcast] no se pudieron cargar las categorías', e);
      setError(describeError(e, 'No pudimos cargar tus categorías.'));
      setCategorias([]);
    } finally {
      setCargando(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  const crear = useCallback(
    async (nombre: string) => {
      const creada = await PodcastCategoryRepository.create(nombre);
      // Se anade en memoria en vez de recargar: la respuesta ya trae la fila y
      // volver a pedir la lista entera es un viaje de ida y vuelta que se nota.
      setCategorias((previas) => [...previas, creada]);
      return creada;
    },
    [],
  );

  const renombrar = useCallback(async (id: string, nombre: string) => {
    const actualizada = await PodcastCategoryRepository.update(id, { nombre });
    setCategorias((previas) =>
      previas.map((c) => (c.id === id ? { ...c, nombre: actualizada.nombre } : c)),
    );
  }, []);

  const borrar = useCallback(async (id: string) => {
    await PodcastCategoryRepository.remove(id);
    setCategorias((previas) => previas.filter((c) => c.id !== id));
  }, []);

  return { categorias, cargando, error, recargar, crear, renombrar, borrar };
}
