import React, { useEffect, useState } from 'react';
import { Image as RNImage, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import { Image as ExpoImage } from 'expo-image';

import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Proporciones límite, las mismas que usa Instagram.
 *
 * Una foto no puede ocupar la pantalla entera ni quedar como una franja: se
 * permite desde apaisada (1.91:1) hasta vertical (4:5), y solo lo que se salga
 * de ese rango se recorta.
 */
const MAS_APAISADA = 1.91;
const MAS_VERTICAL = 0.8; // 4:5

/** Mientras no se conocen las medidas reales, se reserva un cuadrado. */
const PROPORCION_INICIAL = 1;

function limitar(proporcion: number): number {
  if (!Number.isFinite(proporcion) || proporcion <= 0) return PROPORCION_INICIAL;
  return Math.min(MAS_APAISADA, Math.max(MAS_VERTICAL, proporcion));
}

/**
 * Foto de una publicación, encuadrada respetando su forma.
 *
 * Antes se pintaban todas dentro de una caja de 340 px de alto y se recortaba
 * lo que sobraba, así que una foto vertical —la mayoría, porque se hacen con el
 * móvil— aparecía partida por la mitad: se perdían las cabezas.
 *
 * Ahora el alto lo marca la propia foto, dentro de unos límites: se ve entera
 * salvo que sea extremadamente alargada, y en ese caso se recorta centrada, que
 * es donde suele estar lo importante.
 */
export function PostImage({
  source,
  uri,
  style,
}: {
  source?: ImageSourcePropType;
  uri?: string;
  style?: object;
}) {
  const { colors } = useAppTheme();
  const [proporcion, setProporcion] = useState(PROPORCION_INICIAL);

  useEffect(() => {
    let vigente = true;
    if (uri) {
      RNImage.getSize(
        uri,
        (ancho, alto) => {
          if (vigente && alto > 0) setProporcion(limitar(ancho / alto));
        },
        // Si no se pueden leer las medidas (sin red, enlace caducado) se queda
        // el cuadrado: es mejor que no reservar espacio y que la lista salte.
        () => {},
      );
    } else if (source) {
      const resuelta = RNImage.resolveAssetSource(source as never);
      if (resuelta?.width && resuelta?.height) {
        setProporcion(limitar(resuelta.width / resuelta.height));
      }
    }
    return () => {
      vigente = false;
    };
  }, [uri, source]);

  return (
    <View style={[styles.wrap, { aspectRatio: proporcion, backgroundColor: colors.surfaceAlt }, style]}>
      <ExpoImage
        source={uri ? { uri } : source}
        contentFit="cover"
        contentPosition="center"
        cachePolicy="memory-disk"
        transition={150}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', overflow: 'hidden' },
});
