import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { Avatar } from '@/components/Avatar';
import { StateView } from '@/components/StateView';
import { confirm, notify } from '@/lib/confirm';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import type { ProfileSummary } from '@/mappers/profileMapper';
import { profileImageUrl } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Personas bloqueadas, con la opción de revertirlo.
 *
 * Es la contraparte necesaria del bloqueo: una vez bloqueada, esa persona
 * desaparece del muro y de la búsqueda, así que sin esta lista no habría forma
 * de volver a encontrarla para desbloquearla.
 */
export function BlockedUsersScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [people, setPeople] = useState<ProfileSummary[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setStatus('loading');
    ProfileRepository.listBlocked()
      .then((list) => {
        setPeople(list);
        setStatus('idle');
      })
      .catch(() => setStatus('error'));
  }, []);

  // Al volver de un perfil se puede haber bloqueado o desbloqueado a alguien.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const unblock = async (person: ProfileSummary) => {
    const ok = await confirm({
      title: t('blocked.unblockNamed', { nombre: person.fullName }),
      message: t('blocked.unblockBody'),
      confirmLabel: t('blocked.unblock'),
    });
    if (!ok) return;
    setBusyId(person.id);
    // Se quita de la lista antes de responder el servidor: si falla, se repone.
    const previous = people;
    setPeople((list) => list.filter((p) => p.id !== person.id));
    try {
      await ProfileRepository.unblock(person.id);
    } catch {
      setPeople(previous);
      notify(t('blocked.unblockFailed'), t('common.tryAgainSoon'));
    } finally {
      setBusyId(null);
    }
  };

  const uiState =
    status === 'loading' ? 'loading' : status === 'error' ? 'error' : people.length ? 'content' : 'empty';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('settings.blocked')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <ScrollView contentContainerStyle={styles.list}>
        {uiState !== 'content' ? (
          <StateView
            state={uiState}
            onRetry={load}
            title={uiState === 'empty' ? t('blocked.emptyTitle') : undefined}
            description={uiState === 'empty' ? t('blocked.emptyBody') : undefined}
            icon="slash"
          />
        ) : (
          people.map((person) => (
            <View
              key={person.id}
              style={[styles.row, { borderBottomColor: colors.border }]}
            >
              <Avatar
                image={profileImageUrl(person.avatarPath) ?? null}
                name={person.fullName}
                size={44}
              />
              <View style={styles.info}>
                <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                  {person.fullName}
                </Text>
                <Text style={[styles.username, { color: colors.textMuted }]} numberOfLines={1}>
                  {person.username}
                </Text>
              </View>
              <Pressable
                onPress={() => void unblock(person)}
                disabled={busyId === person.id}
                accessibilityRole="button"
                accessibilityLabel={t('blocked.unblockNamed', { nombre: person.fullName })}
                style={({ pressed }) => [
                  styles.action,
                  {
                    borderColor: colors.border,
                    opacity: pressed || busyId === person.id ? 0.6 : 1,
                  },
                ]}
              >
                <Text style={[styles.actionText, { color: colors.text }]}>
                  {t('blocked.unblock')}
                </Text>
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
  },
  info: { flex: 1 },
  name: { fontSize: 14, fontWeight: '700' },
  username: { fontSize: 12, marginTop: 2 },
  action: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  actionText: { fontSize: 12, fontWeight: '700' },
});
