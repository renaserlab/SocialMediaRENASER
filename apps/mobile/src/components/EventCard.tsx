import React from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { EventItem } from '@/types';

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/**
 * Dia (o rango de dias) que se muestra en el distintivo.
 * Un evento de varios dias sale como "25-26"; uno de un dia, como "17".
 */
function badgeDay(start?: Date, end?: Date | null): string {
  if (!start) return '--';
  if (end && end.getDate() !== start.getDate()) {
    return `${start.getDate()}-${end.getDate()}`;
  }
  return String(start.getDate());
}

/** "17 ago, 13:00 — 18 ago, 13:00" (el fin solo si existe). */
function formatRange(start?: Date, end?: Date | null): string {
  if (!start) return '';
  const time = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]?.toLowerCase()}`;
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

  const openWhatsApp = async () => {
    const url = event.whatsappUrl;
    if (!url) return;
    // `canOpenURL` da falso negativo si WhatsApp no esta instalado; el enlace
    // https funciona igual en el navegador, asi que se intenta abrir directo.
    try {
      await Linking.openURL(url);
    } catch {
      notify('No se pudo abrir WhatsApp', 'Copia el enlace del evento e inténtalo de nuevo.');
    }
  };

  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {/* Zona pulsable detras del contenido: evita anidar botones en web. */}
      <Pressable
        onPress={onPress}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={`Ver detalles de ${event.title}`}
      />

      <View style={styles.row} pointerEvents="box-none">
        <View style={[styles.badge, { backgroundColor: colors.surfaceAlt }]} pointerEvents="none">
          <Text variant="body" weight="900" color={colors.text}>
            {badgeDay(event.startsAtDate, event.endsAtDate)}
          </Text>
          <Text variant="secondary" color={colors.textMuted}>
            {event.startsAtDate ? MONTHS[event.startsAtDate.getMonth()] : ''}
          </Text>
        </View>

        <View style={styles.info} pointerEvents="none">
          <Text variant="body" weight="700" numberOfLines={2}>
            {event.title}
          </Text>
          <Text variant="secondary" color={colors.textMuted} numberOfLines={1}>
            {formatRange(event.startsAtDate, event.endsAtDate)}
          </Text>
          {event.location ? (
            <Text variant="secondary" color={colors.textMuted} numberOfLines={1}>
              {event.location}
            </Text>
          ) : null}
        </View>

        {onEdit ? (
          <Pressable
            onPress={onEdit}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Editar ${event.title}`}
            style={styles.edit}
          >
            <Feather name="edit-2" size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {event.whatsappUrl ? (
        <Pressable
          onPress={() => void openWhatsApp()}
          style={[styles.whatsapp, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Unirme al grupo de WhatsApp"
        >
          <Feather name="message-circle" size={16} color={colors.text} />
          <Text variant="secondary" weight="700">
            Unirme al grupo de WhatsApp
          </Text>
        </Pressable>
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
