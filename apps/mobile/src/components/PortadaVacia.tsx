import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { useAppTheme } from '@/theme/useAppTheme';

type PortadaVaciaProps = {
  /** De qué es lo que no tiene imagen: un curso, un servicio… */
  icono: keyof typeof Feather.glyphMap;
  /** El tamaño y la forma los pone quien la usa: es la misma caja que la foto. */
  style?: StyleProp<ViewStyle>;
  tamano?: number;
  /**
   * Cómo se le dice a un lector de pantalla. Sin ella no se anuncia: el hueco
   * de una portada no es información, y el título ya dice de qué es la tarjeta.
   */
  etiqueta?: string;
};

/**
 * El sitio de una portada cuando no hay portada.
 *
 * LO QUE HABÍA (visto el 05/10/2026 al revisar Cursos con datos). Un curso sin
 * imagen pintaba una caja del color de la superficie, que en el tema claro es
 * el mismo blanco que el fondo: no se veía nada. La tarjeta quedaba como un
 * título flotando bajo un hueco, con el marcador de «guardar» colgado en el
 * aire, y la rejilla entera parecía a medio cargar.
 *
 * Ahora ese sitio se ve como lo que es —una portada que falta— con un tono
 * apagado y el icono de aquello de lo que se trata. Sale del tema: en oscuro
 * sigue distinguiéndose del fondo.
 */
export function PortadaVacia({ icono, style, tamano = 22, etiqueta }: PortadaVaciaProps) {
  const { colors } = useAppTheme();
  return (
    <View
      style={[styles.caja, { backgroundColor: colors.surfaceAlt }, style]}
      accessible={!!etiqueta}
      accessibilityLabel={etiqueta}
      accessibilityElementsHidden={!etiqueta}
      importantForAccessibility={etiqueta ? 'yes' : 'no-hide-descendants'}
    >
      <Feather name={icono} size={tamano} color={colors.textMuted} />
    </View>
  );
}

const styles = StyleSheet.create({
  caja: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
