import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { CuentaAtrasDeRetencion } from '@/components/CuentaAtrasDeRetencion';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { nuevaClave } from '@/lib/serviciosAdmision';
import { claveDelDia, diaDeLaSemana, fechaVisible } from '@/lib/serviciosAgenda';
import { claveDeLaModalidad } from '@/lib/serviciosCatalogo';
import {
  borradorDe,
  guardarBorrador,
  olvidarBorrador,
  rutaDeLaContratacion,
  type FormularioDeContratacion,
} from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useCuentaAtras, useResumenDeLaContratacion } from '@/hooks/useReservaDeServicios';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Paso 1 de la contratación: TUS DATOS. Solo lo necesario para prestar el
 * servicio: una nota opcional y, A DOMICILIO, el distrito y la dirección (la
 * referencia, opcional). En otra modalidad no se pide ninguna dirección.
 *
 * Lo escrito pasa al resumen EN MEMORIA (nunca en la ruta) y se olvida al
 * confirmar o al soltar el horario. La cuenta atrás es la del servidor.
 */
export function DatosDeLaContratacionScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const retencion = useParametroDeRuta('holdId');
  const { f } = useTextosDeServicios('reserva');
  const { resumen, recibidaEn, fallo, cargar } = useResumenDeLaContratacion(retencion);
  const segundos = useCuentaAtras(resumen, recibidaEn);
  const [formulario, setFormulario] = useState<FormularioDeContratacion>(() => borradorDe(retencion));
  const recargar = useCallback(async () => {
    await cargar();
  }, [cargar]);
  const { ocupado, correr } = useCerrojo(recargar, 'reserva');

  // Solo lo de ESTE paso: lo aceptado en el resumen no se pisa al volver.
  useEffect(() => {
    const { nota, distrito, direccion, referencia } = formulario;
    guardarBorrador(retencion, { ...borradorDe(retencion), nota, distrito, direccion, referencia });
  }, [formulario, retencion]);

  const titulo = f('servicios.reserva.pasoDatos');
  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios' as never));
  const soltarYElegirOtro = (servicio: string) =>
    void correr(async () => {
      await ServiceBookingRepository.soltar(retencion, nuevaClave());
      olvidarBorrador(retencion);
      router.replace(`/servicios/horarios/${servicio}` as never);
    });

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (resumen === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  const h = resumen.hold;
  const cambiar = (campo: keyof FormularioDeContratacion) => (valor: string) =>
    setFormulario((ya) => ({ ...ya, [campo]: valor }));

  // Ya reservado (se volvió aquí tras confirmar): a la reserva.
  if (h.status === 'consumed' && h.booking_id) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="check-circle"
          title={f('servicios.reserva.yaReservado')}
          actionLabel={f('servicios.reserva.verReserva')}
          onAction={() => router.replace(`/servicios/reservas/${h.booking_id}` as never)}
        />
      </AppScreen>
    );
  }
  // Vencida o soltada: el horario ya no está apartado. Se vuelve a elegir.
  if (h.status !== 'active' || segundos <= 0) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="clock"
          title={f(h.status === 'released' ? 'servicios.reserva.bloqueo.hold_released' : 'servicios.reserva.vencio')}
          description={f('servicios.reserva.vencioCuerpo')}
          actionLabel={f('servicios.reserva.elegirOtro')}
          onAction={() => router.replace(`/servicios/horarios/${h.service_id}` as never)}
        />
      </AppScreen>
    );
  }

  const l = resumen.limits;
  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <CuentaAtrasDeRetencion
        segundos={segundos}
        hora={h.time}
        fecha={`${f(claveDelDia(diaDeLaSemana(h.date)))} ${fechaVisible(h.date)}`}
      />
      <Text variant="titleMedium">{resumen.service.title ?? f('servicios.catalogo.sinTitulo')}</Text>
      <Text variant="secondary">
        {`${f('servicios.agenda.modalidad')}: ${f(claveDeLaModalidad(h.modality))}`}
      </Text>

      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.reserva.soloLoNecesario')}
      </Text>
      <Input
        label={f('servicios.reserva.nota')}
        placeholder={f('servicios.reserva.notaAyuda')}
        value={formulario.nota}
        onChangeText={cambiar('nota')}
        maxLength={l.note_max_length}
        multiline
      />
      {resumen.requires_address ? (
        <>
          <Text weight="700">{f('servicios.reserva.direccionTitulo')}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.reserva.direccionPrivada')}
          </Text>
          <Input
            label={f('servicios.reserva.distrito')}
            value={formulario.distrito}
            onChangeText={cambiar('distrito')}
            maxLength={l.district_max_length}
          />
          <Input
            label={f('servicios.reserva.direccion')}
            value={formulario.direccion}
            onChangeText={cambiar('direccion')}
            maxLength={l.address_max_length}
          />
          <Input
            label={f('servicios.reserva.referencia')}
            value={formulario.referencia}
            onChangeText={cambiar('referencia')}
            maxLength={l.reference_max_length}
          />
        </>
      ) : null}

      <Button
        label={f('servicios.reserva.revisar')}
        icon="arrow-right"
        disabled={ocupado}
        onPress={() => router.push(rutaDeLaContratacion(retencion, 'resumen') as never)}
      />
      <Button
        label={f('servicios.reserva.elegirOtro')}
        variant="ghost"
        loading={ocupado}
        disabled={ocupado}
        onPress={() => soltarYElegirOtro(h.service_id)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
});
