import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { PeopleList } from '@/components/PeopleList';
import { people } from '@/data/mockData';
import { useAppTheme } from '@/theme/useAppTheme';

export function FollowersScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Seguidores"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/profile'))}
      />
      <PeopleList
        people={people}
        emptyTitle="Aún no tienes seguidores"
        emptyDescription="Comparte tu primera publicación para empezar a conectar."
      />
    </View>
  );
}
