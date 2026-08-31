import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { BottomSheet } from '@/components/BottomSheet';
import { ListRow } from '@/components/ListRow';
import { VideoPlayer } from '@/components/VideoPlayer';
import { assets } from '@/data/assets';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { StoryRepository } from '@/repositories/StoryRepository';
import { useAppStore } from '@/store/useAppStore';
import { palette, radius, spacing } from '@/theme/tokens';
import type { StoryViewer } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

// Visor a pantalla completa sobre imagen → contexto de media (siempre oscuro).
const media = palette('dark');

export function StoriesScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const groups = useAppStore((state) => state.storyGroups);
  const markStoryViewed = useAppStore((state) => state.markStoryViewed);
  const deleteStory = useAppStore((state) => state.deleteStory);

  // El parametro es el id del autor; se admite el indice como alternativa.
  const initialAuthor = useMemo(() => {
    const byId = groups.findIndex((g) => g.authorId === id);
    if (byId >= 0) return byId;
    const asIndex = Number(id);
    return Number.isFinite(asIndex) && asIndex >= 0 && asIndex < groups.length ? asIndex : 0;
  }, [id, groups]);

  const [authorIndex, setAuthorIndex] = useState(initialAuthor);
  const [segIndex, setSegIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewersOpen, setViewersOpen] = useState(false);
  const [viewers, setViewers] = useState<StoryViewer[] | null>(null);

  const group = groups[authorIndex];
  const items = group?.items ?? [];
  const item = items[segIndex];

  /**
   * Progreso del tramo. Se anima con `Animated` en vez del `setInterval` de
   * antes, que forzaba un render cada 60 ms. `useNativeDriver` no admite
   * `width`, pero aun asi el valor deja de pasar por el estado de React.
   */
  const progress = useRef(new Animated.Value(0)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const resumeFrom = useRef(0);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  }, [router]);

  const goNext = useCallback(() => {
    if (segIndex + 1 < items.length) {
      setSegIndex(segIndex + 1);
      return;
    }
    if (authorIndex + 1 < groups.length) {
      setAuthorIndex(authorIndex + 1);
      setSegIndex(0);
      return;
    }
    close();
  }, [segIndex, items.length, authorIndex, groups.length, close]);

  const goPrev = useCallback(() => {
    if (segIndex > 0) {
      setSegIndex(segIndex - 1);
      return;
    }
    if (authorIndex > 0) {
      const prev = authorIndex - 1;
      setAuthorIndex(prev);
      setSegIndex(Math.max(0, (groups[prev]?.items.length ?? 1) - 1));
      return;
    }
    setSegIndex(0);
  }, [segIndex, authorIndex, groups]);

  const nextAuthor = useCallback(() => {
    if (authorIndex + 1 < groups.length) {
      setAuthorIndex(authorIndex + 1);
      setSegIndex(0);
    } else {
      close();
    }
  }, [authorIndex, groups.length, close]);

  const prevAuthor = useCallback(() => {
    if (authorIndex > 0) {
      setAuthorIndex(authorIndex - 1);
      setSegIndex(0);
    }
  }, [authorIndex]);

  const runProgress = useCallback(
    (from: number, totalMs: number) => {
      progress.setValue(from);
      const anim = Animated.timing(progress, {
        toValue: 1,
        duration: Math.max(0, totalMs * (1 - from)),
        easing: Easing.linear,
        useNativeDriver: false,
      });
      animation.current = anim;
      anim.start(({ finished }) => {
        if (finished) goNext();
      });
    },
    [progress, goNext],
  );

  // Arranca el tramo y lo marca como visto.
  useEffect(() => {
    if (!item) return;
    resumeFrom.current = 0;
    runProgress(0, item.durationMs);
    markStoryViewed(item.id);
    return () => {
      animation.current?.stop();
    };
  }, [item, runProgress, markStoryViewed]);

  // Mantener pulsado pausa (patron de Instagram); al soltar, continua.
  useEffect(() => {
    if (!item) return;
    if (paused) {
      progress.stopAnimation((value) => {
        resumeFrom.current = value;
      });
    } else if (resumeFrom.current > 0) {
      runProgress(resumeFrom.current, item.durationMs);
    }
  }, [paused, item, progress, runProgress]);

  const openViewers = async () => {
    if (!item) return;
    setPaused(true);
    setViewersOpen(true);
    try {
      setViewers(await StoryRepository.listViewers(item.id));
    } catch {
      setViewers([]);
    }
  };

  const removeStory = async () => {
    if (!item) return;
    setPaused(true);
    const accepted = await confirm({
      title: t('stories.deleteTitle'),
      message: t('stories.deleteBody'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!accepted) {
      setPaused(false);
      return;
    }
    try {
      await deleteStory(item.id);
      toast(t('stories.deleted'));
      close();
    } catch {
      notify(t('common.deleteFailed'), t('common.tryAgain'));
      setPaused(false);
    }
  };

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

  const hold = Gesture.LongPress()
    .minDuration(180)
    .onStart(() => runOnJS(setPaused)(true))
    .onFinalize(() => runOnJS(setPaused)(false));

  const gesture = Gesture.Simultaneous(pan, hold);

  if (!group || !item) {
    return (
      <View style={[styles.root, styles.empty]}>
        <Text style={[styles.author, { color: media.text }]}>No hay historias que mostrar.</Text>
        <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel="Cerrar">
          <Feather name="x" size={26} color={media.text} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/*
        `contain` y no `cover`: una historia se ve ENTERA. Con `cover` se
        rellenaba la pantalla recortando lo que sobraba, asi que una foto que no
        fuera justo vertical perdia los bordes —y con ellos, a menudo, la cara
        de quien la subio—. Lo que queda libre alrededor es negro, como en
        Instagram o TikTok.
      */}
      {item.mediaType === 'video' && item.mediaUrl ? (
        <VideoPlayer
          uri={item.mediaUrl}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          active={!paused}
        />
      ) : (
        <ExpoImage
          source={item.mediaUrl ? { uri: item.mediaUrl } : assets.hero}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={150}
        />
      )}
      <LinearGradient
        colors={[media.overlay, 'transparent', media.overlay]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* Zonas de tap: izquierda retrocede, derecha avanza */}
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={styles.zoneLeft} onPress={goPrev} accessibilityRole="button" accessibilityLabel="Tramo anterior" />
          <Pressable style={styles.zoneRight} onPress={goNext} accessibilityRole="button" accessibilityLabel="Siguiente tramo" />
        </View>
      </GestureDetector>

      <SafeAreaView style={styles.safe} pointerEvents="box-none">
        {/* Barras de progreso, una por tramo */}
        <View style={styles.progressRow} pointerEvents="none">
          {items.map((seg, i) => (
            <View key={seg.id} style={[styles.progressTrack, { backgroundColor: media.border }]}>
              {i === segIndex ? (
                <Animated.View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: media.text,
                      width: progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['0%', '100%'],
                      }),
                    },
                  ]}
                />
              ) : (
                <View
                  style={[
                    styles.progressFill,
                    { backgroundColor: media.text, width: i < segIndex ? '100%' : '0%' },
                  ]}
                />
              )}
            </View>
          ))}
        </View>

        <View style={styles.header}>
          <ExpoImage
            source={group.avatarUrl ? { uri: group.avatarUrl } : assets.avatar}
            style={styles.avatar}
            contentFit="cover"
          />
          <Text style={[styles.author, { color: media.text }]} numberOfLines={1}>
            {group.author}
          </Text>
          {group.isOwn ? (
            <Pressable
              onPress={() => void removeStory()}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('stories.deleteTitle')}
            >
              <Feather name="trash-2" size={20} color={media.text} />
            </Pressable>
          ) : null}
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('stories.close')}>
            <Feather name="x" size={24} color={media.text} />
          </Pressable>
        </View>

        <View style={styles.spacer} pointerEvents="none" />

        {item.caption ? (
          <Text style={[styles.caption, { color: media.text }]} pointerEvents="none">
            {item.caption}
          </Text>
        ) : null}

        {/* Solo el autor ve quien miro su historia. */}
        {group.isOwn ? (
          <Pressable
            onPress={() => void openViewers()}
            style={styles.viewsRow}
            accessibilityRole="button"
            accessibilityLabel={t('stories.whoViewed')}
          >
            <Feather name="eye" size={16} color={media.text} />
            <Text style={[styles.viewsText, { color: media.text }]}>
              {item.viewsCount === 1
                ? t('stories.viewsOne')
                : t('stories.viewsMany', { count: item.viewsCount })}
            </Text>
          </Pressable>
        ) : null}
      </SafeAreaView>

      <BottomSheet
        visible={viewersOpen}
        onClose={() => {
          setViewersOpen(false);
          setPaused(false);
        }}
      >
        <Text style={styles.sheetTitle}>VISTO POR</Text>
        {viewers === null ? (
          <Text style={styles.sheetEmpty}>Cargando…</Text>
        ) : viewers.length === 0 ? (
          <Text style={styles.sheetEmpty}>Todavía no la ha visto nadie.</Text>
        ) : (
          viewers.map((viewer) => (
            <ListRow
              key={viewer.id}
              title={viewer.fullName}
              subtitle={viewer.username}
              leftComponent={
                <ExpoImage
                  source={viewer.avatarUrl ? { uri: viewer.avatarUrl } : assets.avatar}
                  style={styles.viewerAvatar}
                  contentFit="cover"
                />
              }
            />
          ))
        )}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  empty: { alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
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
  caption: { fontSize: 15, lineHeight: 21, fontWeight: '600', marginBottom: spacing.lg },
  viewsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xxl },
  viewsText: { fontSize: 13, fontWeight: '700' },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
    color: media.text,
  },
  sheetEmpty: { fontSize: 13, paddingVertical: spacing.md, color: media.textMuted },
  viewerAvatar: { width: 36, height: 36, borderRadius: 18 },
});
