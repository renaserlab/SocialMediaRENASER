import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import {
  ESPERA_ENTRE_REINTENTOS_MS,
  REINTENTOS_MAXIMOS,
  convieneReintentar,
  estadoDeLaVuelta,
  ordenDeLaUrl,
  type EstadoDeLaVuelta,
} from '@/lib/vueltaDelPago';
import { CommerceRepository } from '@/repositories/PaymentRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La pantalla a la que vuelve quien acaba de pasar por la pasarela.
 *
 * ANTES NO EXISTÍA. El checkout mandaba a `/pago` y a `/pago/cancelado`, dos
 * rutas que no estaban en la aplicación y sin `+not-found` que las recogiera:
 * quien acababa de pagar caía en la pantalla de ruta desconocida de
 * expo-router, sin saber si se le había cobrado y sin ninguna salida.
 *
 * LO QUE ESTA PANTALLA NO HACE: conceder acceso. No puede, y no debe. Lo único
 * que trae el navegador es `?order=<id>`, un parámetro que escribe cualquiera.
 * Se le pregunta al servidor por esa orden y se cuenta lo que conteste.
 *
 * REFRESCAR NO DUPLICA NADA, porque esto solo lee: no crea órdenes ni concede
 * derechos. Volver a cargar la página vuelve a preguntar, y ya está.
 */
export function VueltaDelPagoScreen({ cancelada = false }: { cancelada?: boolean }) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const parametros = useLocalSearchParams<{ order?: string }>();

  const orderId = ordenDeLaUrl(parametros.order);
  const [estado, setEstado] = useState<EstadoDeLaVuelta>(
    orderId === null ? 'no_encontrada' : 'verificando',
  );
  const [courseId, setCourseId] = useState<string | null>(null);
  const intentos = useRef(0);
  const vivo = useRef(true);

  const preguntar = useCallback(async () => {
    if (orderId === null) return;
    try {
      const orden = await CommerceRepository.estadoDeOrden(orderId);
      if (!vivo.current) return;
      setCourseId(orden.courseId || null);
      setEstado(estadoDeLaVuelta(orden, null));
    } catch (e) {
      if (!vivo.current) return;
      // UN 404 NO ES UN FALLO DE RED, y confundirlos deja a alguien
      // reintentando sobre una orden que nunca va a aparecer.
      const noEsta =
        typeof e === 'object' && e !== null && 'status' in e && (e as { status: number }).status === 404;
      setEstado(estadoDeLaVuelta(null, noEsta ? 'no_encontrada' : 'red'));
    }
  }, [orderId]);

  useEffect(() => {
    vivo.current = true;
    void preguntar();
    return () => {
      vivo.current = false;
    };
  }, [preguntar]);

  useEffect(() => {
    if (!convieneReintentar(estado) || intentos.current >= REINTENTOS_MAXIMOS) return;
    const espera = setTimeout(() => {
      intentos.current += 1;
      void preguntar();
    }, ESPERA_ENTRE_REINTENTOS_MS);
    return () => clearTimeout(espera);
  }, [estado, preguntar]);

  const alCurso = () => {
    if (courseId) router.replace(`/course/${courseId}`);
    else router.replace('/');
  };
  const aMisCompras = () => router.replace('/compras');

  // El texto de cada estado sale del diccionario, y cada uno lleva su salida:
  // una pantalla de vuelta de pago sin botón es una trampa.
  if (estado === 'verificando') {
    return (
      <AppScreen contentStyle={styles.pantalla}>
        <StateView state="loading" title={t('pago.verificando')} />
      </AppScreen>
    );
  }

  const porEstado: Record<
    Exclude<EstadoDeLaVuelta, 'verificando'>,
    { titulo: string; cuerpo: string; accion: string; alPulsar: () => void; reintentar?: boolean }
  > = {
    confirmado: {
      titulo: t('pago.confirmadoTitulo'),
      cuerpo: t('pago.confirmadoCuerpo'),
      accion: t('pago.irAlCurso'),
      alPulsar: alCurso,
    },
    concediendo: {
      titulo: t('pago.concediendoTitulo'),
      cuerpo: t('pago.concediendoCuerpo'),
      accion: t('pago.verMisCompras'),
      alPulsar: aMisCompras,
    },
    pendiente: {
      titulo: t('pago.pendienteTitulo'),
      cuerpo: t('pago.pendienteCuerpo'),
      accion: t('pago.verMisCompras'),
      alPulsar: aMisCompras,
    },
    rechazado: {
      titulo: cancelada ? t('pago.canceladoTitulo') : t('pago.rechazadoTitulo'),
      cuerpo: cancelada ? t('pago.canceladoCuerpo') : t('pago.rechazadoCuerpo'),
      accion: t('pago.volverAlCurso'),
      alPulsar: alCurso,
    },
    devuelto: {
      titulo: t('pago.devueltoTitulo'),
      cuerpo: t('pago.devueltoCuerpo'),
      accion: t('pago.verMisCompras'),
      alPulsar: aMisCompras,
    },
    error_recuperable: {
      titulo: t('pago.errorTitulo'),
      cuerpo: t('pago.errorCuerpo'),
      accion: t('common.tryAgain'),
      alPulsar: () => void preguntar(),
      reintentar: true,
    },
    no_encontrada: {
      titulo: t('pago.noEncontradaTitulo'),
      cuerpo: t('pago.noEncontradaCuerpo'),
      accion: t('pago.verMisCompras'),
      alPulsar: aMisCompras,
    },
  };

  const vista = porEstado[estado];

  return (
    <AppScreen contentStyle={styles.pantalla}>
      <View
        style={styles.contenido}
        accessibilityLiveRegion="polite"
        accessibilityRole={estado === 'error_recuperable' ? 'alert' : undefined}
      >
        <Text style={[styles.titulo, { color: colors.text }]}>{vista.titulo}</Text>
        <Text style={[styles.cuerpo, { color: colors.textMuted }]}>{vista.cuerpo}</Text>
      </View>
      <Button label={vista.accion} onPress={vista.alPulsar} />
      {estado !== 'confirmado' ? (
        <Button
          label={t('pago.volverAlInicio')}
          variant="ghost"
          onPress={() => router.replace('/')}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  pantalla: { flex: 1, justifyContent: 'center', gap: spacing.md, padding: spacing.lg },
  contenido: { gap: spacing.sm, alignItems: 'center' },
  titulo: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  cuerpo: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
});
