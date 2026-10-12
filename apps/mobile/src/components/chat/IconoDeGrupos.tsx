import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';

type Props = {
  size?: number;
  color: string;
};

/**
 * Dos globos de conversación, uno asomando detrás del otro: el icono con el
 * que se reconoce «aquí hay un grupo al que entrar».
 *
 * VA DIBUJADO, y no sale de Feather, porque Feather solo tiene el globo suelto
 * y en Z ese ya significa «mensaje»: dos botones con el mismo icono y distinto
 * destino, uno al lado del otro, no se distinguen. Lleva el mismo trazo que
 * Feather —rejilla de 24, grosor 2, puntas redondas— para no desentonar junto
 * a sus iconos.
 *
 * Es decorativo y no lleva nada de accesibilidad propio: va siempre dentro de
 * un botón que ya dice con palabras qué grupo es, y un botón se anuncia entero.
 */
export function IconoDeGrupos({ size = 16, color }: Props) {
  return (
    // `flexShrink: 0`: junto a un nombre largo el que cede es el texto. En el
    // navegador un `<svg>` encoge por defecto y el icono se quedaba en un punto.
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={styles.fijo}>
      {/* El de detrás: solo el arco que el de delante no tapa. */}
      <Path
        d="M4.31 12.91A6.5 6.5 0 0 1 12.75 3.37"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* El de delante, con su pico abajo a la izquierda. */}
      <Path
        d="M10.5 19.06A7 7 0 1 0 7.94 16.5L7.49 19.51Z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  fijo: { flexShrink: 0 },
});
