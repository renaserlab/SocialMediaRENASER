import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { StoriesRow } from '@/components/StoriesRow';
import { PostCard } from '@/components/PostCard';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { Skeleton } from '@/components/Skeleton';
import { assets } from '@/data/assets';
import { AuthRepository } from '@/repositories/AuthRepository';
import { CommunityRepository, type CircleDetail } from '@/repositories/CommunityRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { CreateCatalogSheet, type CatalogKind } from '@/components/CreateCatalogSheet';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

export function HomeScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const keyboardOffset = useKeyboardOffset();
  const posts = useAppStore((state) => state.posts);
  const user = useAppStore((state) => state.user);
  const firstName = user?.fullName?.trim().split(' ')[0];
  const feedStatus = useAppStore((state) => state.feedStatus);
  const feedHasMore = useAppStore((state) => state.feedHasMore);
  const feedLoadingMore = useAppStore((state) => state.feedLoadingMore);
  const loadFeed = useAppStore((state) => state.loadFeed);
  const loadMoreFeed = useAppStore((state) => state.loadMoreFeed);

  // Circulo destacado real, para el contador y el enlace de la tarjeta.
  const [circle, setCircle] = useState<CircleDetail | null>(null);
  /**
   * Perfil del administrador. Darren gestiona la aplicacion, asi que los
   * eventos y los cursos viven en su perfil: las tarjetas de abajo llevan alli
   * a cualquier usuario, a la seccion que haya elegido.
   */
  const [adminId, setAdminId] = useState<string | null>(null);
  useEffect(() => {
    if (!AuthRepository.enabled) return;
    CommunityRepository.list()
      .then((list) => setCircle(list[0] ?? null))
      .catch(() => setCircle(null));
    ProfileRepository.listFeatured()
      .then((list) => setAdminId((list.find((m) => m.isAdmin) ?? list[0])?.id ?? null))
      .catch(() => setAdminId(null));
  }, []);

  /**
   * Solo el administrador ve el acceso para publicar. El permiso de verdad lo
   * aplica el backend (`require_admin`); esto es comodidad, no seguridad.
   */
  const isAdmin = user?.isAdmin === true;
  const [creating, setCreating] = useState<CatalogKind | null>(null);

  const openAdminSection = (section: 'eventos' | 'cursos') => {
    if (!adminId) return;
    router.push({ pathname: '/profile/[id]', params: { id: adminId, section } } as never);
  };

  const [feedTab, setFeedTab] = useState(0);

  // Antes el indice se guardaba pero no se usaba: ambas pestañas mostraban el
  // mismo feed global. Ahora "Siguiendo" pide al backend solo lo de los
  // perfiles que sigue el usuario.
  const changeTab = (index: number) => {
    setFeedTab(index);
    void loadFeed(index === 1 ? 'following' : 'all');
  };
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
      {/* Historias reales del backend (subida + anillo visto/sin ver) */}
      <StoriesRow />

      <View style={styles.container}>
        <SegmentedControl
          options={['Para ti', 'Siguiendo']}
          selectedIndex={feedTab}
          onChange={changeTab}
          style={styles.tabs}
        />

        <Pressable
          onPress={() => router.navigate('/(tabs)/create')}
          style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}
          accessibilityLabel="Crear nueva publicación"
          accessibilityRole="button"
        >
          {/* Tu foto real; el marcador solo mientras no haya perfil cargado. */}
          <ExpoImage
            source={user?.avatarUrl ? { uri: user.avatarUrl } : assets.avatar}
            style={styles.composerAvatar}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
          />
          <Text style={[styles.composerText, { color: colors.textMuted }]}>
            {/* Sin nombre se saluda en generico: antes caia a un "Katherine"
                fijo del demo y se le mostraba a cualquier usuario. */}
            {firstName ? `¿Qué estás aprendiendo hoy, ${firstName}?` : '¿Qué estás aprendiendo hoy?'}
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
            onPress={() => circle && router.push(`/circle/${circle.id}` as never)}
            disabled={!circle}
            style={[styles.quickCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
          >
            <Feather name="users" size={24} color={colors.text} />
            <Text style={[styles.quickTitle, { color: colors.text }]}>Tu círculo</Text>
            {/* Contador real; antes era "423 personas" escrito a mano. */}
            <Text style={[styles.quickBody, { color: colors.textMuted }]}>
              {circle ? `${circle.members} personas avanzando` : 'Únete a la comunidad'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.quickRow}>
          <Pressable
            onPress={() => openAdminSection('eventos')}
            disabled={!adminId}
            style={[styles.quickCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Ver eventos"
          >
            <View style={styles.quickHeader}>
              <Feather name="calendar" size={24} color={colors.text} />
              {isAdmin ? (
                <Pressable
                  onPress={() => setCreating('evento')}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Agregar evento"
                  style={[styles.addBadge, { backgroundColor: colors.text }]}
                >
                  <Feather name="plus" size={14} color={colors.background} />
                </Pressable>
              ) : null}
            </View>
            <Text style={[styles.quickTitle, { color: colors.text }]}>Eventos</Text>
            {isAdmin ? (
              <Pressable
                onPress={() => setCreating('evento')}
                style={[styles.addChip, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Agregar evento"
              >
                <Text style={[styles.addChipText, { color: colors.text }]}>Agregar evento</Text>
              </Pressable>
            ) : (
              <Text style={[styles.quickBody, { color: colors.textMuted }]}>Encuentros y experiencias</Text>
            )}
          </Pressable>
          <Pressable
            onPress={() => openAdminSection('cursos')}
            disabled={!adminId}
            style={[styles.quickCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Ver cursos"
          >
            <View style={styles.quickHeader}>
              <Feather name="book" size={24} color={colors.text} />
              {isAdmin ? (
                <Pressable
                  onPress={() => setCreating('curso')}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Agregar curso"
                  style={[styles.addBadge, { backgroundColor: colors.text }]}
                >
                  <Feather name="plus" size={14} color={colors.background} />
                </Pressable>
              ) : null}
            </View>
            <Text style={[styles.quickTitle, { color: colors.text }]}>Cursos</Text>
            {isAdmin ? (
              <Pressable
                onPress={() => setCreating('curso')}
                style={[styles.addChip, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Agregar curso"
              >
                <Text style={[styles.addChipText, { color: colors.text }]}>Agregar curso</Text>
              </Pressable>
            ) : (
              <Text style={[styles.quickBody, { color: colors.textMuted }]}>Programas para avanzar</Text>
            )}
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

      {/* El comentario inline de PostCard vive dentro de esta lista: el KAV debe
          estar a nivel de pantalla, nunca dentro del item. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
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
        keyboardShouldPersistTaps="handled"
      />
      </KeyboardAvoidingView>

      {creating ? (
        <CreateCatalogSheet
          kind={creating}
          visible
          onClose={() => setCreating(null)}
          onCreated={() => void loadFeed()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  tabs: { marginBottom: spacing.lg },
  composer: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.md, marginBottom: spacing.lg },
  composerAvatar: { width: 40, height: 40, borderRadius: 20 },
  composerText: { flex: 1, fontSize: 13 },
  quickRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  quickCard: { flex: 1, minHeight: 136, borderRadius: radius.lg, padding: spacing.lg, justifyContent: 'space-between' },
  quickHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  addBadge: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  addChip: { borderWidth: 1, borderRadius: radius.pill, paddingVertical: 5, paddingHorizontal: 10, alignSelf: 'flex-start' },
  addChipText: { fontSize: 10, fontWeight: '700' },
  quickTitle: { fontSize: 15, fontWeight: '900', marginTop: spacing.md },
  quickBody: { fontSize: 11, lineHeight: 16, opacity: 0.82 },
  footer: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, paddingBottom: 100 },
  skeletonContainer: { gap: spacing.md },
  skeletonCard: { padding: spacing.lg, borderWidth: 1, borderRadius: radius.md, gap: spacing.md },
  skeletonHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
