import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import {
  claveDelCampo,
  claveDelEstado,
  fechaCorta,
  type EventoAdmin,
  type FalloDeCarga,
} from '@/lib/serviciosAdmision';
import { leerFallo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceAdmissionRepository } from '@/repositories/ServiceAdmissionRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * El historial COMPLETO de una postulación, para Z: cada salto con la función
 * con la que se actuó, el mensaje visible, la nota interna y lo que se pidió
 * corregir. Solo se añade: nada de lo que aquí aparece se puede reescribir.
 */
export function AdminServicioHistorialScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { applicationId } = useLocalSearchParams<{ applicationId?: string }>();
  const id = typeof applicationId === 'string' ? applicationId : '';
  const { f } = useTextosDeServicios();
  const [eventos, setEventos] = useState<EventoAdmin[] | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setEventos(await ServiceAdmissionRepository.historial(id));
    } catch (error) {
      setFallo(leerFallo(error));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/admin/servicios' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.historial.completo')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : eventos === null ? (
        <StateView state="loading" />
      ) : eventos.length === 0 ? (
        <StateView state="empty" icon="clock" title={f('servicios.historial.vacio')} />
      ) : (
        [...eventos].reverse().map((e) => (
          <View key={e.id} style={[styles.evento, { borderColor: colors.border }]} accessible>
            <Text weight="600">
              {e.from_status
                ? `${f(claveDelEstado(e.from_status))} → ${f(claveDelEstado(e.to_status))}`
                : f(claveDelEstado(e.to_status))}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {`${f(`servicios.funcion.${['provider', 'reviewer', 'admin', 'system'].includes(e.actor_role) ? e.actor_role : 'system'}`)} · ${fechaCorta(e.created_at)}`}
            </Text>
            {e.visible_note ? <Text variant="secondary">{e.visible_note}</Text> : null}
            {e.internal_note ? (
              <Text variant="secondary" color={colors.textMuted}>
                {f('servicios.admin.notaInternaDice', { nota: e.internal_note })}
              </Text>
            ) : null}
            {e.details?.fields && e.details.fields.length > 0 ? (
              <Text variant="secondary">
                {f('servicios.prestador.camposPorCorregir', {
                  campos: e.details.fields.map((c) => f(claveDelCampo(c))).join(', '),
                })}
              </Text>
            ) : null}
          </View>
        ))
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  evento: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.md },
});
