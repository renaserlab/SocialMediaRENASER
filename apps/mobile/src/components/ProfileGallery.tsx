import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AudioPlayer } from '@/components/AudioPlayer';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { assets } from '@/data/assets';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

type Props = {
  gallery: Post[];
  audios: Post[];
  loading: boolean;
  error: string | null;
  /** Texto del estado vacío; cambia entre perfil propio y ajeno. */
  emptyHint?: string;
};

/**
 * Galeria de un perfil: cuadricula de fotos/videos y lista de audios.
 *
 * Antes eran seis imagenes fijas del paquete de demo, asi que un perfil real
 * mostraba contenido que no era suyo (y en tema oscuro parecian recuadros
 * vacios). Ahora sale lo que ha publicado esa persona.
 */
export function ProfileGallery({ gallery, audios, loading, error, emptyHint }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const [tab, setTab] = useState(0);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
          {error}
        </Text>
      </View>
    );
  }

  const showingAudios = tab === 1;
  const items = showingAudios ? audios : gallery;

  return (
    <View style={styles.wrap}>
      <SegmentedControl
        options={[`Publicaciones ${gallery.length}`, `Audios ${audios.length}`]}
        selectedIndex={tab}
        onChange={setTab}
        style={styles.tabs}
      />

      {items.length === 0 ? (
        <View style={styles.center}>
          <Feather
            name={showingAudios ? 'headphones' : 'camera'}
            size={30}
            color={colors.textMuted}
          />
          <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
            {showingAudios
              ? 'Aún no hay audios publicados.'
              : (emptyHint ?? 'Aún no hay publicaciones.')}
          </Text>
        </View>
      ) : showingAudios ? (
        <View style={styles.audioList}>
          {audios.map((post) => (
            <Pressable
              key={post.id}
              onPress={() => router.push(`/post/${post.id}` as never)}
              accessibilityRole="button"
              accessibilityLabel={`Abrir audio: ${post.body}`}
            >
              <Text variant="secondary" numberOfLines={1} style={styles.audioTitle}>
                {post.body}
              </Text>
              {post.mediaUrl ? (
                <View pointerEvents="none">
                  <AudioPlayer uri={post.mediaUrl} title={post.createdAt} />
                </View>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={styles.grid}>
          {gallery.map((post) => (
            <Pressable
              key={post.id}
              style={styles.tile}
              onPress={() => router.push(`/post/${post.id}` as never)}
              accessibilityRole="button"
              accessibilityLabel={`Abrir publicación: ${post.body}`}
            >
              {/*
                `pointerEvents="none"` deja pasar el toque a esta celda: sin
                ello los controles del video se lo quedaban y no se abria la
                publicacion (y en web anidaba elementos interactivos).
              */}
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                {post.mediaType === 'video' && post.mediaUrl ? (
                  <VideoPlayer
                    uri={post.mediaUrl}
                    style={StyleSheet.absoluteFill}
                    nativeControls={false}
                    contentFit="cover"
                  />
                ) : post.mediaUrl || post.imageKey ? (
                  <ExpoImage
                    source={post.mediaUrl ? { uri: post.mediaUrl } : assets[post.imageKey!]}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={120}
                  />
                ) : (
                  // Sin URL (p. ej. sesion caducada al firmar): un marcador
                  // neutro. Poner aqui una imagen del demo mostraria contenido
                  // que no es de esta persona.
                  <View style={[styles.placeholder, { backgroundColor: colors.surfaceAlt }]}>
                    <Feather name="image" size={20} color={colors.textMuted} />
                  </View>
                )}
              </View>

              {post.mediaType === 'video' ? (
                <View style={styles.badge} pointerEvents="none">
                  <Feather name="play" size={11} color="#FFFFFF" />
                </View>
              ) : null}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.lg },
  tabs: { marginBottom: spacing.md },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
  centerText: { textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  tile: { width: '32.6%', aspectRatio: 1, overflow: 'hidden', backgroundColor: '#000' },
  badge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  audioList: { gap: spacing.md },
  audioTitle: { fontWeight: '600', marginBottom: spacing.xs },
  audioRow: { borderRadius: radius.lg },
});
