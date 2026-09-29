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
import { nombreDeLaCategoria, type FalloDelCatalogo, type ServicioPublico } from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La ficha PÚBLICA de un servicio: solo lo publicado, de un prestador activo.
 *
 * Lo que no está publicado (borrador, suspendido, retirado) o no existe es el
 * mismo «no lo encontramos»: la ficha no revela que hubo algo.
 *
 * NO HAY BOTÓN DE CONTRATAR: la reserva y el pago no existen todavía, y un
 * botón que no lleva a ningún sitio promete lo que no hay.
 */
export function FichaDeServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f, idioma } = useTextosDeServicios('catalogo');
  const [ficha, setFicha] = useState<ServicioPublico | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setFicha(await ServiceCatalogRepository.ficha(id));
    } catch (error) {
      setFallo(leerFalloDelCatalogo(error));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.catalogo.ficha.titulo')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : ficha === null ? (
        <StateView state="loading" />
      ) : (
        <>
          <ContenidoDelServicio
            contenido={ficha}
            categoria={nombreDeLaCategoria(ficha.category, idioma)}
            imagenes={ficha.images}
          />
          <Text variant="secondary">
            {f('servicios.catalogo.ficha.ofrece', { nombre: ficha.provider.display_name })}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.catalogo.ficha.publicado', { fecha: fechaCorta(ficha.published_at) })}
          </Text>
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
});
