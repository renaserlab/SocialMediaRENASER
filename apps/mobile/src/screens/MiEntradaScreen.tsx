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
  // `?? ''` porque el servidor solo manda el codigo a su dueno: en cualquier
  // otra respuesta viene nulo. Aqui SIEMPRE somos el dueno, pero el tipo dice
  // la verdad y el recuadro de abajo se esconde si no hay nada que ensenar.
  const codigo = credencial?.code ?? entrada.code ?? '';

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
          {/*
            ZONA TRANQUILA. La norma pide cuatro modulos de margen blanco
            alrededor del simbolo, y el valor por defecto de la libreria es
            CERO: todo el margen lo ponia el relleno del recuadro, unos dos
            modulos y medio. Los lectores tolerantes leian igual; los de puerta,
            con poca luz o de refilon, fallaban de vez en cuando y no habia
            forma de entender por que esa entrada «a veces no lee».
          */}
          <QRCode
            value={credencial.credential}
            size={220}
            quietZone={16}
            backgroundColor="#FFFFFF"
          />
        </View>
      ) : null}

      {codigo !== '' ? (
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
      ) : null}

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

      {/*
        EL ACCESO A LA POSVENTA, DESDE LA ENTRADA. Aquí es donde alguien mira
        cuando algo va mal con su compra, así que aquí tiene que estar la
        salida. Va al final y en su propia tarjeta: no compite con el QR, que
        es para lo que se abre esta pantalla el noventa y nueve por ciento de
        las veces.

        NO PROMETE NADA. Dice que una persona lo revisará, que es lo único que
        se puede afirmar antes de preguntarle al servidor si esta compra admite
        siquiera una solicitud.
      */}
      <View style={[styles.ayuda, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {t('posventa.ayudaTitulo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {t('posventa.ayudaCuerpo')}
        </Text>
        <Button
          label={t('posventa.ayudaBoton')}
          variant="secondary"
          onPress={() =>
            router.push(`/posventa/nueva/${entrada.order_id}` as never)
          }
        />
      </View>
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
  ayuda: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
