import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { CLAVE_SIN_IMPORTE } from '@/lib/carrito';
import {
  claveDeErrorDePedidos,
  claveDelEstado,
  direccionEnUnaLinea,
  esPedidoApagado,
  iconoDelEstado,
  minutosDeReserva,
  plazoConfigurado,
  precioUnitario,
  reservaVencida,
  sePuedeCancelar,
  sePuedeDecirCompraProtegida,
  sePuedePagar,
  totalDeLaLinea,
  totalDelPedido,
  type Pedido,
} from '@/lib/pedidos';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
} from '@/lib/productos';
import { ProductOrderRepository } from '@/repositories/ProductOrderRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Un pedido: qué llevas, a dónde va, qué aceptaste y en qué estado está.
 *
 * ES TAMBIÉN LA PANTALLA DE VUELTA DE LA PASARELA, y por eso lo primero que
 * hace siempre es PREGUNTARLE EL ESTADO AL SERVIDOR. El parámetro `estado` de
 * la URL solo sirve para decir «cancelaste el pago» con las palabras adecuadas:
 * NO CONFIRMA DINERO, porque un parámetro en una URL lo escribe cualquiera.
 *
 * EL COBRO OCURRE FUERA. «Ir a pagar» pide una URL alojada a la pasarela y la
 * abre en el navegador del sistema. No hay formulario de tarjeta en Z y no
 * puede haberlo.
 *
 * CANCELAR SOLO ANTES DE PAGAR. Después no: devolver el dinero es otra cosa,
 * tiene sus plazos y todavía no existe. Un botón de cancelar sobre un pedido
 * pagado prometería un reembolso que nadie ha definido.
 *
 * NI TRANSPORTISTA NI SEGUIMIENTO, y se dice con palabras en vez de dejar un
 * hueco: eso llega en una entrega posterior.
 */
