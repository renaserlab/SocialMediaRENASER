import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { SelectorDeHorarios } from '@/components/SelectorDeHorarios';
import { Text } from '@/components/Text';
import { claveDelMotivo, type Calendario } from '@/lib/serviciosAgenda';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceScheduleRepository } from '@/repositories/ServiceScheduleRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Cómo verá los horarios una persona, calculado por el servidor igual que en
 * la ficha pública, aunque el servicio todavía no sea público. Arriba, por qué
 * el público aún no los ve (si es el caso). Aquí no se elige nada.
 */
export function VistaPreviaDeAgendaScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f } = useTextosDeServicios('agenda');
  const [motivos, setMotivos] = useState<string[]>([]);

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(`/servicios/prestador/catalogo/${id}/agenda` as never);

  const cargarCalendario = useCallback(
    async (desde: string | null, hasta: string | null): Promise<Calendario> => {
      const c = await ServiceScheduleRepository.vistaPrevia(id, desde, hasta);
      setMotivos(c.issues.map(claveDelMotivo).filter((m): m is string => m !== null));
      return c;
    },
    [id],
  );
  const cargarDia = useCallback(
    (fecha: string, cursor: string | null) => ServiceScheduleRepository.vistaPreviaDelDia(id, fecha, cursor),
    [id],
  );

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.agenda.vistaPrevia')} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.agenda.vistaPreviaCuerpo')}
      </Text>
      {motivos.length > 0 ? (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
          <Text weight="700">{f('servicios.agenda.porQueNoSeVe')}</Text>
          {motivos.map((clave) => (
            <Text key={clave} variant="secondary">
              {`• ${f(clave)}`}
            </Text>
          ))}
        </View>
      ) : null}
      <SelectorDeHorarios cargarCalendario={cargarCalendario} cargarDia={cargarDia} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
