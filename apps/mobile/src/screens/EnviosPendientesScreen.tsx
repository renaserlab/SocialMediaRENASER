import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  claveDeLaEspera,
  claveDelEstadoDeEnvio,
  esEnvioApagado,
  iconoDelEstadoDeEnvio,
  numeroDeLaEspera,
  type EnvioPendiente,
} from '@/lib/envios';
import { esPedidoApagado } from '@/lib/pedidos';
import { esFaltaDeSesion } from '@/lib/productos';
import { ProductShipmentAdminRepository } from '@/repositories/ProductShipmentRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Los pedidos pagados cuyo paquete todavía no ha llegado.
 *
 * NO DICE «ATRASADO», Y NO ES UN DESCUIDO. Ninguna política publicada fija un
 * plazo de despacho, así que no hay contra qué comparar: llamarle tarde a algo
 * sin plazo es inventarse el plazo, y quien lo lea actuaría sobre un
 * incumplimiento que nadie definió. Lo que se enseña es CUÁNTO TIEMPO HA
 * PASADO, que es un hecho, y quien mira decide.
 *
 * LOS QUE MÁS LLEVAN ESPERANDO, PRIMERO. Lo ordena el servidor.
 *
 * SIN NINGÚN DATO PERSONAL. Ni dirección, ni nombre de quien compró, ni
 * importe: para saber si un paquete está parado hace falta de quién es, en qué
 * estado está y cuánto lleva así. Es lo que permite que esta cola la pueda leer
 * curaduría sin que eso reparta domicilios.
 *
 * Y DESDE AQUÍ NO SE DESPACHA NI SE ENTREGA. Sacar la caja del almacén solo
 * puede afirmarlo quien la saca, y escribir «llegó» sin saberlo es fabricar una
 * entrega. Intervenir un envío parado es otra ruta, siempre con motivo, y lo
 * que permite lo decide el servidor.
 */
export function EnviosPendientesScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [filas, setFilas] = useState<EnvioPendiente[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'sinSesion' | 'sinPermiso' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setFilas(await ProductShipmentAdminRepository.pendientes());
    } catch (error) {
      if (error instanceof ApiError && esFaltaDeSesion(error.status)) setFallo('sinSesion');
      else if (error instanceof ApiError && error.status === 403) setFallo('sinPermiso');
      else if (
        error instanceof ApiError &&
        (esPedidoApagado(error.code) || esEnvioApagado(error.code))
      )
        setFallo('noDisponible');
      else if (error instanceof ApiError && esFalloDeRed(error.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/admin/productos' as never);

  const encabezado = <AppHeader title={f('envio.admin.titulo')} onBack={volver} />;

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        {fallo === 'sinSesion' ? (
          <StateView
            state="empty"
            icon="lock"
            title={f('carrito.error.sinSesion')}
            description={f('carrito.error.sinSesionCuerpo')}
          />
        ) : fallo === 'sinPermiso' ? (
          <StateView
            state="empty"
            icon="lock"
            title={f('envio.admin.sinPermiso')}
            description={f('envio.admin.sinPermisoCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('envio.error.noDisponible')}
            description={f('envio.falta.migration_0079')}
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        )}
      </AppScreen>
    );
  }

  if (filas.length === 0) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="check-circle"
          title={f('envio.admin.vacio')}
          description={f('envio.admin.vacioCuerpo')}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen scroll={false}>
      {encabezado}
      <ScrollView
        contentContainerStyle={styles.contenido}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="caption" color={colors.textMuted}>
          {f('envio.admin.cuerpo')}
        </Text>
        {/* SE DICE QUE NO HAY PLAZO, en vez de dejar que el tiempo transcurrido
            se lea como un incumplimiento. */}
        <Text variant="caption" color={colors.textMuted}>
          {f('envio.admin.sinPlazo')}
        </Text>

        {filas.map((fila) => {
          const icono = iconoDelEstadoDeEnvio(fila.status);
          return (
            <View
              key={fila.order_id}
              style={[styles.tarjeta, { borderColor: colors.border }]}
              accessible
              accessibilityLabel={`${f(claveDelEstadoDeEnvio(fila.status))} · ${f(
                claveDeLaEspera(fila.waiting_hours),
                { n: numeroDeLaEspera(fila.waiting_hours) },
              )}`}
            >
              <View style={styles.fila}>
                {icono !== null ? (
                  <Feather name={icono as never} size={16} color={colors.text} />
                ) : null}
                <Text variant="secondary" weight="700" style={styles.crece}>
                  {f(claveDelEstadoDeEnvio(fila.status))}
                </Text>
                {/* TIEMPO TRANSCURRIDO, NO RETRASO. */}
                <Text variant="caption" color={colors.textMuted}>
                  {f(claveDeLaEspera(fila.waiting_hours), {
                    n: numeroDeLaEspera(fila.waiting_hours),
                  })}
                </Text>
              </View>
              {fila.seller_name !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {fila.seller_name}
                </Text>
              ) : null}
              <Text variant="caption" color={colors.textMuted}>
                {f('envio.proveedor.unidades', { n: fila.units })}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: {
    gap: 2,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 44,
  },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  crece: { flex: 1 },
});
