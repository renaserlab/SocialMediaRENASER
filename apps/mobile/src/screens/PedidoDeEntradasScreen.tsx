import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { importeConMoneda } from '@/lib/dinero';
import { claveDeErrorDeEntradas, comoReloj, esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  claveDelEstadoDePedido,
  cuantasEntradas,
  estaCerrado,
  siguePagable,
} from '@/lib/pedidoDeEntradas';
import { useSeccionActiva } from '@/navigation/foco';
import { EventOrderRepository, type Pedido } from '@/repositories/EventOrderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * El resumen del pedido, y el estado del pago.
 *
 * UNA SOLA PANTALLA PARA LAS DOS COSAS, y no por ahorrar: el estado del pago ES
 * el estado del pedido. Separarlas obligaría a mantener sincronizados dos sitios
 * que cuentan lo mismo, y a decidir a cuál vuelve alguien que cierra el
 * navegador de la pasarela a medias.
 *
 * ESTO NO ES UNA FACTURA NI UNA BOLETA. Es el resumen de un pedido: no hay
 * entidad vendedora decidida, ni impuestos, ni comisión. La pantalla no usa esas
 * palabras y lo dice explícitamente.
 *
 * NO SE CANTA VICTORIA ANTES DE TIEMPO. «Pagado» se escribe cuando el SERVIDOR
 * dice `PAID`, que es cuando ha llegado el aviso verificado de la pasarela.
 * Volver del navegador no es haber pagado.
 */
