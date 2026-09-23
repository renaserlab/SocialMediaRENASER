import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { importeConMoneda } from '@/lib/dinero';
import {
  claveDeErrorDeEntradas,
  claveDelEstadoDeReserva,
  esFalloDeRed,
  comoReloj,
  pedidoQueEstorba,
  segundosRestantes,
  sigueEnPie,
} from '@/lib/entradasDeEvento';
import { EventOrderRepository } from '@/repositories/EventOrderRepository';
import {
  EventTicketRepository,
  type ReservaTemporal,
} from '@/repositories/EventTicketRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * El resumen de una reserva temporal, con su cuenta atrás.
 *
 * NO ES UNA COMPRA, y la pantalla lo dice en vez de insinuar lo contrario: no
 * hay «Pagar», no hay total final y no hay recibo. El botón de continuar al
 * pago no está —ni deshabilitado ni oculto tras un `if`— porque el pago no
 * existe: enseñarlo apagado sugiere que llegará en un minuto.
 *
 * EL CONTADOR ES INFORMATIVO. Quien decide si la reserva venció es el SERVIDOR;
 * el teléfono puede tener la hora mal. Por eso al llegar a cero la pantalla
 * vuelve a PREGUNTAR en vez de dar la reserva por muerta.
 */
export function ReservaDeEntradasScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [reserva, setReserva] = useState<ReservaTemporal | null>(null);
  const [restantes, setRestantes] = useState(0);
  const [cargando, setCargando] = useState(true);
  /**
   * QUÉ falló, no solo que falló.
   *
   * `red` se reintenta; `noEncontrada` y `noDisponible` no, y ofrecer un botón
   * de «Reintentar» que no va a funcionar nunca es peor que no ofrecer ninguno.
   * Las otras dos pantallas ya ramificaban por código; esta lo mandaba todo al
   * mismo saco.
   */
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noEncontrada' | 'noDisponible' | null
  >(null);
  const [liberando, setLiberando] = useState(false);
  const liberandoRef = useRef(false);
  const [pidiendo, setPidiendo] = useState(false);
  const pidiendoRef = useRef(false);
  /**
   * La clave de idempotencia de ESTE pedido.
   *
   * Una por reserva, no una por pulsación: un reintento de la red sobre la misma
   * reserva tiene que devolver el mismo pedido, no crear otro. La reserva ya es
   * única, así que la clave puede colgar de ella.
   */
  const claveRef = useRef<string | null>(null);
  /** Para no volver a preguntar en bucle cuando el contador llega a cero. */
  const yaPreguntadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(null);
    try {
      const datos = await EventTicketRepository.leerReserva(id);
      setReserva(datos);
      // SE PARTE DEL NÚMERO DEL SERVIDOR, no del reloj local: si el teléfono
      // va adelantado, la cuenta atrás empezaría ya vencida.
      setRestantes(datos.segundos_restantes);
      yaPreguntadoRef.current = false;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ticket_hold_not_found') {
        setFallo('noEncontrada');
      } else if (
        error instanceof ApiError &&
        error.code === 'event_ticketing_not_available'
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

  useEffect(() => {
    void cargar();
  }, [cargar]);

  useEffect(() => {
    if (reserva === null || reserva.status !== 'ACTIVE') return;
    const tic = setInterval(() => {
      setRestantes((previos) => Math.max(0, previos - 1));
    }, 1000);
    return () => clearInterval(tic);
  }, [reserva]);

  useEffect(() => {
    // Al llegar a cero se PREGUNTA, no se decide. Una sola vez.
    if (restantes === 0 && reserva?.status === 'ACTIVE' && !yaPreguntadoRef.current) {
      yaPreguntadoRef.current = true;
      void cargar();
    }
  }, [restantes, reserva, cargar]);

  const liberar = async () => {
    if (!id || liberandoRef.current) return;
    // EL CERROJO, ANTES DEL PRIMER `await`, que aquí es el propio diálogo. Sin
    // esto dos toques rápidos encolaban dos diálogos y la persona veía
    // «¿Liberar las entradas?» otra vez después de haber aceptado, que se lee
    // como que la acción falló.
    liberandoRef.current = true;
    const aceptado = await confirm({
      title: t('reserva.liberarTitulo'),
      message: t('reserva.liberarCuerpo'),
      confirmLabel: t('reserva.liberar'),
      destructive: true,
    });
    if (!aceptado) {
      liberandoRef.current = false;
      return;
    }
    setLiberando(true);
    try {
      const datos = await EventTicketRepository.liberar(id);
      setReserva(datos);
      setRestantes(0);
    } catch (error) {
      const clave =
        error instanceof ApiError ? claveDeErrorDeEntradas(error.code) : null;
      notify(
        t('common.saveFailed'),
        clave !== null
          ? t(clave as TranslationKey)
          : error instanceof Error && error.message.trim() !== ''
            ? error.message
            : t('common.tryAgain'),
      );
    } finally {
      liberandoRef.current = false;
      setLiberando(false);
    }
  };

  const continuar = async () => {
    // EL CERROJO ANTES DEL PRIMER `await`: dos toques no crean dos pedidos.
    if (!id || pidiendoRef.current) return;
    pidiendoRef.current = true;
    setPidiendo(true);
    try {
      if (claveRef.current === null) {
        claveRef.current = `${id}-${Date.now()}`;
      }
      const pedido = await EventOrderRepository.crearPedido(id, claveRef.current);
      router.push(`/pedido/${pedido.id}` as never);
    } catch (error) {
      // YA HAY UN PEDIDO: se lleva a él en vez de dejar un error sin salida.
      const suyo =
        error instanceof ApiError && error.code === 'event_order_already_exists'
          ? pedidoQueEstorba(error.details)
          : null;
      if (suyo !== null) {
        router.replace(`/pedido/${suyo}` as never);
        return;
      }
      const clave =
        error instanceof ApiError ? claveDeErrorDeEntradas(error.code) : null;
      notify(
        t('common.saveFailed'),
        clave !== null
          ? t(clave as TranslationKey)
          : error instanceof Error && error.message.trim() !== ''
            ? error.message
            : t('common.tryAgain'),
      );
      void cargar();
    } finally {
      pidiendoRef.current = false;
      setPidiendo(false);
    }
  };

  const volver = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    // A LA FICHA SI SE SABE CUÁL, Y SI NO, A LOS EVENTOS. `/eventos/` sin
    // identificador no es ninguna ruta: `app/eventos/` solo tiene `[id].tsx`, y
    // el respaldo caía en la pantalla de «no encontrado».
    const evento = reserva?.event_id;
    router.replace((evento ? `/eventos/${evento}` : '/mis-eventos') as never);
  };

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('reserva.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !reserva) {
    return (
      <AppScreen>
        <AppHeader title={t('reserva.titulo')} onBack={volver} />
        {fallo === 'noEncontrada' || fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            title={
              fallo === 'noEncontrada'
                ? t('errorDeEntradas.reservaNoEncontrada')
                : t('entradas.noDisponible')
            }
            description={
              fallo === 'noEncontrada'
                ? t('reserva.noEncontradaCuerpo')
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

  const enPie = sigueEnPie(reserva.status, restantes);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('reserva.titulo')} onBack={volver} />

      {/* NO ES UNA COMPRA. Lo primero que se lee. */}
      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather name="clock" size={16} color={colors.textMuted} />
        <Text variant="secondary" color={colors.textMuted} style={styles.crece}>
          {t('reserva.noEsUnaCompra')}
        </Text>
      </View>

      {enPie ? (
        <View style={[styles.cuenta, { borderColor: colors.primary }]}>
          <Text variant="title">{comoReloj(restantes)}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {t('reserva.tiempoRestante')}
          </Text>
        </View>
      ) : (
        <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
          <Feather name="alert-circle" size={16} color={colors.danger} />
          <Text variant="secondary" color={colors.danger} style={styles.crece}>
            {t(claveDelEstadoDeReserva(reserva.status) as TranslationKey)}
          </Text>
        </View>
      )}

      {reserva.items.map((linea) => (
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
                importe: importeConMoneda(linea.unit_price_minor, reserva.currency),
              })}
            </Text>
          </View>
          <Text variant="secondary" weight="700">
            {importeConMoneda(linea.subtotal_minor, reserva.currency)}
          </Text>
        </View>
      ))}

      <View style={[styles.resumen, { backgroundColor: colors.surfaceAlt }]}>
        <Text variant="secondary" weight="700" style={styles.crece}>
          {t('entradas.subtotal')}
        </Text>
        <Text variant="secondary" weight="700">
          {importeConMoneda(reserva.subtotal_minor, reserva.currency)}
        </Text>
      </View>
      <Text variant="caption" color={colors.textMuted}>
        {t('entradas.avisoDeCargos')}
      </Text>

      {enPie ? (
        <>
          <Button
            label={t('reserva.continuar')}
            onPress={() => void continuar()}
            loading={pidiendo}
            disabled={pidiendo || liberando}
          />
          <Button
            label={t('reserva.liberar')}
            variant="secondary"
            onPress={() => void liberar()}
            loading={liberando}
            disabled={liberando || pidiendo}
          />
        </>
      ) : (
        <Button
          label={t('reserva.volverAElegir')}
          onPress={() => router.replace(`/entradas/${reserva.event_id}` as never)}
        />
      )}

      {/*
        EL PAGO NO ESTÁ, ni siquiera apagado. Un botón deshabilitado sugiere que
        llega en un minuto, y aquí lo que falta no es un botón: son la comisión,
        los impuestos, el vendedor de registro y los comprobantes, que la
        empresa todavía no ha decidido.
      */}
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
