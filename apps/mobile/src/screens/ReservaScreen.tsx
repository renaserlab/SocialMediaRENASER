import React, { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { AtencionDeLaReserva } from '@/components/AtencionDeLaReserva';
import { DetalleDeReserva } from '@/components/DetalleDeReserva';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import type { FalloDeCarga } from '@/lib/serviciosAdmision';
import type { ConCuidado } from '@/lib/serviciosAtencion';
import type { ReservaDetalle } from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { leerFallo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * UNA RESERVA PROPIA, con lo aceptado y su historial. Recién confirmada
 * (`?confirmada=1`), lo dice arriba: ahora SÍ está reservado.
 *
 * Y SU ATENCIÓN (Incremento 6): en qué está y lo que se puede hacer ahora
 * (cancelar, cambiar el horario, el código de asistencia, confirmar, reportar
 * un problema, reseñar). Lo decide el servidor (`care.available_actions`).
 */
export function ReservaScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('bookingId');
  const { confirmada } = useLocalSearchParams<{ confirmada?: string }>();
  const { f } = useTextosDeServicios('reserva');
  const [reserva, setReserva] = useState<ConCuidado<ReservaDetalle> | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setReserva(await ServiceBookingRepository.miReserva(id));
    } catch (error) {
      setFallo(leerFallo(error));
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  // La otra parte confirma, reprograma o cancela mientras se mira: tirar hacia
  // abajo vuelve a pedirla, sin salir y volver a entrar.
  const [refrescando, setRefrescando] = useState(false);
  const refrescar = () =>
    void (async () => {
      setRefrescando(true);
      try {
        await cargar();
      } finally {
        setRefrescando(false);
      }
    })();

  const titulo = f('servicios.reserva.tuReserva');
  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/reservas' as never));

  return (
    <AppScreen
      contentStyle={styles.contenido}
      scrollProps={{
        refreshControl: (
          <RefreshControl refreshing={refrescando} onRefresh={refrescar} tintColor={colors.text} colors={[colors.text]} />
        ),
      }}
    >
      <AppHeader title={titulo} onBack={volver} />
      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : reserva === null ? (
        <StateView state="loading" />
      ) : (
        <>
          {confirmada === '1' ? (
            <View
              style={[styles.aviso, { borderColor: colors.primary }]}
              accessibilityLiveRegion="polite"
              accessibilityRole="alert"
            >
              <Text weight="700">{f('servicios.reserva.confirmada')}</Text>
              <Text variant="secondary">{f('servicios.reserva.confirmadaCuerpo')}</Text>
            </View>
          ) : null}
          <AtencionDeLaReserva rol="client" reserva={reserva} alCambiar={setReserva} recargar={cargar} />
          <DetalleDeReserva reserva={reserva} />
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  aviso: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
