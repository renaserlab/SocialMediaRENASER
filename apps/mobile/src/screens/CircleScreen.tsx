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
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

// Las publicaciones del circulo ya NO son un array fijo firmado por gente del
// demo: se piden al backend filtrando por `circle_id` y se pintan con la misma
// tarjeta que el feed, para no mantener dos versiones de lo mismo.

/** Las pestañas del círculo: su identidad y, aparte, el rótulo que se lee. */
const PESTANAS: Array<{ id: 'feed' | 'chat' | 'recursos' | 'eventos'; etiqueta: TranslationKey }> = [
  { id: 'feed', etiqueta: 'circle.tabFeed' },
  { id: 'chat', etiqueta: 'circle.tabChat' },
  { id: 'recursos', etiqueta: 'circle.tabResources' },
  { id: 'eventos', etiqueta: 'home.events' },
];

export function CircleScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // Círculo vía la capa de repositorio (mock hoy, backend mañana).
  const { circle, loading, error, reload } = useCircle(id);

  /*
    La pestaña activa se guarda por su IDENTIFICADOR, no por su rótulo.

    `Tabs` trabaja con textos, y hasta ahora el texto ERA la identidad: con la
    aplicación en inglés, `activeTab === 'Feed'` habría dejado de ser cierto en
    cuanto el rótulo cambiara de idioma y el muro del círculo no se pintaría.
    Aquí se traduce solo lo que se ve, y las comparaciones siguen siendo sobre
    el identificador de siempre.
  */
  const [activeTab, setActiveTab] = useState<'feed' | 'chat' | 'recursos' | 'eventos'>('feed');
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
        <AppHeader title={t('circle.headerTitle')} rightIcon="more-horizontal" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="loading" />
      </View>
    );
  }

  if (error || !circle) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('circle.headerTitle')} rightIcon="more-horizontal" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('circle.headerTitle')}
        rightIcon="more-horizontal"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <SinTecladoDelante>
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.header}>
          <Image source={assets.circle} style={[styles.circleImage, { borderColor: colors.border }]} />
          <Text style={[styles.title, { color: colors.text }]}>{circle.name}</Text>
          <Text style={[styles.members, { color: colors.textMuted }]}>
            {t('circle.members', { count: circle.members })}
          </Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>{circle.description}</Text>
        </View>

        <Tabs
          tabs={PESTANAS.map((p) => t(p.etiqueta))}
          activeTab={t(PESTANAS.find((p) => p.id === activeTab)!.etiqueta)}
          onChangeTab={(rotulo) => {
            const elegida = PESTANAS.find((p) => t(p.etiqueta) === rotulo);
            if (elegida) setActiveTab(elegida.id);
          }}
          style={styles.tabs}
        />

        <View style={styles.container}>
          {activeTab === 'feed' && (
            <React.Fragment>
              <View style={styles.composerWrapper}>
                <Input
                  placeholder={t('circle.composer')}
                  containerStyle={{ flex: 1 }}
                />
              </View>

              {circlePosts.length === 0 ? (
                <Text style={[styles.emptyPosts, { color: colors.textMuted }]}>
                  {t('circle.noPosts')}
                </Text>
              ) : (
                circlePosts.map((post) => <PostCard key={post.id} post={post} />)
              )}
            </React.Fragment>
          )}

          {activeTab !== 'feed' && (
            <StateView
              state="empty"
              icon={activeTab === 'chat' ? 'message-square' : activeTab === 'recursos' ? 'folder' : 'calendar'}
              /*
                Un título por pestaña, entero. Antes se armaba pegando «Aún no
                hay» al rótulo en minúsculas: eso no se puede recolocar en un
                idioma que ordene las palabras de otra forma.
              */
              title={
                activeTab === 'chat'
                  ? t('circle.emptyChatTitle')
                  : activeTab === 'recursos'
                    ? t('circle.emptyResourcesTitle')
                    : t('circle.emptyEventsTitle')
              }
              description={
                activeTab === 'chat'
                  ? t('circle.emptyChat')
                  : activeTab === 'recursos'
                    ? t('circle.emptyResources')
                    : t('circle.emptyEvents')
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
