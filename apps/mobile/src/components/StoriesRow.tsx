import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { haptics } from '@/lib/haptics';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { StoryGroup } from '@/types';

const BUBBLE = 54;

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
  const user = useAppStore((state) => state.user);


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
   * Abre la pantalla de crear historia.
   *
   * Sustituye a la hoja con tres opciones: ahora se entra directo a la camara,
   * como en Instagram, y desde alli se pasa a la galeria. La hoja obligaba a
   * decidir "foto o video" antes de ver nada.
   */
  const nuevaHistoria = () => {
    haptics.light();
    router.push('/stories/nueva' as never);
  };

  const onOwnPress = () => {
    haptics.light();
    if (own) {
      router.push(`/stories/${own.authorId}` as never);
      return;
    }
    nuevaHistoria();
  };

  const onAddPress = nuevaHistoria;


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
});
