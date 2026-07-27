import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { VideoScrubber } from '@/components/VideoScrubber';
import { palette } from '@/theme/tokens';
import type { VideoPlayerProps } from './VideoPlayer.types';

// En web no se puede usar expo-video (modulo nativo), pero el navegador ya trae
// un reproductor: montamos un <video> del DOM. Antes esto era un placeholder
// estatico ("Reproduccion disponible en la app movil") y el video no se veia.
const media = palette('dark');

const OBJECT_FIT = {
  cover: 'cover',
  contain: 'contain',
  fill: 'fill',
} as const satisfies Record<NonNullable<VideoPlayerProps['contentFit']>, string>;

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
  onMutedChange,
}: VideoPlayerProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(autoPlay);
  const [progress, setProgress] = useState({ currentTime: 0, duration: 0 });

  // El silencio puede cambiarlo la persona con el boton de sonido, y ademas lo
  // toca el propio componente cuando el navegador bloquea el autoarranque con
  // audio: se mantiene el elemento al dia en las dos direcciones.
  useEffect(() => {
    const el = ref.current;
    if (el) el.muted = muted;
  }, [muted]);

  // Reproduccion por viewport (feeds tipo reels), igual que en nativo.
  useEffect(() => {
    const el = ref.current;
    if (!el || active === undefined) return;
    if (!active) {
      el.pause();
      return;
    }
    void el.play().catch(() => {
      /*
        Los navegadores no dejan que un video empiece con sonido si la persona
        aun no ha tocado la pagina. Antes que quedarse en negro sin reproducir,
        arranca en silencio y se avisa para que el boton de sonido lo refleje y
        pueda activarlo de un toque.
      */
      el.muted = true;
      onMutedChange?.(true);
      void el.play().catch(() => {});
    });
  }, [active, onMutedChange]);

  // Estado y avance para los controles propios.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () =>
      setProgress({
        currentTime: el.currentTime,
        // `duration` es NaN hasta que llegan los metadatos, y una emision en
        // directo la informa como Infinity.
        duration: Number.isFinite(el.duration) ? el.duration : 0,
      });
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onTime);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onTime);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
    };
  }, []);

  /** Un toque en el video: pausa si sonaba, reanuda si estaba parado. */
  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  const seek = useCallback((seconds: number) => {
    const el = ref.current;
    if (!el) return;
    el.currentTime = seconds;
    setProgress((prev) => ({ ...prev, currentTime: seconds }));
  }, []);

  // `poster` es un require() de React Native; ExpoImage sabe resolverlo a URL,
  // el atributo poster del DOM no. Lo pintamos debajo del video.
  const posterUri = typeof poster === 'number' ? undefined : (poster as { uri?: string })?.uri;

  /**
   * Primer fotograma como portada.
   *
   * Con `preload="metadata"` el navegador descarga la duracion y las medidas,
   * pero NO pinta ningun fotograma: el hueco queda negro hasta que alguien
   * pulsa play, y en el muro parece que el video esta roto o vacio.
   *
   * El fragmento `#t=0.001` le pide que se situe en ese instante, y al hacerlo
   * dibuja ese fotograma. Es la forma habitual de conseguir una portada sin
   * generar imagenes aparte ni guardarlas en el servidor.
   *
   * Se anade solo si la URL no traia ya un fragmento, para no pisarlo. Las
   * firmadas de Supabase llevan sus parametros en la query (`?token=`), asi que
   * no estorba.
   */
  const src = uri && !uri.includes('#') ? `${uri}#t=0.001` : uri;

  return (
    <View style={[styles.wrap, style]}>
      {poster ? (
        <ExpoImage source={poster} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : null}
      <video
        ref={ref}
        src={src}
        poster={posterUri}
        controls={nativeControls && !shortsControls}
        autoPlay={autoPlay}
        loop={loop}
        muted={muted}
        playsInline
        preload="metadata"
        // Sin esto el menu "..." del navegador ofrece Descargar / Imagen en
        // imagen: no queremos que el contenido se difunda fuera de la app.
        controlsList="nodownload noplaybackrate noremoteplayback"
        disablePictureInPicture
        disableRemotePlayback
        // El menu contextual del navegador tiene su propio "Guardar video como".
        onContextMenu={(event) => event.preventDefault()}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: OBJECT_FIT[contentFit],
          backgroundColor: media.background,
        }}
      />
      {shortsControls ? (
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
    </View>
  );
}

const styles = StyleSheet.create({
  // Gris muy oscuro en vez de negro puro: mientras el fotograma llega, un
  // rectangulo negro se lee como un hueco roto; este se lee como algo cargando.
  wrap: { overflow: 'hidden', backgroundColor: '#1c1c1c' },
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
