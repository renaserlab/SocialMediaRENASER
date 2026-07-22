import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { BottomSheet } from '@/components/BottomSheet';
import { ListRow } from '@/components/ListRow';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { confirm, notify } from '@/lib/confirm';
import { haptics } from '@/lib/haptics';
import { TestimonialRepository } from '@/repositories/TestimonialRepository';
import { pickImage, pickVideo, uploadPostMedia } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Testimonial, TestimonialFilter } from '@/types';

const FILTERS: TestimonialFilter[] = ['all', 'image', 'video'];

/**
 * En web el navegador ofrece "Guardar imagen como" en el menu contextual y
 * permite arrastrar la foto fuera. Se desactivan ambos, igual que ya hace
 * VideoPlayer.web con el menu del reproductor.
 *
 * No es una proteccion real —quien abra las herramientas de desarrollo puede
 * guardar el archivo igual—, pero evita la copia accidental o casual.
 */
const noSaveProps =
  Platform.OS === 'web'
    ? ({
        onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
        draggable: false,
      } as Record<string, unknown>)
    : {};

export function TestimonialsScreen() {
  const { colors } = useAppTheme();
  // Solo la administracion publica; el resto mira. La RLS lo impone de verdad,
  // esto solo evita mostrar botones que no llevarian a ninguna parte.
  const isAdmin = useAppStore((state) => state.user?.isAdmin === true);

  const [filterIndex, setFilterIndex] = useState(0);
  const [items, setItems] = useState<Testimonial[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const filter = FILTERS[filterIndex] ?? 'all';

  const load = useCallback(async () => {
    setStatus((prev) => (prev === 'idle' ? 'idle' : 'loading'));
    try {
      setItems(await TestimonialRepository.list(filter));
      setStatus('idle');
    } catch (error) {
      console.warn('[testimonios] no se pudieron cargar:', error);
      setStatus('error');
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const publish = async (kind: 'image' | 'video') => {
    setSheetOpen(false);
    try {
      const picked = kind === 'image' ? await pickImage() : await pickVideo();
      if (!picked) return;
      setUploading(true);
      const uploaded = await uploadPostMedia(picked);
      await TestimonialRepository.create(uploaded);
      await load();
    } catch (error) {
      notify(
        'No se pudo publicar',
        error instanceof Error ? error.message : 'Inténtalo de nuevo.',
      );
    } finally {
      setUploading(false);
    }
  };

  const remove = async (item: Testimonial) => {
    const accepted = await confirm({
      title: 'Eliminar testimonio',
      message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await TestimonialRepository.remove(item.id);
      haptics.light();
      await load();
    } catch {
      notify('No se pudo eliminar', 'Inténtalo de nuevo.');
    }
  };

  const renderItem = ({ item }: { item: Testimonial }) => (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View {...noSaveProps}>
        {item.mediaType === 'video' && item.mediaUrl ? (
          <VideoPlayer uri={item.mediaUrl} style={styles.media} nativeControls />
        ) : (
          <ExpoImage
            source={item.mediaUrl ? { uri: item.mediaUrl } : undefined}
            style={styles.media}
            contentFit="cover"
            transition={150}
          />
        )}
      </View>

      <View style={styles.cardFooter}>
        <View style={styles.badgeRow}>
          <Feather
            name={item.mediaType === 'video' ? 'video' : 'camera'}
            size={13}
            color={colors.textMuted}
          />
          <Text variant="secondary" color={colors.textMuted}>
            {item.mediaType === 'video' ? 'Video' : 'Foto'}
          </Text>
        </View>
        {isAdmin ? (
          <Pressable
            onPress={() => void remove(item)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Eliminar testimonio"
          >
            <Feather name="trash-2" size={17} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {item.caption ? (
        <Text variant="body" style={styles.caption}>
          {item.caption}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="TESTIMONIOS"
        rightIcon={isAdmin ? (uploading ? 'upload-cloud' : 'plus') : undefined}
        onRightPress={isAdmin && !uploading ? () => setSheetOpen(true) : undefined}
      />

      <View style={styles.filters}>
        <SegmentedControl
          options={['Todos', 'Fotos', 'Videos']}
          selectedIndex={filterIndex}
          onChange={setFilterIndex}
        />
      </View>

      {status === 'loading' && items.length === 0 ? (
        <StateView state="loading" />
      ) : status === 'error' ? (
        <StateView state="error" onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <StateView
          state="empty"
          icon="camera"
          title="Todavía no hay testimonios"
          description={
            isAdmin
              ? 'Publica el primero con el botón + de la cabecera.'
              : 'Vuelve a revisar más adelante.'
          }
        />
      ) : (
        <FlashList
          data={items}
          keyExtractor={(item: Testimonial) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              tintColor={colors.textMuted}
            />
          }
        />
      )}

      <BottomSheet visible={sheetOpen} onClose={() => setSheetOpen(false)}>
        <Text style={styles.sheetTitle} color={colors.text}>
          Nuevo testimonio
        </Text>
        <ListRow title="Foto de la galería" leftIcon="image" onPress={() => void publish('image')} />
        <ListRow title="Video de la galería" leftIcon="video" onPress={() => void publish('video')} />
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  content: { padding: spacing.lg },
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  media: { width: '100%', height: 320 },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  caption: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
});
