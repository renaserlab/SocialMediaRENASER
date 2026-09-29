import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { fechaCorta } from '@/lib/serviciosAdmision';
import {
  claveDelEstadoDeLaVersion,
  claveDelEstadoDelServicio,
  estadoDeVersionQueSeEnsena,
  juntar,
  nombreDeLaCategoria,
  type FalloDelCatalogo,
  type ServicioResumen,
} from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * «Mis servicios»: el catálogo propio de un prestador ACTIVO.
 *
 * - Quien todavía no es prestador activo no ve una lista vacía: ve que aún no
 *   puede, y el camino a su postulación (403 `service_provider_not_active`).
 * - Cada fila dice el estado del servicio y, si hay una versión en curso, en
 *   qué punto está. Lo que se puede hacer con cada uno se decide dentro.
 * - PAGINACIÓN POR CURSOR, sin repetir filas.
 */
export function MisServiciosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f, textoDelError, idioma } = useTextosDeServicios('catalogo');
  const [filas, setFilas] = useState<ServicioResumen[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [masCargando, setMasCargando] = useState(false);
  const pedido = useRef(0);

  const cargar = useCallback(async () => {
    const este = ++pedido.current;
    setFallo(null);
    try {
      const pagina = await ServiceCatalogRepository.mios(null);
      if (este !== pedido.current) return;
      setFilas(pagina.items);
      setCursor(pagina.next_cursor);
    } catch (error) {
      if (este === pedido.current) setFallo(leerFalloDelCatalogo(error));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const verMas = async () => {
    if (!cursor || masCargando) return;
    setMasCargando(true);
    try {
      const pagina = await ServiceCatalogRepository.mios(cursor);
      setFilas((actuales) => juntar(actuales ?? [], pagina.items));
      setCursor(pagina.next_cursor);
    } catch (error) {
      notify(f('servicios.noSePudo'), textoDelError(error));
    } finally {
      setMasCargando(false);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));
  const crear = () => router.push('/servicios/prestador/catalogo/nuevo' as never);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.catalogo.misServicios')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : filas === null ? (
        <StateView state="loading" />
      ) : filas.length === 0 ? (
        <StateView
          state="empty"
          icon="briefcase"
          title={f('servicios.catalogo.vacio')}
          description={f('servicios.catalogo.vacioCuerpo')}
          actionLabel={f('servicios.catalogo.crear')}
          onAction={crear}
        />
      ) : (
        <>
          <Text variant="secondary">{f('servicios.catalogo.intro')}</Text>
          <Button label={f('servicios.catalogo.crear')} icon="plus" onPress={crear} />
          <View style={styles.lista}>
            {filas.map((s) => {
              const partes = [f(claveDelEstadoDelServicio(s.status))];
              const deVersion = estadoDeVersionQueSeEnsena(s);
              if (deVersion) partes.push(f(claveDelEstadoDeLaVersion(deVersion)));
              partes.push(nombreDeLaCategoria(s.category, idioma));
              return (
                <ListRow
                  key={s.id}
                  title={s.title ?? f('servicios.catalogo.sinTitulo')}
                  subtitle={`${partes.join(' · ')} · ${fechaCorta(s.updated_at)}`}
                  leftIcon={
                    deVersion === 'changes_requested'
                      ? 'alert-circle'
                      : s.status === 'published'
                        ? 'eye'
                        : s.status === 'suspended'
                          ? 'eye-off'
                          : 'edit-3'
                  }
                  rightIcon="chevron-right"
                  onPress={() => router.push(`/servicios/prestador/catalogo/${s.id}` as never)}
                />
              );
            })}
          </View>
          {cursor ? (
            <Button
              label={f('servicios.admin.verMas')}
              variant="secondary"
              loading={masCargando}
              disabled={masCargando}
              onPress={() => void verMas()}
            />
          ) : null}
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.catalogo.soloCatalogo')}
          </Text>
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  lista: { gap: spacing.xs },
});
