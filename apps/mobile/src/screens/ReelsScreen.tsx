import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { ShortVideoItem, type ReelItem } from '@/components/ShortVideoItem';
import { Text } from '@/components/Text';
import { useBackgroundAudio } from '@/hooks/useBackgroundAudio';
import { perfMark } from '@/lib/perf';
import { bestVideoSource } from '@/lib/videoSource';
import { AuthRepository } from '@/repositories/AuthRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import { palette, spacing } from '@/theme/tokens';
import type { Post } from '@/types';

const media = palette('dark');

/**
 * Cuantos videos por pagina. Antes se pedian 30 con todas sus firmas para
 * ensenar UNO; con paginas cortas el primero llega antes y el resto se trae
 * segun el usuario se acerca al final.
 */
const REELS_PAGE = 6;

/** Post con video → item del feed vertical. */
function toReel(post: Post): ReelItem | null {
  const source = bestVideoSource(post);
  if (!source) return null;
  return {
    id: post.id,
    author: post.author,
    authorId: post.authorId,
    avatarUrl: post.authorAvatarUrl,
    caption: post.body,
    uri: source.uri,
    isStream: source.isStream,
    posterUrl: post.posterUrl,
    posterPath: post.posterPath,
    createdAtIso: post.createdAtIso,
    likes: post.likes,
    comments: post.commentsCount ?? 0,
  };
}

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
  /*
    Paginacion incremental. `hasMore` se apaga cuando una pagina llega corta o
    no aporta ids nuevos: esto ultimo protege contra un backend anterior al
    cursor, que ignoraria los parametros y devolveria siempre la primera
    pagina.
  */
  const [hasMore, setHasMore] = useState(true);
  const loadingMore = useRef(false);

  useEffect(() => {
    if (!AuthRepository.enabled) {
      setEstado('listo');
      return;
    }
    let alive = true;
    setEstado('cargando');
    PostRepository.listVideos(currentUserId, { limit: REELS_PAGE })
      .then((posts) => {
        if (!alive) return;
        perfMark('REELS_FIRST_PAGE');
        setReels(posts.map(toReel).filter((r): r is ReelItem => r !== null));
        setHasMore(posts.length === REELS_PAGE);
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

  const loadMore = useCallback(() => {
    if (!AuthRepository.enabled || !hasMore || loadingMore.current) return;
    const last = reels[reels.length - 1];
    if (!last) return;
    loadingMore.current = true;
    PostRepository.listVideos(currentUserId, {
      limit: REELS_PAGE,
      // Cursor y offset a la vez: el backend nuevo usa el cursor (no repite
      // aunque entren videos nuevos); uno viejo lo ignora y usa el offset.
      offset: reels.length,
      beforeCreatedAt: last.createdAtIso,
      beforeId: last.id,
    })
      .then((posts) => {
        const conocidos = new Set(reels.map((r) => r.id));
        const nuevos = posts
          .map(toReel)
          .filter((r): r is ReelItem => r !== null && !conocidos.has(r.id));
        if (nuevos.length > 0) setReels((prev) => [...prev, ...nuevos]);
        // Pagina corta o sin novedades: no hay mas que pedir.
        setHasMore(posts.length === REELS_PAGE && nuevos.length > 0);
      })
      .catch(() => {
        // Se reintentara la proxima vez que el usuario se acerque al final.
      })
      .finally(() => {
        loadingMore.current = false;
      });
  }, [currentUserId, hasMore, reels]);

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
            // Ventana de reproductores: el visible y sus vecinos inmediatos.
            // Nunca hay mas de 3 vivos; el resto son posters.
            preload={Math.abs(index - activeIndex) <= 1}
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
        // La siguiente pagina se pide con dos pantallas de antelacion: al
        // ritmo de un swipe por video, llega antes de alcanzar el final.
        onEndReached={loadMore}
        onEndReachedThreshold={2}
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
