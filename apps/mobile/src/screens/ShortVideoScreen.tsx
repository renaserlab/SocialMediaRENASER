import React, { useState } from 'react';
import { Share, StyleSheet, Text, View, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { Avatar } from '@/components/Avatar';
import { VideoPlayer } from '@/components/VideoPlayer';
import { assets } from '@/data/assets';
import { SAMPLE_VIDEO_URL } from '@/data/media';
import { palette, spacing } from '@/theme/tokens';

// Superficie full-bleed sobre video → contexto de media (siempre oscuro).
const media = palette('dark');

export function ShortVideoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [liked, setLiked] = useState(false);
  const [likesCount, setLikesCount] = useState(142);

  const toggleLike = () => {
    setLiked(!liked);
    setLikesCount((prev) => prev + (liked ? -1 : 1));
  };

  const onShare = () => {
    Share.share({ message: 'Mira este short de Darren Hardy en RENASER Universo.' }).catch(() => {});
  };

  return (
    <View style={[styles.container, { backgroundColor: media.background }]}>
      {/* Video vertical real (autoplay + loop, silenciado) */}
      <VideoPlayer
        uri={SAMPLE_VIDEO_URL}
        poster={assets.hero}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        loop
        autoPlay
        muted
        nativeControls={false}
      />
      <LinearGradient
        colors={['transparent', media.overlay]}
        style={styles.bottomScrim}
        pointerEvents="none"
      />

      {/* Header back button */}
      <Pressable
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        accessibilityLabel="Volver"
        accessibilityRole="button"
        style={[styles.backButton, { backgroundColor: media.overlay }]}
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>

      {/* Floating Action Bar */}
      <View style={styles.sidebar}>
        <Pressable
          onPress={() => router.push('/profile/darren' as any)}
          style={styles.sidebarItem}
          accessibilityLabel="Perfil del creador"
        >
          <Avatar size={40} image="speaker" />
        </Pressable>

        <Pressable
          onPress={toggleLike}
          style={styles.sidebarItem}
          accessibilityLabel="Dar me gusta"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: liked }}
        >
          <Feather name="heart" size={28} color={liked ? media.danger : media.text} />
          <Text style={[styles.sidebarLabel, { color: media.text }]}>{likesCount}</Text>
        </Pressable>

        <Pressable
          onPress={() => router.push(`/comments/${id || 'video-1'}` as any)}
          style={styles.sidebarItem}
          accessibilityLabel="Comentarios"
        >
          <Feather name="message-square" size={28} color={media.text} />
          <Text style={[styles.sidebarLabel, { color: media.text }]}>28</Text>
        </Pressable>

        <Pressable
          onPress={onShare}
          style={styles.sidebarItem}
          accessibilityLabel="Compartir"
        >
          <Feather name="share-2" size={28} color={media.text} />
          <Text style={[styles.sidebarLabel, { color: media.text }]}>Compartir</Text>
        </Pressable>
      </View>

      {/* Bottom Info Overlay */}
      <View style={styles.bottomInfo}>
        <Text style={[styles.author, { color: media.text }]}>Darren Hardy</Text>
        <Text style={[styles.caption, { color: media.text }]} numberOfLines={2}>
          El secreto de tu éxito se encuentra en tu rutina diaria. Haz que cada día cuente. #crecimiento #mindset #rutina
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '40%',
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
    zIndex: 10,
  },
  sidebar: {
    position: 'absolute',
    right: spacing.md,
    bottom: 120,
    alignItems: 'center',
    gap: spacing.lg,
    zIndex: 10,
  },
  sidebarItem: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
    minHeight: 44,
  },
  sidebarLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: spacing.xs,
    textShadowColor: media.overlay,
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 2,
  },
  bottomInfo: {
    position: 'absolute',
    left: spacing.lg,
    right: 80,
    bottom: 40,
    zIndex: 10,
    gap: spacing.xs,
  },
  author: {
    fontSize: 16,
    fontWeight: '700',
    textShadowColor: media.overlay,
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 2,
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
    textShadowColor: media.overlay,
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 2,
  },
});
