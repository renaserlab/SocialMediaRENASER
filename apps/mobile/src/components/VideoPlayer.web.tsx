import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';

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
}: VideoPlayerProps) {
  const ref = useRef<HTMLVideoElement | null>(null);

  // Reproduccion por viewport (feeds tipo reels), igual que en nativo.
  useEffect(() => {
    const el = ref.current;
    if (!el || active === undefined) return;
    if (active) void el.play().catch(() => {});
    else el.pause();
  }, [active]);

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
        controls={nativeControls}
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
    </View>
  );
}

const styles = StyleSheet.create({
  // Gris muy oscuro en vez de negro puro: mientras el fotograma llega, un
  // rectangulo negro se lee como un hueco roto; este se lee como algo cargando.
  wrap: { overflow: 'hidden', backgroundColor: '#1c1c1c' },
});
