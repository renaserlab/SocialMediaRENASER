import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  icon?: keyof typeof Feather.glyphMap;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
  icon,
}: ButtonProps) {
  const { colors } = useAppTheme();
  const primary = variant === 'primary';
  const ghost = variant === 'ghost';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }: { pressed: boolean }) => [
        styles.base,
        {
          backgroundColor: primary ? colors.primary : ghost ? 'transparent' : colors.background,
          borderColor: primary ? colors.primary : colors.border,
          borderWidth: ghost ? 0 : 1,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={primary ? colors.onPrimary : colors.text} size="small" />
      ) : (
        <React.Fragment>
          {icon && (
            <Feather
              name={icon}
              size={18}
              color={primary ? colors.onPrimary : colors.text}
              style={styles.icon}
            />
          )}
          <Text style={[styles.label, { color: primary ? colors.onPrimary : colors.text }]}>
            {label}
          </Text>
        </React.Fragment>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  icon: {
    marginRight: spacing.sm,
  },
});
