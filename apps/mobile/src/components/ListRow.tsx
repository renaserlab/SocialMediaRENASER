import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Pulsable } from '@/components/Pulsable';
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

  const baseStyle = [
    styles.container,
    { borderColor: colors.border, backgroundColor: colors.surface },
    style,
  ];

  const contenido = (
    <>
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
    </>
  );

  // Una fila que no lleva a ningún sitio no responde al dedo: animarla sería
  // prometer que se puede pulsar (p. ej. la de la cuenta en Ajustes).
  const etiqueta = `${title}${subtitle ? `, ${subtitle}` : ''}`;
  if (!onPress) {
    return (
      <View accessibilityLabel={etiqueta} style={baseStyle}>
        {contenido}
      </View>
    );
  }

  return (
    <Pulsable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={etiqueta}
      // Una fila ocupa todo el ancho: encoge menos que un botón para que no
      // parezca que se despega de sus vecinas.
      escala={0.985}
      atenuar={0.7}
      style={baseStyle}
    >
      {contenido}
    </Pulsable>
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
