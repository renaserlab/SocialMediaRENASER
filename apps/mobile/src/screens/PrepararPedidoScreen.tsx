import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  avanceDeLaPreparacion,
  claveDeErrorDeEnvios,
  claveDelEstadoDeEnvio,
  esEnvioApagado,
  faltanDeLaLinea,
  hayDatosDeTransporte,
  iconoDelEstadoDeEnvio,
  lineaCompleta,
  ofrece,
  sePuedeCerrar,
  sePuedeContarLaCaja,
  yaSalio,
  type LineaPreparada,
  type PedidoDelProveedor,
} from '@/lib/envios';
import { claveDeErrorDeInventario } from '@/lib/inventario';
import { esPedidoApagado } from '@/lib/pedidos';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
} from '@/lib/productos';
import { ProductShipmentRepository } from '@/repositories/ProductShipmentRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Preparar y despachar un pedido pagado.
 *
 * ES LA ÚNICA PANTALLA DE PRODUCTOS DONDE SALEN UNIDADES DEL ALMACÉN, y por eso
 * el botón de despachar pide confirmación y dice lo que va a pasar antes de
 * hacerlo. Ni cobrar ni entregar tocan el inventario: al cobrar las unidades
 * siguen en la caja, y al entregar salieron hace rato.
 *
 * QUÉ ESTADOS SE PINTAN, Y NINGUNO SE DEDUCE. Qué salto es legal lo dice el
 * servidor en `available_transitions`; aquí solo se pintan los botones que esa
 * lista ofrece. Si esta pantalla decidiera, bastaría una versión vieja
 * instalada en un teléfono para intentar despachar algo dos veces.
 *
 * LO QUE ESTA PANTALLA NO ENSEÑA, Y ES DELIBERADO:
 *
 *   * NINGUNA FECHA PREVISTA DE LLEGADA. No hay plazos de transporte fijados.
 *   * NINGÚN COSTE DE ENVÍO NI IMPUESTO. Siguen sin decidirse, y un cero es una
 *     promesa de envío gratis.
 *   * NINGÚN TRANSPORTISTA POR DEFECTO. Los dos campos son opcionales y vacíos
 *     se guardan como «no lo dijeron», nunca como «N/A».
 *   * NINGÚN ENLACE DE SEGUIMIENTO. Construirlo exige saber el transportista.
 *   * NINGÚN DATO DE QUIEN COMPRÓ más allá de a dónde va el paquete.
 *
 * LOS ERRORES VAN EN LA PROPIA PANTALLA, no en un diálogo. Hay formularios
 * delante —transportista, referencia, motivo— y un `notify()` encima de ellos
 * en iOS no se ve: los Modales no se apilan. Lo que sí es un diálogo es la
 * confirmación del despacho, porque ahí no hay hoja abierta y lo que se va a
 * hacer no se deshace.
 */
