import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Text';
import { cuentaAtras } from '@/lib/serviciosReserva';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Cuánto falta para que venza el horario APARTADO, con la hora del servidor.
 * Lo que se lee es «apartado para ti durante 09:42», nunca «reservado».
 */
export function CuentaAtrasDeRetencion({ segundos, hora, fecha }: { segundos: number; hora: string; fecha: string }) {
  const { colors } = useAppTheme();
  const { f } = useTextosDeServicios('reserva');
  const vencida = segundos <= 0;
  return (
    <View
      style={[styles.caja, { borderColor: vencida ? colors.danger : colors.primary }]}
      // Se anuncia al VENCER, no cada segundo.
      accessibilityLiveRegion={vencida ? 'assertive' : 'none'}
      accessibilityRole="timer"
    >
      <Text weight="700">
        {vencida
          ? f('servicios.reserva.vencio')
          : f('servicios.reserva.apartadoDurante', { hora, fecha, tiempo: cuentaAtras(segundos) })}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {f(vencida ? 'servicios.reserva.vencioCuerpo' : 'servicios.reserva.apartadoNoReservado')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  caja: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.md },
});
