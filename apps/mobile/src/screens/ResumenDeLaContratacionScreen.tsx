import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { CuentaAtrasDeRetencion } from '@/components/CuentaAtrasDeRetencion';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { huellaCorta, nuevaClave } from '@/lib/serviciosAdmision';
import { claveDelDia, diaDeLaSemana, fechaVisible } from '@/lib/serviciosAgenda';
import { claveDeLaModalidad, duracionLegible, precioLegible } from '@/lib/serviciosCatalogo';
import {
  borradorDe,
  claveDelBloqueo,
  guardarBorrador,
  hayQueVolverAElegir,
  olvidarBorrador,
  peticionDeConfirmacion,
  rutaDeLaContratacion,
  rutaDeLaReserva,
} from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useCuentaAtras, useResumenDeLaContratacion } from '@/hooks/useReservaDeServicios';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Paso 2: EL RESUMEN y la confirmación.
 *
 * Lo que se contrata, con los datos del SERVIDOR (servicio, horario en la zona
 * de la agenda, modalidad, lugar público, duración y precio: sin precio no se
 * inventa uno, y «a consultar» no es gratis), las condiciones de contratación
 * VIGENTES (versión y huella) y las del servicio si las tiene.
 *
 * ANTES DE CONFIRMAR SE VUELVE A PREGUNTAR AL SERVIDOR: si las condiciones
 * cambiaron o algo impide contratar, se enseña lo nuevo y no se manda nada.
 * Con PRECIO, la contratación se PREPARA y se detiene: todavía no se puede
 * pagar en Z, y se dice así, sin fingir un cobro.
 */
export function ResumenDeLaContratacionScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const retencion = useParametroDeRuta('holdId');
  const { f } = useTextosDeServicios('reserva');
  const { resumen, recibidaEn, fallo, cargar } = useResumenDeLaContratacion(retencion);
  const segundos = useCuentaAtras(resumen, recibidaEn);
  const [formulario, setFormulario] = useState(() => borradorDe(retencion));
  // Al volver de «tus datos» o de las condiciones, lo último que se escribió.
  useFocusEffect(
    useCallback(() => {
      setFormulario(borradorDe(retencion));
    }, [retencion]),
  );
  // UNA CLAVE POR PETICIÓN: repetir lo mismo (doble toque, reintento) usa la
  // misma; cambiar la nota o la dirección es otra petición, con otra clave.
  const clave = useRef<{ firma: string; valor: string } | null>(null);
  const claveDe = (peticion: Record<string, unknown>): string => {
    const firma = JSON.stringify(peticion);
    if (clave.current === null || clave.current.firma !== firma) clave.current = { firma, valor: nuevaClave() };
    return clave.current.valor;
  };
  const recargar = useCallback(async () => {
    await cargar();
  }, [cargar]);
  const { ocupado, correr } = useCerrojo(recargar, 'reserva');

  const titulo = f('servicios.reserva.pasoResumen');
  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(rutaDeLaContratacion(retencion) as never);

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

  const r = resumen;
  const h = r.hold;
  const elegirOtro = () => {
    olvidarBorrador(retencion);
    router.replace(`/servicios/horarios/${h.service_id}` as never);
  };
  if (h.status === 'consumed' && h.booking_id) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="check-circle"
          title={f('servicios.reserva.yaReservado')}
          actionLabel={f('servicios.reserva.verReserva')}
          onAction={() => router.replace(rutaDeLaReserva(h.booking_id as string) as never)}
        />
      </AppScreen>
    );
  }
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
          onAction={elegirOtro}
        />
      </AppScreen>
    );
  }

  const cambiarAcepta = (campo: 'acepta' | 'aceptaServicio') => () => {
    const nuevo = { ...formulario, [campo]: !formulario[campo] };
    setFormulario(nuevo);
    guardarBorrador(retencion, nuevo);
  };
  const precio = precioLegible(r.service.price);
  const bloqueos = r.contract.blockers.map(claveDelBloqueo).filter((c): c is string => c !== null);
  const esDePago = r.contract.kind === 'paid';

  const confirmar = () =>
    void correr(async () => {
      // ANTES DE MANDAR NADA, lo último del servidor.
      const fresco = await cargar();
      if (fresco === null) return;
      if (fresco.terms?.sha256 !== r.terms?.sha256 || !fresco.contract.confirmable) {
        notify(f('servicios.noSePudo'), f('servicios.reserva.algoCambio'));
        return;
      }
      const { peticion, fallo: falta } = peticionDeConfirmacion(fresco, formulario);
      if (peticion === null) {
        notify(f('servicios.noSePudo'), f(falta ?? 'common.tryAgain'));
        return;
      }
      try {
        const reserva = await ServiceBookingRepository.confirmar(retencion, peticion, claveDe(peticion));
        olvidarBorrador(retencion);
        router.replace(`${rutaDeLaReserva(reserva.id)}?confirmada=1` as never);
      } catch (error) {
        // Otra persona se adelantó, venció o el servicio cambió: se vuelve a elegir.
        if (error instanceof ApiError && hayQueVolverAElegir(error.code)) {
          await cargar();
        }
        throw error;
      }
    });

  const soltar = () =>
    void correr(async () => {
      await ServiceBookingRepository.soltar(retencion, nuevaClave());
      elegirOtro();
    });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <CuentaAtrasDeRetencion
        segundos={segundos}
        hora={h.time}
        fecha={`${f(claveDelDia(diaDeLaSemana(h.date)))} ${fechaVisible(h.date)}`}
      />

      <View style={[styles.tarjeta, { borderColor: colors.border }]} accessibilityRole="summary">
        <Text variant="titleMedium">{r.service.title ?? f('servicios.catalogo.sinTitulo')}</Text>
        {r.service.provider_name ? <Text variant="secondary">{r.service.provider_name}</Text> : null}
        <Text>
          {f('servicios.reserva.cuando', {
            dia: f(claveDelDia(diaDeLaSemana(h.date))),
            fecha: fechaVisible(h.date),
            hora: h.time,
            fin: h.end_time,
          })}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.agenda.horasEn', { zona: h.timezone })}
        </Text>
        <Text variant="secondary">
          {`${f('servicios.agenda.modalidad')}: ${f(claveDeLaModalidad(h.modality))}`}
        </Text>
        {r.service.location_area ? (
          <Text variant="secondary">{f('servicios.reserva.lugar', { zona: r.service.location_area })}</Text>
        ) : null}
        {r.service.duration_minutes ? (
          <Text variant="secondary">
            {f(duracionLegible(r.service.duration_minutes).clave, duracionLegible(r.service.duration_minutes).params)}
          </Text>
        ) : null}
        <Text weight="700">{f(precio.clave, precio.params)}</Text>
      </View>

      {formulario.nota.trim() || (r.requires_address && formulario.direccion.trim()) ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <Text weight="700">{f('servicios.reserva.tusDatos')}</Text>
          {formulario.nota.trim() ? <Text variant="secondary">{formulario.nota.trim()}</Text> : null}
          {r.requires_address && formulario.direccion.trim() ? (
            <Text variant="secondary">{`${formulario.direccion.trim()} · ${formulario.distrito.trim()}`}</Text>
          ) : null}
        </View>
      ) : null}
      <Button
        label={f('servicios.reserva.editarDatos')}
        variant="ghost"
        onPress={() =>
          router.canGoBack() ? router.back() : router.replace(rutaDeLaContratacion(retencion) as never)
        }
      />

      {bloqueos.length > 0 ? (
        <View style={[styles.tarjeta, { borderColor: colors.danger }]}>
          <Text weight="700">{f('servicios.reserva.porQueNo')}</Text>
          {bloqueos.map((b) => (
            <Text key={b} variant="secondary">{`• ${f(b)}`}</Text>
          ))}
        </View>
      ) : null}

      {r.terms ? (
        <>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.reserva.condicionesVersion', { version: r.terms.version, huella: huellaCorta(r.terms.sha256) })}
          </Text>
          <Button
            label={f('servicios.reserva.leerCondiciones')}
            variant="ghost"
            icon="file-text"
            onPress={() => router.push(rutaDeLaContratacion(retencion, 'condiciones') as never)}
          />
          <Chip
            rol="checkbox"
            label={f('servicios.reserva.aceptoZ')}
            selected={formulario.acepta}
            onPress={cambiarAcepta('acepta')}
          />
          {r.service_conditions ? (
            <Chip
              rol="checkbox"
              label={f('servicios.reserva.aceptoServicio')}
              selected={formulario.aceptaServicio}
              onPress={cambiarAcepta('aceptaServicio')}
            />
          ) : null}
        </>
      ) : null}

      {esDePago ? (
        <StateView
          state="empty"
          icon="credit-card"
          title={f('servicios.reserva.sinPagos')}
          description={f('servicios.reserva.sinPagosCuerpo')}
        />
      ) : null}

      {r.contract.confirmable ? (
        <Button
          label={f('servicios.reserva.confirmar')}
          icon="check"
          loading={ocupado}
          disabled={ocupado || !formulario.acepta || (r.service_conditions !== null && !formulario.aceptaServicio)}
          onPress={confirmar}
        />
      ) : null}
      <Button
        label={f(esDePago ? 'servicios.reserva.soltar' : 'servicios.reserva.elegirOtro')}
        variant="ghost"
        disabled={ocupado}
        onPress={soltar}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
