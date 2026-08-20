import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { SegmentedControl } from '@/components/SegmentedControl';
import { Text } from '@/components/Text';
import { VideoTile } from '@/components/VideoTile';
import { assets } from '@/data/assets';
import { GRID_GAP, gridItemSize } from '@/lib/gridLayout';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

type Props = {
  gallery: Post[];
  /** Audios publicados. Ya no se muestran como pestaña, pero se conservan
   *  para el podcast del perfil (siguiente iteración). */
  audios?: Post[];
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
export function ProfileGallery({ gallery, loading, error, emptyHint }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();

  /*
    El lado de cada celda se calcula midiendo el contenedor, en pixeles.

    Antes se definia con un ancho en porcentaje y la altura deducida de la
    proporcion, y eso no se resuelve igual en el navegador que en el movil: en
    el navegador salia bien, y en la aplicacion instalada las celdas se
    quedaban sin altura. El perfil anunciaba «3 publicaciones» y debajo no
    habia nada, ni las fotos ni el aviso de que no hubiera ninguna.
  */
  const [anchoCuadricula, setAnchoCuadricula] = useState(0);
  const lado = gridItemSize(anchoCuadricula);

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

  const items = gallery;

  return (
    <View style={styles.wrap}>
      {/*
        Solo "Publicaciones". Los audios publicados siguen llegando en `audios`
        y se muestran en el podcast del perfil, no como una pestaña aparte.
      */}
      <SegmentedControl
        options={[`Publicaciones ${gallery.length}`]}
        selectedIndex={0}
        onChange={() => {}}
        style={styles.tabs}
      />

      {items.length === 0 ? (
        <View style={styles.center}>
          <Feather name="camera" size={30} color={colors.textMuted} />
          <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
            {emptyHint ?? 'Aún no hay publicaciones.'}
          </Text>
        </View>
      ) : (
        <View
          style={styles.grid}
          onLayout={(event) => setAnchoCuadricula(event.nativeEvent.layout.width)}
        >
          {/* Hasta medir no se dibuja: pintar con un tamano inventado daria un salto. */}
          {lado === 0 ? null : gallery.map((post) => (
            <Pressable
              key={post.id}
              style={[styles.tile, { width: lado, height: lado }]}
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
                  // Sin reproductor: en una cuadricula no se reproduce nada.
                  <VideoTile
                    uri={post.mediaUrl}
                    posterUrl={post.posterUrl}
                    posterCacheKey={post.posterPath}
                  />
                ) : post.mediaUrl || post.imageKey ? (
                  <ExpoImage
                    source={post.mediaUrl ? { uri: post.mediaUrl } : assets[post.imageKey!]}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    // La cuadricula reaprovecha las mismas casillas al
                    // desplazarse; sin esta marca la miniatura anterior sigue
                    // ocupando memoria hasta que le toca soltarse.
                    recyclingKey={post.mediaUrl ?? post.imageKey}
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  // El tamano llega medido en pixeles; aqui solo lo que no depende de el.
  tile: { overflow: 'hidden', backgroundColor: '#000' },
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
});
