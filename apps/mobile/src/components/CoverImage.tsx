import React, { useState } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';

import { radius } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Proporción usada mientras no se conoce la real (banner tipo 820x312).
 * Es la más habitual en las portadas de evento, así que el salto al cargar la
 * imagen suele ser inapreciable.
 */
const FALLBACK_RATIO = 820 / 312;

type Props = {
  uri: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Portada de un evento o curso, siempre completa.
 *
 * El contenedor adopta la proporción REAL de la imagen (se lee en `onLoad`),
 * así que no hay recorte ni franjas negras: un banner apaisado se ve entero y
 * uno cuadrado también.
 *
 * Antes se pintaba con alto fijo y `contentFit="cover"`, que recorta: en un
 * banner de 820x312 metido en una caja 16:9 se perdían los laterales, que es
 * justo donde suelen ir el lugar y las fechas.
 */
export function CoverImage({ uri, style }: Props) {
  const { colors } = useAppTheme();
  const [ratio, setRatio] = useState(FALLBACK_RATIO);

  return (
    <View
      style={[
        styles.wrap,
        { aspectRatio: ratio, backgroundColor: colors.surfaceAlt },
        style,
      ]}
    >
      <ExpoImage
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        // `contain` como red de seguridad: si la proporción aún no se conoce
        // (primer render), se ve entera igualmente en vez de recortada.
        contentFit="contain"
        cachePolicy="memory-disk"
        transition={150}
        onLoad={({ source }) => {
          if (source?.width && source?.height) {
            setRatio(source.width / source.height);
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', borderRadius: radius.lg, overflow: 'hidden' },
});
