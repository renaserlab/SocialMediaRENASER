import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { notify } from '@/lib/confirm';
import { haptics } from '@/lib/haptics';
import { pickImage, pickVideo, takePhoto, uploadPostMedia } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { StoryGroup } from '@/types';

const BUBBLE = 54;
/** Tope de duracion de una historia; coincide con el CHECK de la migracion. */
const MAX_STORY_MS = 15_000;
/** Lo que dura una foto en el visor. */
const PHOTO_MS = 5_000;

type Source = 'gallery-photo' | 'gallery-video' | 'camera';

/**
 * Fila de historias del inicio.
 *
 * Sigue el patron de Instagram: tu burbuja va primera, con un `+` cuando aun no
 * has publicado nada; el anillo distingue lo que te falta por ver.
 */
export function StoriesRow() {
  const { colors } = useAppTheme();
  const router = useRouter();

  const groups = useAppStore((state) => state.storyGroups);
  const status = useAppStore((state) => state.storiesStatus);
  const loadStories = useAppStore((state) => state.loadStories);
  const createStory = useAppStore((state) => state.createStory);
  const user = useAppStore((state) => state.user);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    void loadStories();
  }, [loadStories]);

  const own = groups.find((group) => group.isOwn) ?? null;
  const others = groups.filter((group) => !group.isOwn);

  const openStory = (authorId: string) => {
    haptics.light();
    router.push(`/stories/${authorId}` as never);
  };

  /**
   * Como en Instagram, la burbuja propia son dos acciones: tocar la foto ve tu
   * historia (si la tienes) y el boton `+` siempre anade una nueva.
   */
  const onOwnPress = () => {
    haptics.light();
    if (own) {
      router.push(`/stories/${own.authorId}` as never);
      return;
    }
    setSheetOpen(true);
  };

  const onAddPress = () => {
    haptics.light();
    setSheetOpen(true);
  };

  const publish = async (source: Source) => {
    setSheetOpen(false);
    try {
      const picked =
        source === 'gallery-photo'
          ? await pickImage([9, 16])
          : source === 'camera'
          ? await takePhoto([9, 16])
          : await pickVideo(MAX_STORY_MS / 1000);
      if (!picked) return;

      // `videoMaxDuration` solo limita la camara, asi que el recorte real de la
      // galeria hay que comprobarlo aqui.
      const duration = picked.durationMs ?? 0;
      if (picked.kind === 'video' && duration > MAX_STORY_MS) {
        notify(
          'El video es muy largo',
          `Las historias admiten hasta ${MAX_STORY_MS / 1000} segundos. Recorta el video e inténtalo de nuevo.`,
        );
        return;
      }

      setUploading(true);
      const uploaded = await uploadPostMedia(picked);
      await createStory(uploaded, picked.kind === 'video' ? Math.max(1000, duration) : PHOTO_MS);
    } catch (error) {
      notify(
        'No se pudo publicar la historia',
        error instanceof Error ? error.message : 'Inténtalo de nuevo.',
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {/* Tu historia: la foto abre la tuya y el `+` anade otra. */}
        {/*
          El `+` NO puede ir dentro del Pressable de la burbuja: en web cada
          Pressable es un <button> y anidarlos es HTML invalido (rompe la
          hidratacion). Van como hermanos dentro del mismo contenedor, que es
          lo que posiciona el badge absoluto.
        */}
        <View style={styles.item}>
          <View>
            <Pressable
              onPress={onOwnPress}
              accessibilityRole="button"
              accessibilityLabel={own ? 'Ver tu historia' : 'Añadir a tu historia'}
              style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
            >
              <Ring seen={own?.seen ?? true} hasStory={!!own}>
                <ExpoImage
                  // Tu foto local (edicion de perfil) tiene prioridad; si no, la
                  // del backend; y en ultimo caso el placeholder.
                  source={
                    user?.avatarUrl
                      ? { uri: user.avatarUrl }
                      : own?.avatarUrl
                      ? { uri: own.avatarUrl }
                      : assets.avatar
                  }
                  style={styles.avatar}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                />
              </Ring>
            </Pressable>
            {/*
              El `+` se muestra SIEMPRE, tengas o no historia: es el acceso a
              publicar otra. Antes solo aparecia sin historias, asi que al subir
              la primera desaparecia la forma de anadir mas.
            */}
            {uploading ? (
              <View
                style={[styles.badge, { backgroundColor: colors.text, borderColor: colors.background }]}
              >
                <ActivityIndicator size="small" color={colors.background} />
              </View>
            ) : (
              <Pressable
                onPress={onAddPress}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Añadir a tu historia"
                style={({ pressed }) => [
                  styles.badge,
                  {
                    backgroundColor: colors.text,
                    borderColor: colors.background,
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}
              >
                <Feather name="plus" size={13} color={colors.background} />
              </Pressable>
            )}
          </View>
          <Text numberOfLines={1} style={styles.label} color={colors.text}>
            Tu historia
          </Text>
        </View>

        {others.map((group) => (
          <Bubble key={group.authorId} group={group} onPress={() => openStory(group.authorId)} />
        ))}

        {status === 'loading' && groups.length === 0 ? (
          <View style={styles.item}>
            <ActivityIndicator color={colors.textMuted} />
          </View>
        ) : null}
      </ScrollView>

      <BottomSheet visible={sheetOpen} onClose={() => setSheetOpen(false)}>
        <Text style={styles.sheetTitle} color={colors.text}>
          Añadir a tu historia
        </Text>
        <ListRow title="Foto de la galería" leftIcon="image" onPress={() => void publish('gallery-photo')} />
        <ListRow
          title="Video de la galería"
          subtitle={`Hasta ${MAX_STORY_MS / 1000} segundos`}
          leftIcon="video"
          onPress={() => void publish('gallery-video')}
        />
        <ListRow title="Tomar foto" leftIcon="camera" onPress={() => void publish('camera')} />
      </BottomSheet>
    </View>
  );
}

/** Anillo del avatar: marcado si queda algo por ver, apagado si ya lo viste. */
function Ring({
  seen,
  hasStory,
  children,
}: {
  seen: boolean;
  hasStory: boolean;
  children: React.ReactNode;
}) {
  const { colors } = useAppTheme();
  return (
    <View
      style={[
        styles.ring,
        {
          // Sin historias no hay anillo; visto = gris apagado; sin ver = solido.
          borderColor: !hasStory ? 'transparent' : seen ? colors.border : colors.text,
          borderWidth: hasStory ? 2 : 0,
        },
      ]}
    >
      {children}
    </View>
  );
}

function Bubble({ group, onPress }: { group: StoryGroup; onPress: () => void }) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Ver historia de ${group.author}`}
      style={({ pressed }) => [styles.item, { opacity: pressed ? 0.8 : 1 }]}
    >
      <Ring seen={group.seen} hasStory>
        <ExpoImage
          source={group.avatarUrl ? { uri: group.avatarUrl } : assets.avatar}
          style={styles.avatar}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      </Ring>
      <Text numberOfLines={1} style={styles.label} color={colors.text}>
        {group.author}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.lg },
  item: { alignItems: 'center', gap: 6, width: BUBBLE + 16 },
  ring: {
    width: BUBBLE + 8,
    height: BUBBLE + 8,
    borderRadius: (BUBBLE + 8) / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: { width: BUBBLE, height: BUBBLE, borderRadius: BUBBLE / 2 },
  badge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 10, maxWidth: BUBBLE + 16, textAlign: 'center', fontWeight: '600' },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
});
