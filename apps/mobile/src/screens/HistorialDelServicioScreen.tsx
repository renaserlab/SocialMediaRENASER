import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { fechaCorta } from '@/lib/serviciosAdmision';
import {
  claveDelCampo,
  claveDelSuceso,
  type EventoVisible,
  type FalloDelCatalogo,
} from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * El historial de un servicio propio: cada paso, de qué versión, con el
 * motivo VISIBLE y los campos señalados. Sin quién de Z actuó ni notas
 * internas: el servidor no los manda. Lo más reciente, arriba.
 */
export function HistorialDelServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f } = useTextosDeServicios('catalogo');
  const [eventos, setEventos] = useState<EventoVisible[] | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setEventos(await ServiceCatalogRepository.historial(id));
    } catch (error) {
      setFallo(leerFalloDelCatalogo(error));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(`/servicios/prestador/catalogo/${id}` as never);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.historial.titulo')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : eventos === null ? (
        <StateView state="loading" />
      ) : eventos.length === 0 ? (
        <StateView state="empty" icon="clock" title={f('servicios.historial.vacio')} />
      ) : (
        [...eventos].reverse().map((e) => (
          <View key={e.id} style={[styles.evento, { borderColor: colors.border }]} accessible>
            <Text weight="600">{f(claveDelSuceso(e.action))}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {`${e.version ? `${f('servicios.catalogo.versionN', { n: e.version })} · ` : ''}${fechaCorta(e.created_at)}`}
            </Text>
            {e.note ? <Text variant="secondary">{e.note}</Text> : null}
            {e.fields.length > 0 ? (
              <Text variant="secondary">
                {f('servicios.catalogo.camposSenalados', {
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
