import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { SelectorDeHorarios } from '@/components/SelectorDeHorarios';
import { Text } from '@/components/Text';
import { nuevaClave } from '@/lib/serviciosAdmision';
import {
  claveDelDia,
  diaDeLaSemana,
  fechaVisible,
  horarioElegidoDesdeRuta,
  rutaDelHorarioElegido,
  type Calendario,
  type Horario,
} from '@/lib/serviciosAgenda';
import { hayQueVolverAElegir, rutaDeLaContratacion } from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';
import { ServiceScheduleRepository } from '@/repositories/ServiceScheduleRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Los horarios POSIBLES de un servicio público: una fecha y sus horarios,
 * calculados por el servidor en la zona de la agenda.
 *
 * ELEGIR UN HORARIO SOLO LO GUARDA EN LA RUTA (`fecha`, `inicio`, `hora`,
 * `modalidad`): «Atrás» y un enlace lo conservan. ELEGIDO NO ES APARTADO: no se
 * escribe nada al tocar un horario.
 *
 * «CONTINUAR» (Incremento 5), y solo si el servidor dice que este servicio se
 * puede contratar aquí (`booking_available`), APARTA el horario unos minutos:
 * el servidor lo vuelve a calcular y, si otra persona lo tomó, contesta 409 y
 * se vuelve a elegir. Con la misma clave, un doble toque aparta una vez.
 */
export function HorariosDelServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const parametros = useLocalSearchParams();
  const { f } = useTextosDeServicios('reserva');
  const elegido = horarioElegidoDesdeRuta({ ...parametros, serviceId: id });
  const [sePuedeContinuar, setSePuedeContinuar] = useState(false);
  // Volver a pedir los horarios (tras un 409: alguien tomó el elegido).
  const [vuelta, setVuelta] = useState(0);
  // UNA CLAVE POR HORARIO ELEGIDO: repetir el mismo toque es repetir lo mismo;
  // elegir otro es otra retención.
  const clave = useRef(nuevaClave());
  useEffect(() => {
    clave.current = nuevaClave();
  }, [elegido?.inicio]);

  const volver = () => (router.canGoBack() ? router.back() : router.replace(`/servicios/ficha/${id}` as never));
  const cargarCalendario = useCallback(
    async (desde: string | null, hasta: string | null): Promise<Calendario> => {
      const calendario = await ServiceScheduleRepository.disponibilidad(id, desde, hasta);
      setSePuedeContinuar(calendario.booking_available === true);
      return calendario;
    },
    [id],
  );
  const cargarDia = useCallback(
    (fecha: string, cursor: string | null) => ServiceScheduleRepository.horarios(id, fecha, cursor),
    [id],
  );
  const elegir = (h: Horario, fecha: string, modalidad: string | null) => {
    if (!modalidad) return;
    router.setParams(rutaDelHorarioElegido({ fecha, inicio: h.starts_at, hora: h.time, modalidad }));
  };

  const { ocupado, correr } = useCerrojo(undefined, 'reserva');
  const continuar = () => {
    if (!elegido) return;
    void correr(async () => {
      try {
        const retencion = await ServiceBookingRepository.retener(id, elegido.inicio, elegido.modalidad, clave.current);
        // Hecho: la próxima vez es OTRA petición (si esta venció, se aparta de
        // nuevo; si sigue activa, el servidor dice cuál es y se sigue con ella).
        clave.current = nuevaClave();
        router.push(rutaDeLaContratacion(retencion.id) as never);
      } catch (error) {
        // Ese mismo horario ya estaba apartado para ti: se sigue con él.
        const detalles = error instanceof ApiError ? (error.details as { hold_id?: string } | null) : null;
        if (error instanceof ApiError && error.code === 'service_hold_already_active' && detalles?.hold_id) {
          router.push(rutaDeLaContratacion(detalles.hold_id) as never);
          return;
        }
        if (error instanceof ApiError && hayQueVolverAElegir(error.code)) {
          router.setParams({ fecha: undefined, inicio: undefined, hora: undefined, modalidad: undefined } as never);
          setVuelta((v) => v + 1);
        }
        throw error;
      }
    });
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.agenda.horarios')} onBack={volver} />
      <SelectorDeHorarios
        key={vuelta}
        cargarCalendario={cargarCalendario}
        cargarDia={cargarDia}
        elegido={elegido?.inicio ?? null}
        fechaInicial={elegido?.fecha ?? null}
        alElegir={elegir}
      />
      {elegido ? (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]} accessibilityLiveRegion="polite">
          <Text weight="700">{f('servicios.agenda.elegiste')}</Text>
          <Text variant="secondary">
            {f('servicios.agenda.elegidoCuerpo', {
              dia: f(claveDelDia(diaDeLaSemana(elegido.fecha))),
              fecha: fechaVisible(elegido.fecha),
              hora: elegido.hora,
            })}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f(sePuedeContinuar ? 'servicios.reserva.elegidoNoApartado' : 'servicios.agenda.noApartado')}
          </Text>
          {sePuedeContinuar ? (
            <Button
              label={f('servicios.reserva.continuar')}
              icon="arrow-right"
              loading={ocupado}
              disabled={ocupado}
              onPress={continuar}
            />
          ) : null}
        </View>
      ) : null}
      <Text variant="caption" color={colors.textMuted}>
        {f(sePuedeContinuar ? 'servicios.reserva.sePuedeApartar' : 'servicios.agenda.sinReservasPublico')}
      </Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
