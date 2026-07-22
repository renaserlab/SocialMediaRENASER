import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { VideoPlayer } from '@/components/VideoPlayer';
import { useLesson } from '@/hooks/useLesson';
import { AuthRepository } from '@/repositories/AuthRepository';
import { assets } from '@/data/assets';
import { SAMPLE_VIDEO_URL } from '@/data/media';
import { signMediaUrls } from '@/services/storage';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();

  const { lesson, loading, error, reload } = useLesson(id);

  // El video vive en un bucket privado: hay que firmar su ruta para verlo.
  // En modo demo (sin backend) se sigue usando el clip de ejemplo.
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const mediaPath = lesson?.mediaPath ?? null;
  useEffect(() => {
    let alive = true;
    if (!AuthRepository.enabled) {
      setVideoUrl(SAMPLE_VIDEO_URL);
      return;
    }
    if (!mediaPath) {
      setVideoUrl(null);
      return;
    }
    signMediaUrls([mediaPath])
      .then((urls) => {
        if (alive) setVideoUrl(urls[mediaPath] ?? null);
      })
      .catch(() => {
        if (alive) setVideoUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [mediaPath]);

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
        {/*
          Video de ESTA lección. Antes era `SAMPLE_VIDEO_URL`, un clip de
          ejemplo fijo, asi que todas las lecciones mostraban lo mismo.
        */}
        {videoUrl ? (
          <VideoPlayer
            uri={videoUrl}
            poster={assets.course}
            style={[styles.playerContainer, { borderBottomWidth: 1, borderColor: colors.border }]}
            contentFit="cover"
            nativeControls
          />
        ) : (
          <View
            style={[
              styles.playerContainer,
              styles.noVideo,
              { borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
            ]}
          >
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>
              Esta lección aún no tiene video.
            </Text>
          </View>
        )}

        <View style={styles.details}>
          <Text style={[styles.title, { color: colors.text }]}>
            Lección {lesson.order}: {lesson.title}
          </Text>
          <Text style={[styles.duration, { color: colors.textMuted }]}>
            Duración: {lesson.durationMin} min
            {lesson.mentor ? ` • Mentor: ${lesson.mentor}` : ''}
          </Text>

          {/*
            El backend aun no guarda transcripcion ni recursos por leccion. Se
            ocultan las secciones vacias en vez de dejar la cabecera sola.
          */}
          {lesson.summary ? (
            <>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Transcripción / Resumen</Text>
              <Text style={[styles.bodyText, { color: colors.text, lineHeight: 22 }]}>{lesson.summary}</Text>
            </>
          ) : null}

          {lesson.resources.length > 0 ? (
            <>
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
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: spacing.xxl,
  },
  noVideo: { alignItems: 'center', justifyContent: 'center' },
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
