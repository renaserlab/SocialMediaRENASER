import { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';

import { palette } from '@/theme/tokens';
import type { VideoPlayerProps } from './VideoPlayer.types';

// Las superficies de video son siempre oscuras → usamos la paleta dark como
// contexto de "media" para que los overlays sean legibles en ambos temas.
const media = palette('dark');

/**
 * Oscurecido minimo sobre el video en reposo: lo justo para que el boton de
 * reproduccion se distinga sobre un fotograma claro, sin llegar a ocultar de que
 * va el video.
 */
const SOFT_VEIL = 'rgba(0,0,0,0.18)';

/**
 * Ejecuta una accion sobre el reproductor tolerando que ya no exista.
 *
 * `useVideoPlayer` libera el reproductor NATIVO al desmontar el componente,
 * pero las limpiezas de los efectos de React corren despues. Al salir de una
 * pantalla con video, `player.pause()` se ejecutaba sobre un objeto ya
 * liberado y lanzaba NativeSharedObjectNotFoundException, que tumbaba la app
 * con una pantalla roja.
 *
 * expo-video no expone forma de saber si el reproductor sigue vivo, asi que se
 * captura el fallo. Es seguro porque estas llamadas son de control de
 * reproduccion: si el reproductor ya no esta, no hay nada que pausar.
 */
function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Reproductor ya liberado; no queda nada que hacer.
  }
}

export function VideoPlayer({
  uri,
  poster,
  style,
  loop = false,
  autoPlay = false,
  muted = false,
  contentFit = 'cover',
  nativeControls = true,
  active,
}: VideoPlayerProps) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = loop;
    p.muted = muted;
    if (autoPlay) {
      p.play();
    }
  });

  const [started, setStarted] = useState(autoPlay);

  // Reproducción por viewport: play/pausa según `active` (feeds tipo reels).
  useEffect(() => {
    if (active === undefined) return;
    if (active) {
      setStarted(true);
      safely(() => player.play());
    } else {
      safely(() => player.pause());
    }
  }, [active, player]);

  // Con el Stack, las pantallas anteriores siguen montadas: sin esto un video
  // seguiría decodificando en segundo plano (batería y hasta 4-7 players a la
  // vez). Pausamos al perder el foco y reanudamos solo si debía reproducir.
  useFocusEffect(
    useCallback(() => {
      if (autoPlay || active) {
        safely(() => player.play());
      }
      return () => {
        // Esta limpieza corre tambien al desmontar, cuando el reproductor
        // nativo ya puede estar liberado: de ahi la guarda.
        safely(() => player.pause());
      };
    }, [player, autoPlay, active]),
  );

  const start = () => {
    setStarted(true);
    player.play();
  };

  return (
    <View style={[styles.wrap, style]}>
      <VideoView
        style={StyleSheet.absoluteFill}
        player={player}
        contentFit={contentFit}
        nativeControls={nativeControls && started}
        // `allowsFullscreen` está deprecada en expo-video. Además, en un feed
        // vertical (reels) no tiene sentido ofrecer pantalla completa.
        fullscreenOptions={{ enable: nativeControls }}
        allowsPictureInPicture={false}
      />
      {!started && (
        <Pressable
          style={styles.posterLayer}
          onPress={start}
          accessibilityRole="button"
          accessibilityLabel="Reproducir video"
        >
          {poster ? <Image source={poster} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
          {/*
            Velo MUY tenue. Antes cubria el video con un negro al 72 %, asi que
            en el muro un video sin portada se veia como un rectangulo negro:
            el primer fotograma que ya pinta el reproductor quedaba tapado y
            parecia que no hubiera nada hasta pulsar play.

            El circulo de reproduccion lleva su propio fondo, de modo que se lee
            igual sobre una imagen clara sin necesidad de oscurecerla entera.
          */}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: SOFT_VEIL }]} />
          <View style={[styles.playCircle, { backgroundColor: media.overlay, borderColor: media.text }]}>
            <Feather name="play" size={30} color={media.text} />
          </View>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', backgroundColor: media.background },
  posterLayer: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
