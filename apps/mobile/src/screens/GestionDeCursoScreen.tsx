import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { deCentavos } from '@/lib/dinero';
import { LearningRepository } from '@/repositories/LearningRepository';
import { OwnerRepository, type ResumenDeVentas } from '@/repositories/OwnerRepository';
import { ApiError } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * GESTIONAR UN CURSO NO ES CREARLO.
 *
 * El asistente de creación (`AsistenteDeCursoScreen`) sirve para escribir el
 * curso: su ficha, sus módulos, sus lecciones. Quién está dentro, qué se ha
 * cobrado y qué se ha devuelto son preguntas de DESPUÉS, sobre un curso que ya
 * existe y que puede tener gente pagando. Meterlas dentro del asistente
 * significaría que para mirar a tus alumnos hay que entrar en la pantalla desde
 * la que se cambia el precio.
 *
 * Por eso esto vive aparte y el asistente se ALCANZA desde aquí —«Editar
 * curso»—, sin reimplementar ni un campo suyo.
 *
 * EL PERMISO LO PONE EL SERVIDOR. `can_manage` viene del detalle del curso, y
 * cada llamada de `OwnerRepository` vuelve a comprobarlo: si responde 403 se
 * dice, no se deja la pantalla cargando para siempre.
 */

/**
 * Traducción con claves que TODAVÍA no están en el diccionario.
 *
 * Mismo caso que `useTextosDeDevoluciones`: las claves de gestión llegan en
 * este cambio pero por otro camino —`i18n/*` no se toca desde aquí—, así que
 * mientras tanto se pasan como cadena. La firma es la de `t`, así que cuando
 * estén en `es.ts` basta con borrar esto.
 */
export function useTextosDeGestion(): (
  clave: string,
  params?: Record<string, string | number>,
) => string {
  const { t } = useTranslation();
  return useCallback(
    (clave: string, params?: Record<string, string | number>) =>
      t(clave as TranslationKey, params),
    [t],
  );
}

/** Un 403 no es «no pudimos cargar»: es «esto no es tuyo». */
export function esProhibido(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function GestionDeCursoScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const t = useTextosDeGestion();
  const { id } = useLocalSearchParams<{ id: string }>();
  const courseId = typeof id === 'string' ? id : '';
  const esAdmin = useAppStore((state) => state.user?.isAdmin === true);

  const [titulo, setTitulo] = useState('');
  const [lecciones, setLecciones] = useState(0);
  const [resumen, setResumen] = useState<ResumenDeVentas | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prohibido, setProhibido] = useState(false);

  const cargar = useCallback(async () => {
    if (!courseId) return;
    setCargando(true);
    setError(null);
    setProhibido(false);
    try {
      const detalle = await LearningRepository.getCourseDetail(courseId);
      setTitulo(detalle.course.title);
      setLecciones(detalle.lessons.length);
      if (!detalle.canManage) {
        setProhibido(true);
        return;
      }
      /*
        El resumen comercial va con su propio `catch`: el dominio comercial
        puede no estar montado todavía, y eso no puede dejar sin gestión a
        quien sí tiene el curso. Sin resumen no se pintan ceros —serían un dato
        inventado—: simplemente no se pinta el bloque.
      */
      setResumen(await OwnerRepository.resumenDeVentas(courseId).catch(() => null));
    } catch (e) {
      if (esProhibido(e)) setProhibido(true);
      else setError(e instanceof Error ? e.message : t('common.loadFailed'));
    } finally {
      setCargando(false);
    }
  }, [courseId, t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cabecera = (
    <AppHeader
      title={t('gestion.titulo')}
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

  if (prohibido) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView state="empty" icon="lock" description={t('gestion.sinPermiso')} />
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {cabecera}
      <AppScreen contentStyle={styles.contenido}>
        <Text style={[styles.curso, { color: colors.text }]}>{titulo}</Text>

        {/* 1. RESUMEN */}
        <Text style={[styles.seccion, { color: colors.textMuted }]}>{t('gestion.resumen')}</Text>
        <View
          style={[styles.tarjeta, { borderColor: colors.border, backgroundColor: colors.surface }]}
        >
          <Dato etiqueta={t('gestion.lecciones')} valor={String(lecciones)} />
          {resumen ? (
            <React.Fragment>
              <Dato
                etiqueta={t('gestion.resumenPagados')}
                valor={String(resumen.studentsPaid)}
              />
              <Dato
                etiqueta={t('gestion.resumenDevoluciones')}
                valor={String(resumen.refunds)}
              />
              <Dato
                etiqueta={t('gestion.resumenNeto')}
                valor={deCentavos(resumen.netMinor, resumen.currency)}
              />
            </React.Fragment>
          ) : null}
        </View>

        {/* 2, 3 y 4. Las otras tres secciones, cada una en su pantalla. */}
        <Fila
          icono="users"
          titulo={t('gestion.estudiantes')}
          pie={t('gestion.estudiantesPie')}
          onPress={() => router.push(`/gestionar-curso/${courseId}/estudiantes` as never)}
        />
        <Fila
          icono="bar-chart-2"
          titulo={t('gestion.ventas')}
          pie={t('gestion.ventasPie')}
          onPress={() => router.push(`/gestionar-curso/${courseId}/ventas` as never)}
        />
        <Fila
          icono="edit-3"
          titulo={t('gestion.editar')}
          pie={t('gestion.editarPie')}
          /* El asistente EXISTENTE. Aquí no se reimplementa ni un campo suyo. */
          onPress={() => router.push(`/editar-curso/${courseId}` as never)}
        />

        {esAdmin ? (
          <Fila
            icono="inbox"
            titulo={t('gestion.bandejaAdmin')}
            pie={t('gestion.bandejaAdminPie')}
            onPress={() => router.push('/admin/devoluciones' as never)}
          />
        ) : null}
      </AppScreen>
    </View>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.dato}>
      <Text style={[styles.datoEtiqueta, { color: colors.textMuted }]}>{etiqueta}</Text>
      <Text style={[styles.datoValor, { color: colors.text }]}>{valor}</Text>
    </View>
  );
}

function Fila({
  icono,
  titulo,
  pie,
  onPress,
}: {
  icono: keyof typeof Feather.glyphMap;
  titulo: string;
  pie: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={titulo}
      style={({ pressed }: { pressed: boolean }) => [
        styles.fila,
        {
          borderColor: colors.border,
          backgroundColor: colors.surface,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Feather name={icono} size={18} color={colors.text} />
      <View style={styles.filaTextos}>
        <Text style={[styles.filaTitulo, { color: colors.text }]}>{titulo}</Text>
        <Text style={[styles.filaPie, { color: colors.textMuted }]}>{pie}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  curso: { fontSize: 20, fontWeight: '800' },
  seccion: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
  },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  dato: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  datoEtiqueta: { fontSize: 13 },
  datoValor: { fontSize: 13, fontWeight: '800' },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  filaTextos: { flex: 1, gap: 2 },
  filaTitulo: { fontSize: 15, fontWeight: '700' },
  filaPie: { fontSize: 12 },
});
