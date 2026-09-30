import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { SelectorDeHorarios } from '@/components/SelectorDeHorarios';
import { Text } from '@/components/Text';
import {
  claveDelDia,
  diaDeLaSemana,
  fechaVisible,
  horarioElegidoDesdeRuta,
  rutaDelHorarioElegido,
  type Horario,
} from '@/lib/serviciosAgenda';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceScheduleRepository } from '@/repositories/ServiceScheduleRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Los horarios POSIBLES de un servicio público: una fecha y sus horarios,
 * calculados por el servidor en la zona de la agenda.
 *
 * ELEGIR UN HORARIO SOLO LO GUARDA EN LA RUTA (`fecha`, `inicio`, `hora`,
 * `modalidad`): «Atrás» y un enlace lo conservan, y el Incremento 5 lo
 * recogerá de ahí (`horarioElegidoDesdeRuta`). NO SE ESCRIBE NADA: ni una
 * reserva, ni una retención, ni un pedido. Por eso no hay botón de reservar,
 * confirmar ni pagar, y se dice claramente que el horario no queda apartado.
 */
export function HorariosDelServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const parametros = useLocalSearchParams();
  const { f } = useTextosDeServicios('agenda');
  const elegido = horarioElegidoDesdeRuta({ ...parametros, serviceId: id });

  const volver = () => (router.canGoBack() ? router.back() : router.replace(`/servicios/ficha/${id}` as never));
  const cargarCalendario = useCallback(
    (desde: string | null, hasta: string | null) => ServiceScheduleRepository.disponibilidad(id, desde, hasta),
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

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.agenda.horarios')} onBack={volver} />
      <SelectorDeHorarios
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
            {f('servicios.agenda.noApartado')}
          </Text>
        </View>
      ) : null}
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.agenda.sinReservasPublico')}
      </Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
