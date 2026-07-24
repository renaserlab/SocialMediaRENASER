import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { toast } from '@/lib/toast';
import { MessageRepository } from '@/repositories/MessageRepository';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  visible: boolean;
  onClose: () => void;
  targetUser: {
    id: string;
    fullName: string;
  };
};

export function BookSessionSheet({ visible, onClose, targetUser }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();

  const [dateText, setDateText] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setDateText('');
    setNote('');
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const handleOpenChat = async () => {
    try {
      const conv = await MessageRepository.getOrCreateDirect(targetUser.id);
      close();
      router.push({
        pathname: '/chat/[id]',
        params: { id: conv.id, name: targetUser.fullName },
      } as never);
    } catch {
      setError('No se pudo abrir el chat directo.');
    }
  };

  const handleBook = async () => {
    if (!dateText.trim()) {
      setError('Indica la fecha y hora sugerida para la sesión.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await NotificationRepository.notifySessionBooked({
        targetUserId: targetUser.id,
        dateText: dateText.trim(),
        note: note.trim(),
      });
      toast(`Sesión agendada con ${targetUser.fullName}`);
      close();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'No se pudo agendar la sesión. Inténtalo de nuevo.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={close}>
      <Text style={styles.title} color={colors.text}>
        Agenda tu sesión 1:1
      </Text>
      <Text variant="secondary" color={colors.textMuted} style={styles.subtitle}>
        Reserva un espacio personalizado con {targetUser.fullName}.
      </Text>

      <Input
        value={dateText}
        onChangeText={setDateText}
        placeholder="Fecha y hora sugerida (ej. Mañana a las 4:00 PM)"
        placeholderTextColor={colors.textMuted}
        style={{ color: colors.text }}
      />

      <Input
        value={note}
        onChangeText={setNote}
        placeholder="Tema o consulta principal (opcional)"
        placeholderTextColor={colors.textMuted}
        multiline
        numberOfLines={3}
        style={{ color: colors.text, marginTop: spacing.sm }}
      />

      <InlineError message={error} />

      <View style={styles.actions}>
        <Button
          label="Enviar mensaje directo"
          icon="message-circle"
          variant="secondary"
          onPress={() => void handleOpenChat()}
          style={styles.chatBtn}
        />
        <Button
          label="Confirmar reserva"
          icon="calendar"
          onPress={() => void handleBook()}
          loading={saving}
          disabled={!dateText.trim()}
          style={styles.bookBtn}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.xs,
  },
  subtitle: {
    marginBottom: spacing.md,
  },
  actions: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  chatBtn: {
    width: '100%',
  },
  bookBtn: {
    width: '100%',
  },
});
