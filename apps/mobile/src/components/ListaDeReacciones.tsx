import React, { useCallback } from 'react';

import { PeopleList } from '@/components/PeopleList';
import { useListaDePersonas } from '@/hooks/useListaDePersonas';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Quién reaccionó a una publicación. SOLO la lista.
 *
 * POR QUE EXISTE SEPARADO. La misma lista se enseña en dos sitios y con dos
 * envoltorios distintos:
 *
 *   - Desde el feed, al pulsar el número, en una HOJA que sube desde abajo y
 *     deja la publicación visible detrás (`ReaccionesSheet`).
 *   - Como PANTALLA propia (`ReaccionesScreen`), que es la entrada directa: un
 *     aviso agrupado —«Edson y 99 personas más»— o un enlace no tienen ninguna
 *     publicación abierta detrás a la que volver.
 *
 * Lo que cambia entre las dos es el marco, no el contenido: la misma consulta,
 * el mismo estado de carga, el mismo seguir/dejar de seguir. Duplicarlo
 * significaria que un dia arreglar algo en una dejaria la otra rota, y que la
 * misma peticion se escribiria dos veces.
 */
export function ListaDeReacciones({ postId }: { postId: string | null | undefined }) {
  const { t } = useTranslation();
  const currentUserId = useAppStore((state) => state.user?.id);

  const cargar = useCallback(async () => {
    if (!postId) return [];
    return PostRepository.listLikes(postId);
  }, [postId]);

  /*
    `null` cuando no hay publicación: el hook no pide nada en vez de pedir una
    lista vacía. Sin esto, abrir la hoja antes de tener el id lanzaría una
    petición que no sirve para nada.
  */
  const { people, loading, error, reload, toggleFollow } = useListaDePersonas(
    postId ? cargar : null,
  );

  return (
    <PeopleList
      people={people}
      loading={loading}
      error={error}
      onRetry={reload}
      onToggleFollow={toggleFollow}
      currentUserId={currentUserId}
      emptyTitle={t('post.noReactions')}
      emptyDescription={t('post.noReactionsBody')}
    />
  );
}
