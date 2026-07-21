import React, { useCallback, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { notify } from '@/lib/notify';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { assets } from '@/data/assets';
import { events as mockEvents } from '@/data/mockData';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { EventItem } from '@/types';

export function EventsScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const demoReserved = useAppStore((state) => state.reservedEventIds);
  const demoToggle = useAppStore((state) => state.toggleReservation);

  const [remoteEvents, setRemoteEvents] = useState<EventItem[]>([]);
  const [remoteReserved, setRemoteReserved] = useState<string[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');

  const load = useCallback(() => {
    if (!supabaseEnabled) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    CatalogRepository.listEvents()
      .then(({ items, reservedIds }) => {
        setRemoteEvents(items);
        setRemoteReserved(reservedIds);
        setStatus('idle');
      })
      .catch(() => setStatus('error'));
  }, [supabaseEnabled]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const events = supabaseEnabled ? remoteEvents : mockEvents;
  const reservedIds = supabaseEnabled ? remoteReserved : demoReserved;

  const toggle = async (id: string) => {
    if (!supabaseEnabled) {
      demoToggle(id);
      return;
    }
    const was = remoteReserved.includes(id);
    setRemoteReserved((prev) => (was ? prev.filter((x) => x !== id) : [...prev, id]));
    try {
      if (was) await CatalogRepository.cancelReservation(id);
      else await CatalogRepository.reserve(id);
    } catch {
      setRemoteReserved((prev) => (was ? [...prev, id] : prev.filter((x) => x !== id)));
      notify('No se pudo actualizar la reserva', 'Inténtalo de nuevo.');
    }
  };

  const uiState = supabaseEnabled && status === 'loading'
    ? 'loading'
    : supabaseEnabled && status === 'error'
    ? 'error'
    : events.length === 0
    ? 'empty'
    : 'content';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Próximos eventos" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.container}>
          <StateView
            state={uiState}
            onRetry={load}
            title={uiState === 'empty' ? 'No hay eventos' : undefined}
            description={uiState === 'empty' ? 'Vuelve pronto para ver próximos eventos.' : undefined}
          >
            {events.map((event, index) => {
              const isReserved = reservedIds.includes(event.id);
              const main = index === 0;
              return main ? (
                <View key={event.id} style={styles.mainCard}>
                  <Image source={assets.event} style={StyleSheet.absoluteFill} resizeMode="cover" />
                  <View style={[styles.overlay, { backgroundColor: colors.overlay }]} />
                  <View style={styles.mainContent}>
                    <Text style={styles.tag}>{event.type.toUpperCase()}</Text>
                    <Text style={styles.mainTitle}>{event.title}</Text>
                    <Text style={styles.mainDescription}>{event.description}</Text>
                    <Text style={styles.mainMeta}>{event.date}{`\n`}{event.location}</Text>
                    <Button
                      label={isReserved ? 'Reserva confirmada' : 'Ver detalles y reservar'}
                      variant={isReserved ? 'secondary' : 'primary'}
                      onPress={() => toggle(event.id)}
                      style={{ marginTop: spacing.lg }}
                    />
                  </View>
                </View>
              ) : (
                <View
                  key={event.id}
                  style={[styles.rowCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
                >
                  <Image source={index === 1 ? assets.speaker : assets.hero} style={[styles.thumb, { borderColor: colors.border }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.title, { color: colors.text }]}>{event.title}</Text>
                    <Text style={[styles.description, { color: colors.textMuted }]}>{event.description}</Text>
                    <Text style={[styles.meta, { color: colors.textMuted }]}>{event.date} · {event.location}</Text>
                  </View>
                  <Pressable
                    onPress={() => (event.type === 'live' ? router.push('/live/main') : toggle(event.id))}
                    style={[styles.reserve, { backgroundColor: colors.primary }]}
                    accessibilityLabel={isReserved ? 'Reserva confirmada' : event.type === 'live' ? 'Ver transmisión' : 'Reservar'}
                    accessibilityRole="button"
                  >
                    <Feather
                      name={isReserved ? 'check' : event.type === 'live' ? 'video' : 'plus'}
                      size={18}
                      color={colors.onPrimary}
                    />
                  </Pressable>
                </View>
              );
            })}
          </StateView>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  mainCard: { height: 460, borderRadius: radius.xl, overflow: 'hidden', justifyContent: 'flex-end', marginBottom: spacing.lg, borderWidth: 1, borderColor: '#333' },
  overlay: { ...StyleSheet.absoluteFillObject },
  mainContent: { padding: spacing.xl },
  tag: { color: '#DADADA', fontSize: 10, letterSpacing: 1.5, fontWeight: '800' },
  mainTitle: { color: '#FFFFFF', fontSize: 32, fontWeight: '900', marginTop: spacing.sm },
  mainDescription: { color: '#E7E7E7', fontSize: 13, lineHeight: 18, marginTop: spacing.sm },
  mainMeta: { color: '#FFFFFF', fontSize: 12, lineHeight: 18, fontWeight: '800', marginTop: spacing.lg },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  thumb: { width: 70, height: 86, borderRadius: radius.md, borderWidth: 1 },
  title: { fontSize: 14, fontWeight: '800' },
  description: { fontSize: 11, lineHeight: 16, marginTop: 4 },
  meta: { fontSize: 10, marginTop: spacing.sm },
  reserve: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
