import { Image, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { palette, spacing } from '@/theme/tokens';
import type { VideoPlayerProps } from './VideoPlayer.types';

// En web evitamos cargar expo-video (módulo nativo) para no romper el bundle.
// Mostramos el póster con tratamiento oscuro; el video real corre en la app móvil.
const media = palette('dark');

export function VideoPlayer({ poster, style }: VideoPlayerProps) {
  return (
    <View style={[styles.wrap, style]}>
      {poster ? <Image source={poster} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: media.overlay }]} />
      <View style={styles.center}>
        <View style={[styles.playCircle, { backgroundColor: media.overlay, borderColor: media.textMuted }]}>
          <Feather name="play" size={30} color={media.text} />
        </View>
        <Text style={[styles.note, { color: media.textMuted }]}>Reproducción disponible en la app móvil</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', backgroundColor: media.background },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  playCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  note: { fontSize: 12 },
});
