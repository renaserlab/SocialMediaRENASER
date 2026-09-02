import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { AudioPlayer } from '@/components/AudioPlayer';
import { Text } from '@/components/Text';
import { usePodcastUnlock } from '@/hooks/usePodcastUnlock';
import { useTranslation } from '@/i18n/useTranslation';
import { DRIP_EPISODES, formatCountdown, waitingLabel } from '@/lib/podcastUnlock';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

/** Episodios visibles en la lista, aunque todavia no existan. */
export const TOTAL_EPISODES = 30;
/**
 * Episodios incluidos en la liberacion progresiva (uno cada 8 h). Del siguiente
 * en adelante el candado ya no es de tiempo, sino de membresia.
 */
export const FREE_EPISODES = DRIP_EPISODES;

type Props = {
  /** Audios publicados, del mas antiguo al mas reciente (episodio 1 primero). */
  episodes: Post[];
  /**
   * Pinta los huecos bloqueados hasta {@link TOTAL_EPISODES}. Se usa en la
   * vista "Todos"; al filtrar por categoria se muestran solo sus episodios,
   * porque los treinta huecos describen el catalogo completo, no el filtrado.
   */
  showLockedSlots?: boolean;
  /** Solo lo recibe el administrador; abre la edicion del episodio. */
  onEdit?: (postId: string) => void;
};

/**
 * Lista de episodios del podcast.
 *
 * Se pintan siempre {@link TOTAL_EPISODES} filas numeradas: las primeras con su
 * audio real y el resto bloqueadas, para que se vea de un vistazo todo lo que
 * incluye la membresia.
 *
 * Los cinco primeros no se abren de golpe: van saliendo uno cada 8 horas y
 * mientras tanto muestran el tiempo que falta (ver `lib/podcastUnlock`).
 *
 * Solo se monta el reproductor del episodio elegido: montar treinta a la vez
 * dejaria otros tantos decodificadores de audio abiertos.
 */
export function PodcastList({ episodes, showLockedSlots = true, onEdit }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [playingId, setPlayingId] = useState<string | null>(null);
  const { gateFor, showsCatalogSlots } = usePodcastUnlock();

  return (
    <View style={styles.list}>
      {Array.from(
        // Los huecos del catalogo solo se pintan si quien mira los ve con
        // sentido: quien administra ve unicamente los audios que ha subido.
        { length: showLockedSlots && showsCatalogSlots ? TOTAL_EPISODES : episodes.length },
        (_, index) => {
        const number = index + 1;
        const episode = episodes[index];
        const gate = gateFor(index);
        // "Esperando" es distinto de "bloqueado": el primero se abre solo con
        // el tiempo y por eso lleva cuenta atras; el segundo es de membresia.
        const waiting = gate.state === 'waiting';
        const locked = gate.state === 'membership';
        const playable = gate.state === 'open' && !!episode?.mediaUrl;
        const isPlaying = playable && playingId === episode!.id;
        const dimmed = locked || waiting || !episode;

        return (
          <View
            key={number}
            style={[styles.row, { borderBottomColor: colors.border }]}
          >
            <View style={styles.head}>
              <Text
                variant="secondary"
                weight="700"
                color={dimmed ? colors.textMuted : colors.text}
                style={styles.number}
              >
                {number}
              </Text>

              <View style={styles.info}>
                <Text
                  variant="body"
                  numberOfLines={1}
                  color={dimmed ? colors.textMuted : colors.text}
                >
                  {episode ? episode.body : `Episodio ${number}`}
                </Text>
                {waiting ? (
                  <View style={styles.waiting}>
                    <Text variant="secondary" color={colors.textMuted}>
                      {waitingLabel(gate.remainingMs)}
                    </Text>
                    <View
                      style={[
                        styles.countdown,
                        { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
                      ]}
                    >
                      <Feather name="clock" size={11} color={colors.primary} />
                      <Text
                        variant="secondary"
                        weight="700"
                        color={colors.primary}
                        style={styles.digits}
                      >
                        {formatCountdown(gate.remainingMs)}
                      </Text>
                    </View>
                  </View>
                ) : locked || !episode ? (
                  <Text variant="secondary" color={colors.textMuted}>
                    {locked ? t('podcast.locked') : t('common.comingSoon')}
                  </Text>
                ) : null}
              </View>

              {onEdit && episode ? (
                <Pressable
                  onPress={() => onEdit(episode.id)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Editar ${episode.body}`}
                  style={styles.action}
                >
                  <Feather name="edit-2" size={15} color={colors.textMuted} />
                </Pressable>
              ) : null}

              {locked ? (
                <View style={styles.action}>
                  <Feather name="lock" size={17} color={colors.textMuted} />
                </View>
              ) : playable ? (
                <Pressable
                  /*
                    UNA sola pulsacion. Elegir un episodio cambia el unico
                    `playingId`, asi que React desmonta el reproductor anterior
                    y monta este; el audio arranca solo (`autoPlay`) en cuanto
                    la fuente carga, sin pedir un segundo toque dentro.
                  */
                  onPress={() => setPlayingId(isPlaying ? null : episode!.id)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`${
                    isPlaying ? t('common.close') : t('audio.play')
                  } · ${episode!.body}`}
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
              /*
                EN LINEA, debajo del episodio: no es una bandeja inferior ni
                otra pantalla. La `key` ata el reproductor a SU episodio, de
                modo que saltar de uno a otro lo desmonta y lo vuelve a montar
                en vez de reaprovecharlo con la fuente cambiada a medias.
              */
              <AudioPlayer
                key={episode!.id}
                uri={episode!.mediaUrl!}
                title={episode!.body}
                variante="lista"
                autoPlay
              />
            ) : null}
          </View>
        );
        },
      )}
      {(!showLockedSlots || !showsCatalogSlots) && episodes.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.empty}>
          {/* El motivo de que no haya nada depende de por que esta vacia: por
              el filtro elegido, o porque todavia no se ha subido ningun audio. */}
          {showLockedSlots ? 'Aún no has subido audios.' : 'No hay episodios en esta categoría.'}
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
  // Se envuelve porque en pantallas estrechas el texto y la cuenta atras no
  // caben en una linea junto al numero y los botones.
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: 3,
  },
  // Cifras de ancho fijo: si no, la pastilla se encoge y se estira cada segundo.
  digits: { fontVariant: ['tabular-nums'] },
  countdown: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  action: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  play: { borderRadius: radius.pill },
  empty: { textAlign: 'center', paddingVertical: spacing.xl },
});
