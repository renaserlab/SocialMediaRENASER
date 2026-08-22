import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Feather } from '@expo/vector-icons';

import { ShortVideoItem, type ReelItem } from '@/components/ShortVideoItem';
import { Text } from '@/components/Text';
import type { FeedDeVideos } from '@/hooks/useFeedDeVideos';
import { palette, spacing } from '@/theme/tokens';

// Superficie a pantalla completa sobre video → contexto de media (oscuro).
const media = palette('dark');

type Props = {
  feed: FeedDeVideos;
  /** Alto de una pagina: una pantalla exacta, para que el ajuste sea limpio. */
  altura: number;
  /** El feed de la pestana que se esta viendo. Los demas no reproducen nada. */
  activo: boolean;
  /** Silencio compartido por todo el Inicio, no video a video. */
  silenciado: boolean;
  alCambiarSilencio: () => void;
  alForzarSilencio: () => void;
  /** Hueco reservado abajo para que la barra no tape los controles. */
  espacioInferior: number;
  /** Que ensenar cuando no hay ni un video (cada pestana dice lo suyo). */
  vacio?: React.ReactNode;
};

/**
 * Feed vertical de videos a pantalla completa.
 *
 * Es el corazon del nuevo Inicio y esta separado de la pantalla porque hay
 * TRES usos del mismo componente —"Para ti", "Siguiendo" y cualquier feed
 * futuro— y duplicarlo significaria arreglar cada problema de reproduccion
 * tres veces.
 *
 * Lo que hace que se sienta inmediato, y que conviene no deshacer:
 *  - Solo el video visible reproduce; sus vecinos existen ya preparados. Nunca
 *    hay mas de tres reproductores vivos, que es lo que evita quedarse sin
 *    memoria nativa en Android.
 *  - El resto de celdas son su poster: una imagen, cero red y cero memoria.
 *  - La siguiente pagina se pide con dos pantallas de antelacion, asi que al
 *    ritmo de un deslizamiento por video llega antes de hacer falta.
 */
export function FeedVerticalDeVideos({
  feed,
  altura,
  activo,
  silenciado,
  alCambiarSilencio,
  alForzarSilencio,
  espacioInferior,
  vacio,
}: Props) {
  const [indiceActivo, setIndiceActivo] = useState(0);
  const [refrescando, setRefrescando] = useState(false);

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      const primero = viewableItems[0];
      if (primero && typeof primero.index === 'number') setIndiceActivo(primero.index);
    },
  ).current;

  const refrescar = useCallback(async () => {
    setRefrescando(true);
    try {
      await feed.refrescar();
    } finally {
      setRefrescando(false);
    }
  }, [feed]);

  const aviso =
    feed.estado === 'cargando' ? (
      <View style={styles.aviso}>
        <ActivityIndicator color={media.text} />
      </View>
    ) : feed.estado === 'error' ? (
      <View style={styles.aviso}>
        <Feather name="wifi-off" size={32} color={media.text} />
        <Text variant="title" weight="800" color={media.text} style={styles.avisoTexto}>
          No pudimos cargar el contenido
        </Text>
        <Text variant="body" color={media.textMuted} style={styles.avisoTexto}>
          {/* Se dice el motivo real: si el telefono esta sin cobertura, saberlo
              evita leerlo como un fallo de la aplicacion. */}
          {feed.error ?? 'Revisa tu conexión e inténtalo de nuevo.'}
        </Text>
        <Pressable
          onPress={feed.reintentar}
          style={[styles.avisoBoton, { borderColor: media.border }]}
          accessibilityRole="button"
        >
          <Text variant="body" weight="700" color={media.text}>
            Reintentar
          </Text>
        </Pressable>
      </View>
    ) : feed.items.length === 0 ? (
      <View style={styles.aviso}>{vacio}</View>
    ) : null;

  return (
    <View style={styles.raiz}>
      {aviso}

      {/*
        Se dice que lo que se ve esta guardado y que los videos no van a sonar.
        Callarlo dejaria a alguien tocando una portada sin que pasara nada, sin
        entender por que.
      */}
      {feed.desdeCache && activo ? (
        <View style={[styles.sinRed, { borderColor: media.border }]} pointerEvents="none">
          <Feather name="wifi-off" size={13} color={media.text} />
          <Text variant="caption" weight="700" color={media.text}>
            Sin conexión · contenido guardado
          </Text>
        </View>
      ) : null}
      <FlashList
        data={feed.items}
        keyExtractor={(item: ReelItem) => item.id}
        renderItem={({ item, index }: { item: ReelItem; index: number }) => (
          <ShortVideoItem
            short={item}
            /*
              Un feed que no se esta viendo NO reproduce. Sin esto, al pasar a
              "Siguiendo" el video de "Para ti" seguiria sonando por debajo.
            */
            active={activo && index === indiceActivo}
            preload={activo && Math.abs(index - indiceActivo) <= 1}
            height={altura}
            muted={silenciado}
            onToggleMuted={alCambiarSilencio}
            onForcedMute={alForzarSilencio}
            espacioInferior={espacioInferior}
          />
        )}
        pagingEnabled
        // El siguiente se prepara con una pantalla de antelacion: montarlo justo
        // al llegar deja un parpadeo en blanco que se percibe como un tiron.
        drawDistance={altura}
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onEndReached={feed.cargarMas}
        onEndReachedThreshold={2}
        refreshControl={
          <RefreshControl
            refreshing={refrescando}
            onRefresh={refrescar}
            tintColor={media.text}
            colors={[media.text]}
            progressBackgroundColor={media.background}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  aviso: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    zIndex: 10,
  },
  avisoTexto: { textAlign: 'center' },
  sinRed: {
    position: 'absolute',
    alignSelf: 'center',
    top: 108,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    backgroundColor: media.overlay,
    zIndex: 26,
  },
  avisoBoton: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    minHeight: 44,
    justifyContent: 'center',
  },
});
