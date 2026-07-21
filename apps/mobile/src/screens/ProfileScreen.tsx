import React, { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { notify } from '@/lib/notify';
import { haptics } from '@/lib/haptics';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Avatar } from '@/components/Avatar';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { assets } from '@/data/assets';
import { MessageRepository } from '@/repositories/MessageRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { pickImage, takePhoto } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { UserProfile } from '@/types';

export function ProfileScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();

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
  const [publicProfile, setPublicProfile] = useState<UserProfile | null>(null);
  const [publicState, setPublicState] = useState<'loading' | 'error' | 'idle'>('loading');

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
      setProfileImage(kind, picked.uri);
    } catch {
      notify(
        source === 'gallery' ? 'No se pudo abrir la galería' : 'No se pudo abrir la cámara',
        'Revisa los permisos e inténtalo de nuevo.',
      );
    }
  };

  const removePhoto = () => {
    if (!editingPhoto) return;
    setProfileImage(editingPhoto, null);
    setEditingPhoto(null);
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
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="MI PERFIL" rightIcon="settings" onRightPress={() => router.push('/settings')} />
        <StateView
          state={state}
          onRetry={() => void refreshProfile()}
          title={state === 'empty' ? 'Perfil no disponible' : undefined}
          description={state === 'empty' ? 'Inicia sesión para ver tu perfil.' : undefined}
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
        fullName: currentUser?.fullName ?? 'Katherine Béjar',
        username: currentUser?.username ?? '@katherine',
        bio: currentUser?.bio ?? 'Creando una vida con claridad, propósito y crecimiento consciente.',
        followers: currentUser?.followers ?? 128,
        following: currentUser?.following ?? 96,
        posts: currentUser?.posts ?? 1,
        avatar: 'avatar' as const,
      };

  // Las fotos elegidas por el usuario solo aplican a su propia cuenta.
  const coverSource = !isPublic && currentUser?.coverUrl ? { uri: currentUser.coverUrl } : assets.hero;
  const avatarSource =
    !isPublic && currentUser?.avatarUrl ? { uri: currentUser.avatarUrl } : profileData.avatar;
  // "Quitar foto" solo tiene sentido si hay una elegida por el usuario.
  const hasCustomPhoto =
    editingPhoto === 'cover' ? !!currentUser?.coverUrl : !!currentUser?.avatarUrl;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={isPublic ? 'PERFIL' : 'MI PERFIL'}
        rightIcon={isPublic ? undefined : 'settings'}
        onRightPress={isPublic ? undefined : () => router.push('/settings')}
        onBack={isPublic ? () => (router.canGoBack() ? router.back() : router.replace('/')) : undefined}
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
            <Shortcut icon="bookmark" label="Guardados" onPress={() => router.push('/saved' as never)} />
            <Shortcut icon="headphones" label="Audios" onPress={() => router.push('/audio/private')} />
            <Shortcut icon="calendar" label="Eventos" onPress={() => router.push('/events')} />
            <Shortcut icon="book" label="Cursos" onPress={() => router.push('/course/lider-vida-empresa')} />
            <Shortcut icon="users" label="Círculos" onPress={() => router.push('/circle/lideres-renaser')} />
          </View>

          {/* Grid de imágenes de publicaciones en B&W */}
          <View style={styles.grid}>
            {[assets.audio, assets.event, assets.course, assets.circle, assets.speaker, assets.hero].map((source, index) => (
              <Image key={index} source={source} style={[styles.gridImage, { borderColor: colors.background }]} />
            ))}
          </View>
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
