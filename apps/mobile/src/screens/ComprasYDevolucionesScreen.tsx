import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { LearningRepository } from '@/repositories/LearningRepository';
import {
  CommerceRepository,
  DevolucionesRepository,
  formatAmount,
} from '@/repositories/PaymentRepository';
import type {
  CompraDelHistorial,
  EstadoDeSolicitud,
  SolicitudDeDevolucion,
} from '@/repositories/PaymentRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { type TranslationKey } from '@/i18n';

/**
 * El expediente comercial de una cuenta: qué compró y qué devolvió.
 *
 * EL REGISTRO NO DEPENDE DEL ACCESO. Una compra devuelta sigue siendo una
 * compra: tiene fecha, importe y un pedido detrás, y quien la hizo tiene que
 * poder verla aunque el curso ya no se le abra. Filtrar por «tiene acceso»
 * borraría de la vista precisamente las operaciones sobre las que alguien va a
 * preguntar. Lo que cambia es que se DICE que el acceso ya no está.
 *
 * TODO VIENE DEL SERVIDOR, nunca del almacenamiento del teléfono: allí no hay
 * forma de saber si algo se devolvió, y quien reinstale se quedaría sin
 * historial.
 *
 * NO SE ENSEÑA NADA TÉCNICO: ni identificadores de pedido, ni de solicitud, ni
 * la pasarela, ni ninguna URL de pago.
 */

/** Estados desde los que quien pidió la devolución puede retirarla. */
const SE_PUEDE_RETIRAR: readonly EstadoDeSolicitud[] = [
  'requested',
  'under_review',
  'failed',
];

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

