import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { DateField } from '@/components/DateField';
import { hoyANoche } from '@/components/DateField.types';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { TimeField } from '@/components/TimeField';
import { confirm } from '@/lib/confirm';
import { nuevaClave } from '@/lib/serviciosAdmision';
import {
  bloqueoVacio,
  fechaVisible,
  peticionDeBloqueo,
  type Bloqueo,
  type FormularioDeBloqueo,
} from '@/lib/serviciosAgenda';
import { useAgendaPropia } from '@/hooks/useAgendaDeServicio';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceScheduleRepository } from '@/repositories/ServiceScheduleRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Los bloqueos: un intervalo concreto que el prestador aparta (una cita
 * médica, un viaje). Fecha y hora LOCALES de la agenda; el servidor las
 * convierte a un instante que no se mueve si luego cambia la zona.
 *
 * EL MOTIVO ES PRIVADO: solo lo ve el prestador. No sale en la ficha, en los
 * horarios públicos ni en el historial.
 */
export function BloqueosDeAgendaScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f } = useTextosDeServicios('agenda');
  const { agenda, setAgenda, fallo, cargar } = useAgendaPropia(id);
  const { ocupado, correr } = useCerrojo(cargar, 'agenda');
  const [campos, setCampos] = useState<FormularioDeBloqueo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clave = useRef(nuevaClave());

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(`/servicios/prestador/catalogo/${id}/agenda` as never);
  const titulo = f('servicios.agenda.bloqueos');

  if (fallo !== null || agenda === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        {fallo !== null ? <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} /> : <StateView state="loading" />}
      </AppScreen>
    );
  }

  const a = agenda;
  const guardar = () =>
    void correr(async () => {
      if (!campos) return;
      const { peticion, fallo: problema } = peticionDeBloqueo(campos, a.limits);
      setError(problema);
      if (!peticion) return;
      setAgenda(await ServiceScheduleRepository.crearBloqueo(id, peticion, clave.current));
      clave.current = nuevaClave();
      setCampos(null);
    });

  const quitar = (b: Bloqueo) =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.agenda.quitarBloqueo.titulo'),
        message: f('servicios.agenda.quitarBloqueo.aviso'),
        confirmLabel: f('servicios.agenda.quitarBloqueo.confirmar'),
        destructive: true,
      });
      if (!si) return;
      setAgenda(await ServiceScheduleRepository.borrarBloqueo(id, b.id));
    });

  if (!a.configured) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="empty" icon="calendar" title={f('servicios.agenda.sinConfigurar')} />
      </AppScreen>
    );
  }

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.agenda.horasEn', { zona: a.timezone ?? '' })}
      </Text>

      {a.blocks.length === 0 ? (
        <Text variant="secondary">{f('servicios.agenda.sinBloqueos')}</Text>
      ) : (
        a.blocks.map((b) => (
          <ListRow
            key={b.id}
            title={f('servicios.agenda.desdeHasta', {
              desde: `${fechaVisible(b.start_date)} ${b.start_time}`,
              hasta: `${fechaVisible(b.end_date)} ${b.end_time}`,
            })}
            subtitle={b.reason ? f('servicios.agenda.motivoPrivado', { motivo: b.reason }) : f('servicios.agenda.sinMotivo')}
            leftIcon="lock"
            rightIcon={a.can_edit ? 'trash-2' : undefined}
            onPress={a.can_edit ? () => quitar(b) : undefined}
          />
        ))
      )}

      {a.can_edit && campos === null ? (
        <Button
          label={f('servicios.agenda.anadirBloqueo')}
          icon="plus"
          onPress={() => {
            // Cada alta, su clave (ver HorarioSemanalScreen).
            clave.current = nuevaClave();
            setError(null);
            setCampos(bloqueoVacio());
          }}
        />
      ) : null}

      {campos !== null ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <DateField
            label={f('servicios.agenda.campo.desdeFecha')}
            value={campos.desdeFecha}
            onChange={(v) => setCampos({ ...campos, desdeFecha: v, hastaFecha: campos.hastaFecha || v })}
            minDate={hoyANoche()}
          />
          <TimeField
            label={f('servicios.agenda.campo.desdeHora')}
            value={campos.desdeHora}
            onChange={(v) => setCampos({ ...campos, desdeHora: v })}
          />
          <DateField
            label={f('servicios.agenda.campo.hastaFecha')}
            value={campos.hastaFecha}
            onChange={(v) => setCampos({ ...campos, hastaFecha: v })}
            minDate={hoyANoche()}
          />
          <TimeField
            label={f('servicios.agenda.campo.hastaHora')}
            value={campos.hastaHora}
            onChange={(v) => setCampos({ ...campos, hastaHora: v })}
          />
          <Input
            label={f('servicios.agenda.campo.motivo')}
            value={campos.motivo}
            onChangeText={(v) => setCampos({ ...campos, motivo: v })}
            maxLength={a.limits.reason_max_length}
            placeholder={f('servicios.agenda.campo.motivoAyuda')}
          />
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.agenda.motivoSoloTu')}
          </Text>
          {error ? (
            <Text variant="secondary" color={colors.danger} accessibilityLiveRegion="polite">
              {f(error)}
            </Text>
          ) : null}
          <Button label={f('servicios.agenda.guardar')} icon="check" loading={ocupado} disabled={ocupado} onPress={guardar} />
          <Button label={f('servicios.agenda.cancelar')} variant="ghost" disabled={ocupado} onPress={() => setCampos(null)} />
        </View>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
