import { useCallback, useEffect, useState } from 'react';
import { AppState, Image, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useEventListener } from 'expo';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';

import { VideoScrubber } from '@/components/VideoScrubber';
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
 * Cada cuantos segundos avisa el reproductor de por donde va.
 *
 * Cuatro veces por segundo basta para que la barra se vea avanzar sin saltos y
 * no obliga a repintar en cada fotograma.
 */
const PROGRESS_INTERVAL_SECONDS = 0.25;

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

/** Lee un numero del reproductor devolviendo 0 si ya no esta disponible. */
function readNumber(read: () => number): number {
  try {
    const value = read();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
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
  shortsControls = false,
  controlsBottomInset = 0,
}: VideoPlayerProps) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = loop;
    p.muted = muted;
    if (shortsControls) {
      // Sin esto el reproductor no informa de su avance y la barra se quedaria
      // clavada en el minuto cero.
      p.timeUpdateEventInterval = PROGRESS_INTERVAL_SECONDS;
    }
    if (autoPlay) {
      p.play();
    }
  });

  const [started, setStarted] = useState(autoPlay);
  const [playing, setPlaying] = useState(autoPlay);
  const [progress, setProgress] = useState({ currentTime: 0, duration: 0 });

  // El silencio puede cambiarlo la persona en cualquier momento (boton de
  // sonido); el ajuste inicial del reproductor solo vale para el primer render.
  useEffect(() => {
    safely(() => {
      player.muted = muted;
    });
  }, [muted, player]);

  useEventListener(player, 'playingChange', ({ isPlaying }) => setPlaying(isPlaying));
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    setProgress({ currentTime, duration: readNumber(() => player.duration) });
  });

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

  /*
    Salir de la aplicacion no cambia el foco de navegacion: la pantalla sigue
    siendo la activa. Sin esto, un video con sonido seguiria sonando con el
    movil en el bolsillo.
  */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') safely(() => player.pause());
    });
    return () => subscription.remove();
  }, [player]);

  const start = () => {
    setStarted(true);
    player.play();
  };

  /** Un toque en el video: pausa si sonaba, reanuda si estaba parado. */
  const toggle = useCallback(() => {
    safely(() => {
      if (player.playing) player.pause();
      else player.play();
    });
  }, [player]);

  const seek = useCallback(
    (seconds: number) => {
      safely(() => {
        player.currentTime = seconds;
      });
      // Se adelanta el pintado: el reproductor tarda en confirmar la nueva
      // posicion y, mientras, la barra volveria un instante a donde estaba.
      setProgress((prev) => ({ ...prev, currentTime: seconds }));
    },
    [player],
  );

  // Antes de arrancar manda la portada, que ya ofrece su propio boton de play.
  const showShortsControls = shortsControls && started;

  return (
    <View style={[styles.wrap, style]}>
      <VideoView
        style={StyleSheet.absoluteFill}
        player={player}
        contentFit={contentFit}
        nativeControls={nativeControls && !shortsControls && started}
        // `allowsFullscreen` está deprecada en expo-video. Además, en un feed
        // vertical (reels) no tiene sentido ofrecer pantalla completa.
        fullscreenOptions={{ enable: nativeControls && !shortsControls }}
        allowsPictureInPicture={false}
      />
      {showShortsControls ? (
        <>
          {/*
            La zona de toque va DETRAS de los botones laterales, que son
            hermanos de este reproductor y se pintan despues: asi pulsar el
            corazon no pausa el video.
          */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={toggle}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Pausar video' : 'Reproducir video'}
          >
            {!playing ? (
              <View style={styles.centered} pointerEvents="none">
                <View style={[styles.playCircle, { backgroundColor: media.overlay, borderColor: media.text }]}>
                  <Feather name="play" size={30} color={media.text} />
                </View>
              </View>
            ) : null}
          </Pressable>
          <VideoScrubber
            currentTime={progress.currentTime}
            duration={progress.duration}
            onSeek={seek}
            bottom={controlsBottomInset}
          />
        </>
      ) : null}
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
  centered: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
