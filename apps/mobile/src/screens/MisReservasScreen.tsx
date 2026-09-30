import React, { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { ListaDeReservas } from '@/components/ListaDeReservas';
import { rutaDeLaReserva, type AmbitoDeReservas } from '@/lib/serviciosReserva';
import { useListaDeReservas } from '@/hooks/useReservaDeServicios';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';
import { spacing } from '@/theme/tokens';

/**
 * MIS RESERVAS: las confirmadas, por venir (de la más próxima a la más lejana)
 * o pasadas. Lo apartado que no se confirmó no es una reserva y no sale aquí.
 */
export function MisReservasScreen() {
  const router = useRouter();
  const { f } = useTextosDeServicios('reserva');
  const [ambito, setAmbito] = useState<AmbitoDeReservas>('upcoming');
  const pedir = useCallback(
    (a: AmbitoDeReservas, cursor: string | null) => ServiceBookingRepository.misReservas(a, cursor),
    [],
  );
  const lista = useListaDeReservas(pedir, ambito);
  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.reserva.misReservas')} onBack={volver} />
      <ListaDeReservas
        ambito={ambito}
        alCambiarDeAmbito={setAmbito}
        reservas={lista.reservas}
        fallo={lista.fallo}
        siguiente={lista.siguiente}
        cargandoMas={lista.cargandoMas}
        alReintentar={() => void lista.cargar()}
        alVerMas={() => void lista.mas()}
        alAbrir={(b) => router.push(rutaDeLaReserva(b.id) as never)}
        vacia={{
          titulo: f(ambito === 'upcoming' ? 'servicios.reserva.sinPorVenir' : 'servicios.reserva.sinPasadas'),
          cuerpo: f('servicios.reserva.sinReservasCuerpo'),
        }}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
});
