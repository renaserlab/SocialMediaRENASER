import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Feather from '@expo/vector-icons/Feather';

import { palette } from '@/theme/tokens';

// Superficie de media: siempre oscura, en ambos temas.
const media = palette('dark');

/**
 * Celda de video dentro de una cuadricula, SIN reproductor.
 *
 * Una cuadricula no reproduce nada: solo enseña que ahi hay un video para que
 * quien mire decida abrirlo. Antes se montaba un reproductor completo por cada
 * celda, y eso traia dos problemas a la vez.
 *
 * El primero, que en el movil no se veia NADA. Un reproductor que no esta
 * reproduciendo y no tiene portada dibuja un rectangulo vacio, asi que un
 * perfil podia anunciar «3 publicaciones» y mostrar la cuadricula en blanco.
 * En el navegador si se veian, porque ahi el reproductor del navegador pinta el
 * primer fotograma por su cuenta: de ahi que el fallo solo apareciera en la
 * aplicacion instalada.
 *
 * El segundo, la memoria. Cada reproductor reserva la suya para ir por delante
 * de la reproduccion, y un perfil carga hasta sesenta publicaciones. Con unos
 * pocos videos ya se agota lo que Android concede a la aplicacion, y la cierra
 * de golpe. Limitar la reserva de cada uno no bastaba, porque el problema no
 * era cuanto ocupaba cada reproductor sino cuantos habia.
 *
 * Es lo mismo que hacen las aplicaciones de referencia: en una cuadricula,
 * imagenes; el reproductor aparece al abrir la publicacion.
 */
export function VideoTile({
  posterUrl,
  posterCacheKey,
  fondo,
  colorSimbolo,
  prioridad,
}: {
  uri?: string | null;
  posterUrl?: string | null;
  /** Ruta del poster en Storage: clave de cache estable frente a refirmas. */
  posterCacheKey?: string | null;
  /**
   * Color de la espera. Por defecto la superficie oscura de media, que es la
   * correcta detras de un video a pantalla completa.
   *
   * Una CUADRICULA es otra cosa: ahi son celdas pequeñas y todas a la vez, y
   * pintarlas de casi-negro convertia el perfil en un tablero de agujeros
   * mientras llegaban los posters. Por eso quien dibuja una cuadricula pasa el
   * gris de su tema.
   */
  fondo?: string;
  /** Color del simbolo de video. Va con `fondo`: uno claro necesita otro. */
  colorSimbolo?: string;
  /**
   * Que se descarga antes. En una cuadricula sin reciclaje arrancan todas las
   * descargas a la vez, y las celdas que estan en pantalla tienen que ganarle
   * la conexion a las que nadie esta mirando.
   */
  prioridad?: 'low' | 'normal' | 'high';
}) {
  return (
    <View style={[styles.wrap, { backgroundColor: fondo ?? media.surfaceAlt }]}>
      {/*
        Cuando exista una miniatura guardada junto al video se pinta aqui. Sin
        ella queda el fondo con el simbolo, que es preferible a un hueco negro:
        se entiende que hay un video aunque todavia no se vea cual.
      */}
      {posterUrl ? (
        <ExpoImage
          source={{ uri: posterUrl, cacheKey: posterCacheKey ?? undefined }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="disk"
          recyclingKey={posterCacheKey ?? posterUrl}
          priority={prioridad}
          transition={120}
        />
      ) : (
        <View style={styles.center}>
          <Feather name="video" size={22} color={colorSimbolo ?? media.textMuted} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
