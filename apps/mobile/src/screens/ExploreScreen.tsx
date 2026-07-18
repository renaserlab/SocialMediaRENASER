import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { SectionTitle } from '@/components/SectionTitle';
import { Input } from '@/components/Input';
import { Card } from '@/components/Card';
import { ListRow } from '@/components/ListRow';
import { assets } from '@/data/assets';
import { course, events } from '@/data/mockData';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function ExploreScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="EXPLORAR" />
      <AppScreen contentStyle={{ paddingBottom: 100 }}>
        <View style={styles.container}>
          {/* Campo de búsqueda */}
          <View style={styles.searchWrapper}>
            <Input
              placeholder="Buscar personas, cursos o eventos..."
              placeholderTextColor={colors.textMuted}
              containerStyle={styles.searchContainer}
            />
            <View style={styles.searchIcon}>
              <Feather name="search" size={18} color={colors.textMuted} />
            </View>
          </View>

          <SectionTitle title="Tu siguiente paso" />
          <Pressable
            onPress={() => router.push('/course/lider-vida-empresa')}
            style={styles.heroCard}
            accessibilityLabel={`Programa recomendado: ${course.title}`}
            accessibilityRole="button"
          >
            <Image source={assets.course} style={[StyleSheet.absoluteFill, { tintColor: 'gray' }]} resizeMode="cover" />
            <View style={[styles.heroOverlay, { backgroundColor: colors.overlay }]} />
            <View style={styles.heroContent}>
              <Text style={styles.eyebrow}>PROGRAMA RECOMENDADO</Text>
              <Text style={styles.heroTitle}>{course.title}</Text>
              <Text style={styles.heroBody}>{course.modules} módulos · {course.lessons} lecciones</Text>
            </View>
          </Pressable>

          <SectionTitle title="Próximos eventos" action="Ver calendario" onActionPress={() => router.push('/events')} />
          <View style={styles.list}>
            {events.slice(0, 2).map((event, index) => (
              <ListRow
                key={event.id}
                title={event.title}
                subtitle={`${event.date} • ${event.location}`}
                leftComponent={
                  <Image source={index === 0 ? assets.event : assets.speaker} style={styles.eventImage} />
                }
                rightIcon="chevron-right"
                onPress={() => router.push('/events')}
              />
            ))}
          </View>

          <SectionTitle title="Comunidades" />
          <Pressable
            onPress={() => router.push('/circle/lideres-renaser')}
            style={[styles.circle, { backgroundColor: colors.primary }]}
            accessibilityLabel="Círculo privado: Líderes RENASER"
            accessibilityRole="button"
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.eyebrow, { color: colors.onPrimary }]}>CÍRCULO PRIVADO</Text>
              <Text style={[styles.circleTitle, { color: colors.onPrimary }]}>Líderes RENASER</Text>
              <Text style={[styles.circleBody, { color: colors.onPrimary }]}>Conecta, comparte y crece con 423 miembros.</Text>
            </View>
            <Feather name="users" size={48} color={colors.onPrimary} style={styles.circleIcon} />
          </Pressable>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  searchWrapper: {
    position: 'relative',
    marginBottom: spacing.xl,
  },
  searchContainer: {
    paddingLeft: 30,
  },
  searchIcon: {
    position: 'absolute',
    left: spacing.md,
    top: 15,
  },
  heroCard: { height: 280, borderRadius: radius.xl, overflow: 'hidden', marginBottom: spacing.xl, justifyContent: 'flex-end' },
  heroOverlay: { ...StyleSheet.absoluteFillObject },
  heroContent: { padding: spacing.xl },
  eyebrow: { color: '#D0D0D0', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  heroTitle: { color: '#FFFFFF', fontSize: 24, lineHeight: 30, fontWeight: '900', marginVertical: spacing.sm },
  heroBody: { color: '#E2E2E2', fontSize: 13 },
  list: {
    marginBottom: spacing.xl,
  },
  eventImage: { width: 50, height: 50, borderRadius: radius.md },
  circle: { borderRadius: radius.xl, padding: spacing.xl, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xl },
  circleTitle: { fontSize: 20, fontWeight: '900', marginTop: spacing.sm },
  circleBody: { fontSize: 12, lineHeight: 17, opacity: 0.82, marginTop: spacing.sm },
  circleIcon: {
    marginLeft: spacing.md,
  },
});
