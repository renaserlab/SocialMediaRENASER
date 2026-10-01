import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { CuentaAtrasDeRetencion } from '@/components/CuentaAtrasDeRetencion';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { toast } from '@/lib/toast';
import { nuevaClave, type FalloDeCarga } from '@/lib/serviciosAdmision';
import { claveDelDia, diaDeLaSemana, fechaVisible } from '@/lib/serviciosAgenda';
import {
  llavero,
  puede,
  rutaDeHorariosParaReprogramar,
  type ConCuidado,
} from '@/lib/serviciosAtencion';
import { hayQueVolverAElegir, rutaDeLaReserva, type ReservaDetalle } from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useCuentaAtras, useResumenDeLaContratacion } from '@/hooks/useReservaDeServicios';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';
import { ServiceCareRepository } from '@/repositories/ServiceCareRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * CAMBIAR EL HORARIO de una reserva: el último paso. El horario nuevo ya está
 * APARTADO (una retención, con su cuenta atrás del servidor); aquí se ve de
 * dónde a dónde se mueve y se confirma.
 *
 * EL CONTRATO NO CAMBIA: el mismo servicio, el mismo precio y las condiciones
 * que ya se aceptaron. Y LA RESERVA ORIGINAL NO SE PIERDE: si el cambio no se
 * puede hacer, sigue en su horario de siempre.
 */
export function ReprogramarReservaScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('bookingId');
  const parametros = useLocalSearchParams<{ retencion?: string }>();
  const retencion = typeof parametros.retencion === 'string' ? parametros.retencion : '';
  const { f } = useTextosDeServicios('reserva');
  const [reserva, setReserva] = useState<ConCuidado<ReservaDetalle> | null>(null);
  const [falloDeLaReserva, setFalloDeLaReserva] = useState<FalloDeCarga | null>(null);
  const { resumen, recibidaEn, fallo: falloDelHorario, cargar: cargarHorario } = useResumenDeLaContratacion(retencion);
  const segundos = useCuentaAtras(resumen, recibidaEn);
  const llaves = useRef(llavero(nuevaClave)).current;

  const cargarReserva = useCallback(async () => {
    setFalloDeLaReserva(null);
    try {
      setReserva(await ServiceCareRepository.reserva('client', id));
    } catch (error) {
      setFalloDeLaReserva(leerFallo(error));
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void cargarReserva();
    }, [cargarReserva]),
  );
  const cargar = useCallback(async () => {
    await Promise.all([cargarReserva(), cargarHorario()]);
  }, [cargarHorario, cargarReserva]);
  const { ocupado, correr } = useCerrojo(cargar, 'reserva');

  const titulo = f('servicios.atencion.reprogramar.titulo');
  const volver = () => (router.canGoBack() ? router.back() : router.replace(rutaDeLaReserva(id) as never));
  const fallo = falloDeLaReserva ?? falloDelHorario;

  const elegirOtro = (servicio: string) => router.replace(rutaDeHorariosParaReprogramar(servicio, id) as never);

  const confirmar = () =>
    void correr(async () => {
      try {
        await ServiceCareRepository.reprogramar(id, retencion, llaves.de('reprogramar', retencion));
        llaves.hecho('reprogramar');
        toast(f('servicios.atencion.reprogramar.hecho'));
        router.replace(rutaDeLaReserva(id) as never);
      } catch (error) {
        // El horario apartado ya no sirve: se vuelve a leer y se ofrece elegir otro.
        if (error instanceof ApiError && hayQueVolverAElegir(error.code)) {
          await cargar();
        }
        throw error;
      }
    });

  const soltar = (servicio: string) =>
    void correr(async () => {
      await ServiceBookingRepository.soltar(retencion, nuevaClave());
      elegirOtro(servicio);
    });

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (reserva === null || resumen === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  const h = resumen.hold;
  // La reserva ya no se puede mover (empezó, se canceló, cambió el servicio o se agotaron los cambios).
  if (!puede(reserva.care, 'reschedule')) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="slash"
          title={f('servicios.atencion.reprogramar.yaNo')}
          description={f('servicios.atencion.reprogramar.yaNoCuerpo')}
          actionLabel={f('servicios.reserva.verReserva')}
          onAction={() => router.replace(rutaDeLaReserva(id) as never)}
        />
      </AppScreen>
    );
  }
  // El horario apartado venció, se soltó o no es de este servicio: se elige otro.
  if (h.status !== 'active' || segundos <= 0 || h.service_id !== reserva.service_id) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="clock"
          title={f(h.status === 'released' ? 'servicios.reserva.bloqueo.hold_released' : 'servicios.reserva.vencio')}
          description={f('servicios.atencion.reprogramar.sigueIgual')}
          actionLabel={f('servicios.reserva.elegirOtro')}
          onAction={() => elegirOtro(reserva.service_id)}
        />
      </AppScreen>
    );
  }

  const cuando = (fecha: string, hora: string, fin: string) =>
    f('servicios.reserva.cuando', { dia: f(claveDelDia(diaDeLaSemana(fecha))), fecha: fechaVisible(fecha), hora, fin });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <CuentaAtrasDeRetencion
        segundos={segundos}
        hora={h.time}
        fecha={`${f(claveDelDia(diaDeLaSemana(h.date)))} ${fechaVisible(h.date)}`}
      />
      <Text variant="titleMedium">{reserva.title}</Text>
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text weight="700">{f('servicios.atencion.reprogramar.ahora')}</Text>
        <Text variant="secondary">{cuando(reserva.date, reserva.time, reserva.end_time)}</Text>
      </View>
      <View style={[styles.tarjeta, { borderColor: colors.primary }]} accessibilityLiveRegion="polite">
        <Text weight="700">{f('servicios.atencion.reprogramar.nuevo')}</Text>
        <Text>{cuando(h.date, h.time, h.end_time)}</Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.agenda.horasEn', { zona: h.timezone })}
        </Text>
      </View>
      <Text variant="secondary">{f('servicios.atencion.reprogramar.mismoContrato')}</Text>
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.atencion.reprogramar.quedan', { n: reserva.care?.deadlines.reschedules_left ?? 0 })}
      </Text>
      <Button
        label={f('servicios.atencion.reprogramar.confirmar')}
        icon="check"
        loading={ocupado}
        disabled={ocupado}
        onPress={confirmar}
      />
      <Button
        label={f('servicios.reserva.elegirOtro')}
        variant="ghost"
        disabled={ocupado}
        onPress={() => soltar(reserva.service_id)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
