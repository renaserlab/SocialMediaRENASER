import React from 'react';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';

import { useTranslation } from '@/i18n/useTranslation';
import { useAppTheme } from '@/theme/useAppTheme';

const icon = (name: keyof typeof Feather.glyphMap) => ({ color, size }: { color: string; size: number }) => (
  <Feather name={name} color={color} size={size} />
);

export default function TabsLayout() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  // Sin esto, fijar `height` anula el calculo height + inset de React Navigation
  // y los iconos quedan bajo la barra de gestos / home indicator.
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 64 + insets.bottom,
          paddingTop: 8,
          paddingBottom: 8 + insets.bottom,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '700' },
      }}
    >
      <Tabs.Screen name="home" options={{ title: t('tabs.home'), tabBarIcon: icon('home') }} />
      <Tabs.Screen name="explore" options={{ title: t('tabs.explore'), tabBarIcon: icon('search') }} />
      <Tabs.Screen name="create" options={{ title: t('tabs.create'), tabBarIcon: icon('plus-square') }} />
      <Tabs.Screen name="messages" options={{ title: t('tabs.messages'), tabBarIcon: icon('message-square') }} />
      <Tabs.Screen name="profile" options={{ title: t('tabs.profile'), tabBarIcon: icon('user') }} />
    </Tabs>
  );
}
