import React, { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { AtencionDeLaReserva } from '@/components/AtencionDeLaReserva';
import { DetalleDeReserva } from '@/components/DetalleDeReserva';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import type { FalloDeCarga } from '@/lib/serviciosAdmision';
import type { ConCuidado } from '@/lib/serviciosAtencion';
import type { ReservaDelPrestador } from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { leerFallo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * UNA RESERVA DE MI SERVICIO, con lo JUSTO para atenderla: quién (su nombre
 * público; ni correo ni teléfono), cuándo, cómo y lo que escribió al
 * contratar. La dirección solo existe si es a domicilio. Una reserva ajena o
 * inexistente es el mismo 404.
 *
 * Y SU ATENCIÓN (Incremento 6): empezar (con el código de quien contrata),
 * marcarla como realizada, cancelar, reportar una inasistencia, el caso y la
 * respuesta a la reseña. Lo decide el servidor (`care.available_actions`).
 */
export function ReservaDelPrestadorScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('bookingId');
  const { f } = useTextosDeServicios('reserva');
  const [reserva, setReserva] = useState<ConCuidado<ReservaDelPrestador> | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setReserva(await ServiceBookingRepository.reservaDelPrestador(id));
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

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/servicios/prestador/reservas' as never);

  return (
    <AppScreen
      contentStyle={styles.contenido}
      scrollProps={{
        refreshControl: (
          <RefreshControl refreshing={refrescando} onRefresh={refrescar} tintColor={colors.text} colors={[colors.text]} />
        ),
      }}
    >
      <AppHeader title={f('servicios.reserva.deMiServicio')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : reserva === null ? (
        <StateView state="loading" />
      ) : (
        <>
          <View style={[styles.tarjeta, { borderColor: colors.border }]}>
            <Text weight="700">{f('servicios.reserva.quienContrata')}</Text>
            <Text variant="secondary">
              {reserva.client === null
                ? f('servicios.reserva.cuentaQueYaNoExiste')
                : [reserva.client.name, reserva.client.username ? `@${reserva.client.username}` : null]
                    .filter(Boolean)
                    .join(' · ') || f('servicios.reserva.sinNombrePublico')}
            </Text>
          </View>
          <AtencionDeLaReserva
            rol="provider"
            reserva={reserva}
            alCambiar={(fresca) => setReserva(fresca as ConCuidado<ReservaDelPrestador>)}
            recargar={cargar}
          />
          <DetalleDeReserva reserva={reserva} />
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
