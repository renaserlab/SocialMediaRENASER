import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import type { NotificationItem } from '@/mappers/notificationMapper';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const demoNotifications: NotificationItem[] = [
  { id: '1', title: 'Nueva publicación de Darren Hardy', subtitle: 'Hizo un nuevo post sobre disciplina.', icon: 'bell', time: 'Hace 10 m', read: false },
  { id: '2', title: 'Mensaje nuevo en el Círculo', subtitle: 'Alguien comentó en el Círculo de Liderazgo.', icon: 'message-square', time: 'Hace 1 h', read: false },
  { id: '3', title: 'Registro de Evento Confirmado', subtitle: 'Tienes una reserva activa para el live de mañana.', icon: 'award', time: 'Hace 3 h', read: true },
];

export function NotificationsScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');

  const load = useCallback(() => {
    if (!supabaseEnabled) {
      setItems(demoNotifications);
      setStatus('idle');
      return;
    }
    setStatus('loading');
    NotificationRepository.list()
      .then((data) => {
        setItems(data);
        setStatus('idle');
        // Al abrir, marcamos todas como leídas (limpia el badge).
        NotificationRepository.markAllRead().catch(() => {});
      })
      .catch(() => setStatus('error'));
  }, [supabaseEnabled]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const uiState = supabaseEnabled && status === 'loading'
    ? 'loading'
    : supabaseEnabled && status === 'error'
    ? 'error'
    : items.length === 0
    ? 'empty'
    : 'content';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Notificaciones" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <StateView
        state={uiState}
        onRetry={load}
        icon="bell"
        title={uiState === 'empty' ? 'Sin notificaciones' : undefined}
        description={uiState === 'empty' ? 'Aquí verás la actividad sobre ti.' : undefined}
      >
        <ScrollView contentContainerStyle={styles.list}>
          {items.map((item) => (
            <ListRow
              key={item.id}
              title={item.title}
              subtitle={`${item.subtitle} • ${item.time}`}
              leftIcon={item.icon}
              onPress={() =>
                item.actorId
                  ? router.push(`/profile/${item.actorId}` as never)
                  : undefined
              }
            />
          ))}
        </ScrollView>
      </StateView>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.md,
  },
});