export function ComprasYDevolucionesScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { t } = useTranslation();

  const [compras, setCompras] = useState<CompraDelHistorial[]>([]);
  const [solicitudes, setSolicitudes] = useState<SolicitudDeDevolucion[]>([]);
  const [titulos, setTitulos] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Qué solicitud se está retirando; también es el cerrojo contra el doble toque. */
  const [retirando, setRetirando] = useState<string | null>(null);
  const retirandoRef = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      /*
        Las solicitudes van con su propio `catch`: que el módulo de
        devoluciones no esté no puede dejar a nadie sin su historial de
        compras, que es lo que exigen las tiendas.
      */
      const [historial, mias] = await Promise.all([
        CommerceRepository.history(),
        DevolucionesRepository.misSolicitudes().catch(
          () => [] as SolicitudDeDevolucion[],
        ),
      ]);
      setCompras(historial);
      setSolicitudes(mias);

      /*
        Los títulos, en UNA petición al catálogo y no una por compra. Lo que no
        aparezca ahí —un curso retirado, por ejemplo— se completa con el título
        que ya viaja dentro de cada solicitud.
      */
      const mapa: Record<string, string> = {};
      for (const solicitud of mias) {
        if (solicitud.courseTitle) mapa[solicitud.courseId] = solicitud.courseTitle;
      }
      const catalogo = await LearningRepository.listCourses().catch(() => []);
      for (const curso of catalogo) {
        if (curso.title) mapa[curso.id] = curso.title;
      }
      setTitulos(mapa);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.loadFailed'));
    } finally {
      setCargando(false);
    }
  }, [t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const tituloDe = (courseId: string): string =>
    titulos[courseId] ?? t('compras.cursoDesconocido');

  /** Solicitud viva sobre esa orden, si la hay. Es la que se puede retirar. */
  const solicitudViva = (orderId: string): SolicitudDeDevolucion | undefined =>
    solicitudes.find(
      (s) => s.orderId === orderId && SE_PUEDE_RETIRAR.includes(s.status),
    );

  const retirar = async (solicitud: SolicitudDeDevolucion): Promise<void> => {
    // Cerrojo síncrono: `retirando` no está puesto hasta el siguiente render.
    // Se cierra ANTES del diálogo: detrás no protege nada, porque los dos
    // toques lo encuentran abierto y acaban abriendo dos diálogos.
    if (retirandoRef.current) return;
    retirandoRef.current = true;
    const aceptado = await confirm({
      title: t('compras.retirarTitulo'),
      message: t('compras.retirarCuerpo'),
      confirmLabel: t('compras.retirar'),
    });
    if (!aceptado) {
      retirandoRef.current = false;
      return;
    }
    setRetirando(solicitud.id);
    try {
      await DevolucionesRepository.cancelarSolicitud(solicitud.id);
      toast(t('compras.retirada'));
      await cargar();
    } catch (e) {
      notify(
        t('compras.retirarFallo'),
        e instanceof Error ? e.message : t('common.tryAgain'),
      );
    } finally {
      retirandoRef.current = false;
      setRetirando(null);
    }
  };

  const cabecera = (
    <AppHeader
      title={t('compras.titulo')}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
    />
  );

  if (cargando) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView state="loading" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView state="error" description={error} onRetry={() => void cargar()} />
      </View>
    );
  }

  if (compras.length === 0 && solicitudes.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView
          state="empty"
          icon="shopping-bag"
          title={t('compras.vacioTitulo')}
          description={t('compras.vacioCuerpo')}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {cabecera}
      <AppScreen contentStyle={styles.contenido}>
        {compras.length > 0 ? (
          <React.Fragment>
            <Text style={[styles.seccion, { color: colors.textMuted }]}>
              {t('compras.seccionCompras')}
            </Text>
            {compras.map((compra) => {
              const viva = solicitudViva(compra.id);
              return (
                <View
                  key={compra.id}
                  style={[
                    styles.ficha,
                    { borderColor: colors.border, backgroundColor: colors.surface },
                  ]}
                >
                  <Text style={[styles.nombre, { color: colors.text }]}>
                    {tituloDe(compra.courseId)}
                  </Text>
                  <Text style={[styles.dato, { color: colors.textMuted }]}>
                    {fechaLegible(compra.purchasedAt)} ·{' '}
                    {formatAmount(compra.amountMinor, compra.currency)}
                  </Text>
                  <Etiqueta texto={t(`compras.estado.${compra.status}` as TranslationKey)} />
                  {/*
                    QUE VERSION SE COMPRO. Solo cuando consta: en las compras
                    anteriores al versionado no hay forma de saber que contenido
                    se vendio, y escribir «versión 1» seria inventarlo. Callarse
                    es la respuesta honesta, y por eso no hay rama `else`.
                  */}
                  {compra.courseVersion !== null ? (
                    <Text style={[styles.nota, { color: colors.textMuted }]}>
                      {t('compras.versionAdquirida', { version: compra.courseVersion })}
                    </Text>
                  ) : null}
                  {/*
                    El aviso de acceso retirado va DENTRO de la fila, no en
                    lugar de ella: la compra sigue existiendo y lo que ha
                    cambiado es otra cosa.
                  */}
                  {!compra.hasAccess ? (
                    <Text style={[styles.nota, { color: colors.textMuted }]}>
                      {t('compras.sinAcceso')}
                    </Text>
                  ) : null}
                  <View style={styles.acciones}>
                    <Enlace
                      icono="arrow-right"
                      texto={t('compras.verCurso')}
                      onPress={() => router.push(`/course/${compra.courseId}` as never)}
                    />
                    {viva ? (
                      <Enlace
                        icono="x-circle"
                        texto={t('compras.retirar')}
                        deshabilitado={retirando !== null}
                        onPress={() => void retirar(viva)}
                      />
                    ) : null}
                  </View>
                </View>
              );
            })}
          </React.Fragment>
        ) : null}

        {solicitudes.length > 0 ? (
          <React.Fragment>
            <Text style={[styles.seccion, { color: colors.textMuted }]}>
              {t('compras.seccionSolicitudes')}
            </Text>
            {solicitudes.map((solicitud) => (
              <View
                key={solicitud.id}
                style={[
                  styles.ficha,
                  { borderColor: colors.border, backgroundColor: colors.surface },
                ]}
              >
                <Text style={[styles.nombre, { color: colors.text }]}>
                  {solicitud.courseTitle || tituloDe(solicitud.courseId)}
                </Text>
                <Text style={[styles.dato, { color: colors.textMuted }]}>
                  {t('compras.pedidaEl', { fecha: fechaLegible(solicitud.requestedAt) })} ·{' '}
                  {formatAmount(solicitud.amountMinor, solicitud.currency)}
                </Text>
                <Etiqueta texto={t(`devolucion.estado.${solicitud.status}`)} />
                {solicitud.resolvedAt ? (
                  <Text style={[styles.nota, { color: colors.textMuted }]}>
                    {t('compras.resueltaEl', { fecha: fechaLegible(solicitud.resolvedAt) })}
                  </Text>
                ) : null}
                {/* El motivo del rechazo SÍ se le dice a quien lo pidió: es su
                    expediente. Las notas internas no llegan hasta aquí. */}
                {solicitud.reviewNotes ? (
                  <Text style={[styles.nota, { color: colors.textMuted }]}>
                    {t('compras.motivoDelRechazo', { texto: solicitud.reviewNotes })}
                  </Text>
                ) : null}
                {SE_PUEDE_RETIRAR.includes(solicitud.status) ? (
                  <View style={styles.acciones}>
                    <Enlace
                      icono="x-circle"
                      texto={t('compras.retirar')}
                      deshabilitado={retirando !== null}
                      onPress={() => void retirar(solicitud)}
                    />
                  </View>
                ) : null}
              </View>
            ))}
          </React.Fragment>
        ) : null}
      </AppScreen>
    </View>
  );
}

function Etiqueta({ texto }: { texto: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.etiqueta, { borderColor: colors.border }]}>
      <Text style={[styles.etiquetaTexto, { color: colors.text }]}>{texto}</Text>
    </View>
  );
}

function Enlace({
  icono,
  texto,
  onPress,
  deshabilitado = false,
}: {
  icono: keyof typeof Feather.glyphMap;
  texto: string;
  onPress: () => void;
  deshabilitado?: boolean;
}) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={deshabilitado}
      accessible
      focusable
      accessibilityRole="button"
      accessibilityLabel={texto}
      accessibilityState={{ disabled: deshabilitado }}
      style={[styles.enlace, { opacity: deshabilitado ? 0.5 : 1 }]}
    >
      <Feather name={icono} size={14} color={colors.text} />
      <Text style={[styles.enlaceTexto, { color: colors.text }]}>{texto}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  seccion: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
  },
  ficha: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  nombre: { fontSize: 15, fontWeight: '800' },
  dato: { fontSize: 12 },
  nota: { fontSize: 12, lineHeight: 17, marginTop: spacing.xs },
  etiqueta: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    marginTop: spacing.xs,
  },
  etiquetaTexto: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  acciones: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs },
  enlace: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    // 44 pt es el minimo que se puede pulsar con fiabilidad; con el relleno
    // solo se quedaba por debajo.
    minHeight: 44,
  },
  enlaceTexto: { fontSize: 13, fontWeight: '700' },
});
