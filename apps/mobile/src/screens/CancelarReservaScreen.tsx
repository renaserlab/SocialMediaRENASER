import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { nuevaClave, type FalloDeCarga } from '@/lib/serviciosAdmision';
import { claveDelDia, diaDeLaSemana, fechaVisible } from '@/lib/serviciosAgenda';
import {
  LARGOS_DE_LA_ATENCION,
  MOTIVOS_DE_CANCELACION,
  claveDelEstadoDelEfecto,
  claveDelMotivoDeCancelacion,
  llavero,
  momentoLegible,
  peticionDeCancelacion,
  puede,
  type ConCuidado,
  type Parte,
} from '@/lib/serviciosAtencion';
import { rutaDeLaReserva, rutaDeLaReservaDelPrestador, type ReservaDetalle } from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCareRepository } from '@/repositories/ServiceCareRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * CANCELAR UNA RESERVA, de quien contrata o de su prestador.
 *
 * ANTES DE CONFIRMAR se enseña la consecuencia: qué reserva es, hasta cuándo
 * se puede, que el horario vuelve a quedar libre y en qué queda lo económico
 * (lo dice el servidor; hoy, «no aplica»: no se cobró nada y no hay nada que
 * devolver). El prestador explica por qué; quien contrata, si quiere.
 *
 * Si el servidor ya no ofrece cancelar (empezó, pasó la hora, ya se canceló),
 * se dice y no se manda nada.
 */
export function CancelarReservaScreen({ rol }: { rol: Parte }) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('bookingId');
  const { f } = useTextosDeServicios('reserva');
  const [reserva, setReserva] = useState<ConCuidado<ReservaDetalle> | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [motivo, setMotivo] = useState<string>(rol === 'client' ? 'change_of_plans' : 'unavailable');
  const [nota, setNota] = useState('');
  const llaves = useRef(llavero(nuevaClave)).current;

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setReserva(await ServiceCareRepository.reserva(rol, id));
    } catch (error) {
      setFallo(leerFallo(error));
    }
  }, [id, rol]);
  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar, 'reserva');

  const laReserva = rol === 'client' ? rutaDeLaReserva(id) : rutaDeLaReservaDelPrestador(id);
  const volver = () => (router.canGoBack() ? router.back() : router.replace(laReserva as never));
  const titulo = f('servicios.atencion.cancelar.titulo');

  const cancelar = () =>
    void correr(async () => {
      const { peticion, fallo: falta } = peticionDeCancelacion(rol, motivo, nota);
      if (peticion === null) {
        notify(f('servicios.noSePudo'), f(falta ?? 'servicios.atencion.error.motivo'));
        return;
      }
      const si = await confirm({
        title: f('servicios.atencion.cancelar.preguntaTitulo'),
        message: f('servicios.atencion.cancelar.preguntaAviso'),
        confirmLabel: f('servicios.atencion.cancelar.si'),
        destructive: true,
      });
      if (!si) return;
      await ServiceCareRepository.cancelar(rol, id, peticion, llaves.de('cancelar', peticion));
      llaves.hecho('cancelar');
      toast(f('servicios.atencion.cancelar.hecho'));
      router.replace(laReserva as never);
    });

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : reserva === null ? (
        <StateView state="loading" />
      ) : !puede(reserva.care, 'cancel') ? (
        <StateView
          state="empty"
          icon="slash"
          title={f('servicios.atencion.cancelar.yaNo')}
          description={f('servicios.atencion.cancelar.yaNoCuerpo')}
          actionLabel={f('servicios.reserva.verReserva')}
          onAction={() => router.replace(laReserva as never)}
        />
      ) : (
        <>
          <View style={[styles.tarjeta, { borderColor: colors.border }]} accessibilityRole="summary">
            <Text variant="titleMedium">{reserva.title}</Text>
            <Text>
              {f('servicios.reserva.cuando', {
                dia: f(claveDelDia(diaDeLaSemana(reserva.date))),
                fecha: fechaVisible(reserva.date),
                hora: reserva.time,
                fin: reserva.end_time,
              })}
            </Text>
            <Text weight="700">{f('servicios.reserva.codigo', { codigo: reserva.code })}</Text>
          </View>

          <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
            <Text weight="700">{f('servicios.atencion.cancelar.consecuencias')}</Text>
            <Text variant="secondary">{f('servicios.atencion.cancelar.seLibera')}</Text>
            <Text variant="secondary">
              {f('servicios.atencion.dinero.deLaCancelacion', {
                estado: f(claveDelEstadoDelEfecto(reserva.care?.deadlines.cancellation_financial_effect)),
              })}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.cambios.cancelarHasta', {
                fecha: momentoLegible(reserva.care?.deadlines.cancel_until),
              })}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.cancelar.noSeDeshace')}
            </Text>
          </View>

          <Text weight="700">{f('servicios.atencion.cancelar.porQue')}</Text>
          <View style={styles.fila} accessibilityRole="radiogroup">
            {MOTIVOS_DE_CANCELACION.map((m) => (
              <Chip
                key={m}
                rol="radio"
                label={f(claveDelMotivoDeCancelacion(m))}
                selected={motivo === m}
                onPress={() => setMotivo(m)}
              />
            ))}
          </View>
          <Input
            label={f(rol === 'provider' ? 'servicios.atencion.cancelar.notaObligatoria' : 'servicios.atencion.cancelar.nota')}
            placeholder={f('servicios.atencion.cancelar.notaAyuda')}
            value={nota}
            onChangeText={setNota}
            maxLength={LARGOS_DE_LA_ATENCION.nota}
            multiline
          />
          <Button
            label={f('servicios.atencion.cancelar.si')}
            icon="x-circle"
            loading={ocupado}
            disabled={ocupado || (rol === 'provider' && !nota.trim())}
            onPress={cancelar}
          />
          <Button label={f('servicios.atencion.cancelar.no')} variant="ghost" disabled={ocupado} onPress={volver} />
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
