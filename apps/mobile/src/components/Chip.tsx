import React from 'react';
import { Pressable, StyleSheet, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type ChipProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
  icon?: keyof typeof Feather.glyphMap;
};

export function Chip({ label, selected = false, onPress, style, icon }: ChipProps) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      style={({ pressed }: { pressed: boolean }) => [
        styles.base,
        {
          backgroundColor: selected ? colors.primary : colors.background,
          borderColor: selected ? colors.primary : colors.border,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {icon && (
        <Feather
          name={icon}
          size={14}
          color={selected ? colors.onPrimary : colors.text}
          style={styles.icon}
        />
      )
      }
      <Text style={[styles.label, { color: selected ? colors.onPrimary : colors.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
  },
  icon: {
    marginRight: spacing.xs,
  },
});
