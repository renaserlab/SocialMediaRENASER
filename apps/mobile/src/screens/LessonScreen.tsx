import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { VideoPlayer } from '@/components/VideoPlayer';
import { useLesson } from '@/hooks/useLesson';
import { assets } from '@/data/assets';
import { SAMPLE_VIDEO_URL } from '@/data/media';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();

  // Lección a través de la capa de repositorio (mock hoy, backend mañana).
  const { lesson, loading, error, reload } = useLesson(id);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Lección del Curso" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="loading" />
      </View>
    );
  }

  if (error || !lesson) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Lección del Curso" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Lección del Curso" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Reproductor de video real de la lección */}
        <VideoPlayer
          uri={SAMPLE_VIDEO_URL}
          poster={assets.course}
          style={[styles.playerContainer, { borderBottomWidth: 1, borderColor: colors.border }]}
          contentFit="cover"
          nativeControls
        />

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
