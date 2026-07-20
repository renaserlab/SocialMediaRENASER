import React from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { useLesson } from '@/hooks/useLesson';
import { spacing, radius } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { assets } from '@/data/assets';

export function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();

  // Lección a través de la capa de repositorio (mock hoy, backend mañana).
  const { lesson, loading, error, reload } = useLesson(id);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Lección del Curso" onBack={() => router.back()} />
        <StateView state="loading" />
      </View>
    );
  }

  if (error || !lesson) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Lección del Curso" onBack={() => router.back()} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Lección del Curso" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Visual representation of video player */}
        <View style={[styles.playerContainer, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
          <Image source={assets.course} style={[styles.coverImage, { tintColor: 'gray' }]} />
          <View style={styles.playOverlay}>
            <Button label="Iniciar Lección" icon="play" onPress={() => {}} />
          </View>
        </View>

        <View style={styles.details}>
          <Text style={[styles.title, { color: colors.text }]}>
            Lección {lesson.order}: {lesson.title}
          </Text>
          <Text style={[styles.duration, { color: colors.textMuted }]}>
            Duración: {lesson.durationMin} min • Mentor: {lesson.mentor}
          </Text>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <Text style={[styles.sectionTitle, { color: colors.text }]}>Transcripción / Resumen</Text>
          <Text style={[styles.bodyText, { color: colors.text, lineHeight: 22 }]}>{lesson.summary}</Text>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <Text style={[styles.sectionTitle, { color: colors.text }]}>Recursos del Curso</Text>
          {lesson.resources.map((resource) => (
            <ListRow
              key={resource.id}
              title={resource.title}
              subtitle={resource.subtitle}
              leftIcon={resource.icon}
              rightIcon="download"
              onPress={() => {}}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: spacing.xxl,
  },
  playerContainer: {
    height: 220,
    borderBottomWidth: 1,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  coverImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  playOverlay: {
    position: 'absolute',
    alignSelf: 'center',
  },
  details: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
  },
  duration: {
    fontSize: 13,
  },
  divider: {
    height: 1,
    marginVertical: spacing.sm,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  bodyText: {
    fontSize: 14,
  },
});
