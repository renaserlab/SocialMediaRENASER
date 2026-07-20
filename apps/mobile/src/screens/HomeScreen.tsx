import React, { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { PostCard } from '@/components/PostCard';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { Skeleton } from '@/components/Skeleton';
import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const stories = [
  { label: 'Tu historia', image: 'avatar' as const },
  { label: 'Reto diario', image: 'speaker' as const },
  { label: 'Alquimia', image: 'hero' as const },
  { label: 'Comunidad', image: 'avatar' as const },
  { label: 'En vivo', image: 'speaker' as const },
];

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

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  const uiState =
    feedStatus === 'loading'
      ? 'loading'
      : feedStatus === 'error'
      ? 'error'
      : posts.length === 0
      ? 'empty'
      : 'content';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="RENASER"
        rightIcon="bell"
        onRightPress={() => router.push('/notifications')}
      />

      <AppScreen contentStyle={{ paddingBottom: 100 }}>
        {/* Historias / Avatares */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stories}>
          {stories.map((story) => (
            <Avatar key={story.label} label={story.label} image={story.image} size={54} />
          ))}
        </ScrollView>

        <View style={styles.container}>
          {/* Segmented Control para Para ti / Siguiendo */}
          <SegmentedControl
            options={['Para ti', 'Siguiendo']}
            selectedIndex={feedTab}
            onChange={setFeedTab}
            style={styles.tabs}
          />

          {/* Creador de posts rápido */}
          <Pressable
            onPress={() => router.push('/(tabs)/create')}
            style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}
            accessibilityLabel="Crear nueva publicación"
            accessibilityRole="button"
          >
            <Image source={assets.avatar} style={styles.composerAvatar} />
            <Text style={[styles.composerText, { color: colors.textMuted }]}>
              ¿Qué estás aprendiendo hoy, {user?.fullName.split(' ')[0] ?? 'Katherine'}?
            </Text>
            <Feather name="plus-circle" size={24} color={colors.text} />
          </Pressable>

          {/* Accesos directos rápidos */}
          <View style={styles.quickRow}>
            <Pressable
              onPress={() => router.push('/audio/private')}
              style={[styles.quickCard, { backgroundColor: colors.primary }]}
            >
              <Feather name="headphones" size={24} color={colors.onPrimary} />
              <Text style={[styles.quickTitle, { color: colors.onPrimary }]}>Audio privado</Text>
              <Text style={[styles.quickBody, { color: colors.onPrimary }]}>
                Recomendación de tu quiz
              </Text>
            </Pressable>
            <Pressable
              onPress={() => router.push('/circle/lideres-renaser')}
              style={[
                styles.quickCard,
                { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
              ]}
            >
              <Feather name="users" size={24} color={colors.text} />
              <Text style={[styles.quickTitle, { color: colors.text }]}>Tu círculo</Text>
              <Text style={[styles.quickBody, { color: colors.textMuted }]}>
                423 personas avanzando
              </Text>
            </Pressable>
          </View>

          {/* Feed real con estados de carga / vacío / error */}
          <StateView
            state={uiState}
            onRetry={() => void loadFeed()}
            loadingComponent={
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
            }
          >
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
            {feedHasMore && (
              <Button
                label="Ver más"
                variant="secondary"
                loading={feedLoadingMore}
                onPress={() => void loadMoreFeed()}
              />
            )}
          </StateView>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  stories: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
  container: { paddingHorizontal: spacing.lg },
  tabs: {
    marginBottom: spacing.lg,
  },
  composer: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.md, marginBottom: spacing.lg },
  composerAvatar: { width: 40, height: 40, borderRadius: 20 },
  composerText: { flex: 1, fontSize: 13 },
  quickRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  quickCard: { flex: 1, minHeight: 136, borderRadius: radius.lg, padding: spacing.lg, justifyContent: 'space-between' },
  quickTitle: { fontSize: 15, fontWeight: '900', marginTop: spacing.md },
  quickBody: { fontSize: 11, lineHeight: 16, opacity: 0.82 },
  skeletonContainer: {
    gap: spacing.md,
  },
  skeletonCard: {
    padding: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.md,
    gap: spacing.md,
  },
  skeletonHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
