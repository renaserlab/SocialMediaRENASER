import React, { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { haptics } from '@/lib/haptics';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Avatar } from '@/components/Avatar';
import { ListRow } from '@/components/ListRow';
import { ProfileGallery } from '@/components/ProfileGallery';
import { ProfileSection, type ProfileSectionKind } from '@/components/ProfileSection';
import { StateView } from '@/components/StateView';
import { useProfilePosts } from '@/hooks/useProfilePosts';
import { assets } from '@/data/assets';
import { MessageRepository } from '@/repositories/MessageRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { pickImage, takePhoto } from '@/services/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { UserProfile } from '@/types';

export function ProfileScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { id, section } = useLocalSearchParams<{ id?: string; section?: string }>();

  const currentUser = useAppStore((state) => state.user);
  const setProfileImage = useAppStore((state) => state.setProfileImage);
  const authStatus = useAuthStore((state) => state.status);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const profileError = useAuthStore((state) => state.profileError);
  const refreshProfile = useAuthStore((state) => state.refreshProfile);

  // Tipos de perfil: propio (sin id), Darren (demo), o público real (uuid).
  const isDarren = id === 'darren';
  const isRealPublic = !!id && !isDarren && id !== currentUser?.id;
  const isPublic = isDarren || isRealPublic;

  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  /**
   * Seccion activa bajo los accesos circulares. Llega por parametro desde las
   * tarjetas de Inicio (Eventos / Cursos) y tambien se cambia tocando los
   * circulos. `null` = la galeria de publicaciones.
   */
  const [activeSection, setActiveSection] = useState<ProfileSectionKind | null>(
    section === 'eventos' ||
      section === 'cursos' ||
      section === 'podcast' ||
      section === 'testimonios'
      ? section
      : null,
  );

  const [publicProfile, setPublicProfile] = useState<UserProfile | null>(null);
  const [publicState, setPublicState] = useState<'loading' | 'error' | 'idle'>('loading');

  // Publicaciones del perfil que se esta viendo (el propio o el de otro).
  const galleryOwnerId = isRealPublic ? id : currentUser?.id;
  const {
    gallery,
    audios,
    loading: postsLoading,
    error: postsError,
  } = useProfilePosts(isDarren ? null : galleryOwnerId);

  const loadPublic = React.useCallback(() => {
    if (!isRealPublic || !id) return;
    setPublicState('loading');
    ProfileRepository.getById(id)
      .then((p) => {
        setPublicProfile(p);
        setFollowing(p.isFollowing ?? false);
        setFollowersCount(p.followers);
        setPublicState('idle');
      })
      .catch(() => setPublicState('error'));
  }, [id, isRealPublic]);

  useEffect(() => {
    loadPublic();
  }, [loadPublic]);

  const toggleFollow = async () => {
    haptics.light();
    if (isDarren) {
      setFollowing((v) => !v);
      return;
    }
    if (!isRealPublic || !id) return;
    const wasFollowing = following;
    setFollowBusy(true);
    setFollowing(!wasFollowing);
    setFollowersCount((c) => Math.max(0, c + (wasFollowing ? -1 : 1)));
    try {
      const count = wasFollowing
        ? await ProfileRepository.unfollow(id)
        : await ProfileRepository.follow(id);
      setFollowersCount(count);
    } catch {
      setFollowing(wasFollowing);
      setFollowersCount((c) => Math.max(0, c + (wasFollowing ? 1 : -1)));
    } finally {
      setFollowBusy(false);
    }
  };

  /**
   * Foto en edición: al tocar el avatar o la portada se abre la hoja de
   * opciones (galería / cámara / quitar), en vez de saltar directo al selector.
   */
  const [editingPhoto, setEditingPhoto] = useState<'avatar' | 'cover' | null>(null);

  const openPhotoSheet = (kind: 'avatar' | 'cover') => {
    haptics.light();
    setEditingPhoto(kind);
  };

  /** Recorte cuadrado para el avatar y panorámico para la portada. */
  const applyPhoto = async (source: 'gallery' | 'camera') => {
    const kind = editingPhoto;
    if (!kind) return;
    setEditingPhoto(null);
    const aspect: [number, number] = kind === 'avatar' ? [1, 1] : [16, 9];
    try {
      const picked = source === 'gallery' ? await pickImage(aspect) : await takePhoto(aspect);
      if (!picked) return;
      await setProfileImage(kind, picked);
    } catch (error) {
      notify(
        'No se pudo cambiar la foto',
        error instanceof Error
          ? error.message
          : 'Revisa los permisos e inténtalo de nuevo.',
      );
    }
  };

  const removePhoto = async () => {
    if (!editingPhoto) return;
    const kind = editingPhoto;
    setEditingPhoto(null);
    try {
      await setProfileImage(kind, null);
    } catch (error) {
      notify(
        'No se pudo quitar la foto',
        error instanceof Error ? error.message : 'Inténtalo de nuevo.',
      );
    }
  };

  const openChat = async () => {
    if (isDarren) {
      router.push('/chat/darren' as never);
      return;
    }
    if (!id) return;
    try {
      const conv = await MessageRepository.getOrCreateDirect(id);
      router.push({ pathname: '/chat/[id]', params: { id: conv.id, name: profileData.fullName } } as never);
    } catch {
      notify('No se pudo abrir el chat', 'Inténtalo de nuevo.');
    }
  };

  // Perfil propio con backend real: carga/error mientras llega el perfil.
  if (!id && supabaseEnabled && !currentUser) {
    const state = profileError ? 'error' : authStatus === 'loading' ? 'loading' : 'empty';
    // Sin sesion no falta el perfil: falta entrar. Antes ambos casos mostraban
    // el mismo aviso y sin ninguna accion, asi que quien llegaba aqui sin
    // cuenta se quedaba atascado: se le pedia iniciar sesion sin ofrecer donde.
    const anonymous = authStatus === 'anonymous';
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="MI PERFIL" rightIcon="settings" onRightPress={() => router.push('/settings')} />
        <StateView
          state={state}
          onRetry={() => void refreshProfile()}
          icon={state === 'empty' && anonymous ? 'user' : undefined}
          title={
            state === 'empty' ? (anonymous ? 'Entra a tu cuenta' : 'Perfil no disponible') : undefined
          }
          description={
            state === 'empty'
              ? anonymous
                ? 'Inicia sesión para ver tu perfil, publicar y seguir a otras personas.'
                : 'Estamos preparando tu perfil. Inténtalo de nuevo en un momento.'
              : undefined
          }
          actionLabel={state === 'empty' ? (anonymous ? 'Iniciar sesión' : 'Reintentar') : undefined}
          onAction={
            state === 'empty'
              ? anonymous
                ? () => router.push('/login' as never)
                : () => void refreshProfile()
              : undefined
          }
        />
      </View>
    );
  }

  // Perfil público real: carga/error.
  if (isRealPublic && publicState !== 'idle') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="PERFIL" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state={publicState === 'error' ? 'error' : 'loading'} onRetry={loadPublic} />
      </View>
    );
  }

  const profileData = isDarren
    ? {
        fullName: 'Darren Hardy',
        username: '@darrenhardy',
        bio: 'Mentor de líderes. Autor de The Compound Effect. Te enseño a multiplicar tu productividad y alcanzar tu potencial.',
        followers: 1200000,
        following: 42,
        posts: 180,
        avatar: 'speaker' as const,
      }
    : isRealPublic
    ? {
        fullName: publicProfile?.fullName ?? '',
        username: publicProfile?.username ?? '',
        bio: publicProfile?.bio ?? '',
        followers: followersCount,
        following: publicProfile?.following ?? 0,
        posts: publicProfile?.posts ?? 0,
        avatar: 'avatar' as const,
      }
    : {
        // Sin datos reales no se inventa una identidad: antes caia a la
        // "Katherine Bejar" del demo y el usuario veia un perfil ajeno.
        fullName: currentUser?.fullName ?? '',
        username: currentUser?.username ?? '',
        bio: currentUser?.bio ?? '',
        followers: currentUser?.followers ?? 0,
        following: currentUser?.following ?? 0,
        posts: currentUser?.posts ?? 0,
        avatar: 'avatar' as const,
      };

  // Foto a mostrar: en tu perfil, la tuya (local o backend); en uno ajeno, la
  // del perfil cargado. Sin foto, el placeholder de siempre.
  const coverUri = isPublic ? publicProfile?.coverUrl : currentUser?.coverUrl;
  const avatarUri = isPublic ? publicProfile?.avatarUrl : currentUser?.avatarUrl;
  const coverSource = coverUri ? { uri: coverUri } : assets.hero;
  const avatarSource = avatarUri ? { uri: avatarUri } : profileData.avatar;
  // "Quitar foto" solo tiene sentido si hay una elegida por el usuario.
  const hasCustomPhoto =
    editingPhoto === 'cover' ? !!currentUser?.coverUrl : !!currentUser?.avatarUrl;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={isPublic ? t('profile.titlePublic') : t('profile.title')}
        rightIcon={isPublic ? undefined : 'settings'}
        onRightPress={isPublic ? undefined : () => router.push('/settings')}
        /*
          Atras SIEMPRE que se llegue por /profile/[id], aunque sea el perfil
          propio: esa ruta vive fuera de las pestañas, asi que sin este boton no
          hay barra inferior ni forma de salir. Solo la pestaña Perfil (sin id)
          se queda sin flecha, porque alli si esta la barra.
        */
        onBack={
          id ? () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/home')) : undefined
        }
      />
      <AppScreen contentStyle={{ paddingBottom: 100 }}>
        {/* La portada completa es tocable; el chip solo señala que se puede editar. */}
        <Pressable
          onPress={isPublic ? undefined : () => openPhotoSheet('cover')}
          disabled={isPublic}
          accessibilityRole={isPublic ? undefined : 'button'}
          accessibilityLabel={isPublic ? undefined : 'Cambiar foto de portada'}
          style={({ pressed }) => ({ opacity: pressed && !isPublic ? 0.85 : 1 })}
        >
          <Image source={coverSource} style={styles.cover} />
          {!isPublic && (
            <View style={[styles.coverEditBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Feather name="camera" size={14} color={colors.text} />
              <Text style={[styles.coverEditLabel, { color: colors.text }]}>Editar portada</Text>
            </View>
          )}
        </Pressable>
        <View style={[styles.profileBlock, { backgroundColor: colors.background }]}>
          <View style={styles.avatarRow}>
            <Pressable
              onPress={isPublic ? undefined : () => openPhotoSheet('avatar')}
              disabled={isPublic}
              accessibilityRole={isPublic ? undefined : 'button'}
              accessibilityLabel={isPublic ? undefined : 'Cambiar foto de perfil'}
              style={({ pressed }) => ({ opacity: pressed && !isPublic ? 0.85 : 1 })}
            >
              <Avatar size={90} image={avatarSource} />
              {!isPublic && (
                <View
                  style={[
                    styles.avatarEditBtn,
                    { backgroundColor: colors.text, borderColor: colors.background },
                  ]}
                >
                  <Feather name="camera" size={13} color={colors.background} />
                </View>
              )}
            </Pressable>
            <View style={styles.actionRow}>
              {isPublic ? (
                <React.Fragment>
                  <Button
                    label={following ? 'Siguiendo' : 'Seguir'}
                    variant={following ? 'secondary' : 'primary'}
                    loading={followBusy}
                    onPress={toggleFollow}
                    style={styles.actionBtn}
                  />
                  <Button
                    label="Mensaje"
                    variant="secondary"
                    onPress={openChat}
                    style={styles.actionBtn}
                  />
                </React.Fragment>
              ) : (
                <Button
                  label="Editar perfil"
                  variant="secondary"
                  onPress={() => router.push('/edit-profile' as never)}
                  style={styles.actionBtn}
                />
              )}
            </View>
          </View>

          <View style={styles.infoBlock}>
            <Text style={[styles.name, { color: colors.text }]}>{profileData.fullName}</Text>
            <Text style={[styles.username, { color: colors.textMuted }]}>{profileData.username}</Text>
          </View>

          <View style={[styles.stats, { borderColor: colors.border }]}>
            <Stat
              label="Seguidores"
              value={profileData.followers}
              onPress={() => router.push(`/followers/${id ?? 'me'}` as never)}
            />
            <Stat
              label="Siguiendo"
              value={profileData.following}
              onPress={() => router.push(`/following/${id ?? 'me'}` as never)}
            />
            <Stat label="Publicaciones" value={profileData.posts} />
          </View>

          <Text style={[styles.bio, { color: colors.text }]}>{profileData.bio}</Text>

          {isDarren && (
            <Button
              label="Escuchar Audio Privado"
              icon="headphones"
              onPress={() => router.push('/audio/private')}
              style={styles.audioBtn}
            />
          )}

          <View style={styles.shortcuts}>
            <Shortcut icon="bookmark" label={t('profile.saved')} onPress={() => router.push('/saved' as never)} />
            <Shortcut
              icon="headphones"
              label={t('profile.podcast')}
              onPress={() => setActiveSection((v) => (v === 'podcast' ? null : 'podcast'))}
            />
            <Shortcut
              icon="calendar"
              label={t('profile.events')}
              onPress={() => setActiveSection((v) => (v === 'eventos' ? null : 'eventos'))}
            />
            <Shortcut
              icon="book"
              label={t('profile.courses')}
              onPress={() => setActiveSection((v) => (v === 'cursos' ? null : 'cursos'))}
            />
            <Shortcut icon="users" label={t('profile.circles')} onPress={() => router.push('/circle/lideres-renaser')} />
            <Shortcut
              icon="camera"
              label={t('profile.testimonials')}
              onPress={() => setActiveSection((v) => (v === 'testimonios' ? null : 'testimonios'))}
            />
          </View>

          {activeSection ? (
            <ProfileSection kind={activeSection} profileId={galleryOwnerId} />
          ) : (
          /* Publicaciones reales del perfil: fotos/videos. */
          <ProfileGallery
            gallery={gallery}
            audios={audios}
            loading={postsLoading}
            error={postsError}
            emptyHint={
              isPublic
                ? 'Este perfil aún no ha publicado nada.'
                : 'Cuando publiques una foto o un video, aparecerá aquí.'
            }
          />
          )}
        </View>
      </AppScreen>

      <BottomSheet visible={editingPhoto !== null} onClose={() => setEditingPhoto(null)}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>
          {editingPhoto === 'cover' ? 'Foto de portada' : 'Foto de perfil'}
        </Text>
        <ListRow
          title="Elegir de la galería"
          leftIcon="image"
          onPress={() => void applyPhoto('gallery')}
        />
        <ListRow title="Tomar foto" leftIcon="camera" onPress={() => void applyPhoto('camera')} />
        {hasCustomPhoto && (
          <ListRow title="Quitar foto actual" leftIcon="trash-2" destructive onPress={removePhoto} />
        )}
      </BottomSheet>
    </View>
  );
}

