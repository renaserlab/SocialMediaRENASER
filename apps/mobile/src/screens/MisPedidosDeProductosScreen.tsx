import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { CLAVE_SIN_IMPORTE } from '@/lib/carrito';
import {
  claveDelEstado,
  esPedidoApagado,
  iconoDelEstado,
  minutosDeReserva,
  totalDelPedido,
  type ResumenDePedido,
} from '@/lib/pedidos';
import { esFaltaDeSesion } from '@/lib/productos';
import { ProductOrderRepository } from '@/repositories/ProductOrderRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Mis pedidos de productos.
 *
 * EL ESTADO LO DICE EL SERVIDOR, siempre. Esta pantalla no deduce ninguno: ni
 * «pagado» porque haya pasado tiempo, ni «vencido» porque el reloj del teléfono
 * diga que sí. Lo único que se calcula aquí con el reloj local son los minutos
 * que quedan de reserva, y se enseñan como una ayuda, no como una decisión.
 *
 * NO SE MEZCLA CON LOS PEDIDOS DE ENTRADAS. Son otra cosa, tienen otros
 * estados y otro sitio: juntarlos en una lista haría que «pagado» significara
 * dos cosas distintas según la fila.
 */
export function MisPedidosDeProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [pedidos, setPedidos] = useState<ResumenDePedido[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'sinSesion' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setPedidos(await ProductOrderRepository.mios());
    } catch (error) {
      if (error instanceof ApiError && esFaltaDeSesion(error.status)) setFallo('sinSesion');
      else if (error instanceof ApiError && esPedidoApagado(error.code)) setFallo('noDisponible');
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
    router.canGoBack() ? router.back() : router.replace('/productos' as never);

  const encabezado = <AppHeader title={f('pedidoDeProducto.mis.titulo')} onBack={volver} />;

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
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('pedidoDeProducto.error.noDisponible')}
            description={f('pedidoDeProducto.falta.migration_0078')}
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

  if (pedidos.length === 0) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="package"
          title={f('pedidoDeProducto.mis.vacio')}
          description={f('pedidoDeProducto.mis.vacioCuerpo')}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen scroll={false}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.contenido} showsVerticalScrollIndicator={false}>
        <Text variant="caption" color={colors.textMuted}>
          {f('pedidoDeProducto.mis.cuerpo')}
        </Text>

        {pedidos.map((pedido) => {
          const total = totalDelPedido(pedido);
          const icono = iconoDelEstado(pedido.status);
          const quedan = minutosDeReserva(pedido.reserved_until);
          return (
            <Pressable
              key={pedido.id}
              onPress={() => router.push(`/productos/pedidos/${pedido.id}` as never)}
              accessibilityRole="button"
              accessibilityLabel={`${f('pedidoDeProducto.detalle.titulo')} · ${f(
                claveDelEstado(pedido.status),
              )}`}
              style={({ pressed }) => [
                styles.tarjeta,
                { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <View style={styles.fila}>
                {icono !== null ? (
                  <Feather name={icono as never} size={16} color={colors.text} />
                ) : null}
                <Text variant="secondary" weight="700" style={styles.crece}>
                  {f(claveDelEstado(pedido.status))}
                </Text>
                <Text variant="secondary">
                  {total.configurado ? total.texto : f(CLAVE_SIN_IMPORTE)}
                </Text>
              </View>
              {pedido.seller_name !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {pedido.seller_name}
                </Text>
              ) : null}
              <Text variant="caption" color={colors.textMuted}>
                {f('pedidoDeProducto.checkout.unidades', { n: pedido.units })}
              </Text>
              {/* LOS MINUTOS SON UNA AYUDA, NO UNA DECISIÓN: quien vence el
                  pedido es el servidor, no el reloj de este teléfono. */}
              {quedan !== null && quedan > 0 ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('pedidoDeProducto.pagar.reserva', { n: quedan })}
                </Text>
              ) : null}
            </Pressable>
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
