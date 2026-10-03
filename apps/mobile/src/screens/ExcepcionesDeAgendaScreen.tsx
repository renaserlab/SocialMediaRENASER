import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
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
import { claveDeLaModalidad } from '@/lib/serviciosCatalogo';
import {
  TIPOS_DE_EXCEPCION,
  claveDelDia,
  claveDelTipo,
  diaDeLaSemana,
  excepcionDesde,
  excepcionVacia,
  fechaVisible,
  franja,
  peticionDeExcepcion,
  type Excepcion,
  type FormularioDeExcepcion,
} from '@/lib/serviciosAgenda';
import { useAgendaPropia } from '@/hooks/useAgendaDeServicio';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceScheduleRepository } from '@/repositories/ServiceScheduleRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Las excepciones de una fecha concreta: cerrar el día entero (un feriado),
 * cerrar una franja, añadir una franja extraordinaria o sustituir la semana
 * ese día.
 *
 * LA PRECEDENCIA ES LA DEL SERVIDOR, y se explica aquí con palabras: lo que
 * cierra gana siempre; sustituir deja fuera la semana; añadir solo suma lo
 * que el día no tenía. Dos excepciones que se pisan en la misma fecha no se
 * aceptan: el servidor contesta que se cruzan.
 */
export function ExcepcionesDeAgendaScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f } = useTextosDeServicios('agenda');
  const { agenda, setAgenda, fallo, cargar } = useAgendaPropia(id);
  const { ocupado, correr } = useCerrojo(cargar, 'agenda');
  const [editando, setEditando] = useState<Excepcion | 'nueva' | null>(null);
  const [campos, setCampos] = useState<FormularioDeExcepcion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clave = useRef(nuevaClave());

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(`/servicios/prestador/catalogo/${id}/agenda` as never);
  const titulo = f('servicios.agenda.excepciones');

  if (fallo !== null || agenda === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        {fallo !== null ? <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} /> : <StateView state="loading" />}
      </AppScreen>
    );
  }

  const a = agenda;
  const ofrecidas = a.service.offered_modalities;
  const abrir = (e: Excepcion | null) => {
    // Cada alta, su clave (ver HorarioSemanalScreen).
    clave.current = nuevaClave();
    setError(null);
    setEditando(e ?? 'nueva');
    setCampos(e ? excepcionDesde(e) : excepcionVacia(ofrecidas[0] ?? null));
  };
  const cerrar = () => {
    setEditando(null);
    setCampos(null);
    setError(null);
  };

  const guardar = () =>
    void correr(async () => {
      if (!campos) return;
      const { peticion, fallo: problema } = peticionDeExcepcion(campos, a.limits, ofrecidas, a.service.capacity);
      setError(problema);
      if (!peticion) return;
      if (editando === 'nueva') {
        setAgenda(await ServiceScheduleRepository.crearExcepcion(id, peticion, clave.current));
        clave.current = nuevaClave();
      } else if (editando) {
        setAgenda(await ServiceScheduleRepository.editarExcepcion(id, editando.id, peticion));
      }
      cerrar();
    });

  const quitar = (e: Excepcion) =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.agenda.quitarExcepcion.titulo'),
        message: f('servicios.agenda.quitarExcepcion.aviso'),
        confirmLabel: f('servicios.agenda.quitarExcepcion.confirmar'),
        destructive: true,
      });
      if (!si) return;
      setAgenda(await ServiceScheduleRepository.borrarExcepcion(id, e.id));
      cerrar();
    });

  if (!a.configured) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="empty" icon="calendar" title={f('servicios.agenda.sinConfigurar')} />
      </AppScreen>
    );
  }

  const abre = campos !== null && campos.tipo !== 'closed';

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.agenda.precedencia')}
      </Text>

      {a.exceptions.length === 0 ? (
        <Text variant="secondary">{f('servicios.agenda.sinExcepciones')}</Text>
      ) : (
        a.exceptions.map((e) => {
          const diaEntero = e.kind === 'closed' && e.start === null;
          return (
            <ListRow
              key={e.id}
              title={`${f(claveDelDia(diaDeLaSemana(e.date)))} ${fechaVisible(e.date)}`}
              subtitle={[
                f(claveDelTipo(e.kind, diaEntero)),
                franja(e.start, e.end),
                e.modality ? f(claveDeLaModalidad(e.modality)) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              leftIcon={e.kind === 'closed' ? 'x-circle' : 'plus-circle'}
              rightIcon={a.can_edit ? 'edit-3' : undefined}
              onPress={a.can_edit ? () => abrir(e) : undefined}
            />
          );
        })
      )}

      {a.can_edit && editando === null ? (
        <Button label={f('servicios.agenda.anadirExcepcion')} icon="plus" onPress={() => abrir(null)} />
      ) : null}

      {editando !== null && campos !== null ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <DateField
            label={f('servicios.agenda.campo.fecha')}
            value={campos.fecha}
            onChange={(v) => setCampos({ ...campos, fecha: v })}
            minDate={hoyANoche()}
          />
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.agenda.campo.tipo')}
          </Text>
          <View style={styles.fichas}>
            <Chip
              label={f('servicios.agenda.tipo.closedDay')}
              rol="radio"
              selected={campos.tipo === 'closed' && campos.diaEntero}
              disabled={ocupado}
              onPress={() => setCampos({ ...campos, tipo: 'closed', diaEntero: true })}
            />
            {TIPOS_DE_EXCEPCION.map((tipo) => (
              <Chip
                key={tipo}
                label={f(claveDelTipo(tipo))}
                rol="radio"
                selected={campos.tipo === tipo && !(tipo === 'closed' && campos.diaEntero)}
                disabled={ocupado}
                onPress={() => setCampos({ ...campos, tipo, diaEntero: false })}
              />
            ))}
          </View>
          {!(campos.tipo === 'closed' && campos.diaEntero) ? (
            <>
              <TimeField label={f('servicios.agenda.campo.inicio')} value={campos.inicio} onChange={(v) => setCampos({ ...campos, inicio: v })} />
              <TimeField label={f('servicios.agenda.campo.fin')} value={campos.fin} onChange={(v) => setCampos({ ...campos, fin: v })} />
            </>
          ) : null}
          {abre ? (
            <>
              <View style={styles.fichas}>
                {ofrecidas.map((m) => (
                  <Chip
                    key={m}
                    label={f(claveDeLaModalidad(m))}
                    rol="radio"
                    selected={campos.modalidad === m}
                    disabled={ocupado}
                    onPress={() => setCampos({ ...campos, modalidad: m })}
                  />
                ))}
              </View>
              {a.service.capacity > 1 ? (
                <Input
                  label={f('servicios.agenda.campo.capacidad', { max: a.service.capacity })}
                  value={campos.capacidad}
                  onChangeText={(v) => setCampos({ ...campos, capacidad: v.replace(/[^\d]/g, '').slice(0, 4) })}
                  keyboardType="number-pad"
                />
              ) : null}
            </>
          ) : null}
          <Text variant="caption" color={colors.textMuted}>
            {f(`servicios.agenda.tipoAyuda.${campos.tipo === 'closed' && campos.diaEntero ? 'closedDay' : campos.tipo}`)}
          </Text>
          {error ? (
            <Text variant="secondary" color={colors.danger} accessibilityLiveRegion="polite">
              {f(error)}
            </Text>
          ) : null}
          <Button label={f('servicios.agenda.guardar')} icon="check" loading={ocupado} disabled={ocupado} onPress={guardar} />
          {editando !== 'nueva' ? (
            <Button
              label={f('servicios.agenda.quitarExcepcion.titulo')}
              variant="ghost"
              icon="trash-2"
              disabled={ocupado}
              onPress={() => quitar(editando)}
            />
          ) : null}
          <Button label={f('servicios.agenda.cancelar')} variant="ghost" disabled={ocupado} onPress={cerrar} />
        </View>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fichas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
