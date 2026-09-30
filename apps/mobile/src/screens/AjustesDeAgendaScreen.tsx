import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { ZONAS_HORARIAS, zonaDelDispositivo } from '@/lib/eventoDelOrganizador';
import { ajustesDesde, peticionDeAjustes, type FormularioDeAjustes } from '@/lib/serviciosAgenda';
import { useAgendaPropia } from '@/hooks/useAgendaDeServicio';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceScheduleRepository } from '@/repositories/ServiceScheduleRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La configuración de la agenda: zona horaria (IANA, ELEGIDA: no se pone la
 * del teléfono sin preguntar), si está activa o en pausa, preparación antes,
 * descanso después y cada cuánto empieza un horario.
 *
 * CAMBIAR LA ZONA NO ES SILENCIOSO: la semana y las excepciones son horas
 * locales y pasan a leerse en la nueva; los bloqueos no se mueven. Se pide
 * confirmación, y el servidor la exige igualmente.
 */
export function AjustesDeAgendaScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f } = useTextosDeServicios('agenda');
  const { agenda, setAgenda, fallo, cargar } = useAgendaPropia(id);
  const { ocupado, correr } = useCerrojo(cargar, 'agenda');
  const [campos, setCampos] = useState<FormularioDeAjustes | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agenda && campos === null) setCampos(ajustesDesde(agenda));
  }, [agenda, campos]);

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(`/servicios/prestador/catalogo/${id}/agenda` as never);
  const titulo = f('servicios.agenda.ajustes');

  if (fallo !== null || agenda === null || campos === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        {fallo !== null ? <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} /> : <StateView state="loading" />}
      </AppScreen>
    );
  }

  const dispositivo = zonaDelDispositivo();
  const zonas = [...new Set([...(agenda.timezone ? [agenda.timezone] : []), ...(dispositivo ? [dispositivo] : []), ...ZONAS_HORARIAS])];
  const editable = agenda.can_edit;

  const guardar = () =>
    void correr(async () => {
      const cambiaZona =
        agenda.configured && agenda.timezone !== campos.zona.trim() && (agenda.rules.length > 0 || agenda.exceptions.length > 0);
      if (cambiaZona) {
        const si = await confirm({
          title: f('servicios.agenda.cambiarZona.titulo'),
          message: f('servicios.agenda.cambiarZona.aviso', { desde: agenda.timezone ?? '', hasta: campos.zona.trim() }),
          confirmLabel: f('servicios.agenda.cambiarZona.confirmar'),
        });
        if (!si) return;
      }
      const { peticion, fallo: problema } = peticionDeAjustes(campos, agenda.limits, cambiaZona);
      setError(problema);
      if (!peticion) return;
      setAgenda(await ServiceScheduleRepository.configurar(id, peticion));
      toast(f('servicios.agenda.guardado'));
      volver();
    });

  const numero = (campo: 'preparacion' | 'descanso' | 'intervalo', etiqueta: string, ayuda: string) => (
    <Input
      label={etiqueta}
      value={campos[campo]}
      onChangeText={(v) => setCampos({ ...campos, [campo]: v.replace(/[^\d]/g, '').slice(0, 4) })}
      keyboardType="number-pad"
      placeholder={ayuda}
      editable={editable}
      disabled={!editable}
      accessibilityHint={ayuda}
    />
  );

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <Text weight="700">{f('servicios.agenda.campo.zona')}</Text>
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.agenda.campo.zonaAyuda')}
      </Text>
      <View style={styles.fichas}>
        {zonas.map((zona) => (
          <Chip
            key={zona}
            label={zona}
            rol="radio"
            selected={campos.zona === zona}
            disabled={!editable || ocupado}
            onPress={() => setCampos({ ...campos, zona })}
          />
        ))}
      </View>

      <Text weight="700">{f('servicios.agenda.campo.estado')}</Text>
      <View style={styles.fichas}>
        {(['active', 'paused'] as const).map((estado) => (
          <Chip
            key={estado}
            label={f(`servicios.agenda.estado.${estado}`)}
            rol="radio"
            selected={campos.estado === estado}
            disabled={!editable || ocupado}
            onPress={() => setCampos({ ...campos, estado })}
          />
        ))}
      </View>

      {numero(
        'preparacion',
        f('servicios.agenda.campo.preparacion'),
        f('servicios.agenda.campo.separacionAyuda', { max: agenda.limits.max_buffer_minutes, paso: agenda.limits.grid_minutes }),
      )}
      {numero(
        'descanso',
        f('servicios.agenda.campo.descanso'),
        f('servicios.agenda.campo.separacionAyuda', { max: agenda.limits.max_buffer_minutes, paso: agenda.limits.grid_minutes }),
      )}
      {numero(
        'intervalo',
        f('servicios.agenda.campo.intervalo'),
        f('servicios.agenda.campo.intervaloAyuda', { paso: agenda.limits.grid_minutes }),
      )}

      {error ? (
        <Text variant="secondary" color={colors.danger} accessibilityLiveRegion="polite">
          {f(error)}
        </Text>
      ) : null}
      {editable ? (
        <Button
          label={f(agenda.configured ? 'servicios.agenda.guardar' : 'servicios.agenda.crear')}
          icon="check"
          loading={ocupado}
          disabled={ocupado}
          onPress={guardar}
        />
      ) : (
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.agenda.soloLectura')}
        </Text>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fichas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
