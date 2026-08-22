import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { DateField } from '@/components/DateField';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { TimeField } from '@/components/TimeField';
import { toHumanTime } from '@/components/TimeField.types';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { toast } from '@/lib/toast';
import { BookingRepository } from '@/repositories/BookingRepository';
import { MessageRepository } from '@/repositories/MessageRepository';
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
  const requireAuth = useRequireAuth();

  // Fecha (dd/mm/aaaa) y hora (HH:MM) por separado: cada una con su selector.
  // Antes era un solo campo de texto libre —«Mañana a las 4:00 PM»— que había
  // que interpretar a ojo y no se podía ordenar ni recordar.
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Lo que se enseña y se envía: «12/08/2026 a las 4:00 PM». */
  const propuesta = date && time ? `${date} a las ${toHumanTime(time)}` : '';

  /**
   * La fecha elegida, en el formato que entiende el servidor.
   *
   * El formulario trabaja con «12/08/2026» y «16:00» porque es lo que se lee y
   * se escribe; la base de datos necesita un instante. Convertirlo AQUÍ evita
   * que cada pantalla se invente su propio formato.
   */
  const cuandoIso = (dia: string, hora: string): string | null => {
    const [d, m, a] = dia.split('/').map((n) => Number(n));
    const [hh, mm] = hora.split(':').map((n) => Number(n));
    if (!d || !m || !a || Number.isNaN(hh) || Number.isNaN(mm)) return null;
    const fecha = new Date(a, m - 1, d, hh, mm);
    return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
  };

  const reset = () => {
    setDate('');
    setTime('');
    setNote('');
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  /** Texto de la propuesta, tal y como llega al chat de la otra persona. */
  const redactarMensaje = () =>
    [
      `Hola ${targetUser.fullName}, me gustaría agendar una sesión 1:1.`,
      propuesta ? `Fecha propuesta: ${propuesta}.` : null,
      note.trim() ? `Tema: ${note.trim()}` : null,
    ]
      .filter(Boolean)
      .join('\n');

  /**
   * Abre el chat con la propuesta ya enviada.
   *
   * Antes solo abría la conversación vacía: la persona tenía que volver a
   * escribir a mano lo que acababa de rellenar en el formulario, y la fecha
   * elegida se perdía por el camino.
   */
  const handleOpenChat = async () => {
    let autorizado = false;
    await requireAuth('para escribir a esta persona', () => {
      autorizado = true;
    });
    if (!autorizado) return;

    setSending(true);
    setError(null);
    try {
      const conv = await MessageRepository.getOrCreateDirect(targetUser.id);
      await MessageRepository.sendMessage(conv.id, redactarMensaje());
      close();
      router.push({
        pathname: '/chat/[id]',
        params: { id: conv.id, name: targetUser.fullName },
      } as never);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'No se pudo abrir el chat. Inténtalo de nuevo.',
      );
    } finally {
      setSending(false);
    }
  };

  /**
   * Crea la reserva de verdad y deja la propuesta por escrito en el chat.
   *
   * Antes esto solo insertaba un AVISO: la otra persona lo leía una vez, no
   * podía aceptar ni rechazar, y no quedaba registro de nada. Ahora se crea una
   * sesión con estado propio, que aparece en la agenda de las dos partes.
   *
   * El mensaje se sigue enviando porque el aviso se pierde entre los demás y en
   * la conversación queda por escrito, se puede responder y se acuerda el
   * detalle.
   */
  const handleBook = async () => {
    if (!date || !time) {
      setError('Elige la fecha y la hora de la sesión.');
      return;
    }

    let autorizado = false;
    await requireAuth('para agendar una sesión', () => {
      autorizado = true;
    });
    if (!autorizado) return;

    setSaving(true);
    setError(null);
    try {
      await BookingRepository.create({
        proveedorId: targetUser.id,
        // El tema es lo que la agenda enseña como titulo: sin nota se usa el
        // generico, que sigue siendo mas util que una fila sin asunto.
        tema: note.trim() || 'Sesión 1:1',
        nota: note.trim(),
        cuandoIso: cuandoIso(date, time),
      });

      // Si la sesión se crea pero el mensaje falla, la reserva sigue siendo
      // válida: no se deshace nada ni se avisa de un error que no impide nada.
      try {
        const conv = await MessageRepository.getOrCreateDirect(targetUser.id);
        await MessageRepository.sendMessage(conv.id, redactarMensaje());
      } catch {
        // El aviso ya salió; el chat se puede abrir después.
      }

      toast(`Sesión propuesta a ${targetUser.fullName}`);
      close();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'No se pudo agendar la sesión. Inténtalo de nuevo.',
      );
    } finally {
      setSaving(false);
    }
  };

  const listo = !!date && !!time;

  return (
    <BottomSheet visible={visible} onClose={close}>
      <Text style={styles.title} color={colors.text}>
        Pedir una sesión 1:1
      </Text>
      <Text variant="secondary" color={colors.textMuted} style={styles.subtitle}>
        Reserva un espacio personalizado con {targetUser.fullName}.
      </Text>

      <View style={styles.when}>
        <View style={styles.half}>
          <DateField label="Fecha" value={date} onChange={setDate} />
        </View>
        <View style={styles.half}>
          <TimeField label="Hora" value={time} onChange={setTime} />
        </View>
      </View>

      <Input
        value={note}
        onChangeText={setNote}
        placeholder="Tema o consulta principal (opcional)"
        placeholderTextColor={colors.textMuted}
        multiline
        numberOfLines={3}
        style={{ color: colors.text, marginTop: spacing.md }}
      />

      <InlineError message={error} />

      <View style={styles.actions}>
        <Button
          label="Enviar mensaje directo"
          icon="message-circle"
          variant="secondary"
          loading={sending}
          onPress={() => void handleOpenChat()}
          style={styles.fullWidth}
        />
        <Button
          label="Confirmar reserva"
          icon="calendar"
          onPress={() => void handleBook()}
          loading={saving}
          disabled={!listo}
          style={styles.fullWidth}
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
  // Fecha y hora comparten fila: se leen como una sola respuesta.
  when: { flexDirection: 'row', gap: spacing.sm },
  half: { flex: 1 },
  actions: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  fullWidth: {
    width: '100%',
  },
});
