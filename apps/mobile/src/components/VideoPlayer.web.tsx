import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useFocusEffect } from 'expo-router';
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
  hidePlayButton = false,
  onMutedChange,
}: VideoPlayerProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(autoPlay);
  // Igual que en nativo: el circulo de play solo reaparece si la pausa la pidio
  // la persona. Ver `hidePlayButton` en VideoPlayer.types.ts.
  const [userPaused, setUserPaused] = useState(false);
  const [progress, setProgress] = useState({ currentTime: 0, duration: 0 });

  /*
    UNA SOLA VERDAD SOBRE EL SILENCIO.

    Esto se sincroniza en CADA render y ademas cada vez que el elemento carga
    algo nuevo. No es un exceso de celo: se midio el caso contrario —la interfaz
    anunciando «Activar el sonido» (es decir, silenciado) mientras el elemento
    tenia `muted=false` y sonaba—, que es exactamente el fallo que se reporto.

    Por que se desincronizaba:

     - El efecto anterior dependia solo de `[muted]`, asi que no volvia a
       ejecutarse cuando la lista RECICLABA la celda y aparecia un elemento
       distinto con el mismo valor de la propiedad.
     - `muted` viajaba ademas como propiedad de JSX. Al cambiar de fuente, el
       navegador reajusta el elemento a partir de su ATRIBUTO, y React no ve
       ningun cambio que reconciliar porque para el el valor sigue siendo el
       mismo. Nadie volvia a ponerlo.
     - Y el respaldo de autoarranque (abajo) escribe sobre el elemento por su
       cuenta, porque el navegador exige que sea sincrono.

    Con tres sitios escribiendo y ninguno mandando, era cuestion de tiempo. Una
    asignacion por render no se nota; una interfaz que miente, si.
  */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = muted;
    // Cargar una fuente nueva reinicia el elemento: se vuelve a aplicar.
    const reaplicar = () => {
      if (ref.current) ref.current.muted = muted;
    };
    el.addEventListener('loadedmetadata', reaplicar);
    el.addEventListener('play', reaplicar);
    return () => {
      el.removeEventListener('loadedmetadata', reaplicar);
      el.removeEventListener('play', reaplicar);
    };
  });

  // Reproduccion por viewport (feeds tipo reels), igual que en nativo.
  useEffect(() => {
    const el = ref.current;
    if (!el || active === undefined) return;
    if (!active) {
      el.pause();
      return;
    }
    setUserPaused(false);
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

  /*
    Cambiar de pestaña PARA el video, igual que en la version nativa.

    Las pantallas ya visitadas siguen montadas, asi que sin esto un video del
    muro seguia descargando y decodificando mientras la persona estaba en
    Explorar o en Perfil. En movil lo evitaba `useFocusEffect`, pero esta
    variante para navegador no lo tenia, y ahora que pueden sonar varios videos
    a la vez el desperdicio se multiplicaba. Al volver, solo se reanuda el que
    de verdad le toca reproducir.
  */
  useFocusEffect(
    useCallback(() => {
      const el = ref.current;
      if (el && (autoPlay || active)) void el.play().catch(() => {});
      return () => {
        ref.current?.pause();
      };
    }, [autoPlay, active]),
  );

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
    if (el.paused) {
      setUserPaused(false);
      void el.play().catch(() => {});
    } else {
      el.pause();
      setUserPaused(true);
    }
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
        /* Mismo encuadre que el video: si no, al arrancar cambia de recorte. */
        <ExpoImage
          source={poster}
          style={StyleSheet.absoluteFill}
          contentFit={contentFit === 'fill' ? 'cover' : contentFit}
        />
      ) : null}
      <video
        ref={ref}
        src={src}
        poster={posterUri}
        controls={nativeControls && !shortsControls}
        autoPlay={autoPlay}
        loop={loop}
        /* `muted` NO va aqui: lo lleva el efecto de arriba, que es quien manda.
           Como atributo solo fijaria el valor inicial y volveria a abrir la
           puerta a que elemento y estado digan cosas distintas. */
        playsInline
        /*
          Cuando este video ya tiene turno para reproducirse no tiene sentido
          pedir solo la cabecera y esperar: se pide contenido desde el primer
          momento. Los que estan de paso siguen costando solo los metadatos.
        */
        preload={active || autoPlay ? 'auto' : 'metadata'}
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
            {!playing && (!hidePlayButton || userPaused) ? (
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
