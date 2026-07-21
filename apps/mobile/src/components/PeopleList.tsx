import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';

import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { haptics } from '@/lib/haptics';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Person } from '@/types';

type Props = {
  people: Person[];
  emptyTitle: string;
  emptyDescription: string;
};

/** Lista social reutilizable (seguidores, siguiendo, resultados). */
export function PeopleList({ people, emptyTitle, emptyDescription }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const [following, setFollowing] = useState<Record<string, boolean>>({});

  const toggle = (id: string) => {
    haptics.light();
    setFollowing((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (people.length === 0) {
    return <StateView state="empty" icon="users" title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <FlashList
      data={people}
      keyExtractor={(item: Person) => item.id}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }}
      renderItem={({ item }: { item: Person }) => (
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <Pressable
            style={styles.info}
            onPress={() => router.push(`/profile/${item.id}` as never)}
            accessibilityRole="button"
            accessibilityLabel={`Ver perfil de ${item.fullName}`}
          >
            <ExpoImage source={assets[item.avatar]} style={styles.avatar} contentFit="cover" />
            <View style={{ flex: 1 }}>
              <Text variant="body" weight="700">{item.fullName}</Text>
              <Text variant="secondary" color={colors.textMuted}>{item.username}</Text>
            </View>
          </Pressable>
          <Button
            label={following[item.id] ? 'Siguiendo' : 'Seguir'}
            variant={following[item.id] ? 'secondary' : 'primary'}
            onPress={() => toggle(item.id)}
            style={styles.followBtn}
          />
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
});
