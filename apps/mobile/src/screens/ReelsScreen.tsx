import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { ShortVideoItem, type ReelItem } from '@/components/ShortVideoItem';
import { Text } from '@/components/Text';
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
  /*
    Esta pantalla no tenia ningun estado que contar.

    Con la lista vacia —da igual si porque no hay videos o porque la peticion
    fallo— quedaba una pantalla NEGRA con una flecha de volver y nada mas: ni
    «cargando», ni «todavia no hay shorts», ni aviso de fallo. Parecia que la
    aplicacion se hubiera colgado, y no habia forma de reintentar.
  */
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando');
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (!AuthRepository.enabled) {
      setEstado('listo');
      return;
    }
    let alive = true;
    setEstado('cargando');
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
        setEstado('listo');
      })
      .catch((error) => {
        console.warn('[shorts] no se pudieron cargar los videos', error);
        if (!alive) return;
        setReels([]);
        setEstado('error');
      });
    return () => {
      alive = false;
    };
  }, [currentUserId, intento]);

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

  /*
    El aviso se pinta con la paleta oscura de la propia pantalla, no con la del
    tema de la aplicacion: los shorts son siempre fondo negro y un texto en
    color de tema claro seria ilegible aqui.
  */
  const aviso =
    estado === 'cargando' ? (
      <View style={styles.aviso}>
        <ActivityIndicator color={media.text} />
      </View>
    ) : estado === 'error' ? (
      <View style={styles.aviso}>
        <Feather name="wifi-off" size={32} color={media.text} />
        <Text variant="title" weight="800" color={media.text} style={styles.avisoTexto}>
          No pudimos cargar los shorts
        </Text>
        <Text variant="body" color={media.textMuted} style={styles.avisoTexto}>
          Revisa tu conexión e inténtalo de nuevo.
        </Text>
        <Pressable
          onPress={() => setIntento((n) => n + 1)}
          style={[styles.avisoBoton, { borderColor: media.border }]}
          accessibilityRole="button"
        >
          <Text variant="body" weight="700" color={media.text}>
            Reintentar
          </Text>
        </Pressable>
      </View>
    ) : reels.length === 0 ? (
      <View style={styles.aviso}>
        <Feather name="video-off" size={32} color={media.text} />
        <Text variant="title" weight="800" color={media.text} style={styles.avisoTexto}>
          Todavía no hay shorts
        </Text>
        <Text variant="body" color={media.textMuted} style={styles.avisoTexto}>
          Cuando alguien publique un vídeo aparecerá aquí.
        </Text>
      </View>
    ) : null;

  return (
    <View style={styles.root}>
      {aviso}
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
  aviso: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    zIndex: 10,
  },
  avisoTexto: { textAlign: 'center' },
  avisoBoton: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    minHeight: 44,
    justifyContent: 'center',
  },
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