export function PedidoDeEntradasScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [restantes, setRestantes] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noEncontrado' | 'noDisponible' | null
  >(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(null);
    try {
      const datos = await EventOrderRepository.leerPedido(id);
      setPedido(datos);
      // DEL SERVIDOR, no del reloj local: si el teléfono va adelantado, la
      // cuenta atrás empezaría ya vencida.
      setRestantes(datos.segundos_restantes);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'event_order_not_found') {
        setFallo('noEncontrado');
      } else if (
        error instanceof ApiError &&
        (error.code === 'event_orders_not_available' ||
          error.code === 'event_ticketing_not_available')
      ) {
        setFallo('noDisponible');
      } else if (error instanceof ApiError && esFalloDeRed(error.code)) {
        setFallo('sinConexion');
      } else {
        setFallo('red');
      }
    } finally {
      setCargando(false);
    }
  }, [id]);

  /*
    AL ENTRAR, Y CADA VEZ QUE SE VUELVE A MIRAR ESTA PANTALLA. El cobro ocurre
    en el navegador del sistema: al volver, el pedido ya no está como estaba y
    nadie lo releía, así que seguía diciendo «pendiente de pago» después de
    pagar. `useSeccionActiva` y no solo el foco de navegación: irse al
    navegador y volver no cambia de pantalla, cambia de aplicación.
  */
  const activa = useSeccionActiva();
  useEffect(() => {
    if (activa) void cargar();
  }, [activa, cargar]);

  useEffect(() => {
    if (pedido === null || !siguePagable(pedido.status, restantes)) return;
    const tic = setInterval(() => {
      setRestantes((previos) => Math.max(0, previos - 1));
    }, 1000);
    return () => clearInterval(tic);
  }, [pedido, restantes]);

  const textoDelError = (error: unknown) => {
    const clave =
      error instanceof ApiError ? claveDeErrorDeEntradas(error.code) : null;
    if (clave !== null) return t(clave as TranslationKey);
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const conCerrojo = async (accion: () => Promise<void>) => {
    // ANTES DEL PRIMER `await`, que aquí puede ser un diálogo: dos toques
    // rápidos abrirían dos cobros.
    if (ocupadoRef.current || !id) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await accion();
    } catch (error) {
      notify(t('pedido.noSePudo'), textoDelError(error));
      void cargar();
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const pagar = () =>
    void conCerrojo(async () => {
      const intento = await EventOrderRepository.pagar(id as string);
      // EL NAVEGADOR DEL SISTEMA, no una vista dentro de la aplicación: es lo
      // que las tiendas exigen para un cobro web y lo que ya hace Cursos.
      await Linking.openURL(intento.checkout_url);
      await cargar();
    });

  const cancelar = () =>
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: t('pedido.cancelarTitulo'),
        message: t('pedido.cancelarCuerpo'),
        confirmLabel: t('pedido.cancelar'),
        destructive: true,
      });
      if (!aceptado) return;
      const datos = await EventOrderRepository.cancelar(id as string);
      setPedido(datos);
    });

  const volver = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    const evento = pedido?.event_id;
    router.replace((evento ? `/eventos/${evento}` : '/mis-eventos') as never);
  };

  // A pantalla completa SOLO la primera vez: releer el pedido al volver del
  // pago no puede sustituir el resumen por «Cargando…».
  if (cargando && !pedido) {
    return (
      <AppScreen>
        <AppHeader title={t('pedido.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !pedido) {
    return (
      <AppScreen>
        <AppHeader title={t('pedido.titulo')} onBack={volver} />
        {fallo === 'noEncontrado' || fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            title={
              fallo === 'noEncontrado'
                ? t('pedido.noEncontrado')
                : t('entradas.noDisponible')
            }
            description={
              fallo === 'noEncontrado'
                ? t('pedido.noEncontradoCuerpo')
                : t('entradas.noDisponibleCuerpo')
            }
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

  const pagado = pedido.status === 'PAID';
  const pagable = siguePagable(pedido.status, restantes);
  const cerrado = estaCerrado(pedido.status, restantes);
  const cuantas = cuantasEntradas(pedido.items);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('pedido.titulo')} onBack={volver} />

      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather
          name={pagado ? 'check-circle' : 'clock'}
          size={16}
          color={pagado ? colors.success : colors.textMuted}
        />
        <Text
          variant="secondary"
          color={pagado ? colors.success : colors.textMuted}
          style={styles.crece}
        >
          {t(claveDelEstadoDePedido(pedido.status) as TranslationKey)}
        </Text>
      </View>

      {pagable ? (
        <View style={[styles.cuenta, { borderColor: colors.primary }]}>
          <Text variant="title">{comoReloj(restantes)}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {t('pedido.tiempoRestante')}
          </Text>
        </View>
      ) : null}

      {pedido.items.map((linea) => (
        <View
          key={linea.ticket_type_id}
          style={[styles.linea, { borderColor: colors.border }]}
        >
          <View style={styles.crece}>
            <Text variant="secondary" weight="700">
              {linea.name}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('reserva.porUnidad', {
                n: linea.quantity,
                importe: importeConMoneda(linea.unit_price_minor, pedido.currency),
              })}
            </Text>
          </View>
          <Text variant="secondary" weight="700">
            {importeConMoneda(linea.subtotal_minor, pedido.currency)}
          </Text>
        </View>
      ))}

      <View style={[styles.resumen, { backgroundColor: colors.surfaceAlt }]}>
        <Text variant="secondary" weight="700" style={styles.crece}>
          {t('pedido.total')}
        </Text>
        <Text variant="secondary" weight="700">
          {importeConMoneda(pedido.total_minor, pedido.currency)}
        </Text>
      </View>
      <Text variant="caption" color={colors.textMuted}>
        {t('pedido.noEsUnaFactura')}
      </Text>

      {pagado ? (
        <Button
          label={t('pedido.verMisEntradas', { n: cuantas })}
          onPress={() => router.replace('/mis-entradas' as never)}
        />
      ) : null}

      {pagable ? (
        <>
          <Button
            label={t('pedido.pagar')}
            onPress={pagar}
            loading={ocupado}
            disabled={ocupado}
          />
          <Button
            label={t('pedido.cancelar')}
            variant="secondary"
            onPress={cancelar}
            disabled={ocupado}
          />
        </>
      ) : null}

      {cerrado && !pagado ? (
        <Button
          label={t('pedido.volverAElegir')}
          onPress={() => router.replace(`/entradas/${pedido.event_id}` as never)}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  cuenta: {
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  resumen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
