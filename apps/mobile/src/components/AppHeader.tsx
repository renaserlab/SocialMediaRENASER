import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  title?: string;
  back?: boolean;
  onBack?: () => void;
  rightIcon?: keyof typeof Feather.glyphMap;
  onRightPress?: () => void;
};

export function AppHeader({ title = 'RENASER', back = false, onBack, rightIcon, onRightPress }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();

  const handleBack = () => {
    if (onBack) onBack();
    else router.back();
  };

  return (
    <View style={styles.row}>
      <View style={styles.side}>
        {back || onBack ? (
          <Pressable
            onPress={handleBack}
            hitSlop={12}
            accessibilityLabel="Volver"
            accessibilityRole="button"
            style={styles.backButton}
          >
            <Feather name="chevron-left" size={24} color={colors.text} />
          </Pressable>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{title}</Text>
      <View style={[styles.side, { alignItems: 'flex-end' }]}>
        {rightIcon ? (
          <Pressable
            onPress={onRightPress}
            hitSlop={12}
            accessibilityLabel="Acción derecha"
            accessibilityRole="button"
            style={styles.backButton}
          >
            <Feather name={rightIcon} size={22} color={colors.text} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  side: { width: 44 },
  title: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.8,
  },
  backButton: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
