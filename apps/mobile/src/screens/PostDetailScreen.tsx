import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { PostCard } from '@/components/PostCard';
import { StateView } from '@/components/StateView';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();

  const post = useAppStore((state) => state.posts.find((p) => p.id === id));

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/home'));

  if (!post) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Publicación" onBack={goBack} />
        <StateView
          state="empty"
          icon="file-text"
          title="Publicación no disponible"
          description="Es posible que se haya eliminado o aún no esté en tu feed."
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Publicación" onBack={goBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <PostCard post={post} />
        <ListRow
          title="Ver todos los comentarios"
          subtitle={`${post.commentsCount ?? post.comments.length} comentarios`}
          leftIcon="message-square"
          rightIcon="chevron-right"
          onPress={() => router.push(`/comments/${post.id}` as never)}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
});
