import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { assets } from '@/data/assets';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const source = require('../../assets/sample-audio.wav');

function formatTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function AudioScreen() {
  const { colors } = useAppTheme();
  const player = useAudioPlayer(source, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const duration = status.duration || 18;
  const progress = Math.min(1, (status.currentTime || 0) / duration);

  const toggle = () => {
    if (status.playing) player.pause();
    else player.play();
  };

  return (
    <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
      <AppHeader back title="Audio privado para ti" />
      <View style={styles.container}>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>Basado en el resultado de tu quiz</Text>
        <Image source={assets.audio} style={styles.cover} />

        <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
          <View style={[styles.progress, { width: `${progress * 100}%`, backgroundColor: colors.text }]} />
        </View>
        <View style={styles.timeRow}>
          <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(status.currentTime)}</Text>
          <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(duration)}</Text>
        </View>

        <View style={styles.controls}>
          <Pressable onPress={() => player.seekTo(Math.max(0, status.currentTime - 15))} style={styles.smallControl}>
            <Ionicons name="play-back" size={25} color={colors.text} />
            <Text style={[styles.controlLabel, { color: colors.textMuted }]}>15</Text>
          </Pressable>
          <Pressable onPress={toggle} style={[styles.play, { backgroundColor: colors.primary }]}>
            <Ionicons name={status.playing ? 'pause' : 'play'} size={38} color={colors.onPrimary} />
          </Pressable>
          <Pressable onPress={() => player.seekTo(Math.min(duration, status.currentTime + 15))} style={styles.smallControl}>
            <Ionicons name="play-forward" size={25} color={colors.text} />
            <Text style={[styles.controlLabel, { color: colors.textMuted }]}>15</Text>
          </Pressable>
        </View>

        <View style={styles.actions}>
          <AudioAction icon="download-outline" label="Descargar" />
          <AudioAction icon="share-social-outline" label="Compartir" />
          <AudioAction icon="bookmark-outline" label="Guardar" />
          <AudioAction icon="ellipsis-horizontal" label="Más" />
        </View>

        <View style={[styles.note, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.noteTitle, { color: colors.text }]}>Tu enfoque de esta semana</Text>
          <Text style={[styles.noteBody, { color: colors.textMuted }]}>Elige una decisión que has estado postergando y conviértela en una acción de menos de 20 minutos.</Text>
        </View>
      </View>
    </AppScreen>
  );
}

function AudioAction({ icon, label }: { icon: keyof typeof Ionicons.glyphMap; label: string }) {
  const { colors } = useAppTheme();
  return <Pressable style={{ alignItems: 'center', gap: 5, flex: 1 }}><Ionicons name={icon} size={22} color={colors.text} /><Text style={{ color: colors.textMuted, fontSize: 10 }}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.xl, alignItems: 'center' },
  subtitle: { fontSize: 12, marginTop: spacing.sm, marginBottom: spacing.xl },
  cover: { width: '100%', aspectRatio: 1, borderRadius: radius.lg },
  progressTrack: { height: 4, width: '100%', borderRadius: radius.pill, overflow: 'hidden', marginTop: spacing.xl },
  progress: { height: '100%' },
  timeRow: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  time: { fontSize: 10 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxl, marginVertical: spacing.xl },
  play: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  smallControl: { alignItems: 'center' },
  controlLabel: { fontSize: 9, marginTop: -3 },
  actions: { flexDirection: 'row', width: '100%', marginVertical: spacing.xl },
  note: { width: '100%', borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  noteTitle: { fontSize: 15, fontWeight: '900' },
  noteBody: { fontSize: 13, lineHeight: 19, marginTop: spacing.sm },
});
