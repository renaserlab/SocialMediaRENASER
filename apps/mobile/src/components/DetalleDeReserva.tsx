import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Text';
import { huellaCorta } from '@/lib/serviciosAdmision';
import { claveDelDia, diaDeLaSemana, fechaVisible } from '@/lib/serviciosAgenda';
import { claveDeLaModalidad, duracionLegible, precioLegible } from '@/lib/serviciosCatalogo';
import { claveDeLaAceptacion, claveDelSuceso, type ReservaDetalle } from '@/lib/serviciosReserva';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * El detalle de una reserva: su FOTOGRAFÍA (lo contratado entonces, no lo de
 * hoy), el precio y que NO SE MOVIÓ DINERO, lo que pidió la atención (solo lo
 * ven quien contrata y el prestador), lo aceptado y el historial.
 */
export function DetalleDeReserva({ reserva }: { reserva: ReservaDetalle }) {
  const { colors } = useAppTheme();
  const { f } = useTextosDeServicios('reserva');
  const r = reserva;
  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];
  const precio = precioLegible({ model: r.price.model, amount_minor: r.price.amount_minor, currency: r.price.currency });
  const duracion = duracionLegible(r.duration_minutes);
  return (
    <>
      <View style={tarjeta} accessibilityRole="summary">
        <Text variant="titleMedium">{r.title}</Text>
        <Text variant="secondary">{r.provider_name}</Text>
        <Text weight="700">{f('servicios.reserva.codigo', { codigo: r.code })}</Text>
        <Text>
          {f('servicios.reserva.cuando', {
            dia: f(claveDelDia(diaDeLaSemana(r.date))),
            fecha: fechaVisible(r.date),
            hora: r.time,
            fin: r.end_time,
          })}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.agenda.horasEn', { zona: r.timezone })}
        </Text>
        <Text variant="secondary">
          {`${f('servicios.agenda.modalidad')}: ${f(claveDeLaModalidad(r.modality))}`}
        </Text>
        {r.location_area ? (
          <Text variant="secondary">{f('servicios.reserva.lugar', { zona: r.location_area })}</Text>
        ) : null}
        <Text variant="secondary">{f(duracion.clave, duracion.params)}</Text>
        <Text weight="700">{f(precio.clave, precio.params)}</Text>
        {r.price.payment_status === 'not_required' ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.reserva.sinDinero')}
          </Text>
        ) : null}
      </View>

      {r.intake ? (
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.reserva.lopedido')}</Text>
          {r.intake.note ? <Text variant="secondary">{r.intake.note}</Text> : null}
          {r.intake.address_line ? (
            <Text variant="secondary">
              {[r.intake.address_line, r.intake.district, r.intake.address_reference].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={tarjeta}>
        <Text weight="700">{f('servicios.reserva.aceptadas')}</Text>
        {r.acceptances.map((a) => (
          <Text key={a.kind} variant="secondary">
            {f(claveDeLaAceptacion(a.kind), { version: a.version ?? '—', huella: huellaCorta(a.sha256) })}
          </Text>
        ))}
      </View>

      <View style={tarjeta}>
        <Text weight="700">{f('servicios.reserva.historial')}</Text>
        {r.history.map((e, i) => (
          <Text key={`${e.action}-${i}`} variant="secondary">
            {`• ${f(claveDelSuceso(e.action))}`}
          </Text>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
