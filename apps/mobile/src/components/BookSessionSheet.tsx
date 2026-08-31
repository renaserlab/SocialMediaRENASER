import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { DateField } from '@/components/DateField';
import { hoyANoche } from '@/components/DateField.types';
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
import { useTranslation } from '@/i18n/useTranslation';

type Props = {
  visible: boolean;
  onClose: () => void;
  targetUser: {
    id: string;
    fullName: string;
  };
};

export function BookSessionSheet({ visible, onClose, targetUser }: Props) {
  const { t } = useTranslation();
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
  const cuando = (dia: string, hora: string): Date | null => {
    const [d, m, a] = dia.split('/').map((n) => Number(n));
    const [hh, mm] = hora.split(':').map((n) => Number(n));
    if (!d || !m || !a || Number.isNaN(hh) || Number.isNaN(mm)) return null;
    const fecha = new Date(a, m - 1, d, hh, mm);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  };

  const cuandoIso = (dia: string, hora: string): string | null =>
    cuando(dia, hora)?.toISOString() ?? null;

  /**
   * El momento propuesto ya pasó.
   *
   * SE COMPARAN INSTANTES, NUNCA CADENAS: «02/09/2026» y «2026-09-02» son la
   * misma fecha y dos textos distintos, y `'10:00' < '9:00'` es cierto como
   * texto. `toISOString()` normaliza a UTC, así que la zona horaria del
   * teléfono queda dentro del instante en vez de perderse por el camino.
   *
   * NO ES LA VALIDACIÓN DE VERDAD. Quien decide es el servidor con SU reloj
   * (`booking_date_in_past`): el del teléfono lo elige quien lo lleva, y
   * atrasarlo un día bastaría para colar una fecha pasada si esto fuera lo
   * único. Lo que aporta aquí es no dejar rellenar un formulario entero para
   * que lo rechacen al final.
   */
  const yaPaso = (() => {
    const momento = cuando(date, time);
    return momento !== null && momento.getTime() <= Date.now();
  })();

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
    await requireAuth('auth.reasonWrite', () => {
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
        err instanceof Error ? err.message : t('booking.chatFailed'),
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
      setError(t('booking.pickDateTime'));
      return;
    }
    if (yaPaso) {
      // El servidor lo rechazaría igualmente; decirlo aquí ahorra el viaje y,
      // sobre todo, explica qué hay que cambiar.
      setError(t('booking.pastDateLong'));
      return;
    }

    let autorizado = false;
    await requireAuth('auth.reasonBook', () => {
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
        tema: note.trim() || t('booking.defaultTopic'),
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
        err instanceof Error ? err.message : t('booking.failed'),
      );
    } finally {
      setSaving(false);
    }
  };

  /*
    LISTO PARA CONFIRMAR: fecha, hora, y que el momento no haya pasado.

    El boton se desactiva en vez de dejar pulsar y fallar, pero el mensaje
    tambien se pinta: un boton apagado sin explicacion es lo que hace que
    alguien lo toque cinco veces sin entender que le falta.
  */
  const listo = !!date && !!time && !yaPaso;

  return (
    <BottomSheet visible={visible} onClose={close}>
      <Text style={styles.title} color={colors.text}>
        {t('booking.title')}
      </Text>
      <Text variant="secondary" color={colors.textMuted} style={styles.subtitle}>
        {t('booking.subtitle', { nombre: targetUser.fullName })}
      </Text>

      <View style={styles.when}>
        <View style={styles.half}>
          {/*
            El calendario no ofrece dias anteriores a HOY. Es cortesia: quien
            decide de verdad es el servidor con su reloj, pero ofrecer un dia
            que se va a rechazar es equivocarse a proposito.

            HOY A MEDIANOCHE y no «ahora mismo»: con la hora actual, el dia de
            hoy dejaria de poder elegirse en cuanto pasara un minuto, y una
            sesion para esta tarde es lo mas normal del mundo. Que la HORA
            elegida tampoco haya pasado lo comprueba `yaPaso`.
          */}
          <DateField label={t('booking.date')} value={date} onChange={setDate} minDate={hoyANoche()} />
        </View>
        <View style={styles.half}>
          <TimeField label={t('booking.time')} value={time} onChange={setTime} />
        </View>
      </View>

      <Input
        value={note}
        onChangeText={setNote}
        placeholder={t('booking.topicPlaceholder')}
        placeholderTextColor={colors.textMuted}
        multiline
        numberOfLines={3}
        style={{ color: colors.text, marginTop: spacing.md }}
      />

      {/*
        El aviso de fecha pasada sale SIN esperar a pulsar: en cuanto la
        combinacion de dia y hora queda en el pasado. Enterarse al confirmar,
        con el formulario ya relleno, es la peor version de la misma noticia.
      */}
      <InlineError
        message={error ?? (yaPaso ? t('booking.pastDate') : null)}
      />

      <View style={styles.actions}>
        <Button
          label={t('booking.directMessage')}
          icon="message-circle"
          variant="secondary"
          loading={sending}
          onPress={() => void handleOpenChat()}
          style={styles.fullWidth}
        />
        <Button
          label={t('booking.confirm')}
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
