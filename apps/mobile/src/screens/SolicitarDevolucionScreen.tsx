import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useGarantia } from '@/hooks/useGarantia';
import { confirm } from '@/lib/confirm';
import { DevolucionesRepository, formatAmount } from '@/repositories/PaymentRepository';
import type { MotivoDeDevolucion } from '@/repositories/PaymentRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { type TranslationKey } from '@/i18n';

/**
 * Pedir la devolución de un curso.
 *
 * LO QUE EL CLIENTE NO ELIGE. Ni el pedido, ni el importe, ni si tiene derecho.
 * El `order_id` llega desde `refund-eligibility`, o sea desde el servidor;
 * escribirlo en la URL sería poder pedir la devolución del pedido de otro. El
 * importe se ENSEÑA —viene de la misma respuesta— pero no se envía: un
 * formulario que manda cuánto devolver es un formulario que deja elegirlo.
 *
 * DOBLE ENVÍO. Es el fallo caro de esta pantalla: dos toques rápidos son dos
 * expedientes sobre la misma compra. Se corta en tres sitios —el botón se
 * apaga, un cerrojo síncrono impide reentrar antes del primer render, y el
 * servidor tiene un índice parcial que rechaza la segunda solicitud viva sobre
 * la misma orden— porque el estado de React no es una garantía: se aplica en el
 * siguiente render, y el segundo toque puede llegar antes.
 */

/** Los cuatro del enum del backend, en el orden en que se ofrecen. */
const MOTIVOS: readonly MotivoDeDevolucion[] = [
  'not_as_expected',
  'content_quality',
  'technical_problem',
  'other',
];

