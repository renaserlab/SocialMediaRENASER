import React, { useCallback, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
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
import { abrirAjustes } from '@/lib/permisos';
import { useSeccionActiva } from '@/navigation/foco';
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
 * pasa, y el texto dice cuál de los «no» es.
 *
 * SIN CONEXIÓN NO SE ENSEÑA UN CHECK-IN CORRECTO. Un fallo de red se pinta como
 * fallo de red, nunca como «adelante»: dar por buena una entrada que no se pudo
 * comprobar es dejar pasar a cualquiera con una foto.
 *
 * UN ESCANEO A LA VEZ. La cámara dispara muchas veces por segundo sobre el mismo
 * código; sin el cerrojo, un QR delante del objetivo manda decenas de peticiones
 * y llena el registro de intentos.
 *
 * Y LO QUE FALLA SE PUEDE REINTENTAR. El código que se descarta se recuerda solo
 * mientras haya un veredicto en pantalla; en cuanto algo va mal se olvida, para
 * que volver a acercar el mismo QR sirva de algo. Antes se recordaba siempre, y
 * un corte de red dejaba la cámara viva tirando en silencio ese código en cada
 * fotograma: el escáner parecía roto y la única salida era ir a manual y volver.
 */
export function CheckInScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [permiso, pedirPermiso] = useCameraPermissions();
  /*
    EN LA WEB SE EMPIEZA A MANO. `CameraView` necesita `getUserMedia` y un
    detector de códigos que muchos navegadores no traen; arrancar en cámara deja
    a quien abre la puerta desde un portátil mirando un permiso que su navegador
    no puede conceder. Se empieza por donde sí se puede trabajar.
  */
  const [manual, setManual] = useState(Platform.OS === 'web');
  const [codigo, setCodigo] = useState('');
  const [veredicto, setVeredicto] = useState<Veredicto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);
  const ultimoRef = useRef('');
  // LA CÁMARA SE APAGA CUANDO NADIE MIRA. Estar montado no es estar activo: una
  // pantalla abierta encima deja esta viva por debajo, y con ella el piloto de
  // la cámara encendido y la batería corriendo.
  const activa = useSeccionActiva();

  const anunciar = (clave: TranslationKey) => {
    // `accessibilityLiveRegion` es solo Android. En iOS, sustituir la pantalla
    // entera deja el foco del lector huérfano y el dato más importante de toda
    // la puerta —si pasa o no pasa— no se anuncia.
    AccessibilityInfo.announceForAccessibility(t(clave));
  };

  const admitir = useCallback(
    async (credencial: string) => {
      // EL CERROJO, ANTES DEL PRIMER `await`.
      if (ocupadoRef.current) return;
      const limpia = credencial.trim();
      if (limpia === '' || !id) return;
      ocupadoRef.current = true;
      ultimoRef.current = limpia;
      setOcupado(true);
      setError(null);
      try {
        const respuesta = await EventAdmissionRepository.checkIn(id, limpia);
        setVeredicto(respuesta);
        anunciar(claveDelResultado(respuesta.result ?? '') as TranslationKey);
      } catch (fallo) {
        setVeredicto(null);
        // SE OLVIDA EL CÓDIGO. Lo que no llegó a tener veredicto tiene que
        // poder reintentarse acercando otra vez el mismo QR.
        ultimoRef.current = '';
        if (fallo instanceof ApiError && esFalloDeRed(fallo.code)) {
          /*
            LA RESPUESTA SE PERDIÓ, PERO ¿Y LA PETICIÓN? El check-in escribe y
            no es idempotente: si llegó al servidor y lo que se perdió fue la
            vuelta, la entrada ya está consumida y quien tiene derecho a entrar
            se quedaría fuera. `verificar` no escribe nada y se puede preguntar
            mil veces, así que se pregunta.
          */
          try {
            const real = await EventAdmissionRepository.verificar(id, limpia);
            setVeredicto(real);
            anunciar(claveDelResultado(real.result ?? '') as TranslationKey);
            return;
          } catch {
            setError(t('checkin.sinConexion'));
            anunciar('checkin.sinConexion');
            return;
          }
        }
        const clave =
          fallo instanceof ApiError ? claveDeErrorDeEntradas(fallo.code) : null;
        setError(clave !== null ? t(clave as TranslationKey) : t('common.tryAgain'));
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    },
    [id, t],
  );

  const escaneado = ({ data }: { data: string }) => {
    // EL MISMO CÓDIGO NO SE MANDA DOS VECES SEGUIDAS. La cámara lo ve en cada
    // fotograma mientras esté delante. La marca la pone `admitir` DESPUÉS de
    // pasar sus guardianes: ponerla aquí quemaba códigos que nunca se llegaron
    // a mandar, y el segundo de dos personas que enseñan el móvil a la vez
    // desaparecía sin dejar rastro.
    if (data === ultimoRef.current) return;
    void admitir(data);
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-eventos' as never);

  const siguiente = () => {
    // NO SE OLVIDA EL ÚLTIMO CÓDIGO. Quien acaba de pasar sigue guardando el
    // móvil con su QR delante del objetivo: reactivar la cámara olvidándolo
    // vuelve a leerlo y pinta un rojo «ya utilizada» que no es de nadie de la
    // cola. Se olvida solo cuando algo falló, que es cuando hay que reintentar.
    setVeredicto(null);
    setError(null);
    setCodigo('');
  };

  const cambiarDeModo = () => {
    setManual((previo) => !previo);
    setVeredicto(null);
    setError(null);
    setCodigo('');
    ultimoRef.current = '';
  };

  const resultado = veredicto?.result ?? null;
  const paso = resultado === 'OK';

  // SIN EVENTO NO HAY PUERTA, y se dice. Antes un enlace sin identificador
  // pintaba la pantalla entera, encendía la cámara y descartaba en silencio
  // todo lo que leía: parecía funcionar y no hacía nada.
  if (!id) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={t('checkin.titulo')} onBack={volver} />
        <StateView
          state="error"
          title={t('checkin.sinEvento')}
          description={t('checkin.sinEventoCuerpo')}
        />
      </AppScreen>
    );
  }

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

  /** El visor, o lo que toque decir cuando no hay visor que enseñar. */
  const camara = () => {
    // TODAVÍA NO SE SABE. El estado nace nulo y se resuelve en un viaje al
    // módulo nativo; pintar «sin cámara» mientras tanto hace parpadear un aviso
    // falso en cada arranque, con un botón que invita a pedir lo que ya se
    // tiene.
    if (permiso === null) {
      return <StateView state="loading" />;
    }
    if (permiso.granted) {
      return (
        <View style={styles.camara}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            active={activa}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={ocupado ? undefined : escaneado}
            accessibilityLabel={t('checkin.visorAccesible')}
          />
          {ocupado ? (
            // COMPROBANDO, Y SE VE. Sin esto la pantalla no cambiaba nada
            // mientras esperaba: quien está en la puerta cree que no leyó,
            // mueve el teléfono y vuelve a acercarlo.
            <View style={[styles.comprobando, { backgroundColor: colors.surfaceAlt }]}>
              <Text variant="secondary">{t('checkin.comprobando')}</Text>
            </View>
          ) : null}
        </View>
      );
    }
    // RECHAZADO NO ES BLOQUEADO. Cuando el teléfono ya no va a volver a
    // preguntar, el botón de «permitir» no hace absolutamente nada: se pulsa,
    // la promesa se resuelve al instante en negativo y no sale ningún diálogo.
    // Ahí la única salida son los ajustes del sistema.
    const bloqueado = permiso.canAskAgain === false;
    return (
      <StateView
        state="empty"
        title={bloqueado ? t('checkin.camaraBloqueada') : t('checkin.sinCamara')}
        description={
          bloqueado ? t('checkin.camaraBloqueadaCuerpo') : t('checkin.sinCamaraCuerpo')
        }
        actionLabel={
          bloqueado
            ? Platform.OS === 'web'
              ? undefined
              : t('checkin.abrirAjustes')
            : t('checkin.permitirCamara')
        }
        onAction={
          bloqueado
            ? Platform.OS === 'web'
              ? undefined
              : abrirAjustes
            : () => void pedirPermiso()
        }
      />
    );
  };

  return (
    <SinTecladoDelante>
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={t('checkin.titulo')} onBack={volver} />

        {veredicto !== null ? (
          <>
            {panel}
            <Button label={t('checkin.siguiente')} onPress={siguiente} />
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
              camara()
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
              onPress={cambiarDeModo}
              disabled={ocupado}
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
  comprobando: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingVertical: spacing.md,
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
