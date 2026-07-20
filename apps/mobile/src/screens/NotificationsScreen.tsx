import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type NotificationItem = {
  id: string;
  title: string;
  subtitle: string;
  icon: 'bell' | 'message-square' | 'award' | 'calendar';
  time: string;
};

const notifications: NotificationItem[] = [
  { id: '1', title: 'Nueva publicación de Darren Hardy', subtitle: 'Hizo un nuevo post sobre disciplina en su perfil.', icon: 'bell', time: 'Hace 10 m' },
  { id: '2', title: 'Mensaje nuevo en el Círculo', subtitle: 'Alguien comentó en el Círculo de Liderazgo Consciente.', icon: 'message-square', time: 'Hace 1 h' },
  { id: '3', title: 'Registro de Evento Confirmado', subtitle: 'Tienes una reserva activa para el live de mañana.', icon: 'calendar', time: 'Hace 3 h' },
];

export function NotificationsScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Notificaciones" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.list}>
        {notifications.map((item) => (
          <ListRow
            key={item.id}
            title={item.title}
            subtitle={`${item.subtitle} • ${item.time}`}
            leftIcon={item.icon}
            onPress={() => {}}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.md,
  },
});
