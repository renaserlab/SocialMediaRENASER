import React, { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { ListaDeReservas } from '@/components/ListaDeReservas';
import { Text } from '@/components/Text';
import { rutaDeLaReservaDelPrestador, type AmbitoDeReservas } from '@/lib/serviciosReserva';
import { useListaDeReservas } from '@/hooks/useReservaDeServicios';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * LAS RESERVAS DE MIS SERVICIOS: solo las confirmadas. Lo que alguien tiene
 * apartado (y puede soltar) no llega aquí: no es una reserva ni da acceso a
 * ningún dato de esa persona.
 */
export function ReservasDelPrestadorScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios('reserva');
  const [ambito, setAmbito] = useState<AmbitoDeReservas>('upcoming');
  const pedir = useCallback(
    (a: AmbitoDeReservas, cursor: string | null) => ServiceBookingRepository.reservasDelPrestador(a, cursor),
    [],
  );
  const lista = useListaDeReservas(pedir, ambito);
  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.reserva.delPrestador')} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.reserva.delPrestadorIntro')}
      </Text>
      <ListaDeReservas
        ambito={ambito}
        alCambiarDeAmbito={setAmbito}
        reservas={lista.reservas}
        fallo={lista.fallo}
        siguiente={lista.siguiente}
        cargandoMas={lista.cargandoMas}
        alReintentar={() => void lista.cargar()}
        alVerMas={() => void lista.mas()}
        alAbrir={(b) => router.push(rutaDeLaReservaDelPrestador(b.id) as never)}
        vacia={{
          titulo: f(ambito === 'upcoming' ? 'servicios.reserva.sinPorVenir' : 'servicios.reserva.sinPasadas'),
          cuerpo: f('servicios.reserva.delPrestadorVacia'),
        }}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
});