export function PrepararPedidoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const params = useLocalSearchParams<{ orderId?: string }>();
  const orderId = typeof params.orderId === 'string' ? params.orderId : '';

  const [pedido, setPedido] = useState<PedidoDelProveedor | null>(null);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transportista, setTransportista] = useState('');
  const [referencia, setReferencia] = useState('');
  const [motivo, setMotivo] = useState('');
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
      setPedido(await ProductShipmentRepository.leer(orderId));
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && (esPedidoApagado(e.code) || esEnvioApagado(e.code)))
        setFallo('noDisponible');
      else if (e instanceof ApiError && e.status === 404) setFallo('noEncontrado');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [orderId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (e: unknown) => {
    if (e instanceof ApiError) {
      const deEnvios = claveDeErrorDeEnvios(e.code);
      if (deEnvios !== null) return f(deEnvios);
      //: Y LOS DEL ALMACEN. Despachar es lo unico de esta pantalla que llama a
      //: `inventory`, asi que hereda sus codigos —no alcanza, sin cargar,
      //: clave reutilizada, variante desconocida— y ninguno es de `envios.py`.
      //: Sin esto, quien vende leia el mensaje crudo del servidor, en
      //: castellano, fuera cual fuera su idioma. Lo encontro la revision
      //: independiente.
      const delAlmacen = claveDeErrorDeInventario(e.code);
      if (delAlmacen !== null) return f(delAlmacen);
      const deProductos = claveDeErrorDeProductos(e.code);
      if (deProductos !== null) return f(deProductos);
      const porEstado = claveDeErrorPorEstado(e.status);
      if (porEstado !== null) return f(porEstado);
    }
    return e instanceof Error && e.message.trim() !== '' ? e.message : t('common.tryAgain');
  };

  /**
   * Manda una operación y se queda con lo que devuelve.
   *
   * EL DOBLE TOQUE ESTÁ BLOQUEADO con una referencia y no con el estado: un
   * `setState` no se ve hasta el siguiente render, y en ese hueco cabe el
   * segundo toque. Aquí el segundo toque sacaría unidades del almacén.
   */
  const mandar = async (
    operacion: () => Promise<PedidoDelProveedor>,
    despues?: () => void,
  ) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    setError(null);
    try {
      setPedido(await operacion());
      despues?.();
    } catch (e) {
      setError(textoDelError(e));
      //: SE RECARGA TRAS EL FALLO. Un conflicto significa que el servidor sabe
      //: algo que esta pantalla no: puede que otro dispositivo ya lo despachara.
      if (e instanceof ApiError && e.status === 409) void cargar();
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const cambiarPreparado = (linea: LineaPreparada, paso: number) => {
    const valor = Math.min(
      linea.ordered_quantity,
      Math.max(0, linea.prepared_quantity + paso),
    );
    if (valor === linea.prepared_quantity) return;
    void mandar(() =>
      ProductShipmentRepository.preparar(orderId, [
        { order_item_id: linea.order_item_id, prepared_quantity: valor },
      ]),
    );
  };

  const cerrar = () => void mandar(() => ProductShipmentRepository.cerrar(orderId));

  /** Saca el paquete del almacén. SE PREGUNTA ANTES, y se dice qué implica. */
  const despachar = async () => {
    if (ocupadoRef.current) return;
    const seguro = await confirm({
      title: f('envio.preparar.confirmarDespacho'),
      message: f('envio.preparar.confirmarDespachoCuerpo'),
      confirmLabel: f('envio.preparar.despachar'),
      cancelLabel: t('common.cancel'),
    });
    if (!seguro) return;
    await mandar(
      () =>
        ProductShipmentRepository.despachar(orderId, {
          carrier_name: transportista.trim() === '' ? null : transportista.trim(),
          tracking_reference: referencia.trim() === '' ? null : referencia.trim(),
        }),
      () => {
        setTransportista('');
        setReferencia('');
      },
    );
  };

  /** Los saltos que llevan motivo. El motivo no se rellena con nada. */
  const conMotivo = async (
    operacion: (razon: string) => Promise<PedidoDelProveedor>,
  ) => {
    const razon = motivo.trim();
    if (razon.length < 3) {
      setError(f('envio.error.motivo'));
      return;
    }
    await mandar(operacion.bind(null, razon), () => setMotivo(''));
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/proveedor/pedidos' as never);

  const encabezado = (
    <AppHeader title={f('envio.preparar.titulo')} onBack={volver} />
  );

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
            title={f('envio.error.noDisponible')}
            description={f('envio.falta.migration_0079')}
          />
        ) : fallo === 'noEncontrado' ? (
          /* 404 TAMBIÉN PARA EL AJENO Y PARA EL NO PAGADO. La pantalla no
             distingue los dos casos porque el servidor tampoco: distinguirlos
             contaría que ese pedido existe. */
          <StateView
            state="empty"
            icon="package"
            title={f('envio.error.noEncontrado')}
            description={f('envio.proveedor.noEncontradoCuerpo')}
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

  const envio = pedido.shipment;
  const estado = envio?.status ?? 'PENDING';
  const icono = iconoDelEstadoDeEnvio(estado);
  const avance = avanceDeLaPreparacion(envio);
  const salio = yaSalio(envio);
  const direccion = pedido.address;

  /** Un botón redondo del control de cantidad. Área táctil de 44×44. */
  const paso = (
    icono: 'plus' | 'minus',
    activo: boolean,
    etiqueta: string,
    alPulsar: () => void,
  ) => (
    <Pressable
      onPress={alPulsar}
      disabled={!activo || ocupado}
      accessibilityRole="button"
      accessibilityLabel={etiqueta}
      accessibilityState={{ disabled: !activo || ocupado }}
      style={({ pressed }) => [
        styles.paso,
        {
          borderColor: colors.border,
          opacity: !activo || ocupado ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <Feather
        name={icono}
        size={16}
        color={!activo || ocupado ? colors.disabled : colors.text}
      />
    </Pressable>
  );

  return (
    <AppScreen scroll={false}>
      {encabezado}
      <ScrollView
        contentContainerStyle={styles.contenido}
        showsVerticalScrollIndicator={false}
      >
        {/* El estado, con icono y con texto. */}
        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <View style={styles.fila}>
            {icono !== null ? (
              <Feather name={icono as never} size={18} color={colors.text} />
            ) : null}
            <Text variant="titleMedium" style={styles.crece}>
              {f(claveDelEstadoDeEnvio(estado))}
            </Text>
          </View>
          {avance.total > 0 ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('envio.proveedor.avance', {
                hechas: avance.hechas,
                total: avance.total,
              })}
            </Text>
          ) : null}
          {envio?.failure_reason != null ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('envio.detalle.motivoDelFallo', { motivo: envio.failure_reason })}
            </Text>
          ) : null}
        </View>

        {error !== null ? <InlineError message={error} /> : null}

        {/* A dónde va. LA DIRECCIÓN SOLO AQUÍ, y solo de un pedido pagado mío. */}
        {direccion !== null ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {f('envio.preparar.aDonde')}
            </Text>
            <Text variant="secondary">{direccion.recipient_name}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {[
                direccion.address_line,
                direccion.district,
                direccion.city,
                direccion.region,
                direccion.country_code,
              ]
                .filter((p) => typeof p === 'string' && p.trim() !== '')
                .join(', ')}
            </Text>
            {direccion.postal_code !== null ? (
              <Text variant="caption" color={colors.textMuted}>
                {direccion.postal_code}
              </Text>
            ) : null}
            <Text variant="caption" color={colors.textMuted}>
              {direccion.phone}
            </Text>
            {direccion.reference !== null ? (
              <Text variant="caption" color={colors.textMuted}>
                {direccion.reference}
              </Text>
            ) : null}
            {direccion.instructions !== null ? (
              <Text variant="caption" color={colors.textMuted}>
                {direccion.instructions}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* La lista de comprobación. */}
        <Text variant="titleMedium">{f('envio.preparar.queLlevar')}</Text>
        {(envio?.items ?? []).map((linea) => {
          const completa = lineaCompleta(linea);
          const faltan = faltanDeLaLinea(linea);
          return (
            <View
              key={linea.order_item_id}
              style={[styles.bloque, { borderColor: colors.border }]}
            >
              <View style={styles.fila}>
                {/* EL ICONO DICE SI ESTÁ COMPLETA, además del número: el color
                    no puede ser el único que informe. */}
                <Feather
                  name={completa ? 'check-square' : 'square'}
                  size={16}
                  color={colors.text}
                />
                <Text variant="secondary" weight="700" style={styles.crece}>
                  {linea.name}
                </Text>
              </View>
              {linea.variant_name !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {linea.variant_name}
                </Text>
              ) : null}
              <Text variant="caption" color={colors.textMuted}>
                {f('envio.preparar.sku', { sku: linea.sku })}
              </Text>
              {!sePuedeContarLaCaja(envio) ? (
                <Text variant="secondary">
                  {f('envio.preparar.contadas', {
                    hechas: linea.prepared_quantity,
                    total: linea.ordered_quantity,
                  })}
                </Text>
              ) : (
                <View style={styles.cantidad}>
                  {paso(
                    'minus',
                    linea.prepared_quantity > 0,
                    f('envio.preparar.quitarUna'),
                    () => cambiarPreparado(linea, -1),
                  )}
                  <Text
                    variant="secondary"
                    accessibilityLabel={f('envio.preparar.contadas', {
                      hechas: linea.prepared_quantity,
                      total: linea.ordered_quantity,
                    })}
                  >
                    {f('envio.preparar.contadas', {
                      hechas: linea.prepared_quantity,
                      total: linea.ordered_quantity,
                    })}
                  </Text>
                  {paso('plus', faltan > 0, f('envio.preparar.meterUna'), () =>
                    cambiarPreparado(linea, 1),
                  )}
                </View>
              )}
            </View>
          );
        })}

        {/* Cerrar el paquete. SOLO SI ESTÁ TODO DENTRO, y se dice qué falta. */}
        {ofrece(envio, 'READY') ? (
          <View style={styles.acciones}>
            {!sePuedeCerrar(envio) ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('envio.preparar.faltaMeter')}
              </Text>
            ) : null}
            <Button
              label={f('envio.preparar.cerrar')}
              onPress={cerrar}
              disabled={ocupado || !sePuedeCerrar(envio)}
              icon="box"
            />
          </View>
        ) : null}

        {/* Despachar. AQUÍ SALEN LAS UNIDADES DEL ALMACÉN. */}
        {ofrece(envio, 'DISPATCHED') && !salio ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {f('envio.preparar.despachoTitulo')}
            </Text>
            {/* LOS DOS CAMPOS SON OPCIONALES, y se dice por qué: mientras la
                empresa no elija transportista, lo honesto es dejar escribir lo
                que se tenga y no inventar nada si no hay nada. */}
            <Text variant="caption" color={colors.textMuted}>
              {f('envio.preparar.sinTransportistaElegido')}
            </Text>
            <Input
              label={f('envio.preparar.transportista')}
              value={transportista}
              onChangeText={setTransportista}
              maxLength={120}
              editable={!ocupado}
            />
            <Input
              label={f('envio.preparar.referencia')}
              value={referencia}
              onChangeText={setReferencia}
              maxLength={120}
              editable={!ocupado}
            />
            <Button
              label={f('envio.preparar.despachar')}
              onPress={() => void despachar()}
              disabled={ocupado}
              icon="truck"
            />
          </View>
        ) : null}

        {/* Lo que se escribió al despachar. NULO SE DICE, no se deja en blanco. */}
        {salio ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {f('envio.detalle.transporte')}
            </Text>
            {hayDatosDeTransporte(envio) ? (
              <>
                {envio?.carrier_name != null ? (
                  <Text variant="secondary">{envio.carrier_name}</Text>
                ) : null}
                {envio?.tracking_reference != null ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('envio.detalle.referencia', {
                      referencia: envio.tracking_reference,
                    })}
                  </Text>
                ) : null}
              </>
            ) : (
              <Text variant="caption" color={colors.textMuted}>
                {f('envio.detalle.sinTransportista')}
              </Text>
            )}
          </View>
        ) : null}

        {/* Los saltos con motivo: reabrir, registrar un fallo y reintentar. */}
        {ofrece(envio, 'PREPARING') && estado === 'READY' ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {f('envio.preparar.reabrirTitulo')}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('envio.preparar.reabrirCuerpo')}
            </Text>
            <Input
              label={f('envio.motivo.etiqueta')}
              value={motivo}
              onChangeText={setMotivo}
              maxLength={500}
              editable={!ocupado}
            />
            <Button
              label={f('envio.preparar.reabrir')}
              onPress={() =>
                void conMotivo((razon) =>
                  ProductShipmentRepository.reabrir(orderId, razon),
                )
              }
              disabled={ocupado}
              variant="secondary"
              icon="corner-up-left"
            />
          </View>
        ) : null}

        {/* SEGUN LO QUE EL SERVIDOR OFRECE, y no segun el estado: desde una
            entrega fallida tambien la acepta, y es el caso de quien la lleva
            en mano al dia siguiente. Condicionarlo a DISPATCHED le obligaba a
            inventarse un reintento para poder marcarla: dos renglones falsos
            en un historial que no se puede reescribir. */}
        {ofrece(envio, 'DELIVERED') ? (
          <View style={styles.acciones}>
            <Button
              label={f('envio.preparar.registrarEntrega')}
              onPress={() =>
                void mandar(() =>
                  ProductShipmentRepository.registrarEntrega(orderId),
                )
              }
              disabled={ocupado}
              icon="check-circle"
            />
            <Text variant="caption" color={colors.textMuted}>
              {f('envio.preparar.entregaNoEsConformidad')}
            </Text>
          </View>
        ) : null}

        {estado === 'DISPATCHED' || estado === 'DELIVERY_FAILED' ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {estado === 'DISPATCHED'
                ? f('envio.preparar.falloTitulo')
                : f('envio.preparar.reintentoTitulo')}
            </Text>
            {/* UNA ENTREGA FALLIDA NO REPONE NADA, y se dice: dónde está esa
                unidad lo decide una persona, no un automatismo. */}
            <Text variant="caption" color={colors.textMuted}>
              {estado === 'DISPATCHED'
                ? f('envio.preparar.falloNoRepone')
                : f('envio.preparar.reintentoCuerpo')}
            </Text>
            <Input
              label={f('envio.motivo.etiqueta')}
              value={motivo}
              onChangeText={setMotivo}
              maxLength={500}
              editable={!ocupado}
            />
            <Button
              label={
                estado === 'DISPATCHED'
                  ? f('envio.preparar.registrarFallo')
                  : f('envio.preparar.reintentar')
              }
              onPress={() =>
                void conMotivo((razon) =>
                  estado === 'DISPATCHED'
                    ? ProductShipmentRepository.registrarFallo(orderId, razon)
                    : ProductShipmentRepository.reintentarEntrega(orderId, razon),
                )
              }
              disabled={ocupado}
              variant="secondary"
              icon={estado === 'DISPATCHED' ? 'alert-triangle' : 'refresh-cw'}
            />
          </View>
        ) : null}

        {/* El historial. SOLO SE AÑADE, y aquí solo se lee. */}
        {(envio?.history.length ?? 0) > 0 ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {f('envio.detalle.historial')}
            </Text>
            {(envio?.history ?? []).map((e, i) => (
              <View key={`${e.created_at}-${i}`} style={styles.renglon}>
                <Text variant="caption">{f(claveDelEstadoDeEnvio(e.to_status))}</Text>
                {e.reason !== null ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {e.reason}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {/* NI IMPUESTOS NI ENVÍO. No son cero: están sin decidir. */}
        <Text variant="caption" color={colors.textMuted}>
          {f('envio.preparar.sinCostes')}
        </Text>
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  bloque: {
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  crece: { flex: 1 },
  cantidad: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  paso: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acciones: { gap: spacing.sm },
  renglon: { gap: 2 },
});
