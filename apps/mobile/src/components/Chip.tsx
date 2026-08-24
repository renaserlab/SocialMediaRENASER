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
  /**
   * Se ve, pero no se puede elegir ahora mismo. El caso real: un selector con
   * tope —«hasta 3 temas»— donde los demas se apagan al llegar al maximo.
   *
   * Existe porque atenuarlo por fuera no basta: quien navega con lector de
   * pantalla no ve la opacidad, y sin `accessibilityState` se le anuncia como
   * pulsable algo que no responde. Que se vea apagado y que se ANUNCIE apagado
   * son dos cosas distintas.
   */
  disabled?: boolean;
};

export function Chip({
  label,
  selected = false,
  onPress,
  style,
  icon,
  disabled = false,
}: ChipProps) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={label}
      style={({ pressed }: { pressed: boolean }) => [
        styles.base,
        {
          backgroundColor: selected ? colors.primary : colors.background,
          borderColor: selected ? colors.primary : colors.border,
          opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
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
