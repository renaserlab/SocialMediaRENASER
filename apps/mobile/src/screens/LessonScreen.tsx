import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { LessonResources } from '@/components/LessonResources';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { VideoPlayer } from '@/components/VideoPlayer';
import { useLesson } from '@/hooks/useLesson';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { CourseContentRepository } from '@/repositories/CourseContentRepository';
import { useAppStore } from '@/store/useAppStore';
import { AuthRepository } from '@/repositories/AuthRepository';
import { assets } from '@/data/assets';
import { SAMPLE_VIDEO_URL } from '@/data/media';
import { signCourseUrls } from '@/services/storage';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();

  const { lesson, loading, error, reload } = useLesson(id);
  const isAdmin = useAppStore((state) => state.user?.isAdmin === true);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);

  // El video vive en un bucket privado: hay que firmar su ruta para verlo.
  // En modo demo (sin backend) se sigue usando el clip de ejemplo.
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  /**
   * La leccion tiene video pero no se pudo obtener.
   *
   * Con el muro de pago (migracion 0016) la politica de `course-media` solo
   * deja firmar a quien tenga el curso. Asi que "hay `mediaPath` pero no hay
   * URL" significa que falta el acceso, no que falte el video: son dos estados
   * distintos y conviene no confundirlos delante del usuario.
   */
  const [locked, setLocked] = useState(false);
  const mediaPath = lesson?.mediaPath ?? null;
  useEffect(() => {
    let alive = true;
    if (!AuthRepository.enabled) {
      setVideoUrl(SAMPLE_VIDEO_URL);
      return;
    }
    if (!mediaPath) {
      setVideoUrl(null);
      setLocked(false);
      return;
    }
    // El video de una leccion se sube al bucket course-media (2 GB), no a
    // post-media: firmarlo contra el bucket equivocado devolvia nada y la
    // pantalla decia "esta leccion aun no tiene video".
    signCourseUrls([mediaPath])
      .then((urls) => {
        if (!alive) return;
        const url = urls[mediaPath] ?? null;
        setVideoUrl(url);
        setLocked(url === null);
      })
      .catch(() => {
        if (!alive) return;
        setVideoUrl(null);
        setLocked(true);
      });
    return () => {
      alive = false;
    };
  }, [mediaPath]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Lección del Curso" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="loading" />
      </View>
    );
  }

  if (error || !lesson) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Lección del Curso" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  /** La descripcion se guarda en course_lessons.body, que ya existia. */
  const saveDescription = async () => {
    setSavingDescription(true);
    try {
      await CourseContentRepository.updateLesson(lesson.id, { body: descriptionDraft.trim() });
      toast('Descripción guardada');
      setEditingDescription(false);
      reload();
    } catch (error) {
      notify('No se pudo guardar', error instanceof Error ? error.message : 'Inténtalo de nuevo.');
    } finally {
      setSavingDescription(false);
    }
  };

  /** Solo la administracion borra; la RLS lo impone de verdad. */
  const removeLesson = async () => {
    const accepted = await confirm({
      title: 'Eliminar lección',
      message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await CourseContentRepository.removeLesson(lesson.id);
      toast('Lección eliminada');
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch {
      notify('No se pudo eliminar', 'Inténtalo de nuevo.');
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Lección del Curso"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        // Eliminar vive aqui y no en el temario: alli tocar la fila borraba la
        // leccion, de modo que no habia forma de abrirla para revisarla.
        rightIcon={isAdmin ? 'trash-2' : undefined}
        onRightPress={isAdmin ? () => void removeLesson() : undefined}
      />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/*
          Video de ESTA lección. Antes era `SAMPLE_VIDEO_URL`, un clip de
          ejemplo fijo, asi que todas las lecciones mostraban lo mismo.
        */}
        {videoUrl ? (
          <VideoPlayer
            uri={videoUrl}
            poster={assets.course}
            style={[styles.playerContainer, { borderBottomWidth: 1, borderColor: colors.border }]}
            contentFit="cover"
            nativeControls
          />
        ) : (
          <View
            style={[
              styles.playerContainer,
              styles.noVideo,
              { borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
            ]}
          >
            {/*
              Contenido bloqueado. Se dice lo que pasa y NADA MAS: sin precio,
              sin boton de compra y sin enlace a ninguna web de pago. Una
              llamada a la accion hacia un cobro externo es motivo de rechazo
              (directriz 3.1.1), asi que la puerta se comunica, no se vende.
            */}
            {locked ? (
              <>
                <Feather name="lock" size={22} color={colors.textMuted} />
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700', marginTop: spacing.md }}>
                  Contenido no disponible
                </Text>
                <Text
                  style={{
                    color: colors.textMuted,
                    fontSize: 13,
                    marginTop: spacing.xs,
                    textAlign: 'center',
                    paddingHorizontal: spacing.xl,
                  }}
                >
                  Esta lección no está incluida en tu cuenta.
                </Text>
              </>
            ) : (
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>
                Esta lección aún no tiene video.
              </Text>
            )}
          </View>
        )}

        <View style={styles.details}>
          <Text style={[styles.title, { color: colors.text }]}>
            Lección {lesson.order + 1}: {lesson.title}
          </Text>
          <Text style={[styles.duration, { color: colors.textMuted }]}>
            Duración: {lesson.durationMin} min
            {lesson.mentor ? ` • Mentor: ${lesson.mentor}` : ''}
          </Text>

          {/* Descripcion de la leccion; solo la edita la administracion. */}
          {lesson.summary || isAdmin ? (
            <>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: colors.text, flex: 1 }]}>Descripción</Text>
                {isAdmin ? (
                  <Pressable
                    onPress={() => {
                      setDescriptionDraft(lesson.summary ?? '');
                      setEditingDescription(true);
                    }}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Editar descripción"
                  >
                    <Feather name="edit-2" size={16} color={colors.textMuted} />
                  </Pressable>
                ) : null}
              </View>
              <Text style={[styles.bodyText, { color: lesson.summary ? colors.text : colors.textMuted, lineHeight: 22 }]}>
                {lesson.summary || 'Sin descripción todavía.'}
              </Text>
            </>
          ) : null}

          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <LessonResources lessonId={lesson.id} canEdit={isAdmin} />
        </View>
      </ScrollView>

      <BottomSheet visible={editingDescription} onClose={() => setEditingDescription(false)}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>Descripción de la lección</Text>
        <Input
          value={descriptionDraft}
          onChangeText={setDescriptionDraft}
          placeholder="De qué trata esta lección…"
          placeholderTextColor={colors.textMuted}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
          style={{ color: colors.text, minHeight: 120 }}
        />
        <Button
          label="Guardar"
          onPress={() => void saveDescription()}
          loading={savingDescription}
          style={{ marginTop: spacing.lg }}
        />
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: spacing.xxl,
  },
  noVideo: { alignItems: 'center', justifyContent: 'center' },
  playerContainer: {
    height: 220,
  },
  details: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
  },
  duration: {
    fontSize: 13,
  },
  divider: {
    height: 1,
    marginVertical: spacing.sm,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  bodyText: {
    fontSize: 14,
  },
});
