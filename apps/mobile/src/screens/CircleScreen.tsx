import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Card } from '@/components/Card';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Tabs } from '@/components/Tabs';
import { assets } from '@/data/assets';
import { useCircle } from '@/hooks/useCircle';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const circlePosts = [
  { author: 'Darren Hardy', text: 'Bienvenidos a este espacio. Aquí compartimos, aprendemos y nos impulsamos a nuestro siguiente nivel.', likes: 128, comments: 24 },
  { author: 'Ana Sofía', text: 'Hoy puse un límite que llevaba meses postergando. Se sintió incómodo, pero también liberador.', likes: 84, comments: 17 },
];

export function CircleScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // Círculo vía la capa de repositorio (mock hoy, backend mañana).
  const { circle, loading, error, reload } = useCircle(id);

  const [activeTab, setActiveTab] = useState('Feed');
  const [likedPosts, setLikedPosts] = useState<Record<number, boolean>>({});

  const toggleLike = (index: number) => setLikedPosts((prev) => ({ ...prev, [index]: !prev[index] }));

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

              {circlePosts.map((post, index) => {
                const liked = !!likedPosts[index];
                return (
                  <Card key={post.author} style={styles.postCard}>
                    <View style={styles.authorRow}>
                      <Image source={post.author === 'Darren Hardy' ? assets.speaker : assets.avatar} style={styles.avatar} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.author, { color: colors.text }]}>{post.author}</Text>
                        <Text style={[styles.date, { color: colors.textMuted }]}>Hace 3 horas</Text>
                      </View>
                      <Feather name="more-horizontal" size={20} color={colors.textMuted} />
                    </View>

                    <Text style={[styles.postText, { color: colors.text }]}>{post.text}</Text>

                    <View style={[styles.actions, { borderTopColor: colors.border }]}>
                      <Pressable
                        onPress={() => toggleLike(index)}
                        style={styles.action}
                        accessibilityLabel="Me gusta"
                        accessibilityRole="button"
                        accessibilityState={{ selected: liked }}
                      >
                        <Feather name="heart" size={18} color={liked ? colors.danger : colors.text} />
                        <Text style={{ color: colors.text, fontSize: 13 }}>{post.likes + (liked ? 1 : 0)}</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => router.push(`/comments/circle-${index}` as any)}
                        style={styles.action}
                        accessibilityLabel="Comentarios"
                        accessibilityRole="button"
                      >
                        <Feather name="message-square" size={18} color={colors.text} />
                        <Text style={{ color: colors.text, fontSize: 13 }}>{post.comments}</Text>
                      </Pressable>
                    </View>
                  </Card>
                );
              })}
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
    </View>
  );
}

const styles = StyleSheet.create({
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
