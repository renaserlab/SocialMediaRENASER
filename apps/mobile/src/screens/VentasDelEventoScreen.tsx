import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { importeConMoneda } from '@/lib/dinero';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  EventAdmissionRepository,
  type Ventas,
} from '@/repositories/EventOrderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Las ventas de un evento, para quien lo organiza.
 *
 * «INGRESO BRUTO» Y LO DICE. No es lo que el organizador va a cobrar: faltan
 * comisión de plataforma, impuestos, entidad vendedora y liquidación, y ninguna
 * de esas decisiones está tomada. Enseñar la cifra a secas junto a la palabra
 * «ingresos» sería prometer un pago que nadie ha calculado.
 *
 * NO HAY LIQUIDACIÓN, NI TRANSFERENCIA, NI CALENDARIO DE PAGO. No están
 * apagados: no existen, y un botón deshabilitado sugiere que llegan mañana.
 */
export function VentasDelEventoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [ventas, setVentas] = useState<Ventas | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(null);
    try {
      setVentas(await EventAdmissionRepository.ventas(id));
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === 'event_orders_not_available' ||
          error.code === 'event_ticketing_not_available')
      ) {
        setFallo('noDisponible');
      } else if (error instanceof ApiError && error.status === 404) {
        setFallo('noEncontrado');
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

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-eventos' as never);

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('ventasDeEvento.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !ventas) {
    return (
      <AppScreen>
        <AppHeader title={t('ventasDeEvento.titulo')} onBack={volver} />
        {fallo === 'noEncontrado' || fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            title={
              fallo === 'noEncontrado'
                ? t('ventasDeEvento.sinPuerta')
                : t('entradas.noDisponible')
            }
            description={
              fallo === 'noEncontrado'
                ? t('ventasDeEvento.sinPuertaCuerpo')
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

  const dato = (clave: TranslationKey, valor: string) => (
    <View style={[styles.dato, { borderColor: colors.border }]}>
      <Text variant="caption" color={colors.textMuted} style={styles.crece}>
        {t(clave)}
      </Text>
      <Text variant="secondary" weight="700">
        {valor}
      </Text>
    </View>
  );

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('ventasDeEvento.titulo')} onBack={volver} />

      {dato('ventasDeEvento.emitidas', String(ventas.entradas_emitidas))}
      {dato('ventasDeEvento.usadas', String(ventas.entradas_usadas))}
      {dato('ventasDeEvento.revocadas', String(ventas.entradas_revocadas))}
      {dato('ventasDeEvento.checkins', String(ventas.checkins))}
      {dato('ventasDeEvento.pagadas', String(ventas.ordenes_pagadas))}
      {dato('ventasDeEvento.pendientes', String(ventas.ordenes_pendientes))}

      <View style={[styles.bruto, { backgroundColor: colors.surfaceAlt }]}>
        <Text variant="caption" color={colors.textMuted}>
          {t('ventasDeEvento.bruto')}
        </Text>
        <Text variant="title">
          {/* SIN MONEDA NO SE ESCRIBE EL IMPORTE: una cifra sin divisa no
              significa nada, y suponer la del país es inventarla. */}
          {ventas.currency
            ? importeConMoneda(ventas.ingresos_brutos_minor, ventas.currency)
            : t('ventasDeEvento.sinMoneda')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {t('ventasDeEvento.brutoExplicado')}
        </Text>
      </View>

      <Button
        label={t('ventasDeEvento.verAsistentes')}
        onPress={() => router.push(`/asistentes/${id}` as never)}
      />
      <Button
        label={t('ventasDeEvento.abrirPuerta')}
        variant="secondary"
        onPress={() => router.push(`/check-in/${id}` as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1 },
  dato: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  bruto: {
    gap: 4,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
