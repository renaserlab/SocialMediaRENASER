import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { CoachMark } from '@/components/CoachMark';
import { CourseContentEditor } from '@/components/CourseContentEditor';
import { CourseHighlights } from '@/components/CourseHighlights';
import { CreateCatalogSheet } from '@/components/CreateCatalogSheet';
import { StateView } from '@/components/StateView';
import { FEATURE_PURCHASES } from '@/config/features';
import { confirm, notify } from '@/lib/confirm';
import { etiquetaDePrecio } from '@/lib/dinero';
import { toast } from '@/lib/toast';
import { LearningRepository } from '@/repositories/LearningRepository';
import { assets } from '@/data/assets';
import { useCourse } from '@/hooks/useCourse';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function CourseScreen() {
  const [editing, setEditing] = React.useState(false);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { course, lessons, canManage, hasAccess, loading, error, reload } = useCourse(id);
  // Primera leccion sin completar; si estan todas, la primera del curso.
  const siguiente = lessons.find((l) => !l.completed) ?? lessons[0];
  const firstLessonId = siguiente?.id;
  const empezado = lessons.some((l) => l.completed || l.progressSeconds > 0);
  const [enrolling, setEnrolling] = useState(false);
  const [publicando, setPublicando] = useState(false);

  const esDePago = (course?.priceMinor ?? 0) > 0;
  const borrador = course?.status === 'draft';
  const retirado = course?.status === 'hidden';

  /**
   * Inscribe y abre la leccion por la que iba.
   *
   * La inscripcion se registra en el servidor: sin ella el progreso no se
   * guarda y se pierde al reinstalar. Un curso de PAGO no se puede inscribir
   * —el servidor lo rechaza, y hace bien— asi que ahi solo se abre.
   */
  const startCourse = async () => {
    if (!firstLessonId || !course) return;
    setEnrolling(true);
    try {
      if (!esDePago) await LearningRepository.enroll(course.id);
    } catch {
      // Se reintenta al avanzar por las lecciones.
    } finally {
      setEnrolling(false);
    }
    router.push(`/lesson/${firstLessonId}` as never);
  };

  /**
   * Publicar. La validacion la hace el SERVIDOR y aqui solo se ensena lo que
   * dijo que falta: repetir las reglas en la pantalla garantiza que un dia
   * digan cosas distintas.
   */
  const publicar = async () => {
    if (!course) return;
    setPublicando(true);
    try {
      const resultado = await LearningRepository.publish(course.id);
      if (resultado.published) {
        toast('Curso publicado');
        reload();
      } else {
        notify('Todavía no se puede publicar', resultado.missing.join('\n'));
      }
    } catch (e) {
      notify('No se pudo publicar', e instanceof Error ? e.message : 'Inténtalo de nuevo.');
    } finally {
      setPublicando(false);
    }
  };

  const retirar = async () => {
    if (!course) return;
    const aceptado = await confirm({
      title: 'Retirar del catálogo',
      message:
        'Dejará de aparecer para los demás. No se borra nada: sus módulos, ' +
        'lecciones y el progreso de quien lo empezó siguen ahí.',
      confirmLabel: 'Retirar',
    });
    if (!aceptado) return;
    try {
      await LearningRepository.unpublish(course.id);
      toast('Curso retirado');
      reload();
    } catch (e) {
      notify('No se pudo retirar', e instanceof Error ? e.message : 'Inténtalo de nuevo.');
    }
  };

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

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Programa"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        // Editar los datos del curso vive aqui, junto al temario: asi quien lo
        // gestiona lo hace todo desde un solo sitio.
        rightIcon={canManage ? 'edit-2' : undefined}
        onRightPress={canManage ? () => setEditing(true) : undefined}
      />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        {/* Portada real del curso; el asset local solo mientras no tenga. */}
        <Image
          source={course.coverUrl ? { uri: course.coverUrl } : assets.course}
          style={[styles.hero, { borderColor: colors.border }]}
        />
        <View style={styles.container}>
          {/*
            El estado, y solo para quien puede cambiarlo. Un borrador no lo ve
            nadie mas, asi que anunciarlo al alumno seria hablarle de algo que
            no existe para el.
          */}
          {canManage && (borrador || retirado) ? (
            <View style={[styles.estado, { borderColor: colors.border }]}>
              <Feather name={borrador ? 'edit-3' : 'eye-off'} size={12} color={colors.textMuted} />
              <Text style={[styles.estadoTexto, { color: colors.textMuted }]}>
                {borrador ? 'Borrador — solo lo ves tú' : 'Retirado del catálogo'}
              </Text>
            </View>
          ) : null}

          <Text style={[styles.title, { color: colors.text }]}>{course.title}</Text>

          {/*
            EL PRECIO DICE LA VERDAD. Antes ponia «Incluido en tu membresía»
            para todo el mundo, y no existe ninguna membresia en el backend: ni
            tabla, ni suscripcion, ni derecho de acceso que se llame asi. Un
            curso gratis pone «Gratis» y uno de pago pone lo que cuesta.
          */}
          <View style={[styles.acceso, { borderColor: colors.border }]}>
            <Feather name={esDePago ? 'tag' : 'unlock'} size={14} color={colors.text} />
            <Text style={[styles.accesoTexto, { color: colors.text }]}>
              {etiquetaDePrecio(course.priceMinor, course.currency)}
            </Text>
          </View>
          {esDePago && !hasAccess && !FEATURE_PURCHASES ? (
            /*
              Se comunica la puerta, no se vende. Un boton de compra que no
              lleva a ninguna parte —o peor, a un cobro fuera de la app— es
              motivo de rechazo (directriz 3.1.1) ademas de una promesa falsa.
            */
            <Text style={[styles.notaDeAcceso, { color: colors.textMuted }]}>
              Curso de pago. Todavía no está disponible su compra.
            </Text>
          ) : null}

          <Text style={[styles.description, { color: colors.textMuted }]}>{course.description}</Text>

          {/*
            Solo hechos que salen de la base de datos. Antes aqui ponia
            «Plantillas y ejercicios» y «Comunidad privada» para todos los
            cursos, existieran o no.
          */}
          <View style={[styles.info, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Info icon="book" label={`${course.modules} módulos`} />
            <Info icon="play-circle" label={`${course.lessons} lecciones`} />
            {course.comingSoon ? <Info icon="clock" label="Próximamente" /> : null}
          </View>

          <CourseHighlights courseId={course.id} canEdit={canManage} />

          {/*
            Guia hacia el temario. Para quien lo gestiona sobra: ese bloque es
            su editor y ya lo conoce.
          */}
          <CoachMark
            id="curso-temario"
            arrow="down"
            visible={!canManage && !!firstLessonId}
            text="Abre la primera lección del temario."
            onPress={() => firstLessonId && router.push(`/lesson/${firstLessonId}` as never)}
          />

          <View style={styles.contentBlock}>
            <CourseContentEditor
              courseId={course.id}
              canEdit={canManage}
              onOpenLesson={(lessonId) => router.push(`/lesson/${lessonId}` as never)}
              // Los contadores de arriba ("X modulos, Y lecciones") vienen del
              // detalle del curso, que se pide una sola vez al montar. Sin esto
              // seguian en 0 despues de anadir contenido.
              onChanged={reload}
            />
          </View>

          <Button
            label={
              enrolling ? 'Abriendo…' : empezado ? 'Continuar' : 'Empezar curso'
            }
            // Antes abria siempre '/lesson/1', un id de demo: con datos reales
            // llevaba a una leccion inexistente. Ahora va a la que toca.
            disabled={!firstLessonId || enrolling}
            loading={enrolling}
            onPress={() => void startCourse()}
            style={{ marginTop: spacing.xl }}
          />

          {/* Publicar y retirar, solo para quien gestiona el curso. */}
          {canManage ? (
            borrador || retirado ? (
              <Button
                label="Publicar curso"
                variant="secondary"
                loading={publicando}
                onPress={() => void publicar()}
                style={{ marginTop: spacing.md }}
              />
            ) : (
              <Pressable
                onPress={() => void retirar()}
                style={styles.retirar}
                accessibilityRole="button"
                accessibilityLabel="Retirar del catálogo"
              >
                <Feather name="eye-off" size={14} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
                  Retirar del catálogo
                </Text>
              </Pressable>
            )
          ) : null}
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
            priceMinor: course.priceMinor,
            topicIds: course.topicIds,
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
  estado: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    marginBottom: spacing.md,
  },
  estadoTexto: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  acceso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    marginTop: spacing.md,
  },
  accesoTexto: { fontSize: 13, fontWeight: '800' },
  notaDeAcceso: { fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  description: { fontSize: 14, lineHeight: 21, marginTop: spacing.md },
  info: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.lg, gap: spacing.md, marginVertical: spacing.xl },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  contentBlock: { marginTop: spacing.xl },
  retirar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    marginTop: spacing.sm,
  },
});
