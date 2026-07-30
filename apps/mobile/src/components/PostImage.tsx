import React, { useState } from 'react';
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
  /*
    Las medidas de una imagen que viene con la aplicacion se conocen sin
    descargar nada, asi que se resuelven ya. Las de una foto remota llegan
    cuando termina de cargarse.
  */
  const [proporcion, setProporcion] = useState(() => {
    if (uri || !source) return PROPORCION_INICIAL;
    const resuelta = RNImage.resolveAssetSource(source as never);
    return resuelta?.width && resuelta?.height
      ? limitar(resuelta.width / resuelta.height)
      : PROPORCION_INICIAL;
  });

  return (
    <View style={[styles.wrap, { aspectRatio: proporcion, backgroundColor: colors.surfaceAlt }, style]}>
      <ExpoImage
        source={uri ? { uri } : source}
        contentFit="cover"
        contentPosition="center"
        /*
          Las medidas se leen de la imagen que YA se esta mostrando.

          Antes se pedian aparte con `Image.getSize`, que en Android descarga y
          descomprime la foto ENTERA solo para mirar cuanto mide, y despues se
          volvia a descargar para pintarla: dos descargas y dos copias en
          memoria por cada foto del muro.

          Con fotos hechas con el movil eso no es poca cosa. Una de seis megas
          ocupa unos cuarenta y ocho al descomprimirse, y con varias recorridas
          la aplicacion agotaba la memoria que Android le concede y la cerraba
          de golpe. El aviso solia aparecer al empezar a descargar un video,
          que era lo siguiente en pedir memoria, aunque la culpa no fuera suya.
        */
        onLoad={({ source: cargada }) => {
          if (cargada?.width && cargada?.height) {
            setProporcion(limitar(cargada.width / cargada.height));
          }
        }}
        /*
          En disco, no en memoria. La foto del muro es grande y en memoria se
          guarda descomprimida: conservar ahi todas las que se han ido
          recorriendo es lo que agotaba el limite. Desde disco se vuelve a
          mostrar al instante y sin volver a la red.
        */
        cachePolicy="disk"
        /*
          La lista reaprovecha las mismas filas segun se desplaza. Sin esta
          marca la imagen anterior sigue ocupando memoria hasta que le toca
          soltarse; con ella se libera en cuanto la fila pasa a otra foto.
        */
        recyclingKey={uri ?? undefined}
        transition={150}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', overflow: 'hidden' },
});
