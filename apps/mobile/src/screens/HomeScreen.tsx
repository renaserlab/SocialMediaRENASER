import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { Avatar } from '@/components/Avatar';
import { PostCard } from '@/components/PostCard';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { Skeleton } from '@/components/Skeleton';
import { assets } from '@/data/assets';
import { stories } from '@/data/mockData';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

export function HomeScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const posts = useAppStore((state) => state.posts);
  const user = useAppStore((state) => state.user);
  const feedStatus = useAppStore((state) => state.feedStatus);
  const feedHasMore = useAppStore((state) => state.feedHasMore);
  const feedLoadingMore = useAppStore((state) => state.feedLoadingMore);
  const loadFeed = useAppStore((state) => state.loadFeed);
  const loadMoreFeed = useAppStore((state) => state.loadMoreFeed);

  const [feedTab, setFeedTab] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadFeed();
    } finally {
      setRefreshing(false);
    }
  }, [loadFeed]);

  const onEndReached = useCallback(() => {
    if (feedHasMore && !feedLoadingMore) {
      void loadMoreFeed();
    }
  }, [feedHasMore, feedLoadingMore, loadMoreFeed]);

  const header = (
    <View>
      {/* Historias / Avatares */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stories}>
        {stories.map((story, index) => (
          <Pressable
            key={story.id}
            onPress={() => router.push(`/stories/${index}` as never)}
            accessibilityRole="button"
            accessibilityLabel={`Ver historia de ${story.author}`}
          >
            <Avatar label={story.author} image={story.avatar} size={54} />
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.container}>
        <SegmentedControl
          options={['Para ti', 'Siguiendo']}
          selectedIndex={feedTab}
          onChange={setFeedTab}
          style={styles.tabs}
        />

        <Pressable
          onPress={() => router.navigate('/(tabs)/create')}
          style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}
          accessibilityLabel="Crear nueva publicación"
          accessibilityRole="button"
        >
          <ExpoImage source={assets.avatar} style={styles.composerAvatar} contentFit="cover" />
          <Text style={[styles.composerText, { color: colors.textMuted }]}>
            ¿Qué estás aprendiendo hoy, {user?.fullName.split(' ')[0] ?? 'Katherine'}?
          </Text>
          <Feather name="plus-circle" size={24} color={colors.text} />
        </Pressable>

        <View style={styles.quickRow}>
          <Pressable
            onPress={() => router.push('/audio/private')}
            style={[styles.quickCard, { backgroundColor: colors.primary }]}
          >
            <Feather name="headphones" size={24} color={colors.onPrimary} />
            <Text style={[styles.quickTitle, { color: colors.onPrimary }]}>Audio privado</Text>
            <Text style={[styles.quickBody, { color: colors.onPrimary }]}>Recomendación de tu quiz</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/circle/lideres-renaser')}
            style={[styles.quickCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
          >
            <Feather name="users" size={24} color={colors.text} />
            <Text style={[styles.quickTitle, { color: colors.text }]}>Tu círculo</Text>
            <Text style={[styles.quickBody, { color: colors.textMuted }]}>423 personas avanzando</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );

  const showInitialLoading = feedStatus === 'loading' && posts.length === 0;

  const empty = showInitialLoading ? (
    <View style={styles.container}>
      <View style={styles.skeletonContainer}>
        {[1, 2].map((i) => (
          <View key={i} style={[styles.skeletonCard, { borderColor: colors.border }]}>
            <View style={styles.skeletonHeader}>
              <Skeleton width={40} height={40} circle />
              <View style={{ gap: 6, flex: 1 }}>
                <Skeleton width="40%" height={12} />
                <Skeleton width="20%" height={10} />
              </View>
            </View>
            <Skeleton width="90%" height={14} />
            <Skeleton width="70%" height={14} />
          </View>
        ))}
      </View>
    </View>
  ) : feedStatus === 'error' ? (
    <StateView state="error" onRetry={() => void loadFeed()} />
  ) : (
    <StateView state="empty" title="Aún no hay publicaciones" description="Vuelve más tarde o crea la primera." />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="RENASER" rightIcon="bell" onRightPress={() => router.push('/notifications')} />

      <FlashList
        data={posts}
        keyExtractor={(item: Post) => item.id}
        renderItem={({ item }: { item: Post }) => (
          <View style={styles.container}>
            <PostCard post={item} />
          </View>
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={
          feedLoadingMore ? (
            <View style={styles.footer}>
              <Skeleton width="90%" height={14} />
            </View>
          ) : (
            <View style={{ height: 100 }} />
          )
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} colors={[colors.text]} />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stories: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
  container: { paddingHorizontal: spacing.lg },
  tabs: { marginBottom: spacing.lg },
  composer: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.md, marginBottom: spacing.lg },
  composerAvatar: { width: 40, height: 40, borderRadius: 20 },
  composerText: { flex: 1, fontSize: 13 },
  quickRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  quickCard: { flex: 1, minHeight: 136, borderRadius: radius.lg, padding: spacing.lg, justifyContent: 'space-between' },
  quickTitle: { fontSize: 15, fontWeight: '900', marginTop: spacing.md },
  quickBody: { fontSize: 11, lineHeight: 16, opacity: 0.82 },
  footer: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, paddingBottom: 100 },
  skeletonContainer: { gap: spacing.md },
  skeletonCard: { padding: spacing.lg, borderWidth: 1, borderRadius: radius.md, gap: spacing.md },
  skeletonHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
