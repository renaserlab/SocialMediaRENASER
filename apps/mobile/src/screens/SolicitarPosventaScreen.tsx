import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  LARGO_MAXIMO_DEL_MOTIVO,
  TIPOS_QUE_SE_PUEDEN_PEDIR,
  TIPO_POR_DEFECTO,
  claveDeErrorDePosventa,
  claveDelMotivo,
  claveDelTipoDeExpediente,
  claveDelVeredicto,
  esPosventaApagada,
  largoDelMotivo,
  motivoParaNoPedir,
  motivoUtil,
  porcentajeDePolitica,
} from '@/lib/posventaDeEventos';
import {
  EventAftersaleRepository,
  type VeredictoDePosventa,
} from '@/repositories/EventAftersaleRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Abrir una solicitud de posventa sobre una compra.
 *
 * NO SE INVENTA NADA. Lo que se enseña arriba es literalmente lo que contestó
 * `aftersale-eligibility`: el veredicto, sus motivos y —SOLO SI VIENE— el
 * porcentaje que permiten las condiciones. `porcentaje_bps` puede ser `null`, y
 * `null` no es cero: en ese caso la pantalla dice que está pendiente de
 * configurar en vez de escribir «0 %», que se leería como una negativa que
 * nadie ha dado.
 *
 * SIN CONDICIONES PUBLICADAS, EL BOTÓN SE VE Y NO SE PUEDE PULSAR. Esconderlo
 * dejaría a la persona buscando algo que no está; desactivarlo con la
 * explicación al lado le dice lo que pasa de verdad: la empresa todavía no lo
 * ha decidido. Un botón desactivado sin motivo a la vista es peor que ninguno.
 *
 * PEDIR NO ES OBTENER. Enviar esto registra una solicitud que revisa una
 * persona. No anula la entrada, no mueve dinero y no promete ninguna fecha, y
 * la confirmación lo dice antes de mandar nada.
 */
