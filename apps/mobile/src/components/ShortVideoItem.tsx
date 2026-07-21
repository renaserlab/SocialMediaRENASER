import React, { useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { VideoPlayer } from '@/components/VideoPlayer';
import { assets } from '@/data/assets';
import { haptics } from '@/lib/haptics';
import { palette, spacing } from '@/theme/tokens';
import type { Short } from '@/types';

// Superficie full-bleed sobre video → contexto de media (siempre oscuro).
const media = palette('dark');

type Props = {
  short: Short;
  /** Solo el item visible reproduce (autoplay por viewport). */
  active: boolean;
  height: number;
};

export function ShortVideoItem({ short, active, height }: Props) {
  const router = useRouter();
  const [liked, setLiked] = useState(false);
  const [likes, setLikes] = useState(short.likes);

  const toggleLike = () => {
    haptics.light();
    setLiked((prev) => {
      setLikes((c) => c + (prev ? -1 : 1));
      return !prev;
    });
  };

  const onShare = () => {
    Share.share({ message: `Mira este short de ${short.author} en Renaser Social Media.` }).catch(() => {});
  };

  return (
    <View style={[styles.container, { height }]}>
      <VideoPlayer
        uri={short.uri}
        poster={assets[short.poster]}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        loop
        muted
        nativeControls={false}
        active={active}
      />
      <LinearGradient colors={['transparent', media.overlay]} style={styles.bottomScrim} pointerEvents="none" />

      <View style={styles.sidebar}>
        <Pressable
          onPress={() => router.push('/profile/darren' as never)}
          style={styles.sidebarItem}
          accessibilityRole="button"
          accessibilityLabel={`Perfil de ${short.author}`}
        >
          <ExpoImage source={assets[short.avatar]} style={styles.avatar} contentFit="cover" />
        </Pressable>

        <Pressable
          onPress={toggleLike}
          style={styles.sidebarItem}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: liked }}
          accessibilityLabel="Dar me gusta"
        >
          <Feather name="heart" size={28} color={liked ? media.danger : media.text} />
          <Text style={[styles.sidebarLabel, { color: media.text }]}>{likes}</Text>
        </Pressable>

        <Pressable
          onPress={() => router.push(`/comments/${short.id}` as never)}
          style={styles.sidebarItem}
          accessibilityRole="button"
          accessibilityLabel="Comentarios"
        >
          <Feather name="message-square" size={28} color={media.text} />
          <Text style={[styles.sidebarLabel, { color: media.text }]}>{short.comments}</Text>
        </Pressable>

        <Pressable onPress={onShare} style={styles.sidebarItem} accessibilityRole="button" accessibilityLabel="Compartir">
          <Feather name="share-2" size={28} color={media.text} />
        </Pressable>
      </View>

      <View style={styles.bottomInfo}>
        <Text style={[styles.author, { color: media.text }]}>{short.author}</Text>
        <Text style={[styles.caption, { color: media.text }]} numberOfLines={2}>
          {short.caption}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', backgroundColor: media.background },
  bottomScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '40%' },
  sidebar: { position: 'absolute', right: spacing.md, bottom: 140, alignItems: 'center', gap: spacing.lg, zIndex: 10 },
  sidebarItem: { alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  sidebarLabel: { fontSize: 12, fontWeight: '600', marginTop: spacing.xs },
  bottomInfo: { position: 'absolute', left: spacing.lg, right: 80, bottom: 60, zIndex: 10, gap: spacing.xs },
  author: { fontSize: 16, fontWeight: '700' },
  caption: { fontSize: 13, lineHeight: 18 },
});
