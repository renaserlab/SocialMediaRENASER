import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { assets } from '@/data/assets';
import { events } from '@/data/mockData';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function EventsScreen() {
  const { colors } = useAppTheme();
  const reserved = useAppStore((state) => state.reservedEventIds);
  const toggle = useAppStore((state) => state.toggleReservation);

  return (
    <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
      <AppHeader back title="Próximos eventos" />
      <View style={styles.container}>
        {events.map((event, index) => {
          const isReserved = reserved.includes(event.id);
          const main = index === 0;
          return main ? (
            <View key={event.id} style={styles.mainCard}>
              <Image source={assets.event} style={StyleSheet.absoluteFill} resizeMode="cover" />
              <View style={styles.overlay} />
              <View style={styles.mainContent}>
                <Text style={styles.tag}>{event.type.toUpperCase()}</Text>
                <Text style={styles.mainTitle}>{event.title}</Text>
                <Text style={styles.mainDescription}>{event.description}</Text>
                <Text style={styles.mainMeta}>{event.date}{`\n`}{event.location}</Text>
                <PrimaryButton
                  label={isReserved ? 'Reserva confirmada' : 'Ver detalles y reservar'}
                  variant={isReserved ? 'secondary' : 'primary'}
                  onPress={() => toggle(event.id)}
                  style={{ marginTop: spacing.lg }}
                />
              </View>
            </View>
          ) : (
            <View key={event.id} style={[styles.rowCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Image source={index === 1 ? assets.speaker : assets.hero} style={styles.thumb} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.title, { color: colors.text }]}>{event.title}</Text>
                <Text style={[styles.description, { color: colors.textMuted }]}>{event.description}</Text>
                <Text style={[styles.meta, { color: colors.textMuted }]}>{event.date} · {event.location}</Text>
              </View>
              <Pressable onPress={() => event.type === 'live' ? router.push('/live/main') : toggle(event.id)} style={[styles.reserve, { backgroundColor: colors.primary }]}>
                <Ionicons name={isReserved ? 'checkmark' : event.type === 'live' ? 'videocam' : 'add'} size={18} color={colors.onPrimary} />
              </Pressable>
            </View>
          );
        })}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  mainCard: { height: 520, borderRadius: radius.xl, overflow: 'hidden', justifyContent: 'flex-end', marginBottom: spacing.lg },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.48)' },
  mainContent: { padding: spacing.xl },
  tag: { color: '#DADADA', fontSize: 10, letterSpacing: 1.5, fontWeight: '800' },
  mainTitle: { color: '#FFFFFF', fontSize: 42, fontWeight: '900', marginTop: spacing.sm },
  mainDescription: { color: '#E7E7E7', fontSize: 14, lineHeight: 20, marginTop: spacing.sm },
  mainMeta: { color: '#FFFFFF', fontSize: 13, lineHeight: 20, fontWeight: '800', marginTop: spacing.lg },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  thumb: { width: 78, height: 94, borderRadius: radius.md },
  title: { fontSize: 15, fontWeight: '900' },
  description: { fontSize: 11, lineHeight: 16, marginTop: 4 },
  meta: { fontSize: 10, marginTop: spacing.sm },
  reserve: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
});
