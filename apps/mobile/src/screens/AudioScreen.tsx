import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { AudioScrubber } from '@/components/AudioScrubber';
import { Button } from '@/components/Button';
import { CreateCatalogSheet } from '@/components/CreateCatalogSheet';
import { assets } from '@/data/assets';
import { compartirPublicacion } from '@/lib/enlaces';
import { useBackgroundAudio } from '@/hooks/useBackgroundAudio';
import { AuthRepository } from '@/repositories/AuthRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import type { Post } from '@/types';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { pedirDestacados } from '@/services/cachePerfil';
import { useTranslation } from '@/i18n/useTranslation';

function formatTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function AudioScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const currentUser = useAppStore((state) => state.user);
  const isAdmin = currentUser?.isAdmin === true;

  /**
   * Audio privado vigente: el ultimo que publico el administrador. Mientras no
   * haya ninguno se mantiene el audio de ejemplo, para que la pantalla no
   * quede muda.
   */
  const [audio, setAudio] = useState<Post | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!AuthRepository.enabled) return;
    try {
      // El audio lo publica el administrador, asi que primero hay que saber
      // quien es: si el propio usuario lo es, es su perfil.
      let adminId = currentUser?.isAdmin ? currentUser.id : null;
      if (!adminId) {
        const featured = await pedirDestacados();
        adminId = (featured.find((m) => m.isAdmin) ?? featured[0])?.id ?? null;
      }
      if (!adminId) return;
      setAudio(await PostRepository.getPrivateAudio(adminId, currentUser?.id));
    } catch {
      setAudio(null);
    }
  }, [currentUser?.id, currentUser?.isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reproducción real (expo-audio funciona en iOS/Android/web). Sin audio
  // subido la fuente es null: el reproductor queda en silencio en vez de sonar
  // un ejemplo, que se solapaba con el audio de bienvenida.
  const player = useAudioPlayer(audio?.mediaUrl ?? null);
  const status = useAudioPlayerStatus(player);
  useBackgroundAudio();

  const hasAudio = !!audio?.mediaUrl;
  const playing = status.playing;
  const currentTime = status.currentTime ?? 0;
  const duration = status.duration && status.duration > 0 ? status.duration : 0;
  // Segundo que marca el dedo mientras se arrastra la barra; `null` si no.
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  const toggle = () => {
    // Sin audio subido no hay nada que reproducir.
    if (!hasAudio) return;
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

  /*
    Compartir el episodio que suena AHORA, por su id de publicacion.

    Esta pantalla no lee el parametro `id` de la ruta: siempre carga el audio
    privado vigente del administrador, asi que `/(tabs)/audio/{id}` no identifica
    un episodio y no serviria como enlace. El audio SI es una publicacion con id
    real, y `/post/{id}` la abre para siempre —tambien cuando el administrador
    suba uno nuevo—, que es la unica ruta estable que hay aqui.

    Sin audio cargado no se manda enlace: se comparte la frase a secas antes que
    inventarse una direccion que no lleva a ninguna parte.
  */
  const onShare = () => {
    const { message } = compartirPublicacion({
      postId: audio?.id,
      autor: audio?.author,
      clase: 'audio',
      traducir: t,
    });
    Share.share({ message }).catch(() => {});
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('audio.inviteTitle')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.container}>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>
            {audio ? audio.body : t('audio.basedOnQuiz')}
          </Text>

          {isAdmin ? (
            <Button
              label={audio ? t('audio.changePrivate') : t('audio.addPrivate')}
              variant="secondary"
              icon="plus"
              onPress={() => setCreating(true)}
              style={styles.adminBtn}
            />
          ) : null}

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

          <View style={styles.progressTrack}>
            <AudioScrubber
              currentTime={currentTime}
              duration={duration}
              onSeek={seekTo}
              onScrubChange={setScrubTime}
              height={6}
            />
          </View>
          <View style={styles.timeRow}>
            {/* Al arrastrar se muestra el destino, para verlo antes de soltar. */}
            <Text style={[styles.time, { color: colors.textMuted }]}>
              {formatTime(scrubTime ?? currentTime)}
            </Text>
            <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(duration)}</Text>
          </View>

          <View style={styles.controls}>
            <Pressable
              onPress={() => seekTo(currentTime - 15)}
              style={styles.smallControl}
              accessibilityLabel={t('audio.back15')}
              accessibilityRole="button"
            >
              <Feather name="rotate-ccw" size={24} color={colors.text} />
              <Text style={[styles.controlLabel, { color: colors.textMuted }]}>15</Text>
            </Pressable>

            <Pressable
              onPress={toggle}
              disabled={!hasAudio}
              style={[styles.play, { backgroundColor: colors.primary, opacity: hasAudio ? 1 : 0.4 }]}
              accessibilityLabel={playing ? t('audio.pause') : t('audio.play')}
              accessibilityRole="button"
              accessibilityState={{ disabled: !hasAudio }}
            >
              <Feather name={playing ? 'pause' : 'play'} size={32} color={colors.onPrimary} />
            </Pressable>

            <Pressable
              onPress={() => seekTo(currentTime + 15)}
              style={styles.smallControl}
              accessibilityLabel={t('audio.forward15')}
              accessibilityRole="button"
            >
              <Feather name="rotate-cw" size={24} color={colors.text} />
              <Text style={[styles.controlLabel, { color: colors.textMuted }]}>15</Text>
            </Pressable>
          </View>

          <View style={styles.actions}>
            <AudioAction icon="share-2" label={t('post.share')} onPress={onShare} />
            <AudioAction
              icon="bookmark"
              label={saved ? t('audio.saved') : t('common.save')}
              active={saved}
              onPress={() => setSaved((v) => !v)}
            />
          </View>

          <View style={[styles.note, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.noteTitle, { color: colors.text }]}>{t('audio.weekFocus')}</Text>
            <Text style={[styles.noteBody, { color: colors.textMuted }]}>
              {t('audio.weekFocusBody')}
            </Text>
          </View>
        </View>
      </AppScreen>

      {creating ? (
        <CreateCatalogSheet
          kind="privado"
          visible
          onClose={() => setCreating(false)}
          onCreated={() => void load()}
        />
      ) : null}
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
  subtitle: { fontSize: 12, marginTop: spacing.sm, marginBottom: spacing.lg, textAlign: 'center' },
  adminBtn: { width: '100%', marginBottom: spacing.lg },
  cover: { width: '100%', aspectRatio: 1, borderRadius: radius.lg, borderWidth: 1, overflow: 'hidden', justifyContent: 'flex-end' },
  coverBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, margin: spacing.lg, alignSelf: 'flex-start' },
  coverBadgeText: { fontSize: 12, fontWeight: '700' },
  progressTrack: { width: '100%', marginTop: spacing.lg },
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
