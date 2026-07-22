import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { CourseContentEditor } from '@/components/CourseContentEditor';
import { CourseHighlights } from '@/components/CourseHighlights';
import { CreateCatalogSheet } from '@/components/CreateCatalogSheet';
import { StateView } from '@/components/StateView';
import { assets } from '@/data/assets';
import { useCourse } from '@/hooks/useCourse';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function CourseScreen() {
  const [editing, setEditing] = React.useState(false);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // Curso a través de la capa de repositorio (mock hoy, backend mañana).
  const { course, lessons, loading, error, reload } = useCourse(id);
  const purchasedIds = useAppStore((state) => state.purchasedCourseIds);
  // Solo la administracion edita el temario; la RLS lo impone de verdad.
  const isAdmin = useAppStore((state) => state.user?.isAdmin === true);
  // Primera leccion sin completar; si estan todas, la primera del curso.
  const firstLessonId = (lessons.find((l) => !l.completed) ?? lessons[0])?.id;

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Programa" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="loading" />
      </View>
    );
  }

  if (error || !course) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Programa" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  const purchased = purchasedIds.includes(course.id);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Programa"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        // Editar los datos del curso vive aqui, junto al temario: asi el
        // administrador gestiona todo el curso desde un solo sitio.
        rightIcon={isAdmin ? 'edit-2' : undefined}
        onRightPress={isAdmin ? () => setEditing(true) : undefined}
      />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        {/* Portada real del curso; el asset local solo mientras no tenga. */}
        <Image
          source={course.coverUrl ? { uri: course.coverUrl } : assets.course}
          style={[styles.hero, { borderColor: colors.border }]}
        />
        <View style={styles.container}>
          <Text style={[styles.title, { color: colors.text }]}>{course.title}</Text>
          <Text style={[styles.price, { color: colors.text }]}>${course.price.toLocaleString()} {course.currency}</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>{course.description}</Text>

          <View style={[styles.info, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Info icon="book" label={`${course.modules} módulos`} />
            <Info icon="play-circle" label={`${course.lessons} lecciones`} />
            <Info icon="file-text" label="Plantillas y ejercicios" />
            <Info icon="users" label="Comunidad privada" />
          </View>

          <CourseHighlights courseId={course.id} canEdit={isAdmin} />

          {/*
            Temario real del curso. Para el alumno es la lista de contenidos;
            para la administracion es ademas el editor de modulos y lecciones.
          */}
          <View style={styles.contentBlock}>
            <CourseContentEditor
              courseId={course.id}
              canEdit={isAdmin}
              onOpenLesson={(lessonId) => router.push(`/lesson/${lessonId}` as never)}
              // Los contadores de arriba ("X modulos, Y lecciones") vienen del
              // detalle del curso, que se pide una sola vez al montar. Sin esto
              // seguian en 0 despues de anadir contenido.
              onChanged={reload}
            />
          </View>

          <Button
            label={purchased ? 'Ir al curso' : 'Comprar ahora'}
            // Antes abria siempre '/lesson/1', un id de demo: con datos reales
            // llevaba a una leccion inexistente. Ahora va a la primera del curso.
            disabled={purchased && !firstLessonId}
            onPress={() =>
              purchased
                ? firstLessonId && router.push(`/lesson/${firstLessonId}` as never)
                : router.push(`/checkout/${course.id}` as never)
            }
            style={{ marginTop: spacing.xl }}
          />
        </View>
      </AppScreen>

      {editing ? (
        <CreateCatalogSheet
          kind="curso"
          visible
          editing={{
            id: course.id,
            title: course.title,
            description: course.description,
            price: course.price,
          }}
          onClose={() => setEditing(false)}
          onCreated={reload}
          onDeleted={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
      ) : null}
    </View>
  );
}

function Info({ icon, label }: { icon: keyof typeof Feather.glyphMap; label: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.infoRow}>
      <Feather name={icon} size={20} color={colors.text} />
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // 16:9 en vez de 1.1: una portada panoramica se recortaba de forma agresiva
  // en un lienzo casi cuadrado. Este ratio respeta mejor la imagen que se sube.
  hero: { width: '100%', aspectRatio: 16 / 9, resizeMode: 'cover' },
  container: { padding: spacing.xl },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '900' },
  price: { fontSize: 20, fontWeight: '900', marginTop: spacing.md },
  description: { fontSize: 14, lineHeight: 21, marginTop: spacing.md },
  info: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.lg, gap: spacing.md, marginVertical: spacing.xl },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  contentBlock: { marginTop: spacing.xl },
  sectionTitle: { fontSize: 18, fontWeight: '900', marginBottom: spacing.lg },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.md },
  bullet: { flex: 1, fontSize: 14, lineHeight: 20 },
});
