import React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { PeopleList } from '@/components/PeopleList';
import { useFollowList } from '@/hooks/useFollowList';
import { useAppStore } from '@/store/useAppStore';
import { useAppTheme } from '@/theme/useAppTheme';

export function FollowingScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const currentUserId = useAppStore((state) => state.user?.id);
  /**
   * La ruta usa "me" para el perfil propio, que es legible en la URL pero NO
   * es un id: enviarlo al backend daba 404 ("perfil no encontrado"), porque
   * `/profiles/{id}` espera un UUID. Se resuelve aqui.
   */
  const isSelf = !id || id === 'me' || id === currentUserId;
  const profileId = isSelf ? currentUserId : id;

  const { people, loading, error, reload, toggleFollow } = useFollowList(profileId, 'following');
  const isOwn = isSelf;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Siguiendo"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/profile'))}
      />
      <PeopleList
        people={people}
        loading={loading}
        error={error}
        onRetry={reload}
        onToggleFollow={toggleFollow}
        currentUserId={currentUserId}
        emptyTitle={isOwn ? 'Todavía no sigues a nadie' : 'Todavía no sigue a nadie'}
        emptyDescription={
          isOwn
            ? 'Explora la comunidad y sigue a quienes te inspiran.'
            : 'Cuando siga a alguien, aparecerá aquí.'
        }
      />
    </View>
  );
}
