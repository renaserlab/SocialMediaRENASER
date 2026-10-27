import React, { useState } from 'react';
import { Image as RNImage, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import { Image as ExpoImage } from 'expo-image';

import { perfMark } from '@/lib/perf';
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
 * El encuadre con el que se va a publicar una foto, o `null` si aún no se
 * conocen sus medidas.
 *
 * EXISTE PARA QUE LA VISTA PREVIA NO MIENTA. Al elegir la foto, Crear la
 * pintaba a pantalla completa con `cover`: se recortaban los lados y quien
 * publicaba veía una composición que el muro no iba a reproducir. Como el
 * recorte de verdad lo decide ESTA regla, la previa tiene que consumir la misma
 * función y no una copia con los mismos números, que es como acaban divergiendo.
 */
export function encuadreDePublicacion(
  width?: number | null,
  height?: number | null,
): number | null {
  if (!width || !height) return null;
  return limitar(width / height);
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
  cacheKey,
  width,
  height,
  style,
}: {
  source?: ImageSourcePropType;
  uri?: string;
  /**
   * Identidad ESTABLE de la imagen para la cache de disco (la ruta en
   * Storage). La URL firmada cambia con cada firma; sin esta clave, cada
   * refirma invalidaba la cache y la foto se descargaba entera otra vez.
   */
  cacheKey?: string;
  /** Medidas reales del backend: reservan el hueco exacto desde el primer render. */
  width?: number;
  height?: number;
  style?: object;
}) {
  const { colors } = useAppTheme();
  /*
    La proporcion se resuelve ANTES de descargar nada siempre que se pueda:
    de la metadata del backend (fotos remotas con medidas guardadas) o del
    propio bundle (imagenes locales). Solo las fotos antiguas sin medidas
    esperan al onLoad, y son las unicas que pueden reajustar el alto.
  */
  const [proporcion, setProporcion] = useState(() => {
    if (width && height) return limitar(width / height);
    if (uri || !source) return PROPORCION_INICIAL;
    // react-native-web no trae `resolveAssetSource`: en web, con las fotos
    // locales de la demo, llamarlo tumbaba el muro entero. Sin el, la
    // proporcion la corrige `onLoad`, como con las fotos antiguas sin medidas.
    if (typeof RNImage.resolveAssetSource !== 'function') return PROPORCION_INICIAL;
    const resuelta = RNImage.resolveAssetSource(source as never);
    return resuelta?.width && resuelta?.height
      ? limitar(resuelta.width / resuelta.height)
      : PROPORCION_INICIAL;
  });

  return (
    <View style={[styles.wrap, { aspectRatio: proporcion, backgroundColor: colors.surfaceAlt }, style]}>
      <ExpoImage
        source={uri ? { uri, cacheKey: cacheKey ?? undefined } : source}
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
          perfMark('FIRST_IMAGE_VISIBLE');
          if (cargada?.width && cargada?.height) {
            const real = limitar(cargada.width / cargada.height);
            // Evita un re-render cuando la metadata ya acerto.
            setProporcion((previa) => (Math.abs(previa - real) < 0.01 ? previa : real));
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
        recyclingKey={cacheKey ?? uri ?? undefined}
        transition={150}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', overflow: 'hidden' },
});
