import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { AudioScrubber } from '@/components/AudioScrubber';
import { Text } from '@/components/Text';
import { useBackgroundAudio } from '@/hooks/useBackgroundAudio';
import {
  useReproduccionDiferida,
  useSilencioAlDesmontar,
} from '@/hooks/useReproductorUnico';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/** Segundos que se adelantan o retroceden de un toque. */
const SALTO_S = 15;

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

type Props = {
  uri: string;
  title?: string;
  /**
   * Empieza a sonar en cuanto la fuente carga, sin pedir una segunda pulsacion.
   *
   * Lo usa la lista de podcast: alli el toque en «play» ya fue la orden de
   * reproducir, y volver a pedirla dentro del reproductor recien abierto era
   * justo el fallo («hay que pulsar dos veces»).
   */
  autoPlay?: boolean;
  /**
   * `feed` es la barra compacta del muro y de la biblioteca; `lista` es la
   * tarjeta que se despliega bajo un episodio, con adelantar y retroceder.
   */
  variante?: 'feed' | 'lista';
};

/**
 * Reproductor de audio: una barra compacta en el muro, una tarjeta con saltos
 * dentro de la lista de episodios.
 *
 * Solo se monta UNO por pantalla —quien lo usa decide cual— y ademas se apunta
 * en el registro de `useReproductorUnico`, que calla al anterior antes de que
 * este empiece. Montar uno por fila dejaria tantos decodificadores nativos
 * abiertos como episodios tenga el catalogo.
 */
export function AudioPlayer({ uri, title, autoPlay = false, variante = 'feed' }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);
  useBackgroundAudio();

  const playing = status?.playing ?? false;
  const duration = status?.duration ?? 0;
  const current = status?.currentTime ?? 0;
  const cargado = status?.isLoaded ?? false;

  // Segundo que marca el dedo mientras se arrastra; `null` el resto del tiempo.
  const [scrubTime, setScrubTime] = useState<number | null>(null);

  const { pendiente, pedir, cancelar } = useReproduccionDiferida(player, cargado);

  // La orden de sonar se apunta al montar y se dispara sola cuando la fuente
  // esta lista. Depende de `player` para volver a pedirla si cambia el audio.
  useEffect(() => {
    if (autoPlay) pedir();
  }, [autoPlay, pedir, player]);

  // Callar mientras el objeto nativo sigue vivo, antes de que expo-audio lo
  // suelte. Es lo que evita que se solapen dos episodios al cambiar de uno a otro.
  useSilencioAlDesmontar(player);

  // Controles en la pantalla de bloqueo (y en el aviso de Android). Sin esto el
  // audio sigue sonando de fondo pero no hay forma de pararlo sin volver a
  // abrir la app. Solo existe en nativo; en web la comprobación lo salta.
  useEffect(() => {
    if (typeof player.setActiveForLockScreen !== 'function') return;
    player.setActiveForLockScreen(
      true,
      { title: title ?? t('audio.audio'), artist: 'RENASER' },
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

  const toggle = useCallback(() => {
    if (playing) {
      player.pause();
      return;
    }
    // Segundo toque mientras se espera: se cancela, no se encola otra.
    if (pendiente) {
      cancelar();
      return;
    }
    // Al terminar, el reproductor se queda al final. Sin rebobinar, el toque
    // siguiente no suena y parece que se haya roto.
    if (duration > 0 && current >= duration - 0.2) void player.seekTo(0);
    pedir();
  }, [playing, pendiente, player, duration, current, pedir, cancelar]);

  const saltar = useCallback(
    (delta: number) => {
      const tope = duration > 0 ? duration : current;
      void player.seekTo(Math.min(Math.max(0, current + delta), tope));
    },
    [player, current, duration],
  );

  const barra = (
    <AudioScrubber
      currentTime={current}
      duration={duration}
      onSeek={(seconds) => void player.seekTo(seconds)}
      onScrubChange={setScrubTime}
      knobBorderColor={colors.surfaceAlt}
    />
  );

  // Al arrastrar se muestra el destino, para verlo antes de soltar.
  const transcurrido = formatTime(scrubTime ?? current);
  const total = formatTime(duration);

  const principal = (
    <Pressable
      onPress={toggle}
      style={[styles.button, { backgroundColor: colors.primary }]}
      accessibilityRole="button"
      accessibilityLabel={playing ? t('audio.pause') : t('audio.play')}
      hitSlop={8}
    >
      {pendiente ? (
        <ActivityIndicator color={colors.onPrimary} />
      ) : (
        <Feather name={playing ? 'pause' : 'play'} size={20} color={colors.onPrimary} />
      )}
    </Pressable>
  );

  if (variante === 'lista') {
    return (
      <View
        style={[styles.card, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
      >
        <Text variant="secondary" weight="600" numberOfLines={1}>
          {title ?? t('audio.audio')}
        </Text>

        {barra}

        <View style={styles.times}>
          <Text variant="secondary" color={colors.textMuted} style={styles.digits}>
            {transcurrido}
          </Text>
          <Text variant="secondary" color={colors.textMuted} style={styles.digits}>
            {total}
          </Text>
        </View>

        <View style={styles.controls}>
          <Pressable
            onPress={() => saltar(-SALTO_S)}
            hitSlop={8}
            style={styles.skip}
            accessibilityRole="button"
            accessibilityLabel={t('audio.back15')}
          >
            <Feather name="rotate-ccw" size={18} color={colors.text} />
            <Text variant="caption" color={colors.textMuted}>
              {SALTO_S}
            </Text>
          </Pressable>

          {principal}

          <Pressable
            onPress={() => saltar(SALTO_S)}
            hitSlop={8}
            style={styles.skip}
            accessibilityRole="button"
            accessibilityLabel={t('audio.forward15')}
          >
            <Feather name="rotate-cw" size={18} color={colors.text} />
            <Text variant="caption" color={colors.textMuted}>
              {SALTO_S}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
      {principal}

      <View style={styles.info}>
        <Text variant="secondary" weight="600" numberOfLines={1}>
          {title ?? t('audio.audio')}
        </Text>

        {barra}

        <Text variant="secondary" color={colors.textMuted}>
          {transcurrido} / {total}
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
  // Dentro de una fila de la lista: sin margenes laterales, mismos bordes
  // redondeados que el resto de las tarjetas.
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  // Cifras de ancho fijo: si no, la fila se mueve con cada segundo.
  digits: { fontVariant: ['tabular-nums'] },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
    marginTop: spacing.xs,
  },
  skip: { alignItems: 'center', minWidth: 34 },
  button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  info: { flex: 1, gap: 2 },
});
