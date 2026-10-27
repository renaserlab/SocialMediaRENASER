import React from 'react';
import { StyleSheet, ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
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
  /**
   * `'checkbox'` cuando se pueden elegir varios y `'radio'` cuando la eleccion
   * es unica. Por defecto sigue siendo `'checkbox'`, que es como se usaba.
   *
   * NO ES COSMETICA. Un lector de pantalla anuncia «casilla, no marcada» para
   * lo primero y «boton de opcion» para lo segundo, y la diferencia le dice a
   * quien escucha si al elegir otro se apagara este. Las barras de filtros de
   * alumnos, ventas y devoluciones son de eleccion unica y se anunciaban como
   * casillas: parecia que se podian acumular.
   */
  rol?: 'checkbox' | 'radio' | 'button';
};

export function Chip({
  label,
  selected = false,
  onPress,
  style,
  icon,
  disabled = false,
  rol = 'checkbox',
}: ChipProps) {
  const { colors } = useAppTheme();

  return (
    <Pulsable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      escala={ESCALA_AL_PULSAR.chip}
      opacidad={disabled ? 0.4 : 1}
      accessibilityRole={rol}
      // `checked` vale para los dos papeles; `selected` es el que leen algunos
      // lectores para los botones de opcion, asi que se mandan ambos.
      accessibilityState={{ checked: selected, selected, disabled }}
      accessibilityLabel={label}
      style={[
        styles.base,
        {
          backgroundColor: selected ? colors.primary : colors.background,
          borderColor: selected ? colors.primary : colors.border,
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
      )}
      <Text style={[styles.label, { color: selected ? colors.onPrimary : colors.text }]}>
        {label}
      </Text>
    </Pulsable>
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
