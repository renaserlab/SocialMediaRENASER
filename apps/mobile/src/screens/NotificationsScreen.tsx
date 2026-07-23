import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import type { NotificationItem } from '@/mappers/notificationMapper';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { DARREN_NOTICE_ID } from '@/lib/guides';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
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

  /**
   * Aviso de contenido gratuito de Darren. No es una notificacion del backend:
   * es un aviso de la propia app, fijo arriba, hasta que el usuario entra o lo
   * descarta. Se resuelve el id REAL del administrador (nunca uno fijo) igual
   * que hace el inicio con las tarjetas de eventos y cursos.
   */
  const noticeDismissed = useAppStore((state) => state.dismissedGuides.includes(DARREN_NOTICE_ID));
  const dismissGuide = useAppStore((state) => state.dismissGuide);
  const [adminId, setAdminId] = useState<string | null>(null);
  useEffect(() => {
    if (!supabaseEnabled || noticeDismissed) return;
    ProfileRepository.listFeatured()
      .then((list) => setAdminId(list.find((member) => member.isAdmin)?.id ?? null))
      .catch(() => setAdminId(null));
  }, [supabaseEnabled, noticeDismissed]);

  // `listFeatured` excluye a quien mira: si el propio Darren abre la pantalla no
  // hay administrador que recomendar y el aviso no se muestra. Es lo correcto.
  const showNotice = !noticeDismissed && !!adminId;

  const openDarren = () => {
    if (!adminId) return;
    dismissGuide(DARREN_NOTICE_ID);
    router.push(`/profile/${adminId}` as never);
  };

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
    // Con el aviso visible la pantalla NO esta vacia: sin esta condicion el
    // estado vacio lo tapaba justo cuando mas falta hace, en una cuenta recien
    // creada que todavia no tiene notificaciones.
    : items.length === 0 && !showNotice
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
        <FlashList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            showNotice ? (
              <View style={[styles.notice, { backgroundColor: colors.primary }]}>
                {/*
                  La zona pulsable va DETRAS del contenido: en web cada Pressable
                  es un <button> y el de descartar quedaria anidado dentro del
                  otro (HTML invalido).
                */}
                <Pressable
                  onPress={openDarren}
                  style={StyleSheet.absoluteFill}
                  accessibilityRole="button"
                  accessibilityLabel="Ver contenido de Darren gratis"
                />
                <View style={styles.noticeRow} pointerEvents="none">
                  <Feather name="gift" size={20} color={colors.onPrimary} />
                  <View style={styles.noticeCopy}>
                    <Text variant="body" weight="800" color={colors.onPrimary}>
                      Ver contenido de Darren gratis aquí
                    </Text>
                    <Text variant="secondary" color={colors.onPrimary} style={styles.noticeBody}>
                      Entra a su perfil: cursos, testimonios y publicaciones.
                    </Text>
                  </View>
                </View>
                <Pressable
                  onPress={() => dismissGuide(DARREN_NOTICE_ID)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Descartar aviso"
                  style={styles.noticeClose}
                >
                  <Feather name="x" size={15} color={colors.onPrimary} />
                </Pressable>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <ListRow
              title={item.title}
              subtitle={`${item.subtitle} • ${item.time}`}
              leftIcon={item.icon}
              onPress={() =>
                item.actorId
                  ? router.push(`/profile/${item.actorId}` as never)
                  : undefined
              }
            />
          )}
        />
      </StateView>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.md,
  },
  notice: {
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xxl,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  noticeCopy: { flex: 1, gap: 3 },
  noticeBody: { lineHeight: 18, opacity: 0.9 },
  noticeClose: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
