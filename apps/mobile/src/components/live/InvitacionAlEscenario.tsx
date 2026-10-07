import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { sobreMedio, SuperficieSobreMedio } from '@/components/CapaDeContraste';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { radius, spacing } from '@/theme/tokens';

type Props = {
  /** Quién invita. */
  anfitrion: string;
  /** Hay una respuesta en vuelo. */
  ocupado: boolean;
  alAceptar: () => void;
  alRechazar: () => void;
};

/**
 * «Te invitan a salir en este directo».
 *
 * DICE LO QUE VA A PASAR ANTES DE QUE PASE. Aceptar es salir con la cámara y
 * el micrófono delante de todo el que está mirando: no puede parecerse a
 * aceptar una solicitud de amistad. Por eso el texto lo dice con esas palabras
 * y «Ahora no» pesa lo mismo que «Aceptar».
 *
 * Solo se pinta mientras el servidor diga que la invitación sigue en pie; quien
 * la contesta —o a quien se la retiran— deja de verla.
 */
export function InvitacionAlEscenario({ anfitrion, ocupado, alAceptar, alRechazar }: Props) {
  const { t } = useTranslation();
  return (
    <SuperficieSobreMedio style={styles.tarjeta}>
      <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.textos}>
        <Feather name="video" size={22} color={sobreMedio.text} />
        <Text variant="body" weight="800" color={sobreMedio.text} style={styles.centrado}>
          {t('live.stageInvitedTitle', { nombre: anfitrion })}
        </Text>
        <Text variant="secondary" color={sobreMedio.textMuted} style={styles.centrado}>
          {t('live.stageInvitedBody')}
        </Text>
      </View>
      <View style={styles.botones}>
        <Pulsable
          onPress={alRechazar}
          disabled={ocupado}
          opacidad={ocupado ? 0.45 : 1}
          accessibilityRole="button"
          accessibilityState={{ disabled: ocupado }}
          style={[styles.boton, styles.conBorde]}
        >
          <Text variant="secondary" weight="700" color={sobreMedio.text}>
            {t('live.stageDecline')}
          </Text>
        </Pulsable>
        <Pulsable
          onPress={alAceptar}
          disabled={ocupado}
          opacidad={ocupado ? 0.45 : 1}
          accessibilityRole="button"
          accessibilityState={{ disabled: ocupado }}
          style={[styles.boton, styles.relleno]}
        >
          <Text variant="secondary" weight="800" color={sobreMedio.background}>
            {t('live.stageAccept')}
          </Text>
        </Pulsable>
      </View>
    </SuperficieSobreMedio>
  );
}

const styles = StyleSheet.create({
  tarjeta: { alignSelf: 'stretch', gap: spacing.md, padding: spacing.lg },
  textos: { alignItems: 'center', gap: spacing.xs },
  centrado: { textAlign: 'center' },
  botones: { flexDirection: 'row', gap: spacing.sm },
  boton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  conBorde: { borderWidth: 1, borderColor: sobreMedio.border },
  relleno: { backgroundColor: sobreMedio.text },
});
