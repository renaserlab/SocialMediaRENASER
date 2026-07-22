import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { AudioPlayer } from '@/components/AudioPlayer';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

/** Episodios visibles en la lista, aunque todavia no existan. */
export const TOTAL_EPISODES = 30;
/** Cuantos se pueden escuchar; del siguiente en adelante van con candado. */
export const FREE_EPISODES = 5;

type Props = {
  /** Audios publicados, del mas antiguo al mas reciente (episodio 1 primero). */
  episodes: Post[];
  /**
   * Pinta los huecos bloqueados hasta {@link TOTAL_EPISODES}. Se usa en la
   * vista "Todos"; al filtrar por categoria se muestran solo sus episodios,
   * porque los treinta huecos describen el catalogo completo, no el filtrado.
   */
  showLockedSlots?: boolean;
};

/**
 * Lista de episodios del podcast.
 *
 * Se pintan siempre {@link TOTAL_EPISODES} filas numeradas: las primeras con su
 * audio real y el resto bloqueadas, para que se vea de un vistazo todo lo que
 * incluye la membresia.
 *
 * Solo se monta el reproductor del episodio elegido: montar treinta a la vez
 * dejaria otros tantos decodificadores de audio abiertos.
 */
export function PodcastList({ episodes, showLockedSlots = true }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [playingId, setPlayingId] = useState<string | null>(null);

  return (
    <View style={styles.list}>
      {Array.from(
        { length: showLockedSlots ? TOTAL_EPISODES : episodes.length },
        (_, index) => {
        const number = index + 1;
        const episode = episodes[index];
        const locked = index >= FREE_EPISODES;
        const playable = !locked && !!episode?.mediaUrl;
        const isPlaying = playable && playingId === episode!.id;

        return (
          <View
            key={number}
            style={[styles.row, { borderBottomColor: colors.border }]}
          >
            <View style={styles.head}>
              <Text
                variant="secondary"
                weight="700"
                color={locked ? colors.textMuted : colors.text}
                style={styles.number}
              >
                {number}
              </Text>

              <View style={styles.info}>
                <Text
                  variant="body"
                  numberOfLines={1}
                  color={locked || !episode ? colors.textMuted : colors.text}
                >
                  {episode ? episode.body : `Episodio ${number}`}
                </Text>
                {locked || !episode ? (
                  <Text variant="secondary" color={colors.textMuted}>
                    {locked ? t('podcast.locked') : t('podcast.soon')}
                  </Text>
                ) : null}
              </View>

              {locked ? (
                <View style={styles.action}>
                  <Feather name="lock" size={17} color={colors.textMuted} />
                </View>
              ) : playable ? (
                <Pressable
                  onPress={() => setPlayingId(isPlaying ? null : episode!.id)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`${isPlaying ? 'Cerrar' : 'Reproducir'} ${episode!.body}`}
                  style={[styles.action, styles.play, { backgroundColor: colors.primary }]}
                >
                  <Feather
                    name={isPlaying ? 'x' : 'play'}
                    size={15}
                    color={colors.onPrimary}
                  />
                </Pressable>
              ) : (
                <View style={styles.action}>
                  <Feather name="clock" size={16} color={colors.textMuted} />
                </View>
              )}
            </View>

            {isPlaying ? (
              <AudioPlayer uri={episode!.mediaUrl!} title={episode!.body} />
            ) : null}
          </View>
        );
        },
      )}
      {!showLockedSlots && episodes.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.empty}>
          No hay episodios en esta categoría.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: spacing.md },
  row: { borderBottomWidth: 1, paddingVertical: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  number: { width: 26, textAlign: 'center' },
  info: { flex: 1 },
  action: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  play: { borderRadius: radius.pill },
  empty: { textAlign: 'center', paddingVertical: spacing.xl },
});