export function SolicitarPosventaScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();

  const [veredicto, setVeredicto] = useState<VeredictoDePosventa | null>(null);
  const [tipo, setTipo] = useState<string>(TIPO_POR_DEFECTO);
  const [motivo, setMotivo] = useState('');
  const [errorDelMotivo, setErrorDelMotivo] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noEncontrado' | 'noDisponible' | null
  >(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (!orderId) return;
    setCargando(true);
    setFallo(null);
    try {
      setVeredicto(await EventAftersaleRepository.elegibilidad(orderId));
    } catch (error) {
      if (error instanceof ApiError && esPosventaApagada(error.code)) {
        setFallo('noDisponible');
      } else if (
        error instanceof ApiError &&
        (error.status === 404 || error.code === 'event_order_not_found')
      ) {
        setFallo('noEncontrado');
      } else if (error instanceof ApiError && esFalloDeRed(error.code)) {
        setFallo('sinConexion');
      } else {
        setFallo('red');
      }
    } finally {
      setCargando(false);
    }
  }, [orderId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    const clave =
      error instanceof ApiError ? claveDeErrorDePosventa(error.code) : null;
    if (clave !== null) return t(clave as TranslationKey);
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const enviar = () => {
    // ANTES DEL PRIMER `await`, que aquí es el diálogo de confirmación: dos
    // toques rápidos abrirían dos expedientes sobre la misma compra, y el
    // segundo chocaría con el primero («ya tienes una solicitud abierta»).
    if (ocupadoRef.current || !orderId) return;
    const limpio = motivoUtil(motivo);
    if (limpio === null) {
      setErrorDelMotivo(t('posventa.faltaMotivo'));
      return;
    }
    setErrorDelMotivo(null);
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        const aceptado = await confirm({
          title: t('posventa.confirmarTitulo'),
          message: t('posventa.confirmarCuerpo'),
          confirmLabel: t('posventa.confirmarBoton'),
        });
        if (!aceptado) return;
        const expediente = await EventAftersaleRepository.abrir(
          orderId,
          tipo,
          limpio,
        );
        router.replace(`/posventa/${expediente.id}` as never);
      } catch (error) {
        notify(t('posventa.noSePudo'), textoDelError(error));
        // El veredicto pudo cambiar mientras tanto (otra solicitud abierta, el
        // plazo vencido): se vuelve a preguntar en vez de dejar el formulario
        // ofreciendo algo que el servidor acaba de rechazar.
        void cargar();
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    })();
  };

  const volver = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/mis-entradas' as never);
  };

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('posventa.tituloNueva')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !veredicto) {
    return (
      <AppScreen>
        <AppHeader title={t('posventa.tituloNueva')} onBack={volver} />
        {fallo === 'noEncontrado' || fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'inbox'}
            title={
              fallo === 'noEncontrado'
                ? t('posventa.compraNoEncontrada')
                : t('posventa.noDisponible')
            }
            description={
              fallo === 'noEncontrado'
                ? t('posventa.compraNoEncontradaCuerpo')
                : t('posventa.noDisponibleCuerpo')
            }
            actionLabel={t('miEntrada.titulo')}
            onAction={() => router.replace('/mis-entradas' as never)}
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

  const sinPolitica = veredicto.resultado === 'policy_not_configured';
  const sePuedePedir = veredicto.puede_pedir === true;
  const impedimento = motivoParaNoPedir(veredicto);
  // SOLO SI VIENE. `null` no se convierte en «0 %» por el camino.
  const porcentaje = porcentajeDePolitica(veredicto.porcentaje_bps);
  const escritos = largoDelMotivo(motivo);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('posventa.tituloNueva')} onBack={volver} />

      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather
          name={sePuedePedir ? 'info' : 'alert-circle'}
          size={16}
          color={sePuedePedir ? colors.textMuted : colors.danger}
        />
        <Text
          variant="secondary"
          color={sePuedePedir ? colors.text : colors.danger}
          style={styles.crece}
        >
          {t(claveDelVeredicto(veredicto.resultado) as TranslationKey)}
        </Text>
      </View>

      {veredicto.motivos.length > 0 ? (
        <View style={styles.bloque}>
          <Text variant="caption" color={colors.textMuted}>
            {t('posventa.motivosTitulo')}
          </Text>
          {veredicto.motivos.map((codigo) => (
            <Text key={codigo} variant="secondary">
              {`· ${t(claveDelMotivo(codigo) as TranslationKey)}`}
            </Text>
          ))}
        </View>
      ) : null}

      {veredicto.politica_version ? (
        <Text variant="caption" color={colors.textMuted}>
          {t('posventa.politicaVersion', { version: veredicto.politica_version })}
        </Text>
      ) : null}

      {/*
        EL PORCENTAJE, SOLO SI EL SERVIDOR LO MANDA. Cuando `porcentaje_bps` es
        nulo no se pinta ninguna cifra: se escribe que está sin definir, que es
        lo que pasa. Un «0 %» ahí sería una decisión que nadie ha tomado.
      */}
      {porcentaje !== null ? (
        <Text variant="secondary">{t('posventa.porcentaje', { porcentaje })}</Text>
      ) : (
        <Text variant="caption" color={colors.textMuted}>
          {t('posventa.porcentajeSinDefinir')}
        </Text>
      )}

      {sinPolitica ? (
        <View style={[styles.bloque, { borderColor: colors.border }, styles.recuadro]}>
          <Text variant="secondary" weight="700">
            {t('posventa.sinPoliticaTitulo')}
          </Text>
          <Text variant="secondary" color={colors.textMuted}>
            {t('posventa.sinPoliticaCuerpo')}
          </Text>
        </View>
      ) : null}

      <Text variant="caption" color={colors.textMuted}>
        {t('posventa.queNecesitas')}
      </Text>
      {TIPOS_QUE_SE_PUEDEN_PEDIR.map((candidato) => {
        const elegido = candidato === tipo;
        return (
          <Pressable
            key={candidato}
            onPress={() => setTipo(candidato)}
            disabled={!sePuedePedir}
            accessibilityRole="radio"
            accessibilityState={{ selected: elegido, disabled: !sePuedePedir }}
            accessibilityLabel={t(
              claveDelTipoDeExpediente(candidato) as TranslationKey,
            )}
            style={[
              styles.opcion,
              {
                borderColor: elegido ? colors.primary : colors.border,
                opacity: sePuedePedir ? 1 : 0.5,
              },
            ]}
          >
            <Feather
              name={elegido ? 'check-circle' : 'circle'}
              size={18}
              color={elegido ? colors.primary : colors.textMuted}
            />
            <Text variant="secondary" style={styles.crece}>
              {t(claveDelTipoDeExpediente(candidato) as TranslationKey)}
            </Text>
          </Pressable>
        );
      })}

      <Input
        label={t('posventa.cuentanos')}
        placeholder={t('posventa.motivoEjemplo')}
        value={motivo}
        onChangeText={(texto) => {
          setMotivo(texto.slice(0, LARGO_MAXIMO_DEL_MOTIVO));
          if (errorDelMotivo !== null) setErrorDelMotivo(null);
        }}
        maxLength={LARGO_MAXIMO_DEL_MOTIVO}
        multiline
        numberOfLines={5}
        style={styles.campoLargo}
        disabled={!sePuedePedir}
        error={errorDelMotivo ?? undefined}
      />
      <Text variant="caption" color={colors.textMuted}>
        {t('posventa.motivoAyuda')}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {t('posventa.motivoContador', {
          n: escritos,
          max: LARGO_MAXIMO_DEL_MOTIVO,
        })}
      </Text>

      {/*
        DESACTIVADO CON LA EXPLICACIÓN DELANTE, no escondido. Quien no puede
        pedir tiene derecho a saber por qué, y el motivo viene del servidor.
      */}
      <Button
        label={t('posventa.enviar')}
        onPress={enviar}
        loading={ocupado}
        disabled={ocupado || !sePuedePedir}
      />
      {impedimento !== null ? (
        <Text variant="caption" color={colors.danger}>
          {t(impedimento as TranslationKey)}
        </Text>
      ) : null}

      <Text variant="caption" color={colors.textMuted}>
        {t('posventa.pedirNoEsObtener')}
      </Text>

      <Button
        label={t('posventa.verSolicitudes')}
        variant="secondary"
        onPress={() => router.push('/posventa' as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  bloque: { gap: 4 },
  recuadro: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  opcion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  campoLargo: {
    minHeight: 110,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
