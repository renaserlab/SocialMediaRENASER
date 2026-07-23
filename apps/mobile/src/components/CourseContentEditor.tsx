import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  CourseContentRepository,
  type CourseModule,
} from '@/repositories/CourseContentRepository';
import { pickVideo, uploadCourseMedia, type UploadProgress } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  courseId: string;
  /** Solo la administracion edita; el resto ve el temario. */
  canEdit: boolean;
  /** Al tocar una leccion (para abrirla en el reproductor). */
  onOpenLesson?: (lessonId: string) => void;
  /** Avisa a la pantalla de que el temario cambio, para refrescar contadores. */
  onChanged?: () => void;
};

/** mm:ss a partir de segundos. */
function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Temario del curso: modulos con sus lecciones.
 *
 * Para el alumno es la lista de contenidos; para la administracion es tambien
 * el editor. Quien puede escribir lo impone la RLS (0012_course_content.sql);
 * `canEdit` solo evita mostrar botones que no llevarian a ninguna parte.
 */
export function CourseContentEditor({ courseId, canEdit, onOpenLesson, onChanged }: Props) {
  const { colors } = useAppTheme();
  const [modules, setModules] = useState<CourseModule[]>([]);
  const [loading, setLoading] = useState(true);

  const [moduleTitle, setModuleTitle] = useState('');
  const [addingModule, setAddingModule] = useState(false);
  const [moduleError, setModuleError] = useState<string | null>(null);
  /** Modulo al que se le esta anadiendo una leccion. */
  const [lessonFor, setLessonFor] = useState<CourseModule | null>(null);
  /** Curso anunciado pero sin contenido disponible. */
  const [comingSoon, setComingSoon] = useState(false);

  const load = useCallback(async () => {
    try {
      const [content, soon] = await Promise.all([
        CourseContentRepository.listContent(courseId),
        CourseContentRepository.getComingSoon(courseId).catch(() => false),
      ]);
      setModules(content);
      setComingSoon(soon);
    } catch (error) {
      console.warn('[curso] no se pudo cargar el temario:', error);
      setModules([]);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  /**
   * Recarga el temario y avisa a la pantalla para que refresque sus contadores.
   *
   * `onChanged` va SOLO aqui, tras una modificacion real, y no dentro de
   * `load`: ponerlo alli creaba un bucle infinito, porque recargar el curso
   * activa su estado de carga, la pantalla desmonta este componente y al volver
   * a montarse pedia el temario otra vez.
   */
  const reloadAndNotify = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleComingSoon = async () => {
    const next = !comingSoon;
    try {
      await CourseContentRepository.setComingSoon(courseId, next);
      setComingSoon(next);
      toast(next ? 'Marcado como próximamente' : 'Contenido publicado');
    } catch (error) {
      notify('No se pudo cambiar', error instanceof Error ? error.message : 'Inténtalo de nuevo.');
    }
  };

  const addModule = async () => {
    const title = moduleTitle.trim();
    if (!title) return;
    setModuleError(null);
    try {
      await CourseContentRepository.createModule(courseId, title, modules.length);
      setModuleTitle('');
      setAddingModule(false);
      toast('Módulo añadido');
      await reloadAndNotify();
    } catch (error) {
      // La hoja sigue abierta al fallar: el aviso tiene que vivir dentro de
      // ella, porque en iOS un dialogo no se abre encima de un Modal.
      setModuleError(error instanceof Error ? error.message : 'No se pudo añadir. Inténtalo de nuevo.');
    }
  };

  const removeModule = async (module: CourseModule) => {
    const accepted = await confirm({
      title: 'Eliminar módulo',
      message:
        module.lessons.length > 0
          ? `Se eliminarán también sus ${module.lessons.length} lecciones. Esta acción no se puede deshacer.`
          : 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await CourseContentRepository.removeModule(module.id);
      toast('Módulo eliminado');
      await reloadAndNotify();
    } catch {
      notify('No se pudo eliminar', 'Inténtalo de nuevo.');
    }
  };

  const removeLesson = async (lessonId: string) => {
    const accepted = await confirm({
      title: 'Eliminar lección',
      message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await CourseContentRepository.removeLesson(lessonId);
      toast('Lección eliminada');
      await reloadAndNotify();
    } catch {
      notify('No se pudo eliminar', 'Inténtalo de nuevo.');
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  /**
   * Curso anunciado pero sin contenido disponible.
   *
   * Al alumno se le muestra solo el aviso; la administracion sigue viendo y
   * editando el temario, porque es justo lo que esta preparando.
   */
  if (comingSoon && !canEdit) {
    return (
      <View style={[styles.soon, { borderColor: colors.border }]}>
        <Feather name="clock" size={22} color={colors.textMuted} />
        <Text variant="body" weight="700">
          Próximamente
        </Text>
        <Text variant="secondary" color={colors.textMuted} style={styles.soonBody}>
          Estamos preparando el contenido de este programa. Te avisaremos cuando esté disponible.
        </Text>
      </View>
    );
  }

  return (
    <View>
      {canEdit ? (
        <Pressable
          onPress={() => void toggleComingSoon()}
          style={({ pressed }) => [
            styles.stateRow,
            { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={comingSoon ? 'Publicar el contenido' : 'Marcar como próximamente'}
        >
          <Feather name={comingSoon ? 'clock' : 'check-circle'} size={16} color={colors.text} />
          <Text variant="secondary" weight="700" style={{ flex: 1 }}>
            {comingSoon ? 'Próximamente — el alumno no ve el contenido' : 'Publicado — el contenido es visible'}
          </Text>
          <Text variant="secondary" color={colors.textMuted}>
            {comingSoon ? 'Publicar' : 'Ocultar'}
          </Text>
        </Pressable>
      ) : null}

      <Text variant="body" weight="900" style={styles.heading}>
        Temario
      </Text>

      {modules.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.empty}>
          {canEdit
            ? 'Este curso aún no tiene contenido. Empieza creando un módulo.'
            : 'El temario se publicará pronto.'}
        </Text>
      ) : null}

      {modules.map((module, index) => (
        <View key={module.id} style={[styles.module, { borderColor: colors.border }]}>
          <View style={styles.moduleHeader}>
            <Text variant="body" weight="700" style={{ flex: 1 }}>
              {index + 1}. {module.title}
            </Text>
            {canEdit ? (
              <Pressable
                onPress={() => void removeModule(module)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={`Eliminar módulo ${module.title}`}
              >
                <Feather name="trash-2" size={16} color={colors.textMuted} />
              </Pressable>
            ) : null}
          </View>

          {module.lessons.length === 0 ? (
            <Text variant="secondary" color={colors.textMuted} style={styles.moduleEmpty}>
              Sin lecciones todavía.
            </Text>
          ) : (
            module.lessons.map((lesson) => (
              <ListRow
                key={lesson.id}
                title={lesson.title}
                subtitle={
                  [lesson.mediaPath ? 'Video' : 'Sin video', formatDuration(lesson.durationSeconds)]
                    .filter(Boolean)
                    .join(' · ')
                }
                leftIcon={lesson.mediaPath ? 'play-circle' : 'file-text'}
                rightIcon="chevron-right"
                // Tocar SIEMPRE abre la leccion, tambien siendo administrador:
                // antes la borraba, asi que Darren no podia ni previsualizar su
                // propio contenido. Eliminarla vive dentro, en su cabecera.
                onPress={() => onOpenLesson?.(lesson.id)}
              />
            ))
          )}

          {canEdit ? (
            <Button
              label="Añadir lección"
              variant="secondary"
              icon="plus"
              onPress={() => setLessonFor(module)}
              style={styles.addLesson}
            />
          ) : null}
        </View>
      ))}

      {canEdit ? (
        <Button
          label="Añadir módulo"
          variant="secondary"
          icon="plus"
          onPress={() => setAddingModule(true)}
          style={styles.addModule}
        />
      ) : null}

      <BottomSheet
        visible={addingModule}
        onClose={() => {
          setAddingModule(false);
          setModuleTitle('');
          setModuleError(null);
        }}
      >
        <Text style={styles.sheetTitle} color={colors.text}>
          Nuevo módulo
        </Text>
        <Input
          value={moduleTitle}
          onChangeText={setModuleTitle}
          placeholder="Título del módulo"
          placeholderTextColor={colors.textMuted}
          style={{ color: colors.text }}
        />
        <InlineError message={moduleError} />
        <Button
          label="Crear módulo"
          onPress={() => void addModule()}
          disabled={!moduleTitle.trim()}
          style={styles.submit}
        />
      </BottomSheet>

      {lessonFor ? (
        <AddLessonSheet
          module={lessonFor}
          onClose={() => setLessonFor(null)}
          onCreated={() => void reloadAndNotify()}
        />
      ) : null}
    </View>
  );
}

/** Alta de leccion: titulo, video opcional y su duracion real. */
function AddLessonSheet({
  module,
  onClose,
  onCreated,
}: {
  module: CourseModule;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { colors } = useAppTheme();
  const [title, setTitle] = useState('');
  const [video, setVideo] = useState<Awaited<ReturnType<typeof pickVideo>>>(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  // Dentro de una hoja el error se pinta en la propia hoja: en iOS un dialogo
  // no puede abrirse sobre un Modal y el aviso no llegaba a verse.
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    try {
      const picked = await pickVideo();
      if (picked) {
        setVideo(picked);
        setError(null);
      }
    } catch {
      setError('No se pudo abrir el selector. Revisa los permisos e inténtalo de nuevo.');
    }
  };

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const mediaPath = video ? await uploadCourseMedia(video, setProgress) : null;
      await CourseContentRepository.createLesson({
        moduleId: module.id,
        title: title.trim(),
        mediaPath,
        // El selector informa la duracion en ms; la base la guarda en segundos.
        durationSeconds: video?.durationMs ? Math.round(video.durationMs / 1000) : 0,
        sortOrder: module.lessons.length,
      });
      onCreated();
      // Cerrar antes del aviso: la hoja es un Modal y en iOS tapa el toast.
      onClose();
      toast('Lección añadida');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo guardar. Inténtalo de nuevo.');
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  const progressLabel =
    progress?.phase === 'compressing'
      ? `Comprimiendo ${Math.round(progress.ratio * 100)}%`
      : progress?.phase === 'uploading'
      ? `Subiendo ${Math.round(progress.ratio * 100)}%`
      : null;

  return (
    <BottomSheet visible onClose={onClose}>
      <Text style={styles.sheetTitle} color={colors.text}>
        Nueva lección · {module.title}
      </Text>
      <Input
        value={title}
        onChangeText={setTitle}
        placeholder="Título de la lección"
        placeholderTextColor={colors.textMuted}
        style={{ color: colors.text }}
      />

      <ListRow
        title={video ? video.name || 'Video seleccionado' : 'Elegir video'}
        subtitle={video ? 'Toca para cambiarlo' : 'Opcional'}
        leftIcon="video"
        onPress={() => void choose()}
      />

      {progressLabel ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.progress}>
          {progressLabel}
        </Text>
      ) : null}

      <InlineError message={error} />

      <Button
        label="Guardar lección"
        onPress={() => void save()}
        loading={saving}
        disabled={!title.trim()}
        style={styles.submit}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xl },
  heading: { marginBottom: spacing.md },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  soon: {
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  soonBody: { textAlign: 'center' },
  empty: { marginBottom: spacing.md },
  module: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  moduleHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  moduleEmpty: { marginTop: spacing.sm },
  addLesson: { marginTop: spacing.md },
  addModule: { marginTop: spacing.sm },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.md,
  },
  progress: { marginTop: spacing.sm, textAlign: 'center' },
  submit: { marginTop: spacing.lg },
});
