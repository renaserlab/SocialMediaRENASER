import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { AudioScrubber } from '@/components/AudioScrubber';
import { Text } from '@/components/Text';
import { useBackgroundAudio } from '@/hooks/useBackgroundAudio';
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
  useBackgroundAudio();

  const playing = status?.playing ?? false;
  const duration = status?.duration ?? 0;
  const current = status?.currentTime ?? 0;

  // Segundo que marca el dedo mientras se arrastra; `null` el resto del tiempo.
  const [scrubTime, setScrubTime] = useState<number | null>(null);

  // Controles en la pantalla de bloqueo (y en el aviso de Android). Sin esto el
  // audio sigue sonando de fondo pero no hay forma de pararlo sin volver a
  // abrir la app. Solo existe en nativo; en web la comprobación lo salta.
  useEffect(() => {
    if (typeof player.setActiveForLockScreen !== 'function') return;
    player.setActiveForLockScreen(
      true,
      { title: title ?? 'Audio', artist: 'RENASER' },
      { showSeekForward: true, showSeekBackward: true },
    );
    return () => {
      // Ceder el sitio: solo un reproductor puede ocupar la pantalla de bloqueo.
      try {
        player.setActiveForLockScreen(false);
      } catch {
        /* El reproductor ya se liberó al desmontarse. */
      }
    };
  }, [player, title]);

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

        <AudioScrubber
          currentTime={current}
          duration={duration}
          onSeek={(seconds) => void player.seekTo(seconds)}
          onScrubChange={setScrubTime}
          knobBorderColor={colors.surfaceAlt}
        />

        <Text variant="secondary" color={colors.textMuted}>
          {/* Al arrastrar se muestra el destino, para verlo antes de soltar. */}
          {formatTime(scrubTime ?? current)} / {formatTime(duration)}
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
  info: { flex: 1, gap: 2 },
});
