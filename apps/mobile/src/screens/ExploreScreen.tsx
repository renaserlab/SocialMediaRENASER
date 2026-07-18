import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { SectionTitle } from '@/components/SectionTitle';
import { assets } from '@/data/assets';
import { course, events } from '@/data/mockData';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function ExploreScreen() {
  const { colors } = useAppTheme();

  return (
    <AppScreen contentStyle={{ paddingBottom: 100 }}>
      <AppHeader title="EXPLORAR" />
      <View style={styles.container}>
        <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name="search" size={20} color={colors.textMuted} />
          <TextInput placeholder="Buscar personas, cursos o eventos" placeholderTextColor={colors.textMuted} style={[styles.searchInput, { color: colors.text }]} />
        </View>

        <SectionTitle title="Tu siguiente paso" />
        <Pressable onPress={() => router.push('/course/lider-vida-empresa')} style={styles.heroCard}>
          <Image source={assets.course} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <View style={styles.heroOverlay} />
          <View style={styles.heroContent}>
            <Text style={styles.eyebrow}>PROGRAMA RECOMENDADO</Text>
            <Text style={styles.heroTitle}>{course.title}</Text>
            <Text style={styles.heroBody}>{course.modules} módulos · {course.lessons} lecciones</Text>
          </View>
        </Pressable>

        <SectionTitle title="Próximos eventos" action="Ver calendario" />
        {events.slice(0, 2).map((event, index) => (
          <Pressable key={event.id} onPress={() => router.push('/events')} style={[styles.eventRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Image source={index === 0 ? assets.event : assets.speaker} style={styles.eventImage} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.eventTitle, { color: colors.text }]}>{event.title}</Text>
              <Text style={[styles.eventMeta, { color: colors.textMuted }]}>{event.date}</Text>
              <Text numberOfLines={1} style={[styles.eventMeta, { color: colors.textMuted }]}>{event.location}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </Pressable>
        ))}

        <SectionTitle title="Comunidades" />
        <Pressable onPress={() => router.push('/circle/lideres-renaser')} style={[styles.circle, { backgroundColor: colors.primary }]}>
          <View>
            <Text style={[styles.eyebrow, { color: colors.onPrimary }]}>CÍRCULO PRIVADO</Text>
            <Text style={[styles.circleTitle, { color: colors.onPrimary }]}>Líderes RENASER</Text>
            <Text style={[styles.circleBody, { color: colors.onPrimary }]}>Conecta, comparte y crece con 423 miembros.</Text>
          </View>
          <Ionicons name="people-circle-outline" size={68} color={colors.onPrimary} />
        </Pressable>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  search: { flexDirection: 'row', alignItems: 'center', height: 50, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.lg, gap: spacing.sm, marginBottom: spacing.xl },
  searchInput: { flex: 1, fontSize: 14 },
  heroCard: { height: 300, borderRadius: radius.xl, overflow: 'hidden', marginBottom: spacing.xl, justifyContent: 'flex-end' },
  heroOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.48)' },
  heroContent: { padding: spacing.xl },
  eyebrow: { color: '#D0D0D0', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  heroTitle: { color: '#FFFFFF', fontSize: 29, lineHeight: 34, fontWeight: '900', marginVertical: spacing.sm },
  heroBody: { color: '#E2E2E2', fontSize: 13 },
  eventRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.md, marginBottom: spacing.md },
  eventImage: { width: 76, height: 76, borderRadius: radius.md },
  eventTitle: { fontSize: 15, fontWeight: '800' },
  eventMeta: { fontSize: 11, marginTop: 3 },
  circle: { borderRadius: radius.xl, padding: spacing.xl, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xl },
  circleTitle: { fontSize: 24, fontWeight: '900', marginTop: spacing.sm },
  circleBody: { maxWidth: 240, fontSize: 12, lineHeight: 17, opacity: 0.82, marginTop: spacing.sm },
});
