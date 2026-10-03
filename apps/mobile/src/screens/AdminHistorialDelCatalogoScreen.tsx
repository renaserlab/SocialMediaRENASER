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
  claveDeLaFuncion,
  claveDelCampo,
  claveDelSuceso,
  type EventoAdmin,
  type FalloDelCatalogo,
} from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogAdminRepository } from '@/repositories/ServiceCatalogAdminRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * El historial COMPLETO de un servicio, para Z: cada paso, de qué versión, en
 * calidad de qué se actuó, el motivo visible, la nota interna y los campos
 * señalados. Solo se añade: nada de lo que aquí aparece se puede reescribir.
 */
export function AdminHistorialDelCatalogoScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f } = useTextosDeServicios('catalogo');
  const [eventos, setEventos] = useState<EventoAdmin[] | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setEventos(await ServiceCatalogAdminRepository.historial(id));
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
    router.canGoBack() ? router.back() : router.replace(`/admin/servicios/catalogo/${id}` as never);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.historial.completo')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : eventos === null ? (
        <StateView state="loading" />
      ) : eventos.length === 0 ? (
        <StateView state="empty" icon="clock" title={f('servicios.historial.vacio')} />
      ) : (
        [...eventos].reverse().map((e) => (
          <View key={e.id} style={[styles.evento, { borderColor: colors.border }]} accessible>
            <Text weight="600">
              {`${f(claveDelSuceso(e.action))}${e.version ? ` · ${f('servicios.catalogo.versionN', { n: e.version })}` : ''}`}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {`${f(claveDeLaFuncion(e.actor_role))} · ${fechaCorta(e.created_at)}`}
            </Text>
            {e.note ? <Text variant="secondary">{e.note}</Text> : null}
            {e.internal_note ? (
              <Text variant="secondary" color={colors.textMuted}>
                {f('servicios.admin.notaInternaDice', { nota: e.internal_note })}
              </Text>
            ) : null}
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
