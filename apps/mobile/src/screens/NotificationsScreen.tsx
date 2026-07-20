import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type NotificationItem = {
  id: string;
  title: string;
  subtitle: string;
  icon: 'bell' | 'message-square' | 'award' | 'calendar';
  time: string;
  route: string;
};

const notifications: NotificationItem[] = [
  { id: '1', title: 'Nueva publicación de Darren Hardy', subtitle: 'Hizo un nuevo post sobre disciplina en su perfil.', icon: 'bell', time: 'Hace 10 m', route: '/profile/darren' },
  { id: '2', title: 'Mensaje nuevo en el Círculo', subtitle: 'Alguien comentó en el Círculo de Liderazgo Consciente.', icon: 'message-square', time: 'Hace 1 h', route: '/circle/lideres-renaser' },
  { id: '3', title: 'Registro de Evento Confirmado', subtitle: 'Tienes una reserva activa para el live de mañana.', icon: 'calendar', time: 'Hace 3 h', route: '/events' },
];

export function NotificationsScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Notificaciones" onBack={() => router.back()} />
      {notifications.length === 0 ? (
        <StateView
          state="empty"
          icon="bell"
          title="Sin notificaciones"
          description="Cuando haya novedades te avisaremos aquí."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {notifications.map((item) => (
            <ListRow
              key={item.id}
              title={item.title}
              subtitle={`${item.subtitle} • ${item.time}`}
              leftIcon={item.icon}
              rightIcon="chevron-right"
              onPress={() => router.push(item.route as any)}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.md,
  },
});
