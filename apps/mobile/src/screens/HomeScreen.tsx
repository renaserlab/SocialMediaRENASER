import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { CoachMark } from '@/components/CoachMark';
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
import type { ProfileSectionKind } from '@/components/ProfileSection';
import { useTranslation } from '@/i18n/useTranslation';
import { DARREN_NOTICE_ID } from '@/lib/guides';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

export function HomeScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
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

  /**
   * El aviso de contenido gratuito de Darren vive en Notificaciones. Aqui solo
   * se consulta si sigue pendiente para pintar el punto en la campana; no tiene
   * sentido para el propio Darren.
   */
  const darrenNoticePending = useAppStore(
    (state) => !state.dismissedGuides.includes(DARREN_NOTICE_ID) && state.user?.isAdmin !== true,
  );

  /**
   * Perfil donde viven eventos y cursos. Si el propio usuario es el
   * administrador, es SU perfil: el endpoint de destacados excluye a quien
   * mira, asi que Darren no aparece en su propia lista y las tarjetas se
   * quedaban desactivadas para el.
   */
  const catalogProfileId = isAdmin ? (user?.id ?? null) : adminId;

  const openAdminSection = (section: ProfileSectionKind) => {
    if (!catalogProfileId) return;
    router.push({ pathname: '/profile/[id]', params: { id: catalogProfileId, section } } as never);
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
          options={[t('home.forYou'), t('home.following')]}
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
            {firstName ? t('home.composerNamed', { name: firstName }) : t('home.composer')}
          </Text>
          <Feather name="plus-circle" size={24} color={colors.text} />
        </Pressable>

        {/*
          Guia de la primera publicacion. Solo para quien todavia no ha
          publicado: `createPost` sube el contador, asi que se apaga sola en
          cuanto el usuario hace lo que se le pide.
        */}
        <CoachMark
          id="primera-publicacion"
          arrow="up"
          visible={!!user && user.posts === 0}
          text="Comparte tu primera publicación con la comunidad."
          onPress={() => router.navigate('/(tabs)/create')}
        />

        {/* Audio privado ocupa toda la fila; el circulo baja junto al podcast. */}
        <Pressable
          onPress={() => router.push('/audio/private')}
          style={[styles.wideCard, { backgroundColor: colors.primary }]}
        >
          <Feather name="headphones" size={24} color={colors.onPrimary} />
          <Text style={[styles.quickTitle, { color: colors.onPrimary }]}>{t('home.privateAudio')}</Text>
          <Text style={[styles.quickBody, { color: colors.onPrimary }]}>{t('home.privateAudioBody')}</Text>
        </Pressable>

        <View style={styles.quickRow}>
          <View
            style={[styles.quickCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
          >
            {/*
              La zona pulsable va DETRAS del contenido, no envolviendolo: en web
              cada Pressable es un <button> y el "+" anidado dentro producia
              <button> dentro de <button> (HTML invalido, error de hidratacion).
            */}
            <Pressable
              onPress={() => openAdminSection('eventos')}
              disabled={!catalogProfileId}
              style={StyleSheet.absoluteFill}
              accessibilityRole="button"
              accessibilityLabel="Ver eventos"
            />
            <View style={styles.quickHeader} pointerEvents="box-none">
              <View pointerEvents="none">
                <Feather name="calendar" size={24} color={colors.text} />
              </View>
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
            <Text style={[styles.quickTitle, { color: colors.text }]} pointerEvents="none">
              {t('home.events')}
            </Text>
            {isAdmin ? (
              <Pressable
                onPress={() => setCreating('evento')}
                style={[styles.addChip, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Agregar evento"
              >
                <Text style={[styles.addChipText, { color: colors.text }]}>{t('home.addEvent')}</Text>
              </Pressable>
            ) : (
              <Text style={[styles.quickBody, { color: colors.textMuted }]} pointerEvents="none">
                {t('home.eventsBody')}
              </Text>
            )}
          </View>
          <View
            style={[styles.quickCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
          >
            {/*
              La zona pulsable va DETRAS del contenido, no envolviendolo: en web
              cada Pressable es un <button> y el "+" anidado dentro producia
              <button> dentro de <button> (HTML invalido, error de hidratacion).
            */}
            <Pressable
              onPress={() => openAdminSection('cursos')}
              disabled={!catalogProfileId}
              style={StyleSheet.absoluteFill}
              accessibilityRole="button"
              accessibilityLabel="Ver cursos"
            />
            <View style={styles.quickHeader} pointerEvents="box-none">
              <View pointerEvents="none">
                <Feather name="book" size={24} color={colors.text} />
              </View>
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
            <Text style={[styles.quickTitle, { color: colors.text }]} pointerEvents="none">
              {t('home.courses')}
            </Text>
            {isAdmin ? (
              <Pressable
                onPress={() => setCreating('curso')}
                style={[styles.addChip, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Agregar curso"
              >
                <Text style={[styles.addChipText, { color: colors.text }]}>{t('home.addCourse')}</Text>
              </Pressable>
            ) : (
              <Text style={[styles.quickBody, { color: colors.textMuted }]} pointerEvents="none">
                {t('home.coursesBody')}
              </Text>
            )}
          </View>
        </View>

        {/* Tu circulo baja aqui, junto al nuevo acceso al podcast. */}
        <View style={styles.quickRow}>
          <Pressable
            onPress={() => circle && router.push(`/circle/${circle.id}` as never)}
            disabled={!circle}
            style={[styles.quickCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
            accessibilityRole="button"
            accessibilityLabel={t('home.yourCircle')}
          >
            <Feather name="users" size={24} color={colors.text} />
            <Text style={[styles.quickTitle, { color: colors.text }]}>{t('home.yourCircle')}</Text>
            {/* Contador real; antes era "423 personas" escrito a mano. */}
            <Text style={[styles.quickBody, { color: colors.textMuted }]}>
              {circle ? t('home.circleMembers', { count: circle.members }) : t('home.joinCommunity')}
            </Text>
          </Pressable>

          <View
            style={[styles.quickCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
          >
            {/* Igual que en Eventos: la zona pulsable va detras para no anidar
                un <button> dentro de otro en web. */}
            <Pressable
              onPress={() => openAdminSection('podcast')}
              disabled={!catalogProfileId}
              style={StyleSheet.absoluteFill}
              accessibilityRole="button"
              accessibilityLabel={t('home.podcast')}
            />
            <View style={styles.quickHeader} pointerEvents="box-none">
              <View pointerEvents="none">
                <Feather name="headphones" size={24} color={colors.text} />
              </View>
              {isAdmin ? (
                <Pressable
                  onPress={() => setCreating('podcast')}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t('home.addAudio')}
                  style={[styles.addBadge, { backgroundColor: colors.text }]}
                >
                  <Feather name="plus" size={14} color={colors.background} />
                </Pressable>
              ) : null}
            </View>
            <Text style={[styles.quickTitle, { color: colors.text }]} pointerEvents="none">
              {t('home.podcast')}
            </Text>
            {isAdmin ? (
              <Pressable
                onPress={() => setCreating('podcast')}
                style={[styles.addChip, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel={t('home.addAudio')}
              >
                <Text style={[styles.addChipText, { color: colors.text }]}>{t('home.addAudio')}</Text>
              </Pressable>
            ) : (
              <Text style={[styles.quickBody, { color: colors.textMuted }]} pointerEvents="none">
                {t('home.podcastBody')}
              </Text>
            )}
          </View>
        </View>

        {/* Acceso a la galeria de testimonios, debajo de las tarjetas. */}
        <Pressable
          onPress={() => openAdminSection('testimonios')}
          accessibilityRole="button"
          accessibilityLabel={t('home.seeMore')}
          hitSlop={6}
          style={({ pressed }) => [
            styles.seeMore,
            { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.seeMoreText, { color: colors.text }]}>{t('home.seeMore')}</Text>
          <Feather name="chevron-right" size={15} color={colors.text} />
        </Pressable>
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
    <StateView state="empty" title={t('home.emptyTitle')} description={t('home.emptyBody')} />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="RENASER"
        rightIcon="bell"
        // Un aviso que nadie abre no sirve de nada: el punto marca que el de
        // "contenido de Darren gratis" sigue esperando dentro.
        rightBadge={darrenNoticePending}
        onRightPress={() => router.push('/notifications')}
      />

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
  seeMoreText: { fontSize: 13, fontWeight: '700' },
  seeMore: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    alignSelf: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 36,
    borderWidth: 1,
    borderRadius: radius.pill,
  },
  container: { paddingHorizontal: spacing.lg },
  tabs: { marginBottom: spacing.lg },
  composer: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.md, marginBottom: spacing.lg },
  composerAvatar: { width: 40, height: 40, borderRadius: 20 },
  composerText: { flex: 1, fontSize: 13 },
  wideCard: { minHeight: 120, borderRadius: radius.lg, padding: spacing.lg, justifyContent: 'space-between', marginBottom: spacing.md },
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
