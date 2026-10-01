import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { claveDelDia, diaDeLaSemana, fechaVisible } from '@/lib/serviciosAgenda';
import { claveDeLaModalidad } from '@/lib/serviciosCatalogo';
import { AMBITOS_DE_RESERVAS, type AmbitoDeReservas, type Reserva } from '@/lib/serviciosReserva';
import type { FalloDeCarga } from '@/lib/serviciosAdmision';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { spacing } from '@/theme/tokens';

/**
 * Una lista de reservas (por venir o pasadas; entre las pasadas, las
 * canceladas, que se dicen), con su código, la hora local de la agenda y la
 * modalidad. La usan «Mis reservas» y la
 * bandeja del prestador; cada una decide adónde lleva tocar una fila.
 */
export function ListaDeReservas({
  ambito,
  alCambiarDeAmbito,
  reservas,
  fallo,
  siguiente,
  cargandoMas,
  alReintentar,
  alVerMas,
  alAbrir,
  vacia,
}: {
  ambito: AmbitoDeReservas;
  alCambiarDeAmbito: (ambito: AmbitoDeReservas) => void;
  reservas: Reserva[] | null;
  fallo: FalloDeCarga | null;
  siguiente: string | null;
  cargandoMas: boolean;
  alReintentar: () => void;
  alVerMas: () => void;
  alAbrir: (reserva: Reserva) => void;
  vacia: { titulo: string; cuerpo: string };
}) {
  const { f } = useTextosDeServicios('reserva');
  return (
    <>
      <View style={styles.pestanas} accessibilityRole="tablist">
        {AMBITOS_DE_RESERVAS.map((a) => (
          <Chip
            key={a}
            label={f(`servicios.reserva.ambito.${a}`)}
            selected={ambito === a}
            onPress={() => alCambiarDeAmbito(a)}
          />
        ))}
      </View>
      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={alReintentar} />
      ) : reservas === null ? (
        <StateView state="loading" />
      ) : reservas.length === 0 ? (
        <StateView state="empty" icon="calendar" title={vacia.titulo} description={vacia.cuerpo} />
      ) : (
        <>
          {reservas.map((b) => (
            <ListRow
              key={b.id}
              title={b.title}
              subtitle={`${b.status === 'cancelled' ? `${f('servicios.atencion.reserva.cancelled')} · ` : ''}${f(
                claveDelDia(diaDeLaSemana(b.date)),
              )} ${fechaVisible(b.date)} · ${b.time} · ${f(claveDeLaModalidad(b.modality))} · ${b.code}`}
              rightIcon="chevron-right"
              onPress={() => alAbrir(b)}
            />
          ))}
          {siguiente ? (
            <Button label={f('servicios.reserva.verMas')} variant="ghost" loading={cargandoMas} onPress={alVerMas} />
          ) : null}
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  pestanas: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
});
