import React from 'react';
import { StyleSheet, ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { estilo, radius, spacing } from '@/theme/tokens';
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

  /*
    VARIANTES DE LOS TEMAS (`estilo.chips`) para el chip ELEGIDO. «actual» es
    relleno `primary`. En todas, lo elegido se distingue también por su forma
    (relleno o borde marcado), no solo por el tono.
  */
  const variante = estilo.chips;
  const elegido =
    variante === 'acento'
      ? { fondo: colors.acento, borde: colors.acento, tinta: colors.sobreAcento }
      : variante === 'pildoraSuave'
        ? { fondo: colors.acentoSuave, borde: colors.acentoSuave, tinta: colors.acento }
        : variante === 'contorno'
          ? { fondo: colors.background, borde: colors.acento, tinta: colors.acento }
          : { fondo: colors.primary, borde: colors.primary, tinta: colors.onPrimary };

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
          backgroundColor: selected ? elegido.fondo : colors.background,
          borderColor: selected ? elegido.borde : colors.border,
        },
        selected && variante === 'contorno' ? styles.contornoElegido : null,
        style,
      ]}
    >
      {icon && (
        <Feather
          name={icon}
          size={14}
          color={selected ? elegido.tinta : colors.text}
          style={styles.icon}
        />
      )}
      <Text style={[styles.label, { color: selected ? elegido.tinta : colors.text }]}>
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
  // Contorno: el borde marcado es lo que dice «elegido». Mismo hueco: se
  // compensa el grosor extra con menos relleno.
  contornoElegido: { borderWidth: 2, paddingHorizontal: spacing.md - 1 },
  label: {
    fontSize: 13,
    fontWeight: '600',
  },
  icon: {
    marginRight: spacing.xs,
  },
});
