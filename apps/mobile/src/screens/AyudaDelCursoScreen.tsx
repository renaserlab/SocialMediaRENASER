import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { claveDelEstado } from '@/lib/estadoDeSolicitud';
import {
  DevolucionesRepository,
  type SolicitudDeDevolucion,
} from '@/repositories/PaymentRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Ayuda del curso (captura 22).
 *
 * NO ES UN SISTEMA DE SOPORTE NUEVO, y no lo será: cada tipo de problema lleva
 * al sitio que YA lo resuelve —restaurar compras, el soporte de la aplicación,
 * el perfil de quien lo imparte, las devoluciones—. Montar aquí una bandeja de
 * tickets sería un dominio entero para repartir a mano lo que ya está repartido.
 *
 * POR ESO LOS CUATRO DESTINOS SON DISTINTOS. Un menú donde las cuatro opciones
 * acaban en el mismo formulario no es ayuda, es una lista decorativa.
 *
 * «MIS SOLICITUDES» son las devoluciones de ESTE curso. Es lo único con
 * expediente propio; el resto no deja rastro que se pueda listar, y fingir que
 * sí lo deja sería inventar un estado.
 */
export function AyudaDelCursoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { curso } = useLocalSearchParams<{ curso: string }>();

  const [solicitudes, setSolicitudes] = useState<SolicitudDeDevolucion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState(false);
  const generacionRef = useRef(0);

  const cargar = useCallback(async () => {
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    setCargando(true);
    setFallo(false);
    try {
      const todas = await DevolucionesRepository.misSolicitudes();
      if (generacionRef.current !== generacion) return;
      setSolicitudes(curso ? todas.filter((s) => s.courseId === curso) : todas);
    } catch {
      if (generacionRef.current !== generacion) return;
      setFallo(true);
    } finally {
      if (generacionRef.current === generacion) setCargando(false);
    }
  }, [curso]);

  useEffect(() => {
    void cargar();
    return () => {
      generacionRef.current += 1;
    };
  }, [cargar]);

  const opciones = [
    {
      clave: 'acceso',
      icono: 'lock' as const,
      titulo: t('ayuda.accesoTitulo'),
      cuerpo: t('ayuda.accesoCuerpo'),
      // Quien reinstala o cambia de teléfono llega aquí: restaurar compras vive
      // en el propio curso, junto al contenido que no puede abrir.
      ir: () => (curso ? router.push(`/course/${curso}` as never) : undefined),
    },
    {
      clave: 'video',
      icono: 'play-circle' as const,
      titulo: t('ayuda.videoTitulo'),
      cuerpo: t('ayuda.videoCuerpo'),
      ir: () => router.push('/support' as never),
    },
    {
      clave: 'contenido',
      icono: 'file-text' as const,
      titulo: t('ayuda.contenidoTitulo'),
      cuerpo: t('ayuda.contenidoCuerpo'),
      ir: () => router.push('/support' as never),
    },
    {
      clave: 'pago',
      icono: 'credit-card' as const,
      titulo: t('ayuda.pagoTitulo'),
      cuerpo: t('ayuda.pagoCuerpo'),
      ir: () => router.push('/compras' as never),
    },
  ];

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader
        title={t('ayuda.titulo')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/cursos'))}
      />

      <Text variant="title">{t('ayuda.pregunta')}</Text>
      <Text variant="secondary" color={colors.textMuted}>
        {t('ayuda.cuerpo')}
      </Text>

      <View style={styles.opciones}>
        {opciones.map((opcion) => (
          <ListRow
            key={opcion.clave}
            title={opcion.titulo}
            subtitle={opcion.cuerpo}
            leftIcon={opcion.icono}
            rightIcon="chevron-right"
            onPress={opcion.ir}
          />
        ))}
      </View>

      <SectionTitle title={t('ayuda.misSolicitudes')} />
      {cargando ? (
        <StateView state="loading" style={styles.estado} />
      ) : fallo ? (
        <StateView
          state="error"
          description={t('common.loadFailed')}
          onRetry={() => void cargar()}
          style={styles.estado}
        />
      ) : solicitudes.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('ayuda.sinSolicitudes')}
        </Text>
      ) : (
        solicitudes.map((solicitud) => (
          <ListRow
            key={solicitud.id}
            title={t(claveDelEstado(solicitud.status) as 'solicitud.estado.requested')}
            subtitle={fecha(solicitud.requestedAt)}
            leftIcon="file-text"
            rightIcon="chevron-right"
            onPress={() => router.push(`/devoluciones/${solicitud.id}` as never)}
          />
        ))
      )}
    </AppScreen>
  );
}

function fecha(iso: string): string {
  const momento = new Date(iso);
  return Number.isNaN(momento.getTime()) ? '' : momento.toLocaleDateString();
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  opciones: { gap: spacing.sm, marginTop: spacing.sm },
  estado: { minHeight: 120 },
});
