import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Card } from '@/components/Card';
import { PostCard } from '@/components/PostCard';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Tabs } from '@/components/Tabs';
import { assets } from '@/data/assets';
import { useCircle } from '@/hooks/useCircle';
import { AuthRepository } from '@/repositories/AuthRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import type { Post } from '@/types';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

// Las publicaciones del circulo ya NO son un array fijo firmado por gente del
// demo: se piden al backend filtrando por `circle_id` y se pintan con la misma
// tarjeta que el feed, para no mantener dos versiones de lo mismo.

export function CircleScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // Círculo vía la capa de repositorio (mock hoy, backend mañana).
  const { circle, loading, error, reload } = useCircle(id);

  const [activeTab, setActiveTab] = useState('Feed');
  const [circlePosts, setCirclePosts] = useState<Post[]>([]);

  const currentUserId = useAppStore((state) => state.user?.id);

  // Publicaciones reales del circulo. `circle.id` es el UUID ya resuelto por
  // useCircle, incluso si se entro por el slug antiguo.
  useEffect(() => {
    if (!circle?.id || !AuthRepository.enabled) return;
    let alive = true;
    PostRepository.listByCircle(circle.id, currentUserId)
      .then((posts) => {
        if (alive) setCirclePosts(posts);
      })
      .catch(() => {
        if (alive) setCirclePosts([]);
      });
    return () => {
      alive = false;
    };
  }, [circle?.id, currentUserId]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="CÍRCULO" rightIcon="more-horizontal" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="loading" />
      </View>
    );
  }

  if (error || !circle) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="CÍRCULO" rightIcon="more-horizontal" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="CÍRCULO"
        rightIcon="more-horizontal"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <SinTecladoDelante>
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.header}>
          <Image source={assets.circle} style={[styles.circleImage, { borderColor: colors.border }]} />
          <Text style={[styles.title, { color: colors.text }]}>{circle.name}</Text>
          <Text style={[styles.members, { color: colors.textMuted }]}>{circle.members} miembros</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>{circle.description}</Text>
        </View>

        <Tabs
          tabs={['Feed', 'Chat', 'Recursos', 'Eventos']}
          activeTab={activeTab}
          onChangeTab={setActiveTab}
          style={styles.tabs}
        />

        <View style={styles.container}>
          {activeTab === 'Feed' && (
            <React.Fragment>
              <View style={styles.composerWrapper}>
                <Input
                  placeholder="Escribe algo en el círculo..."
                  containerStyle={{ flex: 1 }}
                />
              </View>

              {circlePosts.length === 0 ? (
                <Text style={[styles.emptyPosts, { color: colors.textMuted }]}>
                  Aún no hay publicaciones en este círculo.
                </Text>
              ) : (
                circlePosts.map((post) => <PostCard key={post.id} post={post} />)
              )}
            </React.Fragment>
          )}

          {activeTab !== 'Feed' && (
            <StateView
              state="empty"
              icon={activeTab === 'Chat' ? 'message-square' : activeTab === 'Recursos' ? 'folder' : 'calendar'}
              title={`Aún no hay ${activeTab.toLowerCase()}`}
              description={
                activeTab === 'Chat'
                  ? 'Sé el primero en iniciar una conversación en el círculo.'
                  : activeTab === 'Recursos'
                    ? 'Los materiales compartidos por el círculo aparecerán aquí.'
                    : 'Los próximos eventos del círculo aparecerán aquí.'
              }
            />
          )}
        </View>
      </AppScreen>
      </SinTecladoDelante>
    </View>
  );
}

const styles = StyleSheet.create({
  emptyPosts: { textAlign: 'center', paddingVertical: spacing.xl, fontSize: 13 },
  header: { alignItems: 'center', paddingHorizontal: spacing.xl, marginTop: spacing.md },
  circleImage: { width: 90, height: 90, borderRadius: 45, borderWidth: 1 },
  title: { fontSize: 20, fontWeight: '900', textAlign: 'center', marginTop: spacing.md },
  members: { fontSize: 12, marginTop: 4 },
  description: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: spacing.md },
  tabs: { marginTop: spacing.lg },
  container: { padding: spacing.lg, gap: spacing.md },
  composerWrapper: {
    marginBottom: spacing.md,
  },
  avatar: { width: 38, height: 38, borderRadius: 19 },
  postCard: {
    padding: spacing.md,
  },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  author: { fontSize: 13, fontWeight: '800' },
  date: { fontSize: 10, marginTop: 2 },
  postText: { fontSize: 14, lineHeight: 20, marginVertical: spacing.md },
  actions: { flexDirection: 'row', gap: spacing.xl, borderTopWidth: 1, paddingTop: spacing.md },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 44, minHeight: 44 },
});