export function PedidoDeProductoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const params = useLocalSearchParams<{ orderId?: string; estado?: string }>();
  const orderId = typeof params.orderId === 'string' ? params.orderId : '';
  const vueltaCancelada = params.estado === 'cancelado';

  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'sinSesion' | 'noEncontrado' | null
  >(null);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (orderId === '') {
      setFallo('noEncontrado');
      setCargando(false);
      return;
    }
    setCargando(true);
    setFallo(null);
    try {
      setPedido(await ProductOrderRepository.leer(orderId));
    } catch (error) {
      if (error instanceof ApiError && esFaltaDeSesion(error.status)) setFallo('sinSesion');
      else if (error instanceof ApiError && esPedidoApagado(error.code)) setFallo('noDisponible');
      else if (error instanceof ApiError && error.status === 404) setFallo('noEncontrado');
      else if (error instanceof ApiError && esFalloDeRed(error.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [orderId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const dePedidos = claveDeErrorDePedidos(error.code);
      if (dePedidos !== null) return f(dePedidos);
      const porCodigo = claveDeErrorDeProductos(error.code);
      if (porCodigo !== null) return f(porCodigo);
      const porEstado = claveDeErrorPorEstado(error.status);
      if (porEstado !== null) return f(porEstado);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  /** Pide la URL de la pasarela y la abre FUERA. No marca nada como pagado. */
  const pagar = () => {
    if (ocupadoRef.current || pedido === null) return;
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        const checkout = await ProductOrderRepository.iniciarPago(pedido.id);
        await Linking.openURL(checkout.checkout_url);
        //: Y SE VUELVE A PREGUNTAR AL SERVIDOR. El pedido ya no está como
        //: estaba: abrir el cobro lo deja en «pago en proceso».
        setPedido(await ProductOrderRepository.leer(pedido.id));
      } catch (error) {
        notify(f('carrito.noSePudo'), textoDelError(error));
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    })();
  };

  const cancelar = () => {
    if (ocupadoRef.current || pedido === null) return;
    void (async () => {
      const acepta = await confirm({
        title: f('pedidoDeProducto.accion.cancelar'),
        message: f('pedidoDeProducto.accion.confirmarCancelar'),
        confirmLabel: f('pedidoDeProducto.accion.cancelar'),
        destructive: true,
      });
      if (!acepta || ocupadoRef.current) return;
      ocupadoRef.current = true;
      setOcupado(true);
      try {
        setPedido(await ProductOrderRepository.cancelar(pedido.id));
      } catch (error) {
        notify(f('carrito.noSePudo'), textoDelError(error));
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    })();
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/productos/pedidos' as never);

  const encabezado = <AppHeader title={f('pedidoDeProducto.detalle.titulo')} onBack={volver} />;

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || pedido === null) {
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
        ) : fallo === 'noEncontrado' ? (
          <StateView
            state="empty"
            icon="package"
            title={f('pedidoDeProducto.error.noEncontrado')}
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

  const total = totalDelPedido(pedido);
  const icono = iconoDelEstado(pedido.status);
  const quedan = minutosDeReserva(pedido.reserved_until);
  const vencida = reservaVencida(pedido.reserved_until);

  return (
    <AppScreen scroll={false}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.contenido} showsVerticalScrollIndicator={false}>
        {/* LA VUELTA DEL NAVEGADOR. Dice lo que pasó con el navegador, y a
            continuación el estado REAL, que viene del servidor. */}
        {vueltaCancelada ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {f('pedidoDeProducto.retorno.titulo')}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('pedidoDeProducto.retorno.cancelado')}
            </Text>
          </View>
        ) : null}

        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <View style={styles.fila}>
            {icono !== null ? (
              <Feather name={icono as never} size={18} color={colors.text} />
            ) : null}
            <Text variant="titleMedium" style={styles.crece}>
              {f(claveDelEstado(pedido.status))}
            </Text>
          </View>
          <Text variant="caption" color={colors.textMuted}>
            {f('pedidoDeProducto.pagar.noConfirma')}
          </Text>
          {pedido.status === 'UNDER_REVIEW' ? (
            <Text variant="caption">{f('pedidoDeProducto.detalle.revision')}</Text>
          ) : null}
          {quedan !== null && quedan > 0 ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('pedidoDeProducto.pagar.reserva', { n: quedan })}
            </Text>
          ) : null}
          {vencida && sePuedePagar(pedido) ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('pedidoDeProducto.pagar.reservaVencida')}
            </Text>
          ) : null}
          {pedido.seller_name !== null ? (
            <View style={styles.dato}>
              <Text variant="caption" color={colors.textMuted}>
                {f('pedidoDeProducto.detalle.proveedor')}
              </Text>
              <Text variant="caption">{pedido.seller_name}</Text>
            </View>
          ) : null}
        </View>

        {/* QUÉ LLEVAS. Todo copiado del momento de la compra. */}
        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <Text variant="titleMedium">{f('pedidoDeProducto.detalle.articulos')}</Text>
          {pedido.items.map((linea) => {
            const unitario = precioUnitario(linea, pedido.currency);
            const suyo = totalDeLaLinea(linea, pedido.currency);
            return (
              <View key={linea.id} style={styles.dato}>
                <View style={styles.crece}>
                  <Text variant="secondary">{linea.name}</Text>
                  {linea.variant_name !== null ? (
                    <Text variant="caption" color={colors.textMuted}>
                      {linea.variant_name}
                    </Text>
                  ) : null}
                  <Text variant="caption" color={colors.textMuted}>
                    {`${linea.quantity} × ${unitario.configurado ? unitario.texto : f(CLAVE_SIN_IMPORTE)}`}
                  </Text>
                </View>
                <Text variant="secondary">
                  {suyo.configurado ? suyo.texto : f(CLAVE_SIN_IMPORTE)}
                </Text>
              </View>
            );
          })}
          <View style={styles.dato}>
            <Text variant="secondary" color={colors.textMuted} style={styles.crece}>
              {f('pedidoDeProducto.checkout.total')}
            </Text>
            <Text variant="titleMedium">
              {total.configurado ? total.texto : f(CLAVE_SIN_IMPORTE)}
            </Text>
          </View>
          <Text variant="caption" color={colors.textMuted}>
            {f('pedidoDeProducto.checkout.sinImpuestosNiEnvio')}
          </Text>
        </View>

        {/* A DÓNDE VA. */}
        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <Text variant="titleMedium">{f('pedidoDeProducto.detalle.entrega')}</Text>
          {pedido.address === null ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('pedidoDeProducto.condiciones.pendiente')}
            </Text>
          ) : (
            <>
              <Text variant="secondary">{pedido.address.recipient_name}</Text>
              <Text variant="caption" color={colors.textMuted}>
                {direccionEnUnaLinea(pedido.address)}
              </Text>
              <Text variant="caption" color={colors.textMuted}>
                {pedido.address.phone}
              </Text>
              {pedido.address.reference !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {pedido.address.reference}
                </Text>
              ) : null}
            </>
          )}
          <Text variant="caption" color={colors.textMuted}>
            {f('pedidoDeProducto.detalle.sinTransportista')}
          </Text>
        </View>

        {/* QUÉ ACEPTASTE. La versión y los plazos, congelados con el pedido. */}
        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <Text variant="titleMedium">{f('pedidoDeProducto.detalle.condiciones')}</Text>
          {pedido.policy === null ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('pedidoDeProducto.condiciones.pendiente')}
            </Text>
          ) : (
            <>
              <View style={styles.dato}>
                <Text variant="caption" color={colors.textMuted}>
                  {f('pedidoDeProducto.condiciones.entidad')}
                </Text>
                <Text variant="caption">{pedido.policy.seller_entity}</Text>
              </View>
              <Text variant="caption" color={colors.textMuted}>
                {f('pedidoDeProducto.condiciones.version', { n: pedido.policy.version })}
              </Text>
              <View style={styles.dato}>
                <Text variant="caption" color={colors.textMuted} style={styles.crece}>
                  {f('pedidoDeProducto.condiciones.desistimiento')}
                </Text>
                <Text variant="caption">
                  {plazoConfigurado(pedido.policy.withdrawal_days)
                    ? f('pedidoDeProducto.condiciones.dias', {
                        n: pedido.policy.withdrawal_days as number,
                      })
                    : f('pedidoDeProducto.condiciones.pendiente')}
                </Text>
              </View>
              <Text variant="caption" color={colors.textMuted}>
                {sePuedeDecirCompraProtegida(pedido.policy)
                  ? f('pedidoDeProducto.compraProtegida', {
                      n: pedido.policy.incident_report_hours as number,
                    })
                  : f('pedidoDeProducto.sinCompraProtegida')}
              </Text>
            </>
          )}
        </View>

        {/* EL HISTORIAL. Sin datos personales: se lee para auditar un estado. */}
        {pedido.history.length > 0 ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="titleMedium">{f('pedidoDeProducto.detalle.historial')}</Text>
            {pedido.history.map((evento, indice) => (
              <View key={`${evento.to_status}-${indice}`} style={styles.fila}>
                <Feather name="chevron-right" size={14} color={colors.textMuted} />
                <Text variant="caption" color={colors.textMuted} style={styles.crece}>
                  {f(claveDelEstado(evento.to_status))}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* EL PIE. Pagar solo si se puede pagar; cancelar solo antes de pagar. */}
      {sePuedePagar(pedido) || sePuedeCancelar(pedido) ? (
        <View style={[styles.pie, { borderColor: colors.border }]}>
          {sePuedePagar(pedido) ? (
            <>
              <Text variant="caption" color={colors.textMuted}>
                {f('pedidoDeProducto.pagar.fuera')}
              </Text>
              <Button
                label={ocupado ? f('pedidoDeProducto.pagar.abriendo') : f('pedidoDeProducto.pagar.accion')}
                onPress={pagar}
                disabled={ocupado || vencida}
                loading={ocupado}
                icon="external-link"
              />
            </>
          ) : null}
          {sePuedeCancelar(pedido) ? (
            <Button
              label={ocupado ? f('pedidoDeProducto.accion.cancelando') : f('pedidoDeProducto.accion.cancelar')}
              onPress={cancelar}
              variant="ghost"
              disabled={ocupado}
            />
          ) : null}
        </View>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  bloque: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dato: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, flexWrap: 'wrap' },
  crece: { flex: 1 },
  pie: { gap: spacing.sm, borderTopWidth: 1, padding: spacing.lg },
});
