import React, { useState } from 'react';
import { Image, LayoutChangeEvent, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { assets } from '@/data/assets';
import { SAMPLE_AUDIO } from '@/data/media';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

function formatTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function AudioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  // Reproducción real (expo-audio funciona en iOS/Android/web).
  const player = useAudioPlayer(SAMPLE_AUDIO);
  const status = useAudioPlayerStatus(player);

  const playing = status.playing;
  const currentTime = status.currentTime ?? 0;
  const duration = status.duration && status.duration > 0 ? status.duration : 0;
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  const [trackWidth, setTrackWidth] = useState(0);
  const [saved, setSaved] = useState(false);

  const toggle = () => {
    if (playing) {
      player.pause();
    } else {
      if (status.didJustFinish || currentTime >= duration) {
        player.seekTo(0);
      }
      player.play();
    }
  };

  const seekTo = (seconds: number) => {
    const clamped = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
    player.seekTo(clamped);
  };

  const onTrackPress = (evt: { nativeEvent: { locationX: number } }) => {
    if (duration <= 0 || trackWidth <= 0) return;
    const ratio = Math.max(0, Math.min(1, evt.nativeEvent.locationX / trackWidth));
    seekTo(ratio * duration);
  };

  const onShare = () => {
    Share.share({
      message: 'Escucha "Tu enfoque de esta semana" en RENASER Universo.',
    }).catch(() => {});
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Audio privado para ti" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.container}>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>Basado en el resultado de tu quiz</Text>

          <View style={[styles.cover, { borderColor: colors.border }]}>
            <Image source={assets.audio} style={StyleSheet.absoluteFill} resizeMode="cover" />
            <LinearGradient
              colors={['transparent', colors.overlay]}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.coverBadge}>
              <Feather name="headphones" size={16} color={colors.onPrimary} />
              <Text style={[styles.coverBadgeText, { color: colors.onPrimary }]}>Audio guiado</Text>
            </View>
          </View>

          <Pressable
            style={[styles.progressTrack, { backgroundColor: colors.border }]}
            onLayout={(e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width)}
            onPress={onTrackPress}
            accessibilityRole="adjustable"
            accessibilityLabel="Barra de progreso del audio"
          >
            <View style={[styles.progress, { width: `${progress * 100}%` as any, backgroundColor: colors.primary }]} />
          </Pressable>
          <View style={styles.timeRow}>
            <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(currentTime)}</Text>
            <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(duration)}</Text>
          </View>

          <View style={styles.controls}>
            <Pressable
              onPress={() => seekTo(currentTime - 15)}
              style={styles.smallControl}
              accessibilityLabel="Retroceder 15 segundos"
              accessibilityRole="button"
            >
              <Feather name="rotate-ccw" size={24} color={colors.text} />
              <Text style={[styles.controlLabel, { color: colors.textMuted }]}>15</Text>
            </Pressable>

            <Pressable
              onPress={toggle}
              style={[styles.play, { backgroundColor: colors.primary }]}
              accessibilityLabel={playing ? 'Pausar audio' : 'Reproducir audio'}
              accessibilityRole="button"
            >
              <Feather name={playing ? 'pause' : 'play'} size={32} color={colors.onPrimary} />
            </Pressable>

            <Pressable
              onPress={() => seekTo(currentTime + 15)}
              style={styles.smallControl}
              accessibilityLabel="Adelantar 15 segundos"
              accessibilityRole="button"
            >
              <Feather name="rotate-cw" size={24} color={colors.text} />
              <Text style={[styles.controlLabel, { color: colors.textMuted }]}>15</Text>
            </Pressable>
          </View>

          <View style={styles.actions}>
            <AudioAction icon="share-2" label="Compartir" onPress={onShare} />
            <AudioAction
              icon="bookmark"
              label={saved ? 'Guardado' : 'Guardar'}
              active={saved}
              onPress={() => setSaved((v) => !v)}
            />
          </View>

          <View style={[styles.note, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.noteTitle, { color: colors.text }]}>Tu enfoque de esta semana</Text>
            <Text style={[styles.noteBody, { color: colors.textMuted }]}>
              Elige una decisión que has estado postergando y conviértela en una acción de menos de 20 minutos.
            </Text>
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

function AudioAction({
  icon,
  label,
  active = false,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.actionButton, { opacity: pressed ? 0.8 : 1 }]}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Feather name={icon} size={22} color={active ? colors.primary : colors.text} />
      <Text style={{ color: active ? colors.text : colors.textMuted, fontSize: 11, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.xl, alignItems: 'center' },
  subtitle: { fontSize: 12, marginTop: spacing.sm, marginBottom: spacing.xl },
  cover: { width: '100%', aspectRatio: 1, borderRadius: radius.lg, borderWidth: 1, overflow: 'hidden', justifyContent: 'flex-end' },
  coverBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, margin: spacing.lg, alignSelf: 'flex-start' },
  coverBadgeText: { fontSize: 12, fontWeight: '700' },
  progressTrack: { height: 6, width: '100%', borderRadius: radius.pill, overflow: 'hidden', marginTop: spacing.xl },
  progress: { height: '100%' },
  timeRow: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  time: { fontSize: 10 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxl, marginVertical: spacing.xl },
  play: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center' },
  smallControl: { alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44 },
  controlLabel: { fontSize: 9, marginTop: 2, fontWeight: '600' },
  actions: { flexDirection: 'row', width: '100%', marginVertical: spacing.xl, justifyContent: 'space-around' },
  actionButton: { alignItems: 'center', gap: 6, minWidth: 44, minHeight: 44 },
  note: { width: '100%', borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  noteTitle: { fontSize: 14, fontWeight: '800' },
  noteBody: { fontSize: 13, lineHeight: 18, marginTop: spacing.sm },
});
