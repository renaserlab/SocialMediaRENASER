import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { StateView } from '@/components/StateView';
import { TarjetaDeServicio } from '@/components/TarjetaDeServicio';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { fechaCorta } from '@/lib/serviciosAdmision';
import type { FalloDelCatalogo } from '@/lib/serviciosCatalogo';
import type { Guardado } from '@/lib/serviciosDescubrimiento';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceDiscoveryRepository } from '@/repositories/ServiceDiscoveryRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Los servicios guardados de quien mira, lo más reciente primero.
 *
 * LO QUE YA NO ESTÁ DISPONIBLE (suspendido, retirado, prestador fuera) sigue en
 * la lista, SIN contenido ni enlace: su título, «ya no está disponible» y un
 * botón para quitarlo. Nunca parece contratable.
 *
 * Guardar no reservó nada, y quitar tampoco cancela nada. Nadie más ve esta
 * lista ni cuántas personas guardaron un servicio.
 */
export function ServiciosGuardadosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f, textoDelError } = useTextosDeServicios('descubrimiento');
  const [filas, setFilas] = useState<Guardado[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [masCargando, setMasCargando] = useState(false);
  const [quitando, setQuitando] = useState<string | null>(null);
  const pedido = useRef(0);

  const cargar = useCallback(async () => {
    const este = ++pedido.current;
    setFallo(null);
    try {
      const pagina = await ServiceDiscoveryRepository.guardados(null);
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
      const pagina = await ServiceDiscoveryRepository.guardados(cursor);
      setFilas((actuales) => {
        const vistos = new Set((actuales ?? []).map((g) => g.service_id));
        return [...(actuales ?? []), ...pagina.items.filter((g) => !vistos.has(g.service_id))];
      });
      setCursor(pagina.next_cursor);
    } catch (error) {
      notify(f('servicios.noSePudo'), textoDelError(error));
    } finally {
      setMasCargando(false);
    }
  };

  const quitar = async (id: string) => {
    if (quitando) return;
    setQuitando(id);
    try {
      await ServiceDiscoveryRepository.quitar(id);
      setFilas((actuales) => (actuales ?? []).filter((g) => g.service_id !== id));
    } catch (error) {
      notify(f('servicios.noSePudo'), textoDelError(error));
    } finally {
      setQuitando(null);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.descubrir.guardados.titulo')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : filas === null ? (
        <StateView state="loading" />
      ) : filas.length === 0 ? (
        <StateView
          state="empty"
          icon="bookmark"
          title={f('servicios.descubrir.guardados.vacio')}
          description={f('servicios.descubrir.guardados.vacioCuerpo')}
          actionLabel={f('servicios.descubrir.guardados.explorar')}
          onAction={() => router.replace('/servicios' as never)}
        />
      ) : (
        <>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.descubrir.guardados.privado')}
          </Text>
          {filas.map((g) =>
            g.available && g.service ? (
              <TarjetaDeServicio
                key={g.service_id}
                tarjeta={g.service}
                alAbrir={() => router.push(`/servicios/ficha/${g.service_id}` as never)}
                alGuardar={() => void quitar(g.service_id)}
                guardando={quitando === g.service_id}
              />
            ) : (
              <View key={g.service_id} style={[styles.noDisponible, { borderColor: colors.border }]}>
                <Text weight="700" color={colors.textMuted}>
                  {g.title ?? f('servicios.catalogo.sinTitulo')}
                </Text>
                <Text variant="secondary">{f('servicios.descubrir.guardados.noDisponible')}</Text>
                <Text variant="caption" color={colors.textMuted}>
                  {f('servicios.descubrir.guardados.guardadoEl', { fecha: fechaCorta(g.saved_at) })}
                </Text>
                <Button
                  label={f('servicios.descubrir.quitarDeGuardados')}
                  variant="secondary"
                  loading={quitando === g.service_id}
                  disabled={quitando !== null}
                  onPress={() => void quitar(g.service_id)}
                />
              </View>
            ),
          )}
          {cursor ? (
            <Button
              label={f('servicios.admin.verMas')}
              variant="secondary"
              loading={masCargando}
              disabled={masCargando}
              onPress={() => void verMas()}
            />
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  noDisponible: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
