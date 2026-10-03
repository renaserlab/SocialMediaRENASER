import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
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
  DIAS,
  claveDelDia,
  franja,
  peticionDeRegla,
  reglaDesde,
  reglaVacia,
  reglasPorDia,
  type FormularioDeRegla,
  type Regla,
} from '@/lib/serviciosAgenda';
import { useAgendaPropia } from '@/hooks/useAgendaDeServicio';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceScheduleRepository } from '@/repositories/ServiceScheduleRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La semana: en qué franjas de cada día se ofrece el servicio, en qué
 * modalidad y para cuántas personas.
 *
 * LOS CRUCES LOS RECHAZA EL SERVIDOR (la base, en realidad): aquí solo se dice
 * antes lo evidente (el inicio va antes del fin, de cinco en cinco, una
 * modalidad que el servicio ofrece). Una regla se puede desactivar sin
 * borrarla.
 */
export function HorarioSemanalScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f } = useTextosDeServicios('agenda');
  const { agenda, setAgenda, fallo, cargar } = useAgendaPropia(id);
  const { ocupado, correr } = useCerrojo(cargar, 'agenda');
  const [editando, setEditando] = useState<Regla | 'nueva' | null>(null);
  const [campos, setCampos] = useState<FormularioDeRegla | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clave = useRef(nuevaClave());

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(`/servicios/prestador/catalogo/${id}/agenda` as never);
  const titulo = f('servicios.agenda.semanal');

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
  const abrir = (regla: Regla | null) => {
    // Cada alta, su clave: la de un intento anterior (que quizá se guardó sin
    // que llegara la respuesta) no puede servir para otro contenido.
    clave.current = nuevaClave();
    setError(null);
    setEditando(regla ?? 'nueva');
    setCampos(regla ? reglaDesde(regla) : reglaVacia(ofrecidas[0] ?? null));
  };
  const cerrar = () => {
    setEditando(null);
    setCampos(null);
    setError(null);
  };

  const guardar = () =>
    void correr(async () => {
      if (!campos) return;
      const { peticion, fallo: problema } = peticionDeRegla(campos, a.limits, ofrecidas, a.service.capacity);
      setError(problema);
      if (!peticion) return;
      if (editando === 'nueva') {
        setAgenda(await ServiceScheduleRepository.crearRegla(id, peticion, clave.current));
        clave.current = nuevaClave();
      } else if (editando) {
        setAgenda(await ServiceScheduleRepository.editarRegla(id, editando.id, peticion));
      }
      cerrar();
    });

  const alternar = (regla: Regla) =>
    void correr(async () => {
      setAgenda(await ServiceScheduleRepository.editarRegla(id, regla.id, { active: !regla.active }));
      cerrar();
    });

  const quitar = (regla: Regla) =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.agenda.quitarFranja.titulo'),
        message: f('servicios.agenda.quitarFranja.aviso'),
        confirmLabel: f('servicios.agenda.quitarFranja.confirmar'),
        destructive: true,
      });
      if (!si) return;
      setAgenda(await ServiceScheduleRepository.borrarRegla(id, regla.id));
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

  const grupos = reglasPorDia(a.rules);

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.agenda.horasEn', { zona: a.timezone ?? '' })}
      </Text>

      {grupos.length === 0 ? (
        <Text variant="secondary">{f('servicios.agenda.sinFranjas')}</Text>
      ) : (
        grupos.map(([dia, reglas]) => (
          <View key={dia} style={styles.seccion}>
            <Text weight="700" accessibilityRole="header">
              {f(claveDelDia(dia))}
            </Text>
            {reglas.map((r) => (
              <ListRow
                key={r.id}
                title={franja(r.start, r.end)}
                subtitle={`${f(claveDeLaModalidad(r.modality))} · ${f('servicios.agenda.personas', { n: r.capacity })}${
                  r.active ? '' : ` · ${f('servicios.agenda.inactiva')}`
                }`}
                leftIcon={r.active ? 'clock' : 'pause'}
                rightIcon={a.can_edit ? 'edit-3' : undefined}
                onPress={a.can_edit ? () => abrir(r) : undefined}
              />
            ))}
          </View>
        ))
      )}

      {a.can_edit && editando === null ? (
        <Button label={f('servicios.agenda.anadirFranja')} icon="plus" onPress={() => abrir(null)} />
      ) : null}

      {editando !== null && campos !== null ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <Text weight="700">
            {f(editando === 'nueva' ? 'servicios.agenda.anadirFranja' : 'servicios.agenda.editarFranja')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.agenda.campo.dia')}
          </Text>
          <View style={styles.fichas}>
            {DIAS.map((d) => (
              <Chip
                key={d}
                label={f(claveDelDia(d))}
                rol="radio"
                selected={campos.dia === d}
                disabled={ocupado}
                onPress={() => setCampos({ ...campos, dia: d })}
              />
            ))}
          </View>
          <TimeField label={f('servicios.agenda.campo.inicio')} value={campos.inicio} onChange={(v) => setCampos({ ...campos, inicio: v })} />
          <TimeField label={f('servicios.agenda.campo.fin')} value={campos.fin} onChange={(v) => setCampos({ ...campos, fin: v })} />
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.agenda.campo.modalidad')}
          </Text>
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
          ) : (
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.agenda.individual')}
            </Text>
          )}
          {error ? (
            <Text variant="secondary" color={colors.danger} accessibilityLiveRegion="polite">
              {f(error)}
            </Text>
          ) : null}
          <Button label={f('servicios.agenda.guardar')} icon="check" loading={ocupado} disabled={ocupado} onPress={guardar} />
          {editando !== 'nueva' ? (
            <>
              <Button
                label={f(editando.active ? 'servicios.agenda.desactivar' : 'servicios.agenda.activar')}
                variant="secondary"
                icon={editando.active ? 'pause' : 'play'}
                disabled={ocupado}
                onPress={() => alternar(editando)}
              />
              <Button
                label={f('servicios.agenda.quitarFranja.titulo')}
                variant="ghost"
                icon="trash-2"
                disabled={ocupado}
                onPress={() => quitar(editando)}
              />
            </>
          ) : null}
          <Button label={f('servicios.agenda.cancelar')} variant="ghost" disabled={ocupado} onPress={cerrar} />
        </View>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  seccion: { gap: spacing.xs },
  fichas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
