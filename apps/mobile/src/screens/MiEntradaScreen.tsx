import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  claveDelEstadoDeEntrada,
  codigoLegible,
  entradaVigente,
} from '@/lib/pedidoDeEntradas';
import {
  EventOrderRepository,
  type Credencial,
  type Entrada,
} from '@/repositories/EventOrderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Una entrada, con su QR.
 *
 * EL QR SE DIBUJA AQUÍ, no se descarga. El servidor entrega un valor opaco y el
 * teléfono lo pinta: guardar imágenes de QR en la base es guardar entradas.
 *
 * Y SE PIDE AL ABRIR, cada vez. La credencial rota: la anterior deja de valer en
 * cuanto se pide una nueva, así que una foto de esta pantalla caduca la próxima
 * vez que su dueño la abre. El código escrito debajo rota con ella.
 *
 * SIN DATOS DE NADIE DENTRO DEL QR. Ni nombre, ni correo, ni precio, ni el
 * identificador de la entrada: un QR se fotografía y se comparte, y cuanto menos
 * diga, menos cuenta.
 */
export function MiEntradaScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [entrada, setEntrada] = useState<Entrada | null>(null);
  const [credencial, setCredencial] = useState<Credencial | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noEncontrada' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(null);
    try {
      const ficha = await EventOrderRepository.leerEntrada(id);
      setEntrada(ficha);
      // LA CREDENCIAL, SOLO SI SIRVE. Pedirla para una entrada usada o revocada
      // enseñaría un QR que la puerta va a rechazar delante de una cola.
      if (entradaVigente(ficha.status)) {
        setCredencial(await EventOrderRepository.credencial(id));
      } else {
        setCredencial(null);
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === 'event_ticket_not_found' ||
          error.code === 'event_ticket_not_valid')
      ) {
        setFallo('noEncontrada');
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

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-entradas' as never);

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('miEntrada.una')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !entrada) {
    return (
      <AppScreen>
        <AppHeader title={t('miEntrada.una')} onBack={volver} />
        {fallo === 'noEncontrada' || fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            title={
              fallo === 'noEncontrada'
                ? t('miEntrada.noEncontrada')
                : t('entradas.noDisponible')
            }
            description={
              fallo === 'noEncontrada'
                ? t('miEntrada.noEncontradaCuerpo')
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

  const vigente = entradaVigente(entrada.status);
  const codigo = credencial?.code ?? entrada.code;

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('miEntrada.una')} onBack={volver} />

      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather
          name={vigente ? 'check-circle' : 'alert-circle'}
          size={16}
          color={vigente ? colors.success : colors.danger}
        />
        <Text
          variant="secondary"
          color={vigente ? colors.success : colors.danger}
          style={styles.crece}
        >
          {t(claveDelEstadoDeEntrada(entrada.status) as TranslationKey)}
        </Text>
      </View>

      <Text variant="title">{entrada.name}</Text>

      {vigente && credencial ? (
        <View
          // FONDO BLANCO SIEMPRE, también en modo oscuro: un QR sobre fondo
          // oscuro no lo lee ningún lector, y el brillo lo sube quien escanea.
          style={[styles.qr, { backgroundColor: '#FFFFFF' }]}
          accessible
          accessibilityRole="image"
          accessibilityLabel={t('miEntrada.qrAccesible')}
        >
          <QRCode value={credencial.credential} size={220} backgroundColor="#FFFFFF" />
        </View>
      ) : null}

      <View style={[styles.codigo, { borderColor: colors.border }]}>
        <Text variant="caption" color={colors.textMuted}>
          {t('miEntrada.codigo')}
        </Text>
        <Text
          variant="title"
          accessibilityLabel={t('miEntrada.codigoAccesible', {
            codigo: codigo.split('').join(' '),
          })}
        >
          {codigoLegible(codigo)}
        </Text>
      </View>

      <Text variant="caption" color={colors.textMuted}>
        {vigente ? t('miEntrada.instrucciones') : t('miEntrada.yaNoSirve')}
      </Text>

      <Button
        label={t('miEntrada.verEvento')}
        variant="secondary"
        onPress={() => router.push(`/eventos/${entrada.event_id}` as never)}
      />
      {vigente ? (
        <Button
          label={t('miEntrada.renovar')}
          variant="secondary"
          onPress={() => void cargar()}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md, alignItems: 'stretch' },
  crece: { flex: 1, gap: 4 },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  qr: {
    alignSelf: 'center',
    padding: spacing.lg,
    borderRadius: radius.lg,
  },
  codigo: {
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
