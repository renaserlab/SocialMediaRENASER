import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { assets } from '@/data/assets';
import { stories } from '@/data/mockData';
import { palette, radius, spacing } from '@/theme/tokens';

// Visor a pantalla completa sobre imagen → contexto de media (siempre oscuro).
const media = palette('dark');

/** Duración de cada tramo antes de auto-avanzar. */
const SEGMENT_MS = 5000;

export function StoriesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  // El parámetro admite el id de la historia o su índice.
  const initialAuthor = useMemo(() => {
    const byId = stories.findIndex((s) => s.id === id);
    if (byId >= 0) return byId;
    const asIndex = Number(id);
    return Number.isFinite(asIndex) && asIndex >= 0 && asIndex < stories.length ? asIndex : 0;
  }, [id]);

  const [authorIndex, setAuthorIndex] = useState(initialAuthor);
  const [segIndex, setSegIndex] = useState(0);
  const [progress, setProgress] = useState(0);

  const story = stories[authorIndex];
  const segments = story?.segments ?? [];
  const segment = segments[segIndex];

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  }, [router]);

  const goNext = useCallback(() => {
    if (segIndex + 1 < segments.length) {
      setSegIndex(segIndex + 1);
      return;
    }
    if (authorIndex + 1 < stories.length) {
      setAuthorIndex(authorIndex + 1);
      setSegIndex(0);
      return;
    }
    close();
  }, [segIndex, segments.length, authorIndex, close]);

  const goPrev = useCallback(() => {
    if (segIndex > 0) {
      setSegIndex(segIndex - 1);
      return;
    }
    if (authorIndex > 0) {
      const prev = authorIndex - 1;
      setAuthorIndex(prev);
      setSegIndex(Math.max(0, (stories[prev]?.segments.length ?? 1) - 1));
      return;
    }
    setSegIndex(0);
  }, [segIndex, authorIndex]);

  const nextAuthor = useCallback(() => {
    if (authorIndex + 1 < stories.length) {
      setAuthorIndex(authorIndex + 1);
      setSegIndex(0);
    } else {
      close();
    }
  }, [authorIndex, close]);

  const prevAuthor = useCallback(() => {
    if (authorIndex > 0) {
      setAuthorIndex(authorIndex - 1);
      setSegIndex(0);
    }
  }, [authorIndex]);

  // Auto-avance: barra de progreso por tramo.
  useEffect(() => {
    setProgress(0);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const value = Math.min(1, (Date.now() - startedAt) / SEGMENT_MS);
      setProgress(value);
      if (value >= 1) {
        clearInterval(timer);
        goNext();
      }
    }, 60);
    return () => clearInterval(timer);
  }, [authorIndex, segIndex, goNext]);

  // Swipe: horizontal cambia de autor, hacia abajo cierra.
  const pan = Gesture.Pan().onEnd((e) => {
    if (e.translationY > 90) {
      runOnJS(close)();
      return;
    }
    if (e.translationX < -60) {
      runOnJS(nextAuthor)();
      return;
    }
    if (e.translationX > 60) {
      runOnJS(prevAuthor)();
    }
  });

  if (!story || !segment) return null;

  return (
    <View style={styles.root}>
      <ExpoImage source={assets[segment.image]} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
      <LinearGradient
        colors={[media.overlay, 'transparent', media.overlay]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* Zonas de tap: izquierda retrocede, derecha avanza */}
      <GestureDetector gesture={pan}>
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={styles.zoneLeft} onPress={goPrev} accessibilityRole="button" accessibilityLabel="Tramo anterior" />
          <Pressable style={styles.zoneRight} onPress={goNext} accessibilityRole="button" accessibilityLabel="Siguiente tramo" />
        </View>
      </GestureDetector>

      <SafeAreaView style={styles.safe} pointerEvents="box-none">
        {/* Barras de progreso, una por tramo */}
        <View style={styles.progressRow} pointerEvents="none">
          {segments.map((seg, i) => (
            <View key={seg.id} style={[styles.progressTrack, { backgroundColor: media.border }]}>
              <View
                style={[
                  styles.progressFill,
                  {
                    backgroundColor: media.text,
                    width: i < segIndex ? '100%' : i === segIndex ? `${progress * 100}%` : '0%',
                  },
                ]}
              />
            </View>
          ))}
        </View>

        <View style={styles.header}>
          <ExpoImage source={assets[story.avatar]} style={styles.avatar} contentFit="cover" />
          <Text style={[styles.author, { color: media.text }]} numberOfLines={1}>
            {story.author}
          </Text>
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel="Cerrar historias">
            <Feather name="x" size={24} color={media.text} />
          </Pressable>
        </View>

        <View style={styles.spacer} pointerEvents="none" />

        {segment.caption ? (
          <Text style={[styles.caption, { color: media.text }]} pointerEvents="none">
            {segment.caption}
          </Text>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  safe: { flex: 1, paddingHorizontal: spacing.lg },
  zoneLeft: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '32%' },
  zoneRight: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '68%' },
  progressRow: { flexDirection: 'row', gap: 4, marginTop: spacing.sm },
  progressTrack: { flex: 1, height: 3, borderRadius: radius.pill, overflow: 'hidden' },
  progressFill: { height: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  author: { flex: 1, fontSize: 14, fontWeight: '800' },
  spacer: { flex: 1 },
  caption: { fontSize: 15, lineHeight: 21, fontWeight: '600', marginBottom: spacing.xxl },
});
