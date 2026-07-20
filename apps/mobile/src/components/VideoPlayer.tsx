import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';

import { palette } from '@/theme/tokens';
import type { VideoPlayerProps } from './VideoPlayer.types';

// Las superficies de video son siempre oscuras → usamos la paleta dark como
// contexto de "media" para que los overlays sean legibles en ambos temas.
const media = palette('dark');

export function VideoPlayer({
  uri,
  poster,
  style,
  loop = false,
  autoPlay = false,
  muted = false,
  contentFit = 'cover',
  nativeControls = true,
}: VideoPlayerProps) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = loop;
    p.muted = muted;
    if (autoPlay) {
      p.play();
    }
  });

  const [started, setStarted] = useState(autoPlay);

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
        allowsFullscreen
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
          <View style={[StyleSheet.absoluteFill, { backgroundColor: media.overlay }]} />
          <View style={[styles.playCircle, { backgroundColor: media.overlay, borderColor: media.textMuted }]}>
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
