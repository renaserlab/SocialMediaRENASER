import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
  claveDeErrorDeEnvios,
  claveDelEstadoDeEnvio,
  hayDatosDeTransporte,
  iconoDelEstadoDeEnvio,
  lineaDeTiempo,
  sePuedeConfirmarRecepcion,
  yaLlego,
  yaSalio,
} from '@/lib/envios';
import {
  claveDelEstadoDeIncidencia,
  claveDelMotivo,
  iconoDelEstadoDeIncidencia,
} from '@/lib/incidencias';
import {
  type LineaValorable,
  esResenasApagadas,
  lineasYaValoradas,
  sePuedeOfrecerValorar,
} from '@/lib/resenasDeProductos';
import {
  type DevolucionDeProducto,
  claveDeErrorFinanciero,
  claveDelEstadoDeDevolucion,
  elDineroYaVolvio,
  esFinanzasApagadas,
  importeDeLaDevolucion,
  sePuedeDarConformidad,
  yaDioLaConformidad,
} from '@/lib/finanzasDeProductos';
import { casoVivo } from '@/lib/incidencias';
import { ProductBuyerMoneyRepository } from '@/repositories/ProductFinanceRepository';
import { ProductReviewRepository } from '@/repositories/ProductReviewRepository';
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
 * EL SEGUIMIENTO VIVE AQUI, desde el Incremento 6, y viaja con el pedido para
 * no pintar la ficha sin su estado de envio mientras llega un segundo viaje.
 *
 * LO QUE EL SEGUIMIENTO NO DICE, Y ES LA MITAD DEL TRABAJO: ninguna fecha de
 * llegada —no hay transportista elegido ni plazos acordados—, ningun enlace de
 * seguimiento —construirlo exige saber el transportista— y ningun transportista
 * por defecto: si quien despacho no lo escribio, se dice que no lo indico.
 *
 * Y CONFIRMAR QUE LLEGO NO ES DAR LA CONFORMIDAD. Lo segundo libera el dinero al
 * proveedor y no existe todavia; el texto bajo el boton lo dice sin rodeos, para
 * que nadie confirme creyendo que renuncia a algo o que ha pagado a alguien.
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
  //: EL DINERO QUE HA VUELTO DE ESTE PEDIDO. Lo dice el servidor.
  const [devueltos, setDevueltos] = useState<DevolucionDeProducto[]>([]);
  //: QUE SE PUEDE VALORAR DE ESTE PEDIDO. Lo dice el servidor, no la
  //: pantalla: aqui no se deduce de que el paquete haya llegado.
  const [valorables, setValorables] = useState<LineaValorable[]>([]);
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
      try {
        setDevueltos(
          await ProductBuyerMoneyRepository.devolucionesDelPedido(orderId),
        );
      } catch (error) {
        //: SIN LAS FINANZAS EL PEDIDO SE SIGUE VIENDO. Es un bloque de mas.
        if (!(error instanceof ApiError) || !esFinanzasApagadas(error.code)) {
          setDevueltos([]);
        }
      }
      try {
        setValorables(await ProductReviewRepository.valorables(orderId));
      } catch (error) {
        //: SIN LAS VALORACIONES EL PEDIDO SE SIGUE VIENDO. Es un bloque
        //: de mas, no el pedido: tumbar la pantalla entera porque la
        //: 0081 no este aplicada seria peor que no ensenar el bloque.
        if (!(error instanceof ApiError) || !esResenasApagadas(error.code)) {
          setValorables([]);
        }
      }
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
      const deEnvios = claveDeErrorDeEnvios(error.code);
      if (deEnvios !== null) return f(deEnvios);
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

  const darLaConformidad = () => {
    if (ocupadoRef.current || pedido === null) return;
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        await ProductBuyerMoneyRepository.darLaConformidad(pedido.id);
        setPedido(await ProductOrderRepository.leer(pedido.id));
      } catch (error) {
        notify(
          f('carrito.noSePudo'),
          error instanceof ApiError
            ? f(claveDeErrorFinanciero(error.code))
            : textoDelError(error),
        );
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

  /**
   * Confirmo que recibi mi pedido.
   *
   * NO SE PREGUNTA ANTES, y es deliberado: no es una accion peligrosa ni
   * irreversible para quien la hace —no renuncia a nada, no mueve dinero y no
   * cierra ningun plazo— y un dialogo delante la haria parecer lo contrario.
   */
  const confirmarRecepcion = () => {
    if (ocupadoRef.current || pedido === null) return;
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        setPedido(await ProductOrderRepository.confirmarRecepcion(pedido.id));
      } catch (error) {
        notify(f('envio.detalle.confirmarRecepcion'), textoDelError(error));
        void cargar();
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
        </View>

        {/*
          EL SEGUIMIENTO. Solo cuando hay algo que enviar: un pedido sin pagar,
          vencido o cancelado no tiene envio, y el servidor manda `shipment` en
          nulo. Ensenar «pendiente de preparacion» ahi haria creer que va a
          salir algo.

          NI FECHA PREVISTA, NI ENLACE DE SEGUIMIENTO, NI MAPA. No hay
          transportista elegido: calcular una fecha exige plazos que nadie ha
          fijado, y un enlace construido con un transportista inventado seria un
          enlace roto dentro de un pedido pagado.
        */}
        {pedido.shipment !== null ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="titleMedium">{f('envio.detalle.titulo')}</Text>
            <View style={styles.fila}>
              {iconoDelEstadoDeEnvio(pedido.shipment.status) !== null ? (
                <Feather
                  name={iconoDelEstadoDeEnvio(pedido.shipment.status) as never}
                  size={16}
                  color={colors.text}
                />
              ) : null}
              <Text variant="secondary" weight="700" style={styles.crece}>
                {f(claveDelEstadoDeEnvio(pedido.shipment.status))}
              </Text>
            </View>

            {/* Lo que escribio quien despacho. NULO SE DICE con palabras. */}
            {yaSalio(pedido.shipment) ? (
              hayDatosDeTransporte(pedido.shipment) ? (
                <>
                  {pedido.shipment.carrier_name !== null ? (
                    <Text variant="caption" color={colors.textMuted}>
                      {pedido.shipment.carrier_name}
                    </Text>
                  ) : null}
                  {pedido.shipment.tracking_reference !== null ? (
                    <Text variant="caption" color={colors.textMuted}>
                      {f('envio.detalle.referencia', {
                        referencia: pedido.shipment.tracking_reference,
                      })}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text variant="caption" color={colors.textMuted}>
                  {f('envio.detalle.sinTransportista')}
                </Text>
              )
            ) : (
              <Text variant="caption" color={colors.textMuted}>
                {f('envio.detalle.todaviaEnElAlmacen')}
              </Text>
            )}

            {pedido.shipment.failure_reason !== null ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('envio.detalle.motivoDelFallo', {
                  motivo: pedido.shipment.failure_reason,
                })}
              </Text>
            ) : null}

            {/* QUIEN AFIRMA QUE LLEGO. No es un detalle: si lo dijo quien vende
                y no es verdad, esto es lo que permite darse cuenta. */}
            {yaLlego(pedido.shipment) ? (
              <Text variant="caption" color={colors.textMuted}>
                {pedido.shipment.delivered_source === 'buyer'
                  ? f('envio.detalle.loDijisteTu')
                  : f('envio.detalle.loDijoElProveedor')}
              </Text>
            ) : null}

            {/* NO SE DICE CUANDO LLEGARA. */}
            <Text variant="caption" color={colors.textMuted}>
              {f('envio.detalle.sinFechaPrevista')}
            </Text>
          </View>
        ) : null}

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

        {/*
          LA LINEA DE TIEMPO. El historial del pago y el del envio, mezclados
          SOLO AL PINTAR: en la base siguen separados, y tienen que seguirlo,
          porque escribir un estado de envio no puede perder el del pago.

          SIN DATOS PERSONALES: se lee para entender que paso con el pedido, no
          para recomponer a quien se le mando que.
        */}
        {(() => {
          const pasos = lineaDeTiempo(pedido.history, pedido.shipment);
          if (pasos.length === 0) return null;
          return (
            <View style={[styles.bloque, { borderColor: colors.border }]}>
              <Text variant="titleMedium">
                {f('pedidoDeProducto.detalle.historial')}
              </Text>
              {pasos.map((paso, indice) => (
                <View key={`${paso.origen}-${paso.fecha}-${indice}`} style={styles.fila}>
                  <Feather
                    name={(paso.icono ?? 'chevron-right') as never}
                    size={14}
                    color={colors.textMuted}
                  />
                  <Text variant="caption" color={colors.textMuted} style={styles.crece}>
                    {f(paso.clave)}
                  </Text>
                </View>
              ))}
              {/* EL MOTIVO DE LO QUE SALIO MAL, si lo hubo. */}
              {pasos
                .filter((p) => p.motivo !== null)
                .map((paso, indice) => (
                  <Text
                    key={`motivo-${indice}`}
                    variant="caption"
                    color={colors.textMuted}
                  >
                    {paso.motivo}
                  </Text>
                ))}
            </View>
          );
        })()}

        {/*
          LAS RECLAMACIONES DE ESTE PEDIDO, Y DESDE AQUI SE ABRE UNA.
          Este es el sitio: quien tuvo un problema con un pedido lo busca en el
          pedido, no en una lista aparte. Y el acceso SE ENSENA SIEMPRE una vez
          entregado, tambien cuando no hay ninguna reclamacion: una ruta que
          solo funciona escribiendo la URL no esta terminada.

          ABRIR NO ES APROBAR, y eso se dice entero en la pantalla de reportar,
          que es donde alguien esta a punto de contar lo que le paso.

          NINGUN IMPORTE JUNTO AL BOTON. Un numero ahi se lee como lo que te van
          a devolver, y cuanto se devuelve no lo ha decidido nadie.
        */}
        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <Text variant="titleMedium">{f('incidencia.enElPedido.titulo')}</Text>
          {pedido.incidents.map((caso) => (
            <Pressable
              key={caso.id}
              onPress={() =>
                router.push(`/productos/reclamaciones/${caso.id}` as never)
              }
              accessibilityRole="button"
              accessibilityLabel={f('incidencia.enElPedido.ver')}
              style={styles.fila}
            >
              <Feather
                name={(iconoDelEstadoDeIncidencia(caso.status) ?? 'alert-circle') as never}
                size={14}
                color={colors.textMuted}
              />
              <View style={styles.crece}>
                <Text variant="caption">{f(claveDelMotivo(caso.reason))}</Text>
                <Text variant="caption" color={colors.textMuted}>
                  {f(claveDelEstadoDeIncidencia(caso.status))}
                </Text>
              </View>
              <Feather name="chevron-right" size={14} color={colors.textMuted} />
            </Pressable>
          ))}
          {yaLlego(pedido.shipment) ? (
            <Button
              label={f('incidencia.enElPedido.reportar')}
              variant="secondary"
              icon="alert-circle"
              onPress={() =>
                router.push(`/productos/pedidos/${pedido.id}/reportar` as never)
              }
              disabled={ocupado}
            />
          ) : (
            <Text variant="caption" color={colors.textMuted}>
              {f('incidencia.enElPedido.soloEntregado')}
            </Text>
          )}
        </View>

        {/*
          Y VALORAR LO QUE LLEGO. Este es el sitio por lo mismo que las
          reclamaciones: se valora una COMPRA, y la compra esta aqui.

          SOLO SI QUEDA ALGO POR VALORAR. El servidor dice que lineas se pueden
          valorar y cuales ya lo estan; sin ninguna pendiente el boton llevaria
          a una pantalla vacia, asi que no se ensena y se dice por que.

          NINGUNA PUNTUACION JUNTO AL BOTON: lo que opinaron otras personas de
          este producto se lee en su ficha, no en el pedido de alguien.
        */}
        {yaLlego(pedido.shipment) ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="titleMedium">{f('resenaDeProducto.valorar.titulo')}</Text>
            {sePuedeOfrecerValorar(valorables) ? (
              <>
                <Text variant="caption" color={colors.textMuted}>
                  {f('resenaDeProducto.valorar.explicacion')}
                </Text>
                <Button
                  label={f('resenaDeProducto.valorar.titulo')}
                  variant="secondary"
                  icon="star"
                  onPress={() =>
                    router.push(`/productos/pedidos/${pedido.id}/valorar` as never)
                  }
                  disabled={ocupado}
                />
              </>
            ) : (
              <Text variant="caption" color={colors.textMuted}>
                {f('resenaDeProducto.valorar.nadaQueValorar')}
              </Text>
            )}
            {/*
          LA CONFORMIDAD (Incremento 9). ESTO SI LIBERA EL DINERO, y por eso es
          una accion aparte de confirmar que llego: aquella existe desde el
          Incremento 6 y sigue significando lo mismo.

          NO HACE FALTA DARLA. Si no se dice nada, el dinero se paga solo cuando
          venza el plazo de proteccion, y el texto lo explica: un boton que
          parezca obligatorio empujaria a renunciar al plazo sin querer.

          Y NO SE OFRECE CON UNA RECLAMACION VIVA: quien dice que algo llego mal
          no puede a la vez decir que esta bien. Lo comprueba tambien el
          servidor, que es quien decide.
        */}
        {yaLlego(pedido.shipment) ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="titleMedium">
              {f('finanzaDeProducto.conformidad.titulo')}
            </Text>
            {yaDioLaConformidad(pedido.shipment) ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('finanzaDeProducto.conformidad.dada')}
              </Text>
            ) : sePuedeDarConformidad(
                pedido.shipment,
                casoVivo(pedido.incidents) !== null,
              ) ? (
              <>
                <Text variant="caption" color={colors.textMuted}>
                  {f('finanzaDeProducto.conformidad.cuerpo')}
                </Text>
                <Text variant="caption" color={colors.textMuted}>
                  {f('finanzaDeProducto.conformidad.noEsLoMismo')}
                </Text>
                <Button
                  label={f('finanzaDeProducto.conformidad.boton')}
                  variant="secondary"
                  icon="check-circle"
                  onPress={darLaConformidad}
                  disabled={ocupado}
                />
              </>
            ) : (
              <Text variant="caption" color={colors.textMuted}>
                {f('finanzaDeProducto.error.product_shipment_incident_open')}
              </Text>
            )}
          </View>
        ) : null}

        {/* Y EL DINERO QUE HA VUELTO, si ha vuelto alguno. SOLO `confirmed`
            dice que salio: un «aprobada» es una decision, no un cobro. */}
        {devueltos.length > 0 ? (
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="titleMedium">
              {f('finanzaDeProducto.devueltoDeEstePedido')}
            </Text>
            {devueltos.map((d) => (
              <View key={d.id} style={styles.fila}>
                <Feather
                  name={elDineroYaVolvio(d) ? 'check-circle' : 'clock'}
                  size={14}
                  color={colors.textMuted}
                />
                <View style={styles.crece}>
                  <Text variant="caption">
                    {f(claveDelEstadoDeDevolucion(d.status))}
                  </Text>
                  {importeDeLaDevolucion(d) !== null ? (
                    <Text variant="caption" color={colors.textMuted}>
                      {importeDeLaDevolucion(d)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* 44 DE ALTO Y HOLGURA EN CADA FILA. styles.fila no lo traia, y
               una fila de dos textos pequenos se queda por debajo del area
               tactil minima. Lo senalo la revision independiente. */}
            {lineasYaValoradas(valorables).map((linea) => (
              <Pressable
                key={linea.order_item_id}
                onPress={() =>
                  router.push(`/productos/resenas/${linea.review_id}` as never)
                }
                accessibilityRole="button"
                accessibilityLabel={f('resenaDeProducto.valorar.verLaMia')}
                hitSlop={8}
                style={[styles.fila, styles.filaTocable]}
              >
                <Feather name="star" size={14} color={colors.textMuted} />
                <View style={styles.crece}>
                  <Text variant="caption">{linea.name}</Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {f('resenaDeProducto.valorar.yaValorada')}
                  </Text>
                </View>
                <Feather name="chevron-right" size={14} color={colors.textMuted} />
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/*
        EL PIE. Pagar solo si se puede pagar; cancelar solo antes de pagar; y
        confirmar la recepcion solo sobre algo que ya salio y que esta persona
        no ha confirmado todavia.
      */}
      {sePuedePagar(pedido) ||
      sePuedeCancelar(pedido) ||
      sePuedeConfirmarRecepcion(pedido.shipment) ? (
        <View style={[styles.pie, { borderColor: colors.border }]}>
          {/*
            CONFIRMAR QUE LLEGO NO ES DAR LA CONFORMIDAD, y el texto de debajo
            lo dice sin rodeos. Lo segundo libera el dinero al proveedor y no
            existe: no hay transferencias, ni comision, ni plazo aprobado. Si
            esta pantalla lo insinuara, alguien confirmaria creyendo que renuncia
            a algo, o creyendo que ha pagado a alguien.
          */}
          {sePuedeConfirmarRecepcion(pedido.shipment) ? (
            <>
              <Button
                label={f('envio.detalle.confirmarRecepcion')}
                onPress={confirmarRecepcion}
                disabled={ocupado}
                loading={ocupado}
                icon="check-circle"
              />
              <Text variant="caption" color={colors.textMuted}>
                {f('envio.detalle.confirmarNoEsConformidad')}
              </Text>
            </>
          ) : null}
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
  //: 44 de alto: el area tactil minima.
  filaTocable: { minHeight: 44, alignItems: 'center' },
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
