import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';

import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Persona tal y como la pinta esta lista.
 *
 * Es a proposito independiente del tipo `Person` del demo (que apunta a una
 * clave de `data/assets`): aqui la foto es una URL real y el estado de
 * seguimiento lo decide el backend, no un `useState` local.
 */
export type PersonRow = {
  id: string;
  fullName: string;
  username: string;
  avatarUrl?: string;
  isFollowing?: boolean;
};

type Props = {
  people: PersonRow[];
  emptyTitle: string;
  emptyDescription: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Sin este callback no se pinta el boton: seguir seria un adorno. */
  onToggleFollow?: (person: PersonRow) => void;
  /** Usuario actual, para no ofrecerle seguirse a si mismo. */
  currentUserId?: string | null;
};

/** Lista social reutilizable (seguidores, siguiendo, resultados). */
export function PeopleList({
  people,
  emptyTitle,
  emptyDescription,
  loading = false,
  error = null,
  onRetry,
  onToggleFollow,
  currentUserId,
}: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  if (error) {
    return <StateView state="error" description={error} onRetry={onRetry} />;
  }

  if (people.length === 0) {
    return <StateView state="empty" icon="users" title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <FlashList
      data={people}
      keyExtractor={(item: PersonRow) => item.id}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }}
      renderItem={({ item }: { item: PersonRow }) => (
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <Pressable
            style={styles.info}
            onPress={() => router.push(`/profile/${item.id}` as never)}
            accessibilityRole="button"
            accessibilityLabel={`Ver perfil de ${item.fullName}`}
          >
            <ExpoImage
              source={item.avatarUrl ? { uri: item.avatarUrl } : assets.avatar}
              style={styles.avatar}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
            <View style={{ flex: 1 }}>
              <Text variant="body" weight="700">{item.fullName}</Text>
              <Text variant="secondary" color={colors.textMuted}>{item.username}</Text>
            </View>
          </Pressable>
          {onToggleFollow && item.id !== currentUserId ? (
            <Button
              label={item.isFollowing ? 'Siguiendo' : 'Seguir'}
              variant={item.isFollowing ? 'secondary' : 'primary'}
              onPress={() => onToggleFollow(item)}
              style={styles.followBtn}
            />
          ) : null}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1 },
  info: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  avatar: { width: 48, height: 48, borderRadius: 24 },
  followBtn: { minWidth: 104, minHeight: 38, height: 38 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
