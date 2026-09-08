import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { CursosParaTi } from '@/components/CursosParaTi';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { etiquetaDePrecio } from '@/lib/dinero';
import { LearningRepository } from '@/repositories/LearningRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Course, MyCourse } from '@/types';

/**
 * La portada de Cursos.
 *
 * QUÉ SE ENSEÑA Y QUÉ NO, que es la única decisión de peso de esta pantalla.
 * La referencia trae valoración con estrellas, número de alumnos, duración,
 * nivel y una fila de «objetivos». **Nada de eso existe en el servidor** —ver
 * `docs/Z_MATRIZ_DE_VISTAS.md`: `ReviewRead` no tiene puntuación, no hay
 * taxonomía de objetivos y el catálogo no devuelve duración ni nivel—. Pintarlo
 * significaría inventarlo, así que aquí no está. El precio sí: `price_minor` y
 * `currency` son columnas reales del curso.
 *
 * TRES SECCIONES, LAS TRES CON DATOS DEL SERVIDOR:
 *   · «Continúa aprendiendo» — `GET /learning/me/courses`, solo lo empezado y
 *     sin terminar, con el progreso que devuelve el servidor.
 *   · «Cursos para ti» — el componente que ya existía, sobre
 *     `GET /recommendations/courses`.
 *   · «Todo el catálogo» — `GET /catalog/courses`, que solo trae publicados.
 *
 * NO HAY BUSCADOR TODAVÍA, y es a propósito: `GET /catalog/courses` no acepta
 * ningún parámetro de búsqueda. Una caja de búsqueda que devolviera el catálogo
 * entero sin filtrar sería peor que no tenerla, porque parecería que ha buscado.
 */
export function CursosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [enCurso, setEnCurso] = useState<MyCourse[]>([]);
  const [catalogo, setCatalogo] = useState<Course[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      // EL CATÁLOGO ES LO OBLIGATORIO Y «MIS CURSOS» NO. Sin sesión, o con la
      // petición de mis cursos caída, la portada tiene que seguir enseñando el
      // catálogo: convertir un fallo de lo accesorio en una pantalla vacía deja
      // sin ver la tienda a quien solo venía a mirar.
      const cursos = await LearningRepository.listCourses(24);
      setCatalogo(cursos);
      try {
        const mios = await LearningRepository.myCourses();
        setEnCurso(mios.filter((c) => c.state === 'in_progress'));
      } catch {
        setEnCurso([]);
      }
    } catch (e) {
      setFallo(e instanceof Error ? e.message : t('common.tryAgain'));
    } finally {
      setCargando(false);
    }
  }, [t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('verticales.cursos')} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen>
        <AppHeader title={t('verticales.cursos')} />
        <StateView state="error" description={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }

  return (
    <AppScreen>
      <AppHeader title={t('verticales.cursos')} />
      <ScrollView contentContainerStyle={styles.contenido}>
        {enCurso.length > 0 ? (
          <View style={styles.seccion}>
            <SectionTitle title={t('cursos.continuaAprendiendo')} />
            {enCurso.map((curso) => (
              <Pressable
                key={curso.id}
                style={({ pressed }) => [
                  styles.fila,
                  { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                ]}
                onPress={() =>
                  curso.nextLessonId
                    ? router.push(`/lesson/${curso.nextLessonId}`)
                    : router.push(`/course/${curso.id}`)
                }
                accessibilityRole="button"
                accessibilityLabel={`${curso.title}. ${t('cursos.progreso').replace(
                  '{porcentaje}',
                  String(curso.progressPercent),
                )}`}
              >
                {curso.coverUrl ? (
                  <ExpoImage source={{ uri: curso.coverUrl }} style={styles.miniatura} />
                ) : (
                  <View style={[styles.miniatura, { backgroundColor: colors.surface }]} />
                )}
                <View style={styles.textoDeFila}>
                  <Text numberOfLines={2} style={[styles.tituloDeFila, { color: colors.text }]}>
                    {curso.title}
                  </Text>
                  {/* El porcentaje lo calcula el SERVIDOR y llega en la respuesta:
                      no se deduce aquí de lecciones vistas, que es como se acaba
                      enseñando un número distinto en cada pantalla. */}
                  <Text style={[styles.pieDeFila, { color: colors.textMuted }]}>
                    {t('cursos.progreso').replace('{porcentaje}', String(curso.progressPercent))}
                  </Text>
                </View>
                <Feather name="play-circle" size={24} color={colors.text} />
              </Pressable>
            ))}
          </View>
        ) : null}

        <CursosParaTi />

        <View style={styles.seccion}>
          <SectionTitle title={t('cursos.todoElCatalogo')} />
          {catalogo.length === 0 ? (
            <StateView state="empty" description={t('cursos.catalogoVacio')} />
          ) : (
            <View style={styles.rejilla}>
              {catalogo.map((curso) => (
                <Pressable
                  key={curso.id}
                  style={({ pressed }) => [
                    styles.tarjeta,
                    { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                  ]}
                  onPress={() => router.push(`/course/${curso.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={curso.title}
                >
                  {curso.coverUrl ? (
                    <ExpoImage source={{ uri: curso.coverUrl }} style={styles.portada} />
                  ) : (
                    <View style={[styles.portada, { backgroundColor: colors.surface }]} />
                  )}
                  <Text numberOfLines={2} style={[styles.tituloDeTarjeta, { color: colors.text }]}>
                    {curso.title}
                  </Text>
                  {/* Precio y moneda son columnas reales. Valoración, número de
                      alumnos, duración y nivel NO lo son, y por eso no están. */}
                  <Text style={[styles.precio, { color: colors.textMuted }]}>
                    {etiquetaDePrecio(curso.priceMinor, curso.currency)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { paddingBottom: spacing.xl, gap: spacing.lg },
  seccion: { gap: spacing.sm },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    padding: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
  },
  miniatura: { width: 72, height: 52, borderRadius: radius.sm },
  textoDeFila: { flex: 1, gap: 2 },
  tituloDeFila: { fontSize: 15, fontWeight: '600' },
  pieDeFila: { fontSize: 13 },
  rejilla: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  tarjeta: { width: '47%', gap: 4 },
  portada: { width: '100%', aspectRatio: 16 / 10, borderRadius: radius.sm },
  tituloDeTarjeta: { fontSize: 14, fontWeight: '600' },
  precio: { fontSize: 13 },
});
