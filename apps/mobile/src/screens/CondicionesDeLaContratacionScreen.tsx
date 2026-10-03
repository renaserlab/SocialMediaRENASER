import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { huellaCorta } from '@/lib/serviciosAdmision';
import { rutaDeLaContratacion } from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useResumenDeLaContratacion } from '@/hooks/useReservaDeServicios';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Las condiciones que se aceptan al contratar, ENTERAS: las de Z (su versión
 * y su huella, las mismas que se mandan al confirmar) y las del servicio, si
 * las tiene. Sin condiciones publicadas no se inventa un texto: se dice que
 * todavía no hay. «Atrás» vuelve al resumen, que conserva lo marcado.
 */
export function CondicionesDeLaContratacionScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const retencion = useParametroDeRuta('holdId');
  const { f } = useTextosDeServicios('reserva');
  const { resumen, fallo, cargar } = useResumenDeLaContratacion(retencion);
  const titulo = f('servicios.reserva.condiciones');
  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(rutaDeLaContratacion(retencion, 'resumen') as never);

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (resumen === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  const caja = [styles.texto, { borderColor: colors.border }];
  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      {resumen.terms ? (
        <>
          <Text variant="titleMedium">{resumen.terms.title}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.reserva.condicionesVersion', {
              version: resumen.terms.version,
              huella: huellaCorta(resumen.terms.sha256),
            })}
          </Text>
          <View style={caja}>
            <Text selectable>{resumen.terms.body}</Text>
          </View>
        </>
      ) : (
        <StateView
          state="empty"
          icon="clock"
          title={f('servicios.reserva.sinCondiciones')}
          description={f('servicios.reserva.sinCondicionesCuerpo')}
        />
      )}
      {resumen.service_conditions ? (
        <>
          <Text variant="titleMedium">{f('servicios.reserva.condicionesDelServicio')}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.reserva.huella', { huella: huellaCorta(resumen.service_conditions.sha256) })}
          </Text>
          <View style={caja}>
            <Text selectable>{resumen.service_conditions.text}</Text>
          </View>
        </>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  texto: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
