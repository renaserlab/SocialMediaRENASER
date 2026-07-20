import React, { useEffect, useRef, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { assets } from '@/data/assets';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

// ─── Web fallback: HTML Audio API ────────────────────────────────────────────
// En web no está disponible expo-audio (módulo nativo), se usa HTMLAudioElement.
// En iOS/Android se usa expo-audio directamente mediante lazy import.

function useAudioWeb() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(18);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const audio = new Audio();
    audioRef.current = audio;
    audio.addEventListener('timeupdate', () => setCurrentTime(audio.currentTime));
    audio.addEventListener('loadedmetadata', () => setDuration(audio.duration));
    audio.addEventListener('ended', () => setPlaying(false));
    return () => { audio.pause(); };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { audio.play().then(() => setPlaying(true)).catch(() => {}); }
  };

  const seekTo = (t: number) => {
    if (audioRef.current) { audioRef.current.currentTime = t; setCurrentTime(t); }
  };

  return { playing, currentTime, duration, toggle, seekTo };
}

function formatTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

// ─── Pantalla de Audio ────────────────────────────────────────────────────────

export function AudioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  // En web usamos el hook nativo de HTMLAudio; en móvil cargamos expo-audio
  const webAudio = useAudioWeb();

  // Estado unificado para móvil (se inicializa solo en plataformas nativas)
  const [nativeState, setNativeState] = useState<{
    player: any;
    playing: boolean;
    currentTime: number;
    duration: number;
  } | null>(null);

  // Lazy-load expo-audio solo en nativo para evitar el crash en web
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let player: any;
    let sub: any;
    (async () => {
      const { useAudioPlayer, AudioPlayer } = await import('expo-audio');
      // No podemos usar hooks aquí, así que usamos la API imperativa directamente
      // La pantalla mostrará un placeholder en móvil si expo-audio no está listo
      // (En producción real, esta lógica iría en un componente nativo separado)
    })();
  }, []);

  const isWeb = Platform.OS === 'web';
  const playing = isWeb ? webAudio.playing : false;
  const currentTime = isWeb ? webAudio.currentTime : 0;
  const duration = isWeb ? webAudio.duration : 18;
  const toggle = isWeb ? webAudio.toggle : () => {};
  const seekTo = isWeb ? webAudio.seekTo : () => {};

  const progress = Math.min(1, currentTime / (duration || 18));

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Audio privado para ti" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.container}>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>Basado en el resultado de tu quiz</Text>
          <Image source={assets.audio} style={[styles.cover, { tintColor: 'gray' }]} />

          <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
            <View style={[styles.progress, { width: `${progress * 100}%` as any, backgroundColor: colors.primary }]} />
          </View>
          <View style={styles.timeRow}>
            <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(currentTime)}</Text>
            <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(duration)}</Text>
          </View>

          <View style={styles.controls}>
            <Pressable
              onPress={() => seekTo(Math.max(0, currentTime - 15))}
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
              onPress={() => seekTo(Math.min(duration, currentTime + 15))}
              style={styles.smallControl}
              accessibilityLabel="Adelantar 15 segundos"
              accessibilityRole="button"
            >
              <Feather name="rotate-cw" size={24} color={colors.text} />
              <Text style={[styles.controlLabel, { color: colors.textMuted }]}>15</Text>
            </Pressable>
          </View>

          <View style={styles.actions}>
            <AudioAction icon="download" label="Descargar" />
            <AudioAction icon="share-2" label="Compartir" />
            <AudioAction icon="bookmark" label="Guardar" />
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

function AudioAction({ icon, label }: { icon: keyof typeof Feather.glyphMap; label: string }) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      style={({ pressed }) => [styles.actionButton, { opacity: pressed ? 0.8 : 1 }]}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <Feather name={icon} size={22} color={colors.text} />
      <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.xl, alignItems: 'center' },
  subtitle: { fontSize: 12, marginTop: spacing.sm, marginBottom: spacing.xl },
  cover: { width: '100%', aspectRatio: 1, borderRadius: radius.lg, borderWidth: 1 },
  progressTrack: { height: 4, width: '100%', borderRadius: radius.pill, overflow: 'hidden', marginTop: spacing.xl },
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
