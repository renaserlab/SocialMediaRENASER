import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  avanceDeLaPreparacion,
  claveDelEstadoDeEnvio,
  esEnvioApagado,
  iconoDelEstadoDeEnvio,
  type PedidoDelProveedor,
} from '@/lib/envios';
import { esPedidoApagado } from '@/lib/pedidos';
import { esFaltaDeSesion } from '@/lib/productos';
import { ProductShipmentRepository } from '@/repositories/ProductShipmentRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Los pedidos pagados de mi tienda, para prepararlos.
 *
 * SOLO LOS PAGADOS, Y SOLO LOS MÍOS. Lo decide el servidor: quien vende no
 * tiene por qué ver quién abandonó un carrito, ni cuántos lo intentaron, ni
 * nada de otro proveedor. Un pedido ajeno es un 404, no un 403.
 *
 * NI EL COBRO NI QUIEN COMPRÓ. En esta lista no hay referencia de pasarela ni
 * identidad de quien compró, porque con eso no se prepara nada. La dirección
 * está en el detalle, donde hay que entrar a propósito.
 *
 * NINGUNA FECHA DE LLEGADA Y NINGÚN «ATRASADO». No hay transportista elegido ni
 * plazo de despacho publicado: lo que se enseña es el estado y lo que llevas
 * metido en la caja, que son hechos.
 *
 * EL ORDEN LO DA EL SERVIDOR, los más nuevos primero. Reordenar aquí por
 * «urgencia» exigiría un criterio de urgencia que nadie ha definido.
 */
export function PedidosDeMiTiendaScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [pedidos, setPedidos] = useState<PedidoDelProveedor[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'sinSesion' | 'sinTienda' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setPedidos(await ProductShipmentRepository.mios());
    } catch (error) {
      if (error instanceof ApiError && esFaltaDeSesion(error.status)) setFallo('sinSesion');
      else if (error instanceof ApiError && error.code === 'product_seller_not_active')
        setFallo('sinTienda');
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
    router.canGoBack() ? router.back() : router.replace('/proveedor/productos' as never);

  const encabezado = (
    <AppHeader title={f('envio.proveedor.titulo')} onBack={volver} />
  );

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
        ) : fallo === 'sinTienda' ? (
          <StateView
            state="empty"
            icon="briefcase"
            title={f('envio.proveedor.sinTienda')}
            description={f('envio.proveedor.sinTiendaCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          /* FUNCIÓN NO CONFIGURADA, y se dice con palabras: falta desplegar la
             migración. No es un error de quien mira. */
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

  if (pedidos.length === 0) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="package"
          title={f('envio.proveedor.vacio')}
          description={f('envio.proveedor.vacioCuerpo')}
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
          {f('envio.proveedor.cuerpo')}
        </Text>

        {pedidos.map((pedido) => {
          const estado = pedido.shipment?.status ?? 'PENDING';
          const icono = iconoDelEstadoDeEnvio(estado);
          const avance = avanceDeLaPreparacion(pedido.shipment);
          return (
            <Pressable
              key={pedido.id}
              onPress={() => router.push(`/proveedor/pedidos/${pedido.id}` as never)}
              accessibilityRole="button"
              accessibilityLabel={`${f('envio.proveedor.pedido')} · ${f(
                claveDelEstadoDeEnvio(estado),
              )} · ${f('envio.proveedor.avance', {
                hechas: avance.hechas,
                total: avance.total,
              })}`}
              style={({ pressed }) => [
                styles.tarjeta,
                { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <View style={styles.fila}>
                {/* EL ICONO ACOMPAÑA AL TEXTO, no lo sustituye: el color no
                    puede ser el único portador de la información. */}
                {icono !== null ? (
                  <Feather name={icono as never} size={16} color={colors.text} />
                ) : null}
                <Text variant="secondary" weight="700" style={styles.crece}>
                  {f(claveDelEstadoDeEnvio(estado))}
                </Text>
              </View>
              <Text variant="caption" color={colors.textMuted}>
                {f('envio.proveedor.unidades', {
                  n: pedido.items.reduce((s, l) => s + l.quantity, 0),
                })}
              </Text>
              {/* CUÁNTO LLEVA METIDO EN LA CAJA. Es lo único que le falta saber
                  a quien empaqueta para decidir si abrirlo ahora o después. */}
              {avance.total > 0 ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('envio.proveedor.avance', {
                    hechas: avance.hechas,
                    total: avance.total,
                  })}
                </Text>
              ) : null}
              {/* LA CIUDAD, NO LA DIRECCIÓN. Para ordenar el trabajo basta; el
                  domicilio completo está en el detalle, donde se entra a
                  propósito y no se lee por encima del hombro. */}
              {pedido.address !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {[pedido.address.city, pedido.address.country_code]
                    .filter((p) => p.trim() !== '')
                    .join(' · ')}
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