export function SolicitarDevolucionScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { curso } = useLocalSearchParams<{ curso?: string }>();

  const { estado, cargando, error, recargar } = useGarantia(curso, !!curso);

  const [motivo, setMotivo] = useState<MotivoDeDevolucion | null>(null);
  const [faltaMotivo, setFaltaMotivo] = useState(false);
  const [explicacion, setExplicacion] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  /**
   * Cerrojo SÍNCRONO. `enviando` se aplica en el siguiente render; entre el
   * primer toque y ese render caben más toques, y cada uno abriría su propio
   * expediente.
   */
  const enviandoRef = useRef(false);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const enviar = async (): Promise<void> => {
    if (enviandoRef.current) return;
    // El motivo es obligatorio: sin él no se envía nada y se dice por qué, en
    // vez de dejar un botón apagado sin explicación.
    if (!motivo) {
      setFaltaMotivo(true);
      return;
    }
    const orderId = estado?.orderId;
    if (!orderId) return;

    const aceptado = await confirm({
      title: t('devolucion.confirmarTitulo'),
      message: t('devolucion.confirmarCuerpo', {
        importe: formatAmount(estado.amountMinor, estado.currency),
      }),
      confirmLabel: t('common.send'),
    });
    if (!aceptado) return;

    enviandoRef.current = true;
    setEnviando(true);
    setFallo(null);
    try {
      await DevolucionesRepository.crearSolicitud({
        orderId,
        reason: motivo,
        explanation: explicacion,
      });
      setEnviado(true);
    } catch (e) {
      setFallo(e instanceof Error ? e.message : t('common.tryAgain'));
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
  };

  const cabecera = (
    <AppHeader title={t('devolucion.titulo')} onBack={volver} />
  );

  if (!curso) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView state="error" description={t('devolucion.sinCompra')} />
      </View>
    );
  }

  if (cargando && !estado) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView state="loading" />
      </View>
    );
  }

  if (error && !estado) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView state="error" description={error} onRetry={recargar} />
      </View>
    );
  }

  // Enviada. No se deja el formulario detrás: volver a él invitaría a repetir.
  if (enviado) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView
          state="empty"
          icon="check-circle"
          title={t('devolucion.exitoTitulo')}
          description={t('devolucion.exitoCuerpo')}
          actionLabel={t('devolucion.verEstado')}
          onAction={() => router.replace('/compras' as never)}
        />
      </View>
    );
  }

  /*
    Sin derecho no hay formulario, y se dice cuál de los motivos es. Enseñar los
    campos y rechazar al enviar sería pedir que alguien escriba para nada.
  */
  if (!estado || !estado.elegible || !estado.orderId) {
    // Una frase por código, sin huecos que rellenar: aquí no hay ninguna fecha
    // a mano y una clave con `{fecha}` dejaría el hueco escrito en pantalla.
    const clave = estado?.motivo ? `devolucion.noDisponible.${estado.motivo}` : undefined;
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView
          state="empty"
          icon="shield-off"
          title={t('devolucion.noDisponibleTitulo')}
          description={clave ? t(clave as TranslationKey) : t('devolucion.noDisponibleCuerpo')}
          actionLabel={t('common.back')}
          onAction={volver}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {cabecera}
      <AppScreen contentStyle={styles.contenido}>
        <Text style={[styles.importe, { color: colors.text }]}>
          {t('devolucion.importe', {
            importe: formatAmount(estado.amountMinor, estado.currency),
          })}
        </Text>

        {/* 1. El motivo, obligatorio. */}
        <Text
          style={[styles.seccion, { color: colors.text }]}
          nativeID="motivo-de-devolucion"
        >
          {t('devolucion.motivoTitulo')}
        </Text>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={t('devolucion.motivoTitulo')}
          style={styles.opciones}
        >
          {MOTIVOS.map((opcion) => {
            const elegida = motivo === opcion;
            const etiqueta = t(`devolucion.motivo.${opcion}`);
            return (
              <Pressable
                key={opcion}
                onPress={() => {
                  setMotivo(opcion);
                  setFaltaMotivo(false);
                }}
                disabled={enviando}
                accessible
                focusable
                accessibilityRole="radio"
                accessibilityLabel={etiqueta}
                accessibilityState={{ checked: elegida, disabled: enviando }}
                style={[
                  styles.opcion,
                  {
                    borderColor: elegida
                      ? colors.primary
                      : faltaMotivo
                        ? colors.danger
                        : colors.border,
                    backgroundColor: colors.surface,
                  },
                ]}
              >
                <Feather
                  name={elegida ? 'check-circle' : 'circle'}
                  size={18}
                  color={elegida ? colors.primary : colors.textMuted}
                />
                <Text style={[styles.opcionTexto, { color: colors.text }]}>{etiqueta}</Text>
              </Pressable>
            );
          })}
        </View>
        {faltaMotivo ? (
          <View style={styles.aviso} accessibilityLiveRegion="polite">
            <Feather name="alert-circle" size={14} color={colors.danger} />
            <Text style={[styles.avisoTexto, { color: colors.danger }]}>
              {t('devolucion.motivoObligatorio')}
            </Text>
          </View>
        ) : null}

        {/* 2. La explicación, opcional. */}
        <Text style={[styles.seccion, { color: colors.text }]} nativeID="explicacion">
          {t('devolucion.explicacionEtiqueta')}
        </Text>
        <TextInput
          value={explicacion}
          onChangeText={setExplicacion}
          editable={!enviando}
          multiline
          numberOfLines={4}
          maxLength={2000}
          placeholder={t('devolucion.explicacionPista')}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={t('devolucion.explicacionEtiqueta')}
          accessibilityLabelledBy="explicacion"
          style={[
            styles.caja,
            { borderColor: colors.border, backgroundColor: colors.surface, color: colors.text },
          ]}
        />

        {/* 3. Las consecuencias, ANTES de la confirmación. */}
        <View style={[styles.consecuencias, { borderColor: colors.border }]}>
          <Text style={[styles.seccion, { color: colors.text }]}>
            {t('devolucion.consecuenciasTitulo')}
          </Text>
          {['1', '2', '3', '4'].map((n) => (
            <View key={n} style={styles.punto}>
              <Feather name="chevron-right" size={14} color={colors.textMuted} />
              <Text style={[styles.puntoTexto, { color: colors.textMuted }]}>
                {t(`devolucion.consecuencia${n}` as TranslationKey)}
              </Text>
            </View>
          ))}
        </View>

        {fallo ? (
          <View style={styles.aviso} accessibilityLiveRegion="polite">
            <Feather name="alert-circle" size={14} color={colors.danger} />
            <Text style={[styles.avisoTexto, { color: colors.danger }]}>
              {t('devolucion.errorTitulo')} {fallo}
            </Text>
          </View>
        ) : null}

        <Button
          label={enviando ? t('devolucion.enviando') : t('devolucion.enviar')}
          // Apagado mientras se envía: es la mitad visible de la protección
          // contra el doble envío. La otra mitad es `enviandoRef`.
          disabled={enviando}
          loading={enviando}
          onPress={() => void enviar()}
          style={styles.boton}
        />
        <Button
          label={t('common.cancel')}
          variant="ghost"
          disabled={enviando}
          onPress={volver}
        />
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.xl, paddingBottom: spacing.xxl, gap: spacing.sm },
  importe: { fontSize: 16, fontWeight: '800' },
  seccion: { fontSize: 13, fontWeight: '800', marginTop: spacing.lg },
  opciones: { gap: spacing.sm, marginTop: spacing.sm },
  opcion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    minHeight: 52,
  },
  opcionTexto: { fontSize: 14, fontWeight: '600', flex: 1 },
  caja: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.md,
    minHeight: 96,
    fontSize: 14,
    textAlignVertical: 'top',
    marginTop: spacing.sm,
  },
  consecuencias: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.xl,
    gap: spacing.xs,
  },
  punto: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  puntoTexto: { fontSize: 12, lineHeight: 18, flex: 1 },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  avisoTexto: { fontSize: 12, flex: 1 },
  boton: { marginTop: spacing.xl },
});
