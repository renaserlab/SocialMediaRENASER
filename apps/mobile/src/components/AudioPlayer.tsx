import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/** Reproductor compacto de audio para publicaciones del feed. */
export function AudioPlayer({ uri, title }: { uri: string; title?: string }) {
  const { colors } = useAppTheme();
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);

  const playing = status?.playing ?? false;
  const duration = status?.duration ?? 0;
  const current = status?.currentTime ?? 0;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  const toggle = () => {
    if (playing) player.pause();
    else player.play();
  };

  return (
    <View style={[styles.wrap, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
      <Pressable
        onPress={toggle}
        style={[styles.button, { backgroundColor: colors.primary }]}
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pausar audio' : 'Reproducir audio'}
        hitSlop={8}
      >
        <Feather name={playing ? 'pause' : 'play'} size={20} color={colors.onPrimary} />
      </Pressable>

      <View style={styles.info}>
        <Text variant="secondary" weight="600" numberOfLines={1}>
          {title ?? 'Audio'}
        </Text>
        <View style={[styles.track, { backgroundColor: colors.border }]}>
          <View
            style={[styles.progress, { width: `${progress * 100}%`, backgroundColor: colors.primary }]}
          />
        </View>
        <Text variant="secondary" color={colors.textMuted}>
          {formatTime(current)} / {formatTime(duration)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  info: { flex: 1, gap: 6 },
  track: { height: 4, borderRadius: radius.pill, overflow: 'hidden' },
  progress: { height: '100%' },
});
