import React from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { PostCard } from '@/components/PostCard';
import { StateView } from '@/components/StateView';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

export function SavedScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  const posts = useAppStore((state) => state.posts);
  const savedIds = useAppStore((state) => state.savedPostIds);

  const saved = posts.filter((p) => savedIds.includes(p.id));

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Guardados"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/profile'))}
      />
      {saved.length === 0 ? (
        <StateView
          state="empty"
          icon="bookmark"
          title="Sin publicaciones guardadas"
          description="Toca el marcador en una publicación para guardarla aquí."
        />
      ) : (
        <FlashList
          data={saved}
          keyExtractor={(item: Post) => item.id}
          contentContainerStyle={styles.content}
          renderItem={({ item }: { item: Post }) => <PostCard post={item} />}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
});
