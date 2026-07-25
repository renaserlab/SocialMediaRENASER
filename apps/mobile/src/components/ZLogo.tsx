import React from 'react';
import { Image, StyleSheet, View } from 'react-native';

import { radius } from '@/theme/tokens';

/**
 * Logo de Z.
 *
 * Es la marca con su textura —la Z blanca en relieve sobre el negro mate—, no
 * la letra escrita con la tipografía de la aplicación: una «Z» de texto se ve
 * como cualquier otra letra y pierde por completo la identidad.
 *
 * Se usa el mismo archivo que el icono de la aplicación, para que la marca sea
 * la misma en la tienda y dentro del producto y no haya dos versiones que
 * mantener por separado.
 */
export function ZLogo({ size = 28 }: { size?: number }) {
  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          // Proporcional al tamaño: con un radio fijo, el logo grande de la
          // pantalla de idioma saldría con las esquinas casi rectas.
          borderRadius: size <= 32 ? radius.sm : size * 0.22,
        },
      ]}
    >
      <Image
        source={require('../../assets/icon.png')}
        style={styles.image}
        resizeMode="cover"
        accessibilityLabel="Z"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // `overflow: hidden` recorta la imagen al radio; sin esto las esquinas del
  // PNG asoman cuadradas por encima del contenedor.
  wrap: { overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
});
