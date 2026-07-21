import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { PeopleList } from '@/components/PeopleList';
import { people } from '@/data/mockData';
import { useAppTheme } from '@/theme/useAppTheme';

export function FollowingScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  // En mock seguimos a un subconjunto de la comunidad.
  const followed = people.slice(0, 3);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Siguiendo"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/profile'))}
      />
      <PeopleList
        people={followed}
        emptyTitle="Todavía no sigues a nadie"
        emptyDescription="Explora la comunidad y sigue a quienes te inspiran."
      />
    </View>
  );
}
