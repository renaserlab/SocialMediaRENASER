import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { haptics } from '@/lib/haptics';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import type { FeaturedMember } from '@/mappers/profileMapper';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Sugerencias tras crear la cuenta. Sin esto el usuario nuevo entraba a un feed
 * vacio; siguiendo a los miembros destacados ya tiene contenido desde el primer
 * momento.
 */
export function MembersScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const loadFeed = useAppStore((state) => state.loadFeed);

  const [members, setMembers] = useState<FeaturedMember[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'idle'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!supabaseEnabled) {
      setState('idle');
      return;
    }
    setState('loading');
    ProfileRepository.listFeatured()
      .then((list) => {
        setMembers(list);
        setState('idle');
      })
      .catch(() => setState('error'));
  }, [supabaseEnabled]);

  useEffect(load, [load]);

  const toggleFollow = async (member: FeaturedMember) => {
    setBusyId(member.id);
    const wasFollowing = member.isFollowing;
    // Optimista: el boton responde sin esperar a la red.
    setMembers((prev) =>
      prev.map((m) =>
        m.id === member.id
          ? { ...m, isFollowing: !wasFollowing, followers: m.followers + (wasFollowing ? -1 : 1) }
          : m,
      ),
    );
    try {
      if (wasFollowing) await ProfileRepository.unfollow(member.id);
      else await ProfileRepository.follow(member.id);
      haptics.light();
    } catch {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === member.id
            ? { ...m, isFollowing: wasFollowing, followers: member.followers }
            : m,
        ),
      );
    } finally {
      setBusyId(null);
    }
  };

  const finish = () => {
    // El feed se recarga para que ya incluya lo de los perfiles seguidos.
    void loadFeed();
    router.replace('/(tabs)/home');
  };

  const followingSomeone = members.some((m) => m.isFollowing);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppScreen contentStyle={styles.content}>
        <Text variant="title" weight="900" style={styles.title}>
          Miembros RENASER
        </Text>
        <Text variant="body" color={colors.textMuted} style={styles.subtitle}>
          Sigue a estos perfiles para que tu espacio tenga contenido desde el primer día.
        </Text>

        {state === 'loading' && (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text} />
          </View>
        )}

        {state === 'error' && (
          <View style={styles.center}>
            <Text variant="body" color={colors.textMuted} style={styles.centerText}>
              No pudimos cargar las sugerencias.
            </Text>
            <Button label="Reintentar" variant="secondary" onPress={load} />
          </View>
        )}

        {state === 'idle' && members.length === 0 && (
          <View style={styles.center}>
            <Text variant="body" color={colors.textMuted} style={styles.centerText}>
              Aún no hay miembros destacados.
            </Text>
          </View>
        )}

        {state === 'idle' &&
          members.map((member) => (
            <View
              key={member.id}
              style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <Pressable
                onPress={() => router.push(`/profile/${member.id}` as never)}
                accessibilityRole="button"
                accessibilityLabel={`Ver perfil de ${member.fullName}`}
                style={styles.avatarWrap}
              >
                <ExpoImage
                  source={member.avatarUrl ? { uri: member.avatarUrl } : assets.avatar}
                  style={styles.avatar}
                  contentFit="cover"
                />
                {member.isAdmin && (
                  <View style={[styles.badge, { backgroundColor: colors.primary, borderColor: colors.surface }]}>
                    <Feather name="check" size={12} color={colors.onPrimary} />
                  </View>
                )}
              </Pressable>

              <Text variant="body" weight="700" style={styles.name}>
                {member.fullName}
              </Text>
              <Text variant="secondary" color={colors.textMuted}>
                {member.username}
              </Text>
              {member.bio ? (
                <Text
                  variant="secondary"
                  color={colors.textMuted}
                  numberOfLines={2}
                  style={styles.bio}
                >
                  {member.bio}
                </Text>
              ) : null}
              <Text variant="secondary" color={colors.textMuted} style={styles.stats}>
                {member.followers} seguidores · {member.posts} publicaciones
              </Text>

              <View style={styles.actions}>
                <Button
                  label={member.isFollowing ? 'Siguiendo' : 'Seguir'}
                  variant={member.isFollowing ? 'secondary' : 'primary'}
                  loading={busyId === member.id}
                  onPress={() => toggleFollow(member)}
                  style={styles.action}
                />
                <Button
                  label="Ver perfil"
                  variant="secondary"
                  onPress={() => router.push(`/profile/${member.id}` as never)}
                  style={styles.action}
                />
              </View>
            </View>
          ))}

        <Button
          label={followingSomeone ? 'Continuar' : 'Ahora no'}
          variant={followingSomeone ? 'primary' : 'ghost'}
          onPress={finish}
          style={styles.finish}
        />
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: { marginTop: spacing.xl },
  subtitle: { marginTop: spacing.sm, marginBottom: spacing.xl },
  center: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
  centerText: { textAlign: 'center' },
  card: {
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  avatarWrap: { marginBottom: spacing.md },
  avatar: { width: 88, height: 88, borderRadius: 44 },
  badge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { textAlign: 'center' },
  bio: { textAlign: 'center', marginTop: spacing.sm },
  stats: { marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, alignSelf: 'stretch' },
  action: { flex: 1 },
  finish: { marginTop: spacing.sm },
});
