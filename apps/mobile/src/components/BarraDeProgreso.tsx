import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { radius } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Cuánto se lleva hecho de algo, en una barra.
 *
 * EL PORCENTAJE LLEGA CALCULADO. Esta pieza no decide nada: lo que significa
 * «completado» vive en el servidor (`progreso.py`, `finalizacion.py`) y aquí
 * solo se dibuja. Si calculara, habría dos reglas y un día no coincidirían.
 *
 * Lo único que hace por su cuenta es ACOTAR entre 0 y 100: un porcentaje fuera
 * de rango dibujaría una barra más ancha que su carril, y eso se nota.
 */
export function BarraDeProgreso({
  porcentaje,
  style,
}: {
  porcentaje: number;
  style?: ViewStyle;
}) {
  const { colors } = useAppTheme();
  const valor = Number.isFinite(porcentaje)
    ? Math.max(0, Math.min(100, Math.round(porcentaje)))
    : 0;

  return (
    <View
      style={[styles.carril, { backgroundColor: colors.surfaceAlt }, style]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: valor }}
    >
      <View
        style={[styles.relleno, { width: `${valor}%`, backgroundColor: colors.text }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  carril: { height: 6, borderRadius: radius.sm, overflow: 'hidden' },
  relleno: { height: '100%', borderRadius: radius.sm },
});
