import React, { useCallback } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { PeopleList } from '@/components/PeopleList';
import { useListaDePersonas } from '@/hooks/useListaDePersonas';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Quién reaccionó a una publicación.
 *
 * Es a donde lleva la notificación agrupada: sin esta pantalla, «Edson y 99
 * personas más» no se puede abrir y el número no lleva a ninguna parte.
 *
 * Reutiliza `PeopleList` —la misma lista de seguidores y seguidos— en vez de
 * inventarse otra: son las mismas filas, con la misma foto, el mismo nombre y
 * el mismo botón de seguir.
 */
export function ReaccionesScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const currentUserId = useAppStore((state) => state.user?.id);

  const cargar = useCallback(async () => {
    if (!id) return [];
    return PostRepository.listLikes(id);
  }, [id]);

  const { people, loading, error, reload, toggleFollow } = useListaDePersonas(
    id ? cargar : null,
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Reacciones"
        // Si se llega desde un aviso puede no haber a donde volver: en ese caso
        // se cae a la publicacion, que es el contexto de lo que se esta viendo.
        onBack={() =>
          router.canGoBack()
            ? router.back()
            : router.replace((id ? `/post/${id}` : '/(tabs)/home') as never)
        }
      />
      <PeopleList
        people={people}
        loading={loading}
        error={error}
        onRetry={reload}
        onToggleFollow={toggleFollow}
        currentUserId={currentUserId}
        emptyTitle="Todavía no hay reacciones"
        emptyDescription="Cuando alguien reaccione, aparecerá aquí."
      />
    </View>
  );
}
