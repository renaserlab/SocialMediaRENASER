import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { ShortVideoItem, type ReelItem } from '@/components/ShortVideoItem';
import { useBackgroundAudio } from '@/hooks/useBackgroundAudio';
import { AuthRepository } from '@/repositories/AuthRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import { palette, spacing } from '@/theme/tokens';

const media = palette('dark');

export function ReelsScreen() {
  const router = useRouter();
  const { height } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(0);
  const currentUserId = useAppStore((state) => state.user?.id);

  /*
    Los shorts suenan. El silencio se decide para todo el feed y arranca
    apagado, como en el resto de aplicaciones de video vertical.
  */
  const [muted, setMuted] = useState(false);

  /*
    Prepara la sesion de audio del sistema. Sin esto, en un iPhone con el
    interruptor de silencio puesto el video se ve pero no se oye, y parece que
    el sonido siga sin funcionar.
  */
  useBackgroundAudio();

  // Reels = las publicaciones de video del feed. Antes era una lista fija de
  // shorts inventados con videos de ejemplo.
  const [reels, setReels] = useState<ReelItem[]>([]);
  useEffect(() => {
    if (!AuthRepository.enabled) return;
    let alive = true;
    PostRepository.listVideos(currentUserId)
      .then((posts) => {
        if (!alive) return;
        setReels(
          posts
            .filter((p) => !!p.mediaUrl)
            .map((p) => ({
              id: p.id,
              author: p.author,
              authorId: p.authorId,
              avatarUrl: p.authorAvatarUrl,
              caption: p.body,
              uri: p.mediaUrl!,
              likes: p.likes,
              comments: p.commentsCount ?? 0,
            })),
        );
      })
      .catch(() => {
        if (alive) setReels([]);
      });
    return () => {
      alive = false;
    };
  }, [currentUserId]);

  // Solo el item visible reproduce; el resto se pausa (memoria y batería).
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      const first = viewableItems[0];
      if (first && typeof first.index === 'number') {
        setActiveIndex(first.index);
      }
    },
  ).current;

  /*
    Los manejadores se crean una sola vez. Si se escribieran dentro del render
    de cada fila serian funciones nuevas en cada pasada y `ShortVideoItem`
    volveria a dibujarse aunque no hubiera cambiado nada suyo, que es
    justamente lo que se quiere evitar mientras el dedo desplaza la lista.
  */
  const toggleMuted = useCallback(() => setMuted((previous) => !previous), []);
  const forceMuted = useCallback(() => setMuted(true), []);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  }, [router]);

  return (
    <View style={styles.root}>
      <FlashList
        data={reels}
        keyExtractor={(item: ReelItem) => item.id}
        renderItem={({ item, index }: { item: ReelItem; index: number }) => (
          <ShortVideoItem
            short={item}
            active={index === activeIndex}
            height={height}
            muted={muted}
            onToggleMuted={toggleMuted}
            onForcedMute={forceMuted}
          />
        )}
        pagingEnabled
        // El siguiente video se prepara con una pantalla de antelacion: si se
        // montara justo al llegar, el salto se veria en blanco un instante y
        // se percibe como un tiron.
        drawDistance={height}
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
      />

      <Pressable
        onPress={close}
        style={[styles.backButton, { backgroundColor: media.overlay }]}
        accessibilityRole="button"
        accessibilityLabel="Volver"
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  backButton: {
    position: 'absolute',
    top: 50,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
});
