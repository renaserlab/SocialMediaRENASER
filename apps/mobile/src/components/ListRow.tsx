import React from 'react';
import { Pressable, StyleSheet, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type ListRowProps = {
  title: string;
  subtitle?: string;
  leftIcon?: keyof typeof Feather.glyphMap;
  rightIcon?: keyof typeof Feather.glyphMap;
  leftComponent?: React.ReactNode;
  rightComponent?: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  /** Tinta el titulo y el icono en rojo (acciones de riesgo: salir, borrar). */
  destructive?: boolean;
};

export function ListRow({
  title,
  subtitle,
  leftIcon,
  rightIcon,
  leftComponent,
  rightComponent,
  onPress,
  style,
  destructive = false,
}: ListRowProps) {
  const { colors } = useAppTheme();
  const accent = destructive ? colors.danger : colors.text;

  const RowContainer = onPress ? Pressable : View;

  return (
    <RowContainer
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${title}${subtitle ? `, ${subtitle}` : ''}`}
      style={({ pressed }: { pressed?: boolean }) => [
        styles.container,
        {
          borderColor: colors.border,
          backgroundColor: colors.surface,
          opacity: pressed ? 0.78 : 1,
        },
        style,
      ]}
    >
      <View style={styles.leftSection}>
        {leftComponent}
        {!leftComponent && leftIcon && (
          <Feather name={leftIcon} size={20} color={accent} style={styles.leftIcon} />
        )}
        <View style={styles.textContainer}>
          <Text style={[styles.title, { color: accent }]}>{title}</Text>
          {subtitle && <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text>}
        </View>
      </View>
      <View style={styles.rightSection}>
        {rightComponent}
        {!rightComponent && rightIcon && (
          <Feather name={rightIcon} size={18} color={colors.textMuted} />
        )}
      </View>
    </RowContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: spacing.md,
  },
  leftIcon: {
    marginRight: spacing.xs,
  },
  textContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  rightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
