import React, { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { ContenidoDelServicio } from '@/components/ContenidoDelServicio';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { fechaCorta } from '@/lib/serviciosAdmision';
import { claveDelEstadoDeLaVersion, type FalloDelCatalogo, type Version } from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogAdminRepository } from '@/repositories/ServiceCatalogAdminRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Una versión cualquiera de un servicio (también las superadas y retiradas),
 * para el equipo de Z: sirve para comparar qué se dijo y qué se publicó en
 * cada momento. Solo lee.
 */
export function AdminVersionDelServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const servicioId = useParametroDeRuta('serviceId');
  const versionId = useParametroDeRuta('versionId');
  const { f } = useTextosDeServicios('catalogo');
  const [version, setVersion] = useState<Version | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setVersion(await ServiceCatalogAdminRepository.version(servicioId, versionId));
    } catch (error) {
      setFallo(leerFalloDelCatalogo(error));
    }
  }, [servicioId, versionId]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(`/admin/servicios/catalogo/${servicioId}` as never);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader
        title={version ? f('servicios.catalogo.versionN', { n: version.version }) : f('servicios.catalogo.admin.version')}
        onBack={volver}
      />
      {fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : version === null ? (
        <StateView state="loading" />
      ) : (
        <>
          <Text weight="700">{f(claveDelEstadoDeLaVersion(version.status))}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.catalogo.admin.fechasDeLaVersion', {
              creada: fechaCorta(version.created_at),
              enviada: fechaCorta(version.submitted_at) || '—',
              publicada: fechaCorta(version.published_at) || '—',
            })}
          </Text>
          {version.based_on_version ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.catalogo.admin.salioDe', { n: version.based_on_version })}
            </Text>
          ) : null}
          <ContenidoDelServicio contenido={version} categoria={null} imagenes={version.images} />
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
});
