import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { notify } from '@/lib/confirm';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { EventItem } from '@/types';

/**
 * Dia (o rango de dias) que se muestra en el distintivo.
 * Un evento de varios dias sale como "25-26"; uno de un dia, como "17".
 */
function badgeDay(start?: Date, end?: Date | null): string {
  // Sin fecha aun: el distintivo lo dice en vez de mostrar un hueco.
  if (!start) return '?';
  if (end && end.getDate() !== start.getDate()) {
    return `${start.getDate()}-${end.getDate()}`;
  }
  return String(start.getDate());
}

/** "17 ago, 13:00 — 18 ago, 13:00" (el fin solo si existe). */
function formatRange(meses: string[], start?: Date, end?: Date | null): string {
  if (!start) return '';
  const time = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (d: Date) => `${d.getDate()} ${meses[d.getMonth()]?.toLowerCase()}`;
  const from = `${day(start)}, ${time(start)}`;
  if (!end) return from;
  return `${from} — ${day(end)}, ${time(end)}`;
}

type Props = {
  event: EventItem;
  onPress: () => void;
  /** Solo el administrador lo recibe; abre la edicion. */
  onEdit?: () => void;
};

/**
 * Fila de un evento en el listado: distintivo con el dia, titulo, rango de
 * fechas y acceso directo al grupo de WhatsApp donde se dan los detalles.
 */
export function EventCard({ event, onPress, onEdit }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  /*
    Los meses abreviados viajan en UNA clave separada por comas. Doce claves
    sueltas serian doce sitios de los que olvidarse uno; asi el idioma que
    falte se nota entero y no a medias.
  */
  const meses = t('date.monthsShort').split(',');

  const openWhatsApp = async () => {
    const url = event.whatsappUrl;
    if (!url) return;
    // `canOpenURL` da falso negativo si WhatsApp no esta instalado; el enlace
    // https funciona igual en el navegador, asi que se intenta abrir directo.
    try {
      await Linking.openURL(url);
    } catch {
      notify(t('event.whatsappFailed'), t('event.whatsappFailedBody'));
    }
  };

  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {/* Zona pulsable detras del contenido: evita anidar botones en web. */}
      <Pulsable
        onPress={onPress}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t('event.viewDetailsOf', { titulo: event.title })}
      />

      <View style={styles.row} pointerEvents="box-none">
        <View style={[styles.badge, { backgroundColor: colors.surfaceAlt }]} pointerEvents="none">
          <Text variant="body" weight="900" color={colors.text}>
            {badgeDay(event.startsAtDate, event.endsAtDate)}
          </Text>
          <Text variant="secondary" color={colors.textMuted}>
            {event.startsAtDate ? meses[event.startsAtDate.getMonth()] : t('event.dateWord')}
          </Text>
        </View>

        <View style={styles.info} pointerEvents="none">
          <Text variant="body" weight="700" numberOfLines={2}>
            {event.title}
          </Text>
          <Text variant="secondary" color={colors.textMuted} numberOfLines={1}>
            {event.startsAtDate
              ? formatRange(meses, event.startsAtDate, event.endsAtDate)
              : t('event.dateTbdLong')}
          </Text>
          {event.location ? (
            <Text variant="secondary" color={colors.textMuted} numberOfLines={1}>
              {event.location}
            </Text>
          ) : null}
        </View>

        {onEdit ? (
          <Pulsable
            onPress={onEdit}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('event.editNamed', { titulo: event.title })}
            style={styles.edit}
          >
            <Feather name="edit-2" size={16} color={colors.textMuted} />
          </Pulsable>
        ) : null}
      </View>

      {event.whatsappUrl ? (
        <Pulsable
          onPress={() => void openWhatsApp()}
          style={[styles.whatsapp, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel={t('event.joinWhatsApp')}
        >
          <Feather name="message-circle" size={16} color={colors.text} />
          <Text variant="secondary" weight="700">
            {t('event.joinWhatsApp')}
          </Text>
        </Pulsable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  badge: {
    width: 54,
    height: 54,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1, gap: 2 },
  edit: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  whatsapp: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
  },
});
