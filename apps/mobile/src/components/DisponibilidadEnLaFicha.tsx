import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { claveDelDia, diaDeLaSemana, fechaVisible, type Calendario } from '@/lib/serviciosAgenda';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceScheduleRepository } from '@/repositories/ServiceScheduleRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La disponibilidad dentro de la ficha pública (bloque 12 del blueprint): el
 * próximo horario POSIBLE y el acceso a ver todos.
 *
 * SI LA AGENDA NO ESTÁ (la 0092 sin aplicar, Servicios apagado, un fallo de
 * red) LA SECCIÓN NO SALE: la ficha sigue siendo la del Incremento 3. Nunca un
 * horario de ejemplo. «Ver horarios» no reserva nada.
 */
export function DisponibilidadEnLaFicha({ servicio }: { servicio: string }) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios('agenda');
  const [calendario, setCalendario] = useState<Calendario | null>(null);
  const [oculta, setOculta] = useState(false);

  useEffect(() => {
    let vigente = true;
    ServiceScheduleRepository.disponibilidad(servicio, null, null)
      .then((c) => {
        if (vigente) setCalendario(c);
      })
      .catch(() => {
        if (vigente) setOculta(true);
      });
    return () => {
      vigente = false;
    };
  }, [servicio]);

  if (oculta || calendario === null) return null;
  const c = calendario;
  const proximo = c.next;

  return (
    <View style={styles.bloque}>
      <Text weight="700" accessibilityRole="header">
        {f('servicios.agenda.disponibilidad')}
      </Text>
      {c.status === 'not_configured' ? (
        <Text variant="secondary">{f('servicios.agenda.vacio.sinAgenda')}</Text>
      ) : c.status === 'paused' ? (
        <Text variant="secondary">{f('servicios.agenda.vacio.enPausa')}</Text>
      ) : proximo ? (
        <>
          <Text variant="secondary">
            {f('servicios.agenda.proximo', {
              dia: f(claveDelDia(diaDeLaSemana(proximo.date))),
              fecha: fechaVisible(proximo.date),
              hora: proximo.time,
            })}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.agenda.horasEn', { zona: c.timezone ?? '' })}
          </Text>
          <Button
            label={f('servicios.agenda.verHorarios')}
            icon="calendar"
            variant="secondary"
            onPress={() => router.push(`/servicios/horarios/${servicio}` as never)}
          />
        </>
      ) : (
        <Text variant="secondary">{f('servicios.agenda.vacio.sinHorarios')}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bloque: { gap: spacing.xs },
});
