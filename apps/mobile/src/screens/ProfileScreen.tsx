import React, { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Avatar } from '@/components/Avatar';
import { StateView } from '@/components/StateView';
import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function ProfileScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const currentUser = useAppStore((state) => state.user);
  const authStatus = useAuthStore((state) => state.status);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const profileError = useAuthStore((state) => state.profileError);
  const refreshProfile = useAuthStore((state) => state.refreshProfile);

  // Determinar si es perfil de Darren o el propio
  const isDarren = id === 'darren';

  const [following, setFollowing] = useState(false);

  // Perfil propio con backend real: mostrar carga/error mientras llega el perfil.
  if (!isDarren && supabaseEnabled && !currentUser) {
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
    : {
        fullName: currentUser?.fullName ?? 'Katherine Béjar',
        username: currentUser?.username ?? '@katherine',
        bio: currentUser?.bio ?? 'Creando una vida con claridad, propósito y crecimiento consciente.',
        followers: currentUser?.followers ?? 128,
        following: currentUser?.following ?? 96,
        posts: currentUser?.posts ?? 1,
        avatar: 'avatar' as const,
      };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={isDarren ? 'PERFIL' : 'MI PERFIL'}
        rightIcon={isDarren ? undefined : 'settings'}
        onRightPress={isDarren ? undefined : () => router.push('/settings')}
        onBack={isDarren ? () => router.back() : undefined}
      />
      <AppScreen contentStyle={{ paddingBottom: 100 }}>
        <Image source={assets.hero} style={[styles.cover, { tintColor: 'gray' }]} />
        <View style={[styles.profileBlock, { backgroundColor: colors.background }]}>
          <View style={styles.avatarRow}>
            <Avatar size={90} image={profileData.avatar} />
            <View style={styles.actionRow}>
              {isDarren ? (
                <React.Fragment>
                  <Button
                    label={following ? 'Siguiendo' : 'Seguir'}
                    variant={following ? 'secondary' : 'primary'}
                    onPress={() => setFollowing(!following)}
                    style={styles.actionBtn}
                  />
                  <Button
                    label="Mensaje"
                    variant="secondary"
                    onPress={() => router.push('/chat/darren')}
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

          <View style={styles.stats}>
            <Stat label="Seguidores" value={profileData.followers} />
            <Stat label="Siguiendo" value={profileData.following} />
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
            <Shortcut icon="headphones" label="Audios" onPress={() => router.push('/audio/private')} />
            <Shortcut icon="calendar" label="Eventos" onPress={() => router.push('/events')} />
            <Shortcut icon="book" label="Cursos" onPress={() => router.push('/course/lider-vida-empresa')} />
            <Shortcut icon="users" label="Círculos" onPress={() => router.push('/circle/lideres-renaser')} />
          </View>

          {/* Grid de imágenes de publicaciones en B&W */}
          <View style={styles.grid}>
            {[assets.audio, assets.event, assets.course, assets.circle, assets.speaker, assets.hero].map((source, index) => (
              <Image key={index} source={source} style={[styles.gridImage, { tintColor: 'gray' }]} />
            ))}
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const { colors } = useAppTheme();
  const display = value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
  return (
    <View style={styles.statBox}>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{display}</Text>
      <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>{label}</Text>
    </View>
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
  profileBlock: { marginTop: -20, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.lg },
  avatarRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: -50 },
  actionRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  actionBtn: { minWidth: 100, minHeight: 40, height: 40 },
  infoBlock: { marginTop: spacing.md },
  name: { fontSize: 20, fontWeight: '900' },
  username: { fontSize: 13, marginTop: 2 },
  stats: { flexDirection: 'row', marginVertical: spacing.lg, borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: spacing.md, borderColor: '#EAEAEA' },
  statBox: { alignItems: 'center', flex: 1 },
  bio: { fontSize: 13, lineHeight: 18, marginBottom: spacing.lg },
  audioBtn: { width: '100%', marginBottom: spacing.lg },
  shortcuts: { flexDirection: 'row', marginVertical: spacing.md, gap: spacing.sm },
  shortcutItem: { alignItems: 'center', gap: 6, flex: 1 },
  shortcutIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginTop: spacing.lg },
  gridImage: { width: '32.6%', aspectRatio: 1, borderWidth: 1, borderColor: 'white' },
});
