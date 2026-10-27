import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { BotonesDeSesion } from '@/components/BotonesDeSesion';
import { Pulsable } from '@/components/Pulsable';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { sigueViva, type AccionDeSesion } from '@/lib/accionesDeSesion';
import { fraseDelHecho, iconoDelHecho } from '@/lib/sesionesDelChat';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MensajeDeSesion } from '@/types';

const NOMBRE_DE_ESTADO: Record<MensajeDeSesion['estado'], TranslationKey> = {
  pending: 'agenda.statePending',
  accepted: 'agenda.stateAccepted',
  rejected: 'agenda.stateRejected',
  cancelled: 'agenda.stateCancelled',
  reschedule_requested: 'agenda.stateRescheduled',
  completed: 'agenda.stateCompleted',
  expired: 'agenda.stateExpired',
};

function fechaLegible(iso: string | null, sinFecha: string): string {
  if (!iso) return sinFecha;
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return sinFecha;
  return fecha.toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type Props = {
  sesion: MensajeDeSesion;
  /** Cómo está la sesión HOY (`lib/sesionesDelChat`), no cuando se leyó el mensaje. */
  estado: MensajeDeSesion['estado'];
  /** El mensaje lo firma quien está mirando. */
  mio: boolean;
  /** Cómo se llama la otra persona. */
  nombre: string;
  /** La hora del mensaje, ya formateada. */
  hora: string;
  /** Hay una respuesta en curso sobre esta sesión. */
  ocupada: boolean;
  alElegir: (accion: AccionDeSesion) => void;
};

/**
 * Una sesión 1:1 dentro de la conversación.
 *
 * LO REPORTADO (04/10/2026). «No hubo manera de aceptar la solicitud de esa
 * sesión estando en mensajes… debería aparecer como una opción de botón y que
 * aparezca también si acepté o no. Eso también debe quedar registrado ahí».
 *
 * DOS FORMAS, según lo que pasó en el mensaje:
 *
 *   - LA SOLICITUD es una tarjeta: qué se pide, para cuándo, cómo está y los
 *     botones que le tocan a quien mira. Los botones salen del estado de HOY,
 *     así que una solicitud ya aceptada no vuelve a ofrecer «Aceptar».
 *   - CADA RESPUESTA es una línea centrada, como la cabecera de un día: quién
 *     hizo qué y a qué hora. Es el registro. No lleva botones: lo que se puede
 *     hacer está en la tarjeta, en un solo sitio.
 *
 * No se puede mantener pulsada para borrarla: el registro de una sesión no se
 * borra (el servidor tampoco lo deja).
 */
export function SesionEnElChat({ sesion, estado, mio, nombre, hora, ocupada, alElegir }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const frase = t(fraseDelHecho(sesion.hecho, mio), { nombre });

  if (sesion.hecho !== 'requested') {
    return (
      <View style={styles.registro} accessible accessibilityLabel={`${frase}. ${hora}`}>
        <View style={[styles.pastilla, { backgroundColor: colors.surfaceAlt }]}>
          <Feather name={iconoDelHecho(sesion.hecho)} size={12} color={colors.textMuted} />
          <Text style={[styles.registroTexto, { color: colors.textMuted }]}>
            {frase} · {hora}
          </Text>
        </View>
      </View>
    );
  }

  const viva = sigueViva(estado);
  const esperando = estado === 'pending' && sesion.miPapel === 'requester';

  return (
    <View style={mio ? styles.filaMia : styles.filaSuya}>
      <View style={[styles.tarjeta, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <View style={styles.cabecera}>
          <Feather name="calendar" size={16} color={colors.text} />
          <Text style={[styles.titulo, { color: colors.text }]}>{frase}</Text>
        </View>

        <Text style={[styles.tema, { color: colors.text }]}>{sesion.tema}</Text>
        <View style={styles.dato}>
          <Feather name="clock" size={13} color={colors.textMuted} />
          <Text style={[styles.datoTexto, { color: colors.text }]}>
            {fechaLegible(sesion.cuandoIso, t('agenda.dateTbd'))}
          </Text>
        </View>
        {sesion.nota && sesion.nota !== sesion.tema ? (
          <Text style={[styles.nota, { color: colors.textMuted }]}>{sesion.nota}</Text>
        ) : null}

        {/*
          El estado, con palabras: es lo que dice si se aceptó o no sin tener
          que bajar a buscar la respuesta.
        */}
        <Text
          style={[styles.estado, { color: viva ? colors.primary : colors.textMuted }]}
          accessibilityLiveRegion="polite"
        >
          {esperando ? t('chat.sessionWaitingThem') : t(NOMBRE_DE_ESTADO[estado] ?? 'agenda.statePending')}
        </Text>

        {ocupada ? (
          <Text style={[styles.nota, { color: colors.textMuted }]}>{t('agenda.saving')}</Text>
        ) : (
          <BotonesDeSesion estado={estado} papel={sesion.miPapel} alElegir={alElegir} />
        )}

        <View style={styles.pie}>
          <Pulsable
            onPress={() => router.push('/agenda' as never)}
            hitSlop={8}
            accessibilityRole="link"
            accessibilityLabel={t('chat.sessionOpenAgenda')}
          >
            <Text style={[styles.enlace, { color: colors.textMuted }]}>
              {t('chat.sessionOpenAgenda')}
            </Text>
          </Pulsable>
          <Text style={[styles.hora, { color: colors.textMuted }]}>{hora}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  filaMia: { alignItems: 'flex-end' },
  filaSuya: { alignItems: 'flex-start' },
  tarjeta: {
    // Algo más ancha que una burbuja: lleva dos botones en fila.
    width: '88%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titulo: { flex: 1, fontSize: 13, fontWeight: '700' },
  tema: { fontSize: 16, fontWeight: '700', marginTop: spacing.xs },
  dato: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  datoTexto: { fontSize: 13 },
  nota: { fontSize: 13 },
  estado: { fontSize: 12, fontWeight: '700', marginTop: spacing.xs },
  pie: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  enlace: { fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
  hora: { fontSize: 11 },
  registro: { alignItems: 'center', marginBottom: spacing.md },
  pastilla: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    maxWidth: '92%',
  },
  registroTexto: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
});
