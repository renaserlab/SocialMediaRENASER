import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';

import type { EstadoDeEntrega } from '@/lib/lecturaDeMensajes';

type Props = {
  estado: EstadoDeEntrega;
  /** El color de la marca mientras no está leído: el del texto de la burbuja. */
  color: string;
  /** El color de las dos marcas de «leído». */
  colorDeLeido: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * La marca de una burbuja propia: reloj mientras se envía, una marca cuando el
 * servidor lo tiene y dos, con color, cuando ya lo leyeron.
 *
 * LAS DOS MARCAS VAN DIBUJADAS. Feather no trae la doble; lleva el mismo trazo
 * que sus iconos —rejilla de 24, grosor 2, puntas redondas— para que la marca
 * sencilla y la doble parezcan de la misma familia.
 *
 * No lleva accesibilidad propia: la franja donde va ya dice con palabras si el
 * mensaje se envió o se leyó.
 */
export function MarcaDeEntrega({ estado, color, colorDeLeido, size = 11, style }: Props) {
  if (estado === 'enviando' || estado === 'fallido') {
    return (
      <Feather
        name={estado === 'enviando' ? 'clock' : 'alert-circle'}
        size={size}
        color={color}
        style={style as never}
      />
    );
  }
  if (estado === 'enviado') {
    return <Feather name="check" size={size} color={color} style={style as never} />;
  }
  // Algo más ancha que alta: son dos marcas, una asomando detrás de la otra.
  const ancho = Math.round(size * 1.35);
  return (
    <Svg
      width={ancho}
      height={size}
      viewBox="0 0 27 20"
      fill="none"
      style={[styles.fijo, style]}
    >
      <Path
        d="M2 11l5 5L18 4"
        stroke={colorDeLeido}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M25 4L14 16l-1.5-1.5"
        stroke={colorDeLeido}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  // En el navegador un `<svg>` encoge por defecto junto a un texto.
  fijo: { flexShrink: 0 },
});
