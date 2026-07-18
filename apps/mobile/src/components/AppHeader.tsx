import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  title?: string;
  back?: boolean;
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightPress?: () => void;
};

export function AppHeader({ title = 'RENASER', back = false, rightIcon, onRightPress }: Props) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.row}>
      <View style={styles.side}>
        {back ? (
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{title}</Text>
      <View style={[styles.side, { alignItems: 'flex-end' }]}>
        {rightIcon ? (
          <Pressable onPress={onRightPress} hitSlop={12}>
            <Ionicons name={rightIcon} size={22} color={colors.text} />
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
});
