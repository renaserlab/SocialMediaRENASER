import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { importeConMoneda } from '@/lib/dinero';
import {
  claveDelEstado,
  estaReembolsada,
  pasosCumplidos,
  sePuedeCancelar,
} from '@/lib/estadoDeSolicitud';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  DevolucionesRepository,
  type SolicitudDeDevolucion,
} from '@/repositories/PaymentRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * El detalle de una solicitud de devolución (capturas 23 y 24).
 *
 * SON LA MISMA PANTALLA. La 23 es una solicitud en revisión y la 24 una ya
 * reembolsada: mismos datos, distinto punto de la línea de tiempo. Dos
 * pantallas separadas habrían sido dos sitios donde arreglar el mismo importe.
 *
 * EL AVISO DE QUE EL ACCESO SE RETIRÓ SOLO CUANDO SE REEMBOLSÓ DE VERDAD.
 * `approved` no basta: aprobar no es haber pagado, y decirlo antes dejaría a
 * alguien esperando un ingreso que todavía no salió —y creyendo que ya perdió
 * el curso—.
 *
 * NO REESCRIBE NADA DEL MOTOR DE DEVOLUCIONES: lee el expediente y lo pinta.
 */
export function DetalleDeSolicitudScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [solicitud, setSolicitud] = useState<SolicitudDeDevolucion | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<unknown>(null);
  const cancelandoRef = useRef(false);
  const generacionRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!id) return;
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    setCargando(true);
    setFallo(null);
    try {
      const datos = await DevolucionesRepository.solicitud(id);
      if (generacionRef.current !== generacion) return;
      setSolicitud(datos);
    } catch (error) {
      if (generacionRef.current !== generacion) return;
      setFallo(error);
    } finally {
      if (generacionRef.current === generacion) setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
    return () => {
      generacionRef.current += 1;
    };
  }, [cargar]);

  const cancelar = async () => {
    if (cancelandoRef.current || !solicitud) return;
    // Echado ANTES del primer `await`, que aquí es el propio diálogo.
    cancelandoRef.current = true;
    try {
      const aceptado = await confirm({
        title: t('solicitud.cancelarTitulo'),
        message: t('solicitud.cancelarCuerpo'),
        confirmLabel: t('solicitud.cancelarConfirmar'),
        destructive: true,
      });
      if (!aceptado) return;
      setSolicitud(await DevolucionesRepository.cancelarSolicitud(solicitud.id));
      toast(t('solicitud.cancelada'));
    } catch (error) {
      notify(
        t('common.saveFailed'),
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : t('common.tryAgain'),
      );
    } finally {
      cancelandoRef.current = false;
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/compras');

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('solicitud.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !solicitud) {
    return (
      <AppScreen>
        <AppHeader title={t('solicitud.titulo')} onBack={volver} />
        <StateView
          state="error"
          description={t('common.loadFailed')}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  const reembolsada = estaReembolsada(solicitud.status);
  const cumplidos = pasosCumplidos(solicitud.status);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader
        title={reembolsada ? t('solicitud.tituloReembolsada') : t('solicitud.titulo')}
        onBack={volver}
      />

      <View style={[styles.cabecera, { backgroundColor: colors.surfaceAlt }]}>
        <View style={styles.cabeceraTexto}>
          {/*
            EL CURSO Y LA FECHA, no el identificador. `ComprasYDevolucionesScreen`
            ya fija la regla —«no se enseña nada técnico: ni identificadores de
            pedido, ni de solicitud»— y romperla solo aquí dejaría dos criterios
            para la misma información.
          */}
          <Text variant="body" weight="800">
            {solicitud.courseTitle}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {t('solicitud.creadaEl', { fecha: fecha(solicitud.requestedAt) })}
          </Text>
        </View>
        <View style={[styles.etiqueta, { borderColor: colors.border }]}>
          <Text variant="caption" weight="700">
            {t(claveDelEstado(solicitud.status) as 'solicitud.estado.requested')}
          </Text>
        </View>
      </View>

      {/* La línea de tiempo: tres pasos, no los ocho estados del expediente. */}
      <View style={styles.linea}>
        {(['recibida', 'revision', 'resolucion'] as const).map((paso, indice) => {
          const hecho = indice < cumplidos;
          return (
            <View key={paso} style={styles.paso}>
              <Feather
                name={hecho ? 'check-circle' : 'circle'}
                size={20}
                color={hecho ? colors.text : colors.textMuted}
              />
              <Text variant="caption" weight="700" style={styles.centrado}>
                {t(`solicitud.paso.${paso}` as 'solicitud.paso.recibida')}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={[styles.ficha, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {t('solicitud.resumen')}
        </Text>
        <Campo
          etiqueta={t('solicitud.monto')}
          valor={importeConMoneda(solicitud.amountMinor, solicitud.currency)}
        />
        <Campo
          etiqueta={t('solicitud.motivo')}
          valor={t(`devolucion.motivo.${solicitud.reason}` as 'devolucion.motivo.other')}
        />
        {/* El detalle que escribió quien pidió, si lo escribió. */}
        {solicitud.explanation ? (
          <Campo etiqueta={t('solicitud.detalle')} valor={solicitud.explanation} />
        ) : null}
        {/* El motivo del rechazo. Las notas internas no salen nunca por aquí. */}
        {solicitud.reviewNotes ? (
          <Campo etiqueta={t('solicitud.respuesta')} valor={solicitud.reviewNotes} />
        ) : null}
        {solicitud.resolvedAt ? (
          <Campo
            etiqueta={t('solicitud.resueltaEl')}
            valor={fecha(solicitud.resolvedAt)}
          />
        ) : null}
      </View>

      {reembolsada ? (
        <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
          <Feather name="layers" size={18} color={colors.textMuted} />
          <View style={styles.avisoTexto}>
            <Text variant="secondary" weight="700">
              {t('solicitud.accesoTitulo')}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('solicitud.accesoCuerpo')}
            </Text>
          </View>
        </View>
      ) : (
        <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
          <Feather name="clock" size={18} color={colors.textMuted} />
          <View style={styles.avisoTexto}>
            <Text variant="secondary" weight="700">
              {t('solicitud.plazoTitulo')}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('solicitud.plazoCuerpo')}
            </Text>
          </View>
        </View>
      )}

      {reembolsada ? (
        <Button
          label={t('solicitud.verComprobante')}
          onPress={() => router.push(`/compras/${solicitud.orderId}` as never)}
        />
      ) : null}

      {sePuedeCancelar(solicitud.status) ? (
        <Button
          label={t('solicitud.cancelar')}
          variant="secondary"
          onPress={() => void cancelar()}
        />
      ) : null}

      <Button
        label={t('solicitud.volverACursos')}
        variant="ghost"
        onPress={() => router.replace('/cursos')}
      />
    </AppScreen>
  );
}

/** Fecha corta, o nada si el servidor mandara algo que no es una fecha. */
function fecha(iso: string): string {
  const momento = new Date(iso);
  return Number.isNaN(momento.getTime()) ? '' : momento.toLocaleDateString();
}

function Campo({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.campo}>
      <Text variant="caption" color={colors.textMuted} style={styles.etiquetaCampo}>
        {etiqueta}
      </Text>
      <Text variant="secondary" style={styles.valorCampo}>
        {valor}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  cabeceraTexto: { flex: 1, gap: 2 },
  etiqueta: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  linea: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  paso: { flex: 1, alignItems: 'center', gap: spacing.xs },
  centrado: { textAlign: 'center' },
  ficha: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  campo: { flexDirection: 'row', gap: spacing.md },
  etiquetaCampo: { width: 96 },
  valorCampo: { flex: 1 },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  avisoTexto: { flex: 1, gap: 2 },
});
