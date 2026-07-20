import React from 'react';
import { Pressable, StyleSheet, View, ViewStyle } from 'react-native';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type SegmentedControlProps = {
  options: string[];
  selectedIndex: number;
  onChange: (index: number) => void;
  style?: ViewStyle;
};

export function SegmentedControl({
  options,
  selectedIndex,
  onChange,
  style,
}: SegmentedControlProps) {
  const { colors } = useAppTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundAlt, borderColor: colors.border }, style]}>
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <Pressable
            key={option}
            onPress={() => onChange(index)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option}
            style={({ pressed }: { pressed: boolean }) => [
              styles.segment,
              {
                backgroundColor: selected ? colors.primary : 'transparent',
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.label,
                {
                  color: selected ? colors.onPrimary : colors.textMuted,
                  fontWeight: selected ? '700' : '500',
                },
              ]}
            >
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    padding: spacing.xs,
    alignItems: 'stretch',
  },
  segment: {
    flex: 1,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 13,
  },
});
