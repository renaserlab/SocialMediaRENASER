import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  claveDelEstadoDeEntrada,
  repartirEntradas,
} from '@/lib/pedidoDeEntradas';
import { toast } from '@/lib/toast';
import {
  EventOrderRepository,
  type Entrada,
} from '@/repositories/EventOrderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Mis entradas, en tres montones.
 *
 * TRES MONTONES Y NO UNA LISTA. Quien abre esta pantalla suele estar en la
 * puerta buscando la que puede usar, no leyendo su historial. Las usadas y las
 * revocadas siguen ahí —desaparecer una entrada que alguien compró es peor que
 * enseñarla apagada— pero debajo.
 *
 * NO SE PINTA EL QR AQUÍ. La credencial ROTA cada vez que se pide, así que
 * pedirla para cada fila de una lista invalidaría todas menos la última. Se pide
 * al abrir UNA entrada, que es cuando hace falta.
 */
export function MisEntradasScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [entradas, setEntradas] = useState<Entrada[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [trayendoMas, setTrayendoMas] = useState(false);
  const [fallo, setFallo] = useState<'red' | 'sinConexion' | 'noDisponible' | null>(
    null,
  );

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      const pagina = await EventOrderRepository.misEntradas();
      setEntradas(pagina.items);
      setCursor(pagina.next_cursor);
    } catch (error) {
      if (
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
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const traerMas = async () => {
    if (cursor === null || trayendoMas) return;
    setTrayendoMas(true);
    try {
      const pagina = await EventOrderRepository.misEntradas(20, cursor);
      setEntradas((previas) => [...previas, ...pagina.items]);
      setCursor(pagina.next_cursor);
    } catch {
      // Se deja la lista como está: no borrar lo que ya se pudo leer. Pero SE
      // DICE: el botón volvía a su sitio sin una palabra y parecía que no
      // había más entradas.
      toast(t('common.tryAgain'), 'alert-circle');
    } finally {
      setTrayendoMas(false);
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/events' as never);

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('miEntrada.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen>
        <AppHeader title={t('miEntrada.titulo')} onBack={volver} />
        {fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            title={t('entradas.noDisponible')}
            description={t('entradas.noDisponibleCuerpo')}
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

  if (entradas.length === 0) {
    return (
      <AppScreen>
        <AppHeader title={t('miEntrada.titulo')} onBack={volver} />
        <StateView
          state="empty"
          title={t('miEntrada.ninguna')}
          description={t('miEntrada.ningunaCuerpo')}
        />
      </AppScreen>
    );
  }

  const { vigentes, usadas, revocadas } = repartirEntradas(entradas);

  const fila = (entrada: Entrada, apagada: boolean) => (
    <Pressable
      key={entrada.id}
      onPress={() => router.push(`/mi-entrada/${entrada.id}` as never)}
      style={[
        styles.entrada,
        { borderColor: colors.border, opacity: apagada ? 0.6 : 1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={t('miEntrada.abrir', { tipo: entrada.name })}
    >
      <View style={styles.crece}>
        <Text variant="secondary" weight="700">
          {entrada.name}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {t(claveDelEstadoDeEntrada(entrada.status) as TranslationKey)}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.textMuted} />
    </Pressable>
  );

  const seccion = (clave: TranslationKey, filas: Entrada[], apagada: boolean) =>
    filas.length === 0 ? null : (
      <>
        <Text variant="caption" color={colors.textMuted}>
          {t(clave)}
        </Text>
        {filas.map((entrada) => fila(entrada, apagada))}
      </>
    );

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('miEntrada.titulo')} onBack={volver} />
      {seccion('miEntrada.vigentes', vigentes, false)}
      {seccion('miEntrada.usadas', usadas, true)}
      {seccion('miEntrada.revocadas', revocadas, true)}
      {cursor !== null ? (
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
  crece: { flex: 1, gap: 4 },
  entrada: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
