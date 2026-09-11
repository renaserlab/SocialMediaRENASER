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
  claveDelEstadoDeExpediente,
  claveDelTipoDeExpediente,
  esPosventaApagada,
  expedienteCerrado,
} from '@/lib/posventaDeEventos';
import {
  EventAftersaleRepository,
  type Expediente,
} from '@/repositories/EventAftersaleRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/** La fecha, en el idioma del sistema. Vacía si el servidor mandó algo raro. */
function fechaLegible(iso: string | null): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Las solicitudes de posventa que ha abierto quien mira.
 *
 * UNA LISTA HONESTA. Sin ninguna solicitud se dice que no hay ninguna y punto:
 * no se insinúa que «pronto aparecerán» ni se anima a abrir una, porque abrir
 * una solicitud no es algo que convenga sugerirle a nadie sin motivo.
 *
 * LO CERRADO SE VE APAGADO, PERO SE VE. Un expediente resuelto, rechazado o
 * retirado sigue siendo el registro de algo que esta persona pidió: esconderlo
 * sería borrarle su propia historia con nosotros.
 */
export function MisSolicitudesScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [expedientes, setExpedientes] = useState<Expediente[]>([]);
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
      const pagina = await EventAftersaleRepository.mios();
      setExpedientes(pagina.items);
      setCursor(pagina.next_cursor);
    } catch (error) {
      if (error instanceof ApiError && esPosventaApagada(error.code)) {
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
      const pagina = await EventAftersaleRepository.mios(20, cursor);
      setExpedientes((previos) => [...previos, ...pagina.items]);
      setCursor(pagina.next_cursor);
    } catch {
      // Se deja la lista como está: no borrar lo que ya se pudo leer.
    } finally {
      setTrayendoMas(false);
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-entradas' as never);

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('posventa.tituloLista')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen>
        <AppHeader title={t('posventa.tituloLista')} onBack={volver} />
        {fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={t('posventa.noDisponible')}
            description={t('posventa.noDisponibleCuerpo')}
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

  if (expedientes.length === 0) {
    return (
      <AppScreen>
        <AppHeader title={t('posventa.tituloLista')} onBack={volver} />
        <StateView
          state="empty"
          title={t('posventa.ninguna')}
          description={t('posventa.ningunaCuerpo')}
          actionLabel={t('miEntrada.titulo')}
          onAction={() => router.replace('/mis-entradas' as never)}
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('posventa.tituloLista')} onBack={volver} />
      {expedientes.map((expediente) => {
        const cerrado = expedienteCerrado(expediente.status);
        const tipo = t(claveDelTipoDeExpediente(expediente.kind) as TranslationKey);
        const fecha = fechaLegible(expediente.created_at);
        return (
          <Pressable
            key={expediente.id}
            onPress={() => router.push(`/posventa/${expediente.id}` as never)}
            style={[
              styles.fila,
              { borderColor: colors.border, opacity: cerrado ? 0.6 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('posventa.abrirSolicitud', { tipo })}
          >
            <View style={styles.crece}>
              <Text variant="secondary" weight="700">
                {tipo}
              </Text>
              <Text variant="caption" color={colors.textMuted}>
                {t(claveDelEstadoDeExpediente(expediente.status) as TranslationKey)}
              </Text>
              {fecha !== '' ? (
                <Text variant="caption" color={colors.textMuted}>
                  {t('posventa.abiertaEl', { fecha })}
                </Text>
              ) : null}
            </View>
            <Feather name="chevron-right" size={18} color={colors.textMuted} />
          </Pressable>
        );
      })}
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
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
