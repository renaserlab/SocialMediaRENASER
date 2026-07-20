import React from 'react';
import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { useAppTheme } from '@/theme/useAppTheme';

const icon = (name: keyof typeof Feather.glyphMap) => ({ color, size }: { color: string; size: number }) => (
  <Feather name={name} color={color} size={size} />
);

export default function TabsLayout() {
  const { colors } = useAppTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 64,
          paddingTop: 8,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '700' },
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'Inicio', tabBarIcon: icon('home') }} />
      <Tabs.Screen name="explore" options={{ title: 'Explorar', tabBarIcon: icon('search') }} />
      <Tabs.Screen name="create" options={{ title: 'Crear', tabBarIcon: icon('plus-square') }} />
      <Tabs.Screen name="messages" options={{ title: 'Mensajes', tabBarIcon: icon('message-square') }} />
      <Tabs.Screen name="profile" options={{ title: 'Perfil', tabBarIcon: icon('user') }} />
    </Tabs>
  );
}
