import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { importeConMoneda } from '@/lib/dinero';
import {
  cantidadPosible,
  cuantasElegidas,
  hayExistencias,
  motivoParaNoReservar,
  subtotal,
  subtotalDe,
  topeDe,
  type Seleccion,
  type TipoDeEntrada,
} from '@/lib/entradasDeEvento';
import {
  EventTicketRepository,
  type Disponibilidad,
} from '@/repositories/EventTicketRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Elegir entradas. La pantalla anterior a una compra que todavía no existe.
 *
 * LO QUE AQUÍ NO SE HACE, y cada omisión es una decisión:
 *
 *   - No se cobra. El botón aparta entradas diez minutos y lo dice.
 *   - No se calcula un total. Se dice «subtotal de entradas», porque faltan
 *     comisión e impuestos que la empresa no ha definido, y llamarlo total
 *     sería prometer un importe que nadie ha decidido.
 *   - No se enseña una comisión de cero como si estuviera decidida.
 *   - No se confía en la disponibilidad que se descargó: al apartar, el
 *     servidor vuelve a mirarla y puede decir que no.
 *
 * EL DINERO, EN ENTEROS. Todo son centavos; ni una división en el camino.
 */
export function ElegirEntradasScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [tipos, setTipos] = useState<TipoDeEntrada[]>([]);
  const [libre, setLibre] = useState<Disponibilidad | null>(null);
  const [seleccion, setSeleccion] = useState<Seleccion>({});
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<'red' | 'sinEntradas' | 'noDisponible' | null>(null);
  const [apartando, setApartando] = useState(false);
  /** Cerrojo síncrono: dos toques no mandan dos reservas. */
  const apartandoRef = useRef(false);
  /**
   * La clave de idempotencia de ESTE intento.
   *
   * Se genera una vez por pantalla, no por pulsación: así un reintento tras un
   * fallo de red devuelve la misma reserva en vez de apartar otras tantas.
   */
  const claveRef = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(null);
    try {
      const [lista, disponible] = await Promise.all([
        EventTicketRepository.tipos(id),
        EventTicketRepository.disponibilidad(id),
      ]);
      setTipos(lista);
      setLibre(disponible);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'event_not_ticketed') {
        setFallo('sinEntradas');
      } else if (
        error instanceof ApiError &&
        error.code === 'event_ticketing_not_available'
      ) {
        setFallo('noDisponible');
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

  const topePorOperacion = libre?.general ?? null;

  const cambiar = (tipo: TipoDeEntrada, delta: number) => {
    setSeleccion((previa) => {
      const pedida = (previa[tipo.id] ?? 0) + delta;
      const posible = cantidadPosible(tipo, pedida, previa, topePorOperacion);
      const siguiente = { ...previa };
      if (posible === 0) delete siguiente[tipo.id];
      else siguiente[tipo.id] = posible;
      return siguiente;
    });
  };

  const apartar = async () => {
    if (!id || apartandoRef.current) return;
    const falta = motivoParaNoReservar(tipos, seleccion);
    if (falta) {
      notify(t('entradas.noSePuedeReservar'), t(falta as TranslationKey));
      return;
    }
    apartandoRef.current = true;
    setApartando(true);
    try {
      const reserva = await EventTicketRepository.apartar(
        id,
        seleccion,
        claveRef.current,
      );
      router.push(`/reserva/${reserva.id}` as never);
    } catch (error) {
      // LA DISPONIBILIDAD SE VUELVE A PEDIR. Lo que se descargó pudo quedarse
      // viejo mientras alguien elegía, y quedarse con el número antiguo haría
      // que el botón siguiera ofreciendo algo que ya no está.
      notify(
        t('entradas.noSePuedeReservar'),
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : t('common.tryAgain'),
      );
      void cargar();
    } finally {
      apartandoRef.current = false;
      setApartando(false);
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(`/eventos/${id}` as never);

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('entradas.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen>
        <AppHeader title={t('entradas.titulo')} onBack={volver} />
        {fallo === 'red' ? (
          <StateView
            state="error"
            description={t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        ) : (
          <StateView
            state="empty"
            title={
              fallo === 'sinEntradas'
                ? t('entradas.sinEntradas')
                : t('entradas.noDisponible')
            }
            description={
              fallo === 'sinEntradas'
                ? t('entradas.sinEntradasCuerpo')
                : t('entradas.noDisponibleCuerpo')
            }
          />
        )}
      </AppScreen>
    );
  }

  if (!hayExistencias(tipos)) {
    return (
      <AppScreen>
        <AppHeader title={t('entradas.titulo')} onBack={volver} />
        <StateView
          state="empty"
          title={t('entradas.agotado')}
          description={t('entradas.agotadoCuerpo')}
          actionLabel={t('common.tryAgain')}
          onAction={() => void cargar()}
        />
      </AppScreen>
    );
  }

  const total = subtotal(tipos, seleccion);
  const moneda = tipos[0]?.currency ?? 'PEN';
  const elegidas = cuantasElegidas(seleccion);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('entradas.titulo')} onBack={volver} />

      {tipos.map((tipo) => {
        const cantidad = seleccion[tipo.id] ?? 0;
        const tope = topeDe(tipo, seleccion, topePorOperacion);
        return (
          <View key={tipo.id} style={[styles.tipo, { borderColor: colors.border }]}>
            <View style={styles.crece}>
              <Text variant="secondary" weight="700">
                {tipo.name}
              </Text>
              {tipo.description ? (
                <Text variant="caption" color={colors.textMuted}>
                  {tipo.description}
                </Text>
              ) : null}
              {tipo.inclusions.length > 0 ? (
                <Text variant="caption" color={colors.textMuted}>
                  {t('entradas.incluye', { lista: tipo.inclusions.join(', ') })}
                </Text>
              ) : null}
              {tipo.restrictions.length > 0 ? (
                <Text variant="caption" color={colors.textMuted}>
                  {t('entradas.restricciones', {
                    lista: tipo.restrictions.join(', '),
                  })}
                </Text>
              ) : null}
              <Text variant="secondary" weight="700">
                {importeConMoneda(tipo.price_minor, tipo.currency)}
              </Text>
              <Text variant="caption" color={colors.textMuted}>
                {t('entradas.quedan', { n: tipo.disponibles })}
              </Text>
              {cantidad > 0 ? (
                <Text variant="caption" color={colors.textMuted}>
                  {t('entradas.subtotalDeTipo', {
                    importe: importeConMoneda(
                      subtotalDe(tipo, cantidad),
                      tipo.currency,
                    ),
                  })}
                </Text>
              ) : null}
            </View>

            <View style={styles.contador}>
              <Pressable
                disabled={apartando || cantidad === 0}
                onPress={() => cambiar(tipo, -1)}
                style={[styles.boton, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel={t('entradas.quitarUna')}
              >
                <Feather
                  name="minus"
                  size={16}
                  color={cantidad === 0 ? colors.disabled : colors.text}
                />
              </Pressable>
              <Text variant="secondary" weight="700">
                {cantidad}
              </Text>
              <Pressable
                disabled={apartando || cantidad >= tope}
                onPress={() => cambiar(tipo, 1)}
                style={[styles.boton, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel={t('entradas.anadirUna')}
              >
                <Feather
                  name="plus"
                  size={16}
                  color={cantidad >= tope ? colors.disabled : colors.text}
                />
              </Pressable>
            </View>
          </View>
        );
      })}

      {/* EL SUBTOTAL, LLAMADO POR SU NOMBRE. */}
      <View style={[styles.resumen, { backgroundColor: colors.surfaceAlt }]}>
        <Text variant="secondary" weight="700" style={styles.crece}>
          {t('entradas.subtotal')}
        </Text>
        <Text variant="secondary" weight="700">
          {importeConMoneda(total, moneda)}
        </Text>
      </View>
      <Text variant="caption" color={colors.textMuted}>
        {t('entradas.avisoDeCargos')}
      </Text>

      <Button
        label={t('entradas.apartar', { n: elegidas })}
        onPress={() => void apartar()}
        loading={apartando}
        disabled={apartando || elegidas === 0}
      />
      <Text variant="caption" color={colors.textMuted}>
        {t('entradas.noEsUnaCompra')}
      </Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  tipo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  contador: { alignItems: 'center', gap: spacing.sm },
  boton: {
    borderWidth: 1,
    borderRadius: radius.lg,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resumen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
