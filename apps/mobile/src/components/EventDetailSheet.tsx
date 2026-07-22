import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { EventItem } from '@/types';

/** A partir de esta longitud la descripción se recorta tras "Mostrar más". */
const PREVIEW_CHARS = 180;

type Props = {
  event: EventItem | null;
  onClose: () => void;
};

/**
 * Ficha del evento superpuesta: portada, descripción e información.
 *
 * La descripción arranca recortada y se despliega con "Mostrar más": abrir el
 * detalle con un muro de texto hace que no se vea ni la fecha ni el acceso al
 * grupo, que es lo que la gente busca primero.
 */
export function EventDetailSheet({ event, onClose }: Props) {
  const { colors } = useAppTheme();
  const [expanded, setExpanded] = useState(false);

  if (!event) return null;

  const description = event.description ?? '';
  const isLong = description.length > PREVIEW_CHARS;
  const shown = expanded || !isLong ? description : `${description.slice(0, PREVIEW_CHARS).trimEnd()}…`;

  const close = () => {
    setExpanded(false);
    onClose();
  };

  const openWhatsApp = async () => {
    if (!event.whatsappUrl) return;
    try {
      await Linking.openURL(event.whatsappUrl);
    } catch {
      notify('No se pudo abrir WhatsApp', 'Copia el enlace del evento e inténtalo de nuevo.');
    }
  };

  return (
    <BottomSheet visible onClose={close}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        {event.coverUrl ? (
          <ExpoImage
            source={{ uri: event.coverUrl }}
            style={styles.cover}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={150}
          />
        ) : null}

        <Text variant="title" weight="900" style={styles.title}>
          {event.title}
        </Text>

        <View style={styles.meta}>
          <Row icon="calendar" text={event.date} />
          {event.location ? <Row icon="map-pin" text={event.location} /> : null}
          {event.type ? <Row icon="tag" text={event.type} /> : null}
        </View>

        {description ? (
          <>
            <Text variant="body" color={colors.textMuted} style={styles.description}>
              {shown}
            </Text>
            {isLong ? (
              <Pressable
                onPress={() => setExpanded((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel={expanded ? 'Mostrar menos' : 'Mostrar más'}
                style={styles.more}
              >
                <Text variant="secondary" weight="700">
                  {expanded ? 'Mostrar menos' : 'Mostrar más'}
                </Text>
                <Feather
                  name={expanded ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={colors.text}
                />
              </Pressable>
            ) : null}
          </>
        ) : null}

        {event.whatsappUrl ? (
          <Button
            label="Unirme al grupo de WhatsApp"
            icon="message-circle"
            onPress={() => void openWhatsApp()}
            style={styles.cta}
          />
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

function Row({ icon, text }: { icon: keyof typeof Feather.glyphMap; text: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.metaRow}>
      <Feather name={icon} size={15} color={colors.textMuted} />
      <Text variant="secondary" color={colors.textMuted} style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { maxHeight: 520 },
  cover: { width: '100%', height: 170, borderRadius: radius.lg, marginBottom: spacing.md },
  title: { marginBottom: spacing.sm },
  meta: { gap: spacing.xs, marginBottom: spacing.md },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  description: { lineHeight: 21 },
  more: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  cta: { marginTop: spacing.md, marginBottom: spacing.lg },
});
