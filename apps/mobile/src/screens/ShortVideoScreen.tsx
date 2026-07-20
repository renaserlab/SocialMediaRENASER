import React, { useState } from 'react';
import { Image, StyleSheet, Text, View, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { Avatar } from '@/components/Avatar';
import { spacing, radius } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { assets } from '@/data/assets';

export function ShortVideoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [liked, setLiked] = useState(false);
  const [likesCount, setLikesCount] = useState(142);

  const toggleLike = () => {
    setLiked(!liked);
    setLikesCount(prev => prev + (liked ? -1 : 1));
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Video cover representation in B&W */}
      <Image
        source={assets.hero}
        style={[styles.videoPlaceholder, { tintColor: 'gray' }]} // visual simulation
      />
      <View style={[styles.overlayShadow, { backgroundColor: 'rgba(0,0,0,0.4)' }]} />

      {/* Header back button */}
      <Pressable
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        accessibilityLabel="Volver"
        accessibilityRole="button"
        style={styles.backButton}
      >
        <Feather name="arrow-left" size={24} color="#FFFFFF" />
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
          <Feather name="heart" size={28} color={liked ? '#FF8A80' : '#FFFFFF'} />
          <Text style={styles.sidebarLabel}>{likesCount}</Text>
        </Pressable>

        <Pressable
          onPress={() => router.push(`/comments/${id || 'video-1'}` as any)}
          style={styles.sidebarItem}
          accessibilityLabel="Comentarios"
        >
          <Feather name="message-square" size={28} color="#FFFFFF" />
          <Text style={styles.sidebarLabel}>28</Text>
        </Pressable>

        <Pressable
          onPress={() => {}}
          style={styles.sidebarItem}
          accessibilityLabel="Compartir"
        >
          <Feather name="share-2" size={28} color="#FFFFFF" />
          <Text style={styles.sidebarLabel}>Compartir</Text>
        </Pressable>
      </View>

      {/* Bottom Info Overlay */}
      <View style={styles.bottomInfo}>
        <Text style={styles.author}>Darren Hardy</Text>
        <Text style={styles.caption} numberOfLines={2}>
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
  videoPlaceholder: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  overlayShadow: {
    ...StyleSheet.absoluteFillObject,
  },
  backButton: {
    position: 'absolute',
    top: 50,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
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
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    marginTop: spacing.xs,
    textShadowColor: 'rgba(0,0,0,0.5)',
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
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 2,
  },
  caption: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 18,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 2,
  },
});
