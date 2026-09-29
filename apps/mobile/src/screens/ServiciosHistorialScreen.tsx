import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import {
  claveDelCampo,
  claveDelEstado,
  fechaCorta,
  type EventoVisible,
  type FalloDeCarga,
} from '@/lib/serviciosAdmision';
import { leerFallo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { ApiError } from '@/services/api';

/**
 * El historial VISIBLE de la postulación propia.
 *
 * Dice qué pasó y cuándo, si lo hizo quien postula o Z, y el mensaje que Z
 * dejó. NO DICE QUIÉN de Z actuó ni enseña notas internas: el servidor no las
 * manda en este molde.
 */
export function ServiciosHistorialScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const [eventos, setEventos] = useState<EventoVisible[] | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [ninguna, setNinguna] = useState(false);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setEventos(await ServiceProviderRepository.historial());
      setNinguna(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'service_application_not_found') setNinguna(true);
      else setFallo(leerFallo(error));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));
  const titulo = f('servicios.historial.titulo');

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : ninguna ? (
        <StateView state="empty" icon="clock" title={f('servicios.historial.vacio')} />
      ) : eventos === null ? (
        <StateView state="loading" />
      ) : eventos.length === 0 ? (
        <StateView state="empty" icon="clock" title={f('servicios.historial.vacio')} />
      ) : (
        [...eventos].reverse().map((e, i) => (
          <View
            key={`${e.created_at ?? ''}-${i}`}
            style={[styles.evento, { borderColor: colors.border }]}
            accessible
          >
            <Text weight="600">{f(claveDelEstado(e.to_status))}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {`${f(e.by === 'you' ? 'servicios.historial.porTi' : 'servicios.historial.porZ')} · ${fechaCorta(e.created_at)}`}
            </Text>
            {e.visible_note ? <Text variant="secondary">{e.visible_note}</Text> : null}
            {e.fields.length > 0 ? (
              <Text variant="secondary">
                {f('servicios.prestador.camposPorCorregir', {
                  campos: e.fields.map((c) => f(claveDelCampo(c))).join(', '),
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
