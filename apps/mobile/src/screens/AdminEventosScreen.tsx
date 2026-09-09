import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { claveDelEstado } from '@/lib/admisionDeEvento';
import {
  EventAdmissionRepository,
  type ExpedienteDeEvento,
} from '@/repositories/EventAdmissionRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * La cola de revisión: lo enviado y lo condicional.
 *
 * QUIÉN PUEDE ABRIRLA lo decide el servidor. Esta pantalla no comprueba ningún
 * rol: si quien entra no es curaduría, la petición responde 403 y aquí se
 * enseña el estado vacío correspondiente. Ocultar la pantalla sería comodidad,
 * no protección, y esconder el error convertiría un permiso denegado en un
 * «no hay nada», que es una cosa distinta.
 */
export function AdminEventosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [cola, setCola] = useState<ExpedienteDeEvento[]>([]);
  const [estado, setEstado] = useState<'loading' | 'content' | 'error' | 'empty'>(
    'loading',
  );
  const [sinPermiso, setSinPermiso] = useState(false);
  const [noDisponible, setNoDisponible] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const [trayendoMas, setTrayendoMas] = useState(false);

  const cargar = useCallback(async () => {
    setEstado('loading');
    setSinPermiso(false);
    setNoDisponible(false);
    try {
      const { items, hayMas: mas } = await EventAdmissionRepository.pendientes();
      setCola(items);
      setHayMas(mas);
      setEstado(items.length === 0 ? 'empty' : 'content');
    } catch (error) {
      /*
        POR EL ESTADO Y EL CÓDIGO. Se buscaba «403» y la palabra «curaduría»
        dentro del mensaje: lo primero no aparece nunca —el número va en
        `error.status`— y lo segundo acertaba de casualidad, porque el servidor
        contesta esa palabra en español. Cambiar la redacción rompía la
        detección en silencio.
      */
      if (error instanceof ApiError && error.status === 403) {
        setSinPermiso(true);
        setEstado('empty');
        return;
      }
      if (
        error instanceof ApiError &&
        error.code === 'events_workflow_not_available'
      ) {
        setNoDisponible(true);
        setEstado('empty');
        return;
      }
      setEstado('error');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  /** La página siguiente. El orden del servidor es estable: no repite. */
  const traerMas = async () => {
    if (trayendoMas || !hayMas) return;
    setTrayendoMas(true);
    try {
      const { items, hayMas: mas } = await EventAdmissionRepository.pendientes(
        cola.length,
      );
      setCola((previos) => [...previos, ...items]);
      setHayMas(mas);
    } catch {
      setHayMas(false);
    } finally {
      setTrayendoMas(false);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('admisionEvento.cola')} onBack={volver} />

      {estado === 'loading' ? <StateView state="loading" /> : null}
      {estado === 'error' ? (
        <StateView
          state="error"
          description={t('common.loadFailed')}
          onRetry={() => void cargar()}
        />
      ) : null}
      {estado === 'empty' ? (
        <StateView
          state="empty"
          title={
            noDisponible
              ? t('misEventos.noDisponible')
              : sinPermiso
                ? t('admisionEvento.sinPermiso')
                : t('admisionEvento.colaVacia')
          }
          description={
            noDisponible
              ? t('misEventos.noDisponibleCuerpo')
              : sinPermiso
                ? t('admisionEvento.sinPermisoCuerpo')
                : t('admisionEvento.colaVaciaCuerpo')
          }
        />
      ) : null}

      {estado === 'content'
        ? cola.map((expediente) => (
            <Pressable
              key={expediente.id}
              onPress={() => router.push(`/admin/eventos/${expediente.id}` as never)}
              style={[styles.fila, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel={expediente.title}
            >
              <View style={styles.crece}>
                <Text variant="secondary" weight="700">
                  {expediente.title}
                </Text>
                <Text variant="caption" color={colors.textMuted}>
                  {t(claveDelEstado(expediente.workflow_status) as TranslationKey)}
                  {expediente.current_version
                    ? ` · ${t('admisionEvento.version', { n: expediente.current_version })}`
                    : ''}
                </Text>
                {/* El total, si ya hay evaluación. Los ocho criterios están en
                    la ficha: en la lista solo hace falta saber si ya se miró. */}
                <Text variant="caption" color={colors.textMuted}>
                  {expediente.evaluacion
                    ? t('admisionEvento.puntuado', {
                        total: expediente.evaluacion.total,
                      })
                    : t('admisionEvento.sinPuntuar')}
                </Text>
              </View>
              <Feather name="chevron-right" size={18} color={colors.textMuted} />
            </Pressable>
          ))
        : null}

      {estado === 'content' && hayMas ? (
        <Button
          label={t('common.loadMore')}
          variant="secondary"
          onPress={() => void traerMas()}
          loading={trayendoMas}
          disabled={trayendoMas}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 44,
  },
  crece: { flex: 1, gap: 4 },
});