function Stat({ label, value, onPress }: { label: string; value: number; onPress?: () => void }) {
  const { colors } = useAppTheme();
  const display = value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
  const content = (
    <React.Fragment>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{display}</Text>
      <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>{label}</Text>
    </React.Fragment>
  );

  if (!onPress) {
    return <View style={styles.statBox}>{content}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.statBox, { opacity: pressed ? 0.7 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={`Ver ${label}`}
    >
      {content}
    </Pressable>
  );
}

function Shortcut({ icon, label, onPress }: { icon: keyof typeof Feather.glyphMap; label: string; onPress: () => void }) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.shortcutItem, { opacity: pressed ? 0.8 : 1 }]}
    >
      <View style={[styles.shortcutIcon, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Feather name={icon} size={20} color={colors.text} />
      </View>
      <Text style={{ color: colors.text, fontSize: 11, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cover: { width: '100%', height: 180, resizeMode: 'cover' },
  // Se separa del borde inferior para no quedar bajo el bloque de perfil (marginTop: -20).
  coverEditBtn: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg + 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  coverEditLabel: { fontSize: 11, fontWeight: '700' },
  // Badge sólido con borde del color del fondo: se lee sobre cualquier foto.
  avatarEditBtn: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  profileBlock: { marginTop: -20, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.lg },
  avatarRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: -50 },
  actionRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  actionBtn: { minWidth: 100, minHeight: 40, height: 40 },
  infoBlock: { marginTop: spacing.md },
  name: { fontSize: 20, fontWeight: '900' },
  username: { fontSize: 13, marginTop: 2 },
  stats: { flexDirection: 'row', marginVertical: spacing.lg, borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: spacing.md },
  statBox: { alignItems: 'center', flex: 1 },
  bio: { fontSize: 13, lineHeight: 18, marginBottom: spacing.lg },
  audioBtn: { width: '100%', marginBottom: spacing.lg },
  shortcuts: { flexDirection: 'row', marginVertical: spacing.md, gap: spacing.sm },
  shortcutItem: { alignItems: 'center', gap: 6, flex: 1 },
  shortcutIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginTop: spacing.lg },
  gridImage: { width: '32.6%', aspectRatio: 1, borderWidth: 1 },
});
