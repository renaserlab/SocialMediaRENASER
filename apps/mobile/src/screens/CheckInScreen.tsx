import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { claveDeErrorDeEntradas, esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  claveDelResultado,
  codigoTecleado,
  pareceUnCodigo,
} from '@/lib/pedidoDeEntradas';
import {
  EventAdmissionRepository,
  type Veredicto,
} from '@/repositories/EventOrderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * La puerta: escanear un QR o teclear el código.
 *
 * EL RESULTADO ES INEQUÍVOCO Y OCUPA LA PANTALLA. Quien está en una puerta mira
 * un teléfono durante medio segundo con gente esperando: verde pasa, rojo no
 * pasa, y el texto dice cuál de los cuatro «no» es.
 *
 * SIN CONEXIÓN NO SE ENSEÑA UN CHECK-IN CORRECTO. Un fallo de red se pinta como
 * fallo de red, nunca como «adelante»: dar por buena una entrada que no se pudo
 * comprobar es dejar pasar a cualquiera con una foto.
 *
 * UN ESCANEO A LA VEZ. La cámara dispara muchas veces por segundo sobre el mismo
 * código; sin el cerrojo, un QR delante del objetivo manda decenas de peticiones
 * y llena el registro de intentos.
 */
export function CheckInScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [permiso, pedirPermiso] = useCameraPermissions();
  const [manual, setManual] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [veredicto, setVeredicto] = useState<Veredicto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);
  const ultimoRef = useRef('');

  const admitir = useCallback(
    async (credencial: string) => {
      // EL CERROJO, ANTES DEL PRIMER `await`.
      if (ocupadoRef.current || !id) return;
      const limpia = credencial.trim();
      if (limpia === '') return;
      ocupadoRef.current = true;
      setOcupado(true);
      setError(null);
      try {
        setVeredicto(await EventAdmissionRepository.checkIn(id, limpia));
      } catch (fallo) {
        setVeredicto(null);
        if (fallo instanceof ApiError && esFalloDeRed(fallo.code)) {
          setError(t('checkin.sinConexion'));
        } else {
          const clave =
            fallo instanceof ApiError ? claveDeErrorDeEntradas(fallo.code) : null;
          setError(
            clave !== null ? t(clave as TranslationKey) : t('common.tryAgain'),
          );
        }
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    },
    [id, t],
  );

  const escaneado = ({ data }: { data: string }) => {
    // EL MISMO CÓDIGO NO SE MANDA DOS VECES SEGUIDAS. La cámara lo ve en cada
    // fotograma mientras esté delante.
    if (data === ultimoRef.current) return;
    ultimoRef.current = data;
    void admitir(data);
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-eventos' as never);

  const limpiar = () => {
    setVeredicto(null);
    setError(null);
    setCodigo('');
    ultimoRef.current = '';
  };

  const resultado = veredicto?.result ?? null;
  const paso = resultado === 'OK';

  const panel = (
    <View
      style={[
        styles.resultado,
        {
          backgroundColor: paso ? colors.success : colors.danger,
        },
      ]}
      accessibilityLiveRegion="assertive"
    >
      <Feather
        name={paso ? 'check-circle' : 'x-circle'}
        size={40}
        color={colors.onPrimary}
      />
      <Text variant="title" color={colors.onPrimary}>
        {t(claveDelResultado(resultado ?? '') as TranslationKey)}
      </Text>
      {veredicto?.name ? (
        <Text variant="secondary" color={colors.onPrimary}>
          {veredicto.name}
        </Text>
      ) : null}
      {veredicto?.checked_in_at && !paso ? (
        <Text variant="caption" color={colors.onPrimary}>
          {t('checkin.entroALas', {
            hora: new Date(veredicto.checked_in_at).toLocaleTimeString(),
          })}
        </Text>
      ) : null}
    </View>
  );

  return (
    <SinTecladoDelante>
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={t('checkin.titulo')} onBack={volver} />

        {veredicto !== null ? (
          <>
            {panel}
            <Button label={t('checkin.siguiente')} onPress={limpiar} />
          </>
        ) : (
          <>
            {error !== null ? (
              <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
                <Feather name="alert-circle" size={16} color={colors.danger} />
                <Text variant="secondary" color={colors.danger} style={styles.crece}>
                  {error}
                </Text>
              </View>
            ) : null}

            {!manual ? (
              permiso?.granted ? (
                <View style={styles.camara}>
                  <CameraView
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={ocupado ? undefined : escaneado}
                  />
                </View>
              ) : (
                <StateView
                  state="empty"
                  title={t('checkin.sinCamara')}
                  description={t('checkin.sinCamaraCuerpo')}
                  actionLabel={t('checkin.permitirCamara')}
                  onAction={() => void pedirPermiso()}
                />
              )
            ) : (
              <>
                <Input
                  label={t('checkin.codigo')}
                  value={codigo}
                  onChangeText={setCodigo}
                  autoCapitalize="characters"
                  maxLength={24}
                  editable={!ocupado}
                />
                <Button
                  label={t('checkin.comprobar')}
                  onPress={() => void admitir(codigoTecleado(codigo))}
                  loading={ocupado}
                  disabled={ocupado || !pareceUnCodigo(codigo)}
                />
              </>
            )}

            <Button
              label={manual ? t('checkin.usarCamara') : t('checkin.escribirCodigo')}
              variant="secondary"
              onPress={() => {
                setManual((previo) => !previo);
                limpiar();
              }}
            />
            <Text variant="caption" color={colors.textMuted}>
              {t('checkin.explicacion')}
            </Text>
          </>
        )}
      </AppScreen>
    </SinTecladoDelante>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1 },
  camara: {
    height: 300,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  resultado: {
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
