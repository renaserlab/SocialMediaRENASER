import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { claveDelEstadoDeEntrada, codigoTecleado } from '@/lib/pedidoDeEntradas';
import {
  EventAdmissionRepository,
  type Asistente,
} from '@/repositories/EventOrderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

const ESTADOS = ['VALID', 'USED', 'REVOKED'] as const;

/**
 * Los asistentes de un evento, para la puerta.
 *
 * NO LLEVA AL COMPRADOR, y no es un descuido: la puerta decide si alguien pasa,
 * no necesita saber quién es. Tampoco lleva el código admisible de cada entrada
 * —volcarlos todos sería repartir entradas—; se BUSCA por el que la persona
 * enseña, y la búsqueda la hace la base antes del límite.
 */
export function AsistentesScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [filas, setFilas] = useState<Asistente[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [cargando, setCargando] = useState(true);
  const [trayendoMas, setTrayendoMas] = useState(false);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(
    async (filtro: string | null, texto: string) => {
      if (!id) return;
      setCargando(true);
      setFallo(null);
      try {
        const pagina = await EventAdmissionRepository.asistentes(id, {
          estado: filtro,
          q: codigoTecleado(texto) || undefined,
        });
        setFilas(pagina.items);
        setCursor(pagina.next_cursor);
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
    },
    [id],
  );

  useEffect(() => {
    void cargar(null, '');
  }, [cargar]);

  const traerMas = async () => {
    if (cursor === null || trayendoMas || !id) return;
    setTrayendoMas(true);
    try {
      const pagina = await EventAdmissionRepository.asistentes(id, {
        cursor,
        estado,
        q: codigoTecleado(busqueda) || undefined,
      });
      setFilas((previas) => [...previas, ...pagina.items]);
      setCursor(pagina.next_cursor);
    } catch {
      // Se deja lo que ya se pudo leer.
    } finally {
      setTrayendoMas(false);
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-eventos' as never);

  const cambiarFiltro = (siguiente: string | null) => {
    setEstado(siguiente);
    void cargar(siguiente, busqueda);
  };

  if (fallo === 'noEncontrado' || fallo === 'noDisponible') {
    return (
      <AppScreen>
        <AppHeader title={t('asistentes.titulo')} onBack={volver} />
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
      </AppScreen>
    );
  }

  return (
    <SinTecladoDelante>
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={t('asistentes.titulo')} onBack={volver} />

        <Input
          label={t('asistentes.buscar')}
          value={busqueda}
          onChangeText={setBusqueda}
          autoCapitalize="characters"
          maxLength={24}
          onSubmitEditing={() => void cargar(estado, busqueda)}
          returnKeyType="search"
        />

        <View style={styles.fichas}>
          {[null, ...ESTADOS].map((valor) => {
            const elegido = estado === valor;
            return (
              <Pressable
                key={valor ?? 'todos'}
                onPress={() => cambiarFiltro(valor)}
                style={[
                  styles.ficha,
                  {
                    borderColor: elegido ? colors.primary : colors.border,
                    backgroundColor: elegido ? colors.primary : 'transparent',
                  },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: elegido }}
              >
                <Text variant="caption" color={elegido ? colors.onPrimary : colors.text}>
                  {valor === null
                    ? t('asistentes.todos')
                    : t(claveDelEstadoDeEntrada(valor) as TranslationKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {cargando ? (
          <StateView state="loading" />
        ) : fallo !== null ? (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar(estado, busqueda)}
          />
        ) : filas.length === 0 ? (
          <StateView
            state="empty"
            title={t('asistentes.ninguno')}
            description={t('asistentes.ningunoCuerpo')}
          />
        ) : (
          <>
            {filas.map((fila) => (
              <View
                key={fila.ticket_id}
                style={[styles.fila, { borderColor: colors.border }]}
              >
                <View style={styles.crece}>
                  <Text variant="secondary" weight="700">
                    {fila.name}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {t(claveDelEstadoDeEntrada(fila.status) as TranslationKey)}
                  </Text>
                </View>
                {fila.checked_in_at ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {new Date(fila.checked_in_at).toLocaleTimeString()}
                  </Text>
                ) : null}
              </View>
            ))}
            {cursor !== null ? (
              <Button
                label={t('common.loadMore')}
                variant="secondary"
                onPress={() => void traerMas()}
                loading={trayendoMas}
                disabled={trayendoMas}
              />
            ) : null}
          </>
        )}
      </AppScreen>
    </SinTecladoDelante>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  fichas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  ficha: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
    justifyContent: 'center',
  },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
