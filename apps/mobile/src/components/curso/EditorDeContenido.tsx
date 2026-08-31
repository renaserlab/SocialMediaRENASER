import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { duracionLegible, moviendo } from '@/lib/asistenteDeCurso';
import { toast } from '@/lib/toast';
import {
  CourseContentRepository,
  soportaContenidoV2,
  type CourseLesson,
  type CourseModule,
  type LessonKind,
} from '@/repositories/CourseContentRepository';
import { pickVideo, uploadCourseMedia, type UploadProgress } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/*
  CUÁNTO PUEDE DURAR UNA LECCIÓN. Un límite de cordura, no una regla
  pedagógica: lo justo para que un toque accidental no se guarde como lección y
  para que un archivo de doce horas no se suba por error. Es el mismo criterio
  —y los mismos números— que el editor del temario, para que las dos pantallas
  no acepten cosas distintas.
*/
const DURACION_MINIMA = 30;
const DURACION_MAXIMA = 4 * 60 * 60;

type Props = {
  courseId: string;
  /** Avisa al asistente de que el temario cambió (contadores y duración). */
  alCambiar?: (modulos: CourseModule[]) => void;
};

/**
 * El paso «contenido» del asistente: módulos y lecciones del curso.
 *
 * ESTO NO SUSTITUYE A `CourseContentEditor`, que es lo que ve el ALUMNO en la
 * ficha del curso. Aquí solo edita quien puede editar, así que no hay que
 * decidir en cada fila si se enseña un botón: todas se enseñan.
 *
 * Quién puede escribir de verdad lo impone la RLS (0012 y 0028), no esta capa.
 *
 * TIPOS DE LECCIÓN. Solo vídeo y texto. La columna `kind` de la 0034 admite
 * crecer, pero una lección de un tipo que ninguna pantalla sabe abrir es una
 * lección rota: los cuestionarios y los directos se ofrecerán el día que haya
 * dónde abrirlos, no antes.
 */
export function EditorDeContenido({ courseId, alCambiar }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const [modulos, setModulos] = useState<CourseModule[]>([]);
  const [cargando, setCargando] = useState(true);
  const [v2, setV2] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [moduloEnEdicion, setModuloEnEdicion] = useState<CourseModule | 'nuevo' | null>(null);
  const [leccionEnEdicion, setLeccionEnEdicion] = useState<
    { modulo: CourseModule; leccion: CourseLesson | null } | null
  >(null);

  const cargar = useCallback(async () => {
    try {
      const [contenido, soporte] = await Promise.all([
        CourseContentRepository.listContent(courseId),
        soportaContenidoV2(),
      ]);
      setModulos(contenido);
      setV2(soporte);
      setError(null);
      alCambiar?.(contenido);
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : t('syllabus.loadFailed'));
    } finally {
      setCargando(false);
    }
    // `alCambiar` fuera de las dependencias a propósito: el asistente lo
    // redefine en cada render y meterlo aquí recargaría el temario en bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const moverModulo = async (desde: number, hacia: number) => {
    // La lista de ids se calcula UNA vez: `moviendo` devuelve la misma
    // referencia cuando el movimiento no cambia nada, y comparar contra un
    // `map` recién hecho nunca coincidiría.
    const actuales = modulos.map((m) => m.id);
    const ids = moviendo(actuales, desde, hacia);
    if (ids === actuales) return;
    // Se pinta ya y se guarda después: esperar a la red para mover una fila
    // hace que el botón parezca roto.
    setModulos(ids.map((id) => modulos.find((m) => m.id === id)!));
    try {
      await CourseContentRepository.reorderModules(ids);
    } catch {
      notify(t('syllabus.reorderFailed'), t('common.tryAgain'));
    }
    await cargar();
  };

  const moverLeccion = async (modulo: CourseModule, desde: number, hacia: number) => {
    const actuales = modulo.lessons.map((l) => l.id);
    const ids = moviendo(actuales, desde, hacia);
    if (ids === actuales) return;
    try {
      await CourseContentRepository.reorderLessons(ids);
    } catch {
      notify(t('syllabus.reorderFailed'), t('common.tryAgain'));
    }
    await cargar();
  };

  const borrarModulo = async (modulo: CourseModule) => {
    const aceptado = await confirm({
      title: t('syllabus.deleteModule'),
      message:
        modulo.lessons.length > 0
          ? t('syllabus.deleteModuleWithLessons', { count: modulo.lessons.length })
          : t('common.cannotBeUndone'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!aceptado) return;
    try {
      await CourseContentRepository.removeModule(modulo.id);
      toast(t('syllabus.moduleDeleted'));
      await cargar();
    } catch {
      notify(t('common.deleteFailed'), t('common.tryAgain'));
    }
  };

  const borrarLeccion = async (leccion: CourseLesson) => {
    const aceptado = await confirm({
      title: t('lesson.deleteTitle'),
      message: t('common.cannotBeUndone'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!aceptado) return;
    try {
      await CourseContentRepository.removeLesson(leccion.id);
      toast(t('lesson.deleted'));
      await cargar();
    } catch {
      notify(t('common.deleteFailed'), t('common.tryAgain'));
    }
  };

  if (cargando) {
    return (
      <View style={styles.centro}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  return (
    <View>
      <InlineError message={error} />

      {modulos.length === 0 ? (
        <View style={[styles.vacio, { borderColor: colors.border }]}>
          <Feather name="list" size={22} color={colors.textMuted} />
          <Text variant="body" weight="700">
            {t('syllabus.noContentYet')}
          </Text>
          <Text variant="secondary" color={colors.textMuted} style={styles.centrado}>
            {t('syllabus.noContentBody')}
          </Text>
        </View>
      ) : null}

      {modulos.map((modulo, indice) => (
        <View key={modulo.id} style={[styles.modulo, { borderColor: colors.border }]}>
          <View style={styles.cabecera}>
            <Text variant="body" weight="800" style={styles.titulo}>
              {indice + 1}. {modulo.title}
            </Text>
            <Pressable
              onPress={() => void moverModulo(indice, indice - 1)}
              disabled={indice === 0}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('syllabus.moveModuleUp', { titulo: modulo.title })}
              style={{ opacity: indice === 0 ? 0.3 : 1 }}
            >
              <Feather name="chevron-up" size={18} color={colors.textMuted} />
            </Pressable>
            <Pressable
              onPress={() => void moverModulo(indice, indice + 1)}
              disabled={indice === modulos.length - 1}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('syllabus.moveModuleDown', { titulo: modulo.title })}
              style={{ opacity: indice === modulos.length - 1 ? 0.3 : 1 }}
            >
              <Feather name="chevron-down" size={18} color={colors.textMuted} />
            </Pressable>
            <Pressable
              onPress={() => setModuloEnEdicion(modulo)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('syllabus.editModule', { titulo: modulo.title })}
            >
              <Feather name="edit-2" size={16} color={colors.textMuted} />
            </Pressable>
            <Pressable
              onPress={() => void borrarModulo(modulo)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('syllabus.deleteModuleNamed', { titulo: modulo.title })}
            >
              <Feather name="trash-2" size={16} color={colors.textMuted} />
            </Pressable>
          </View>

          {modulo.description ? (
            <Text variant="secondary" color={colors.textMuted} style={styles.descripcion}>
              {modulo.description}
            </Text>
          ) : null}

          {modulo.lessons.length === 0 ? (
            <Text variant="secondary" color={colors.textMuted} style={styles.descripcion}>
              {t('syllabus.noLessons')}
            </Text>
          ) : (
            modulo.lessons.map((leccion, i) => (
              <View key={leccion.id} style={[styles.leccion, { borderColor: colors.border }]}>
                <Feather
                  name={leccion.kind === 'text' ? 'file-text' : 'play-circle'}
                  size={16}
                  color={colors.text}
                />
                <View style={styles.textoDeLeccion}>
                  <Text variant="secondary" weight="700" numberOfLines={1}>
                    {leccion.title}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {[
                      leccion.kind === 'text' ? t('syllabus.text') : t('syllabus.video'),
                      leccion.durationSeconds ? duracionLegible(leccion.durationSeconds) : null,
                      leccion.isPreview ? t('syllabus.freeSample') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Pressable
                  onPress={() => void moverLeccion(modulo, i, i - 1)}
                  disabled={i === 0}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('syllabus.moveLessonUp', { titulo: leccion.title })}
                  style={{ opacity: i === 0 ? 0.3 : 1 }}
                >
                  <Feather name="chevron-up" size={16} color={colors.textMuted} />
                </Pressable>
                <Pressable
                  onPress={() => void moverLeccion(modulo, i, i + 1)}
                  disabled={i === modulo.lessons.length - 1}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('syllabus.moveLessonDown', { titulo: leccion.title })}
                  style={{ opacity: i === modulo.lessons.length - 1 ? 0.3 : 1 }}
                >
                  <Feather name="chevron-down" size={16} color={colors.textMuted} />
                </Pressable>
                <Pressable
                  onPress={() => setLeccionEnEdicion({ modulo, leccion })}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('syllabus.editLesson', { titulo: leccion.title })}
                >
                  <Feather name="edit-2" size={16} color={colors.textMuted} />
                </Pressable>
                <Pressable
                  onPress={() => void borrarLeccion(leccion)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('syllabus.deleteLessonNamed', { titulo: leccion.title })}
                >
                  <Feather name="trash-2" size={16} color={colors.textMuted} />
                </Pressable>
              </View>
            ))
          )}

          <Button
            label={t('syllabus.addLesson')}
            variant="secondary"
            icon="plus"
            onPress={() => setLeccionEnEdicion({ modulo, leccion: null })}
            style={styles.accion}
          />
        </View>
      ))}

      <Button
        label={t('syllabus.addModule')}
        variant="secondary"
        icon="plus"
        onPress={() => setModuloEnEdicion('nuevo')}
        style={styles.accion}
      />

      {moduloEnEdicion ? (
        <HojaDeModulo
          courseId={courseId}
          modulo={moduloEnEdicion === 'nuevo' ? null : moduloEnEdicion}
          posicion={modulos.length}
          admiteDescripcion={v2}
          alCerrar={() => setModuloEnEdicion(null)}
          alGuardar={() => void cargar()}
        />
      ) : null}

      {leccionEnEdicion ? (
        <HojaDeLeccion
          courseId={courseId}
          modulo={leccionEnEdicion.modulo}
          leccion={leccionEnEdicion.leccion}
          admiteTipoYMuestra={v2}
          alCerrar={() => setLeccionEnEdicion(null)}
          alGuardar={() => void cargar()}
        />
      ) : null}
    </View>
  );
}

/** Alta y edición de un módulo: título y de qué va el bloque. */
function HojaDeModulo({
  courseId,
  modulo,
  posicion,
  admiteDescripcion,
  alCerrar,
  alGuardar,
}: {
  courseId: string;
  modulo: CourseModule | null;
  posicion: number;
  admiteDescripcion: boolean;
  alCerrar: () => void;
  alGuardar: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const [titulo, setTitulo] = useState(modulo?.title ?? '');
  const [descripcion, setDescripcion] = useState(modulo?.description ?? '');
  const [guardando, setGuardando] = useState(false);
  // El aviso vive DENTRO de la hoja: en iOS un diálogo no se abre encima de un
  // Modal y no llegaría a verse.
  const [error, setError] = useState<string | null>(null);

  const guardar = async () => {
    if (!titulo.trim()) return;
    setGuardando(true);
    setError(null);
    try {
      if (modulo) {
        await CourseContentRepository.updateModule(modulo.id, {
          title: titulo.trim(),
          description: descripcion.trim(),
        });
      } else {
        await CourseContentRepository.createModule(
          courseId,
          titulo.trim(),
          posicion,
          descripcion.trim(),
        );
      }
      alGuardar();
      alCerrar();
      toast(modulo ? t('syllabus.moduleUpdated') : t('syllabus.moduleAdded'));
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : t('editPost.saveFailed'));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <BottomSheet visible onClose={alCerrar}>
      <Text style={styles.tituloDeHoja} color={colors.text}>
        {modulo ? t('syllabus.editModuleTitle') : t('syllabus.newModule')}
      </Text>
      <Input
        label={t('syllabus.moduleTitle')}
        value={titulo}
        onChangeText={setTitulo}
        placeholder={t('syllabus.moduleTitleExample')}
        placeholderTextColor={colors.textMuted}
        style={{ color: colors.text }}
      />
      {admiteDescripcion ? (
        <Input
          label={t('syllabus.moduleAbout')}
          value={descripcion}
          onChangeText={setDescripcion}
          placeholder={t('syllabus.moduleAboutPlaceholder')}
          placeholderTextColor={colors.textMuted}
          multiline
          style={{ color: colors.text }}
        />
      ) : null}
      <InlineError message={error} />
      <Button
        label={modulo ? t('common.saveChanges') : t('syllabus.createModule')}
        onPress={() => void guardar()}
        loading={guardando}
        disabled={!titulo.trim()}
        style={styles.enviar}
      />
    </BottomSheet>
  );
}

/** Alta y edición de una lección: tipo, contenido, duración y muestra. */
function HojaDeLeccion({
  courseId,
  modulo,
  leccion,
  admiteTipoYMuestra,
  alCerrar,
  alGuardar,
}: {
  courseId: string;
  modulo: CourseModule;
  leccion: CourseLesson | null;
  admiteTipoYMuestra: boolean;
  alCerrar: () => void;
  alGuardar: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const [titulo, setTitulo] = useState(leccion?.title ?? '');
  const [tipo, setTipo] = useState<LessonKind>(leccion?.kind ?? 'video');
  const [cuerpo, setCuerpo] = useState(leccion?.body ?? '');
  const [muestra, setMuestra] = useState(leccion?.isPreview ?? false);
  const [video, setVideo] = useState<Awaited<ReturnType<typeof pickVideo>>>(null);
  const [duracion, setDuracion] = useState(leccion?.durationSeconds ?? 0);
  const [progreso, setProgreso] = useState<UploadProgress | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const elegirVideo = async () => {
    try {
      const elegido = await pickVideo();
      if (!elegido) return;
      setVideo(elegido);
      const segundos = elegido.durationMs ? Math.round(elegido.durationMs / 1000) : 0;
      setDuracion(segundos);
      setError(null);
    } catch {
      setError(t('resources.pickerFailed'));
    }
  };

  const guardar = async () => {
    if (!titulo.trim()) return;
    if (tipo === 'video' && video && (duracion < DURACION_MINIMA || duracion > DURACION_MAXIMA)) {
      setError(
        t('syllabus.videoLength', {
          minimo: Math.round(DURACION_MINIMA / 60),
          maximo: Math.round(DURACION_MAXIMA / 3600),
        }),
      );
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      const mediaPath = video ? await uploadCourseMedia(video, courseId, setProgreso) : undefined;
      if (leccion) {
        await CourseContentRepository.updateLesson(leccion.id, {
          title: titulo.trim(),
          body: cuerpo,
          durationSeconds: duracion,
          kind: tipo,
          isPreview: muestra,
          // `undefined` deja el vídeo que ya tenía: solo se toca si se eligió
          // uno nuevo. Sin esto, editar el título borraba el vídeo.
          ...(mediaPath !== undefined ? { mediaPath } : {}),
        });
      } else {
        await CourseContentRepository.createLesson({
          moduleId: modulo.id,
          title: titulo.trim(),
          body: cuerpo,
          mediaPath: mediaPath ?? null,
          durationSeconds: duracion,
          sortOrder: modulo.lessons.length,
          kind: tipo,
          isPreview: muestra,
        });
      }
      alGuardar();
      alCerrar();
      toast(leccion ? t('syllabus.lessonUpdated') : t('syllabus.lessonAdded'));
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : t('editPost.saveFailed'));
    } finally {
      setGuardando(false);
      setProgreso(null);
    }
  };

  const etiquetaDeProgreso =
    progreso?.phase === 'compressing'
      ? t('syllabus.compressing', { porcentaje: Math.round(progreso.ratio * 100) })
      : progreso?.phase === 'uploading'
      ? t('syllabus.uploading', { porcentaje: Math.round(progreso.ratio * 100) })
      : null;

  return (
    <BottomSheet visible onClose={alCerrar}>
      <Text style={styles.tituloDeHoja} color={colors.text}>
        {leccion
          ? t('syllabus.editLessonTitle')
          : t('syllabus.newLesson', { modulo: modulo.title })}
      </Text>

      <Input
        label={t('syllabus.titleField')}
        value={titulo}
        onChangeText={setTitulo}
        placeholder={t('syllabus.titleExample')}
        placeholderTextColor={colors.textMuted}
        style={{ color: colors.text }}
      />

      {/*
        Solo dos tipos, y solo si esta base sabe guardarlos. Cuestionarios y
        directos no aparecen: la arquitectura los admite, pero un botón que
        crea algo que ninguna pantalla sabe abrir es un botón muerto.
      */}
      {admiteTipoYMuestra ? (
        <View style={styles.bloque}>
          <Text variant="caption" weight="800" color={colors.textMuted} style={styles.etiqueta}>
            {t('syllabus.lessonType')}
          </Text>
          <SegmentedControl
            options={[t('syllabus.video'), t('syllabus.text')]}
            selectedIndex={tipo === 'text' ? 1 : 0}
            onChange={(indice) => setTipo(indice === 1 ? 'text' : 'video')}
          />
        </View>
      ) : null}

      {tipo === 'video' ? (
        <>
          <Pressable
            onPress={() => void elegirVideo()}
            accessibilityRole="button"
            accessibilityLabel={t('syllabus.pickLessonVideo')}
            style={({ pressed }) => [
              styles.selector,
              { borderColor: colors.border, backgroundColor: colors.surfaceAlt, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Feather name="video" size={18} color={colors.text} />
            <Text variant="secondary" numberOfLines={1} style={styles.textoDeLeccion}>
              {video?.name ??
                (leccion?.mediaPath ? t('syllabus.changeVideo') : t('syllabus.pickVideoOptional'))}
            </Text>
            {duracion > 0 ? (
              <Text variant="caption" color={colors.textMuted}>
                {duracionLegible(duracion)}
              </Text>
            ) : null}
          </Pressable>
          <Input
            label={t('syllabus.descriptionOptional')}
            value={cuerpo}
            onChangeText={setCuerpo}
            placeholder={t('syllabus.descriptionPlaceholder')}
            placeholderTextColor={colors.textMuted}
            multiline
            style={{ color: colors.text }}
          />
        </>
      ) : (
        <Input
          label={t('syllabus.lessonText')}
          value={cuerpo}
          onChangeText={setCuerpo}
          placeholder={t('syllabus.lessonTextPlaceholder')}
          placeholderTextColor={colors.textMuted}
          multiline
          style={{ color: colors.text }}
        />
      )}

      {admiteTipoYMuestra ? (
        <Pressable
          onPress={() => setMuestra(!muestra)}
          accessibilityRole="switch"
          accessibilityState={{ checked: muestra }}
          accessibilityLabel={t('syllabus.freeSample')}
          style={({ pressed }) => [
            styles.selector,
            { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Feather name={muestra ? 'unlock' : 'lock'} size={18} color={colors.text} />
          <View style={styles.textoDeLeccion}>
            <Text variant="secondary" weight="700">
              {t('syllabus.freeSample')}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {muestra ? t('syllabus.freeSampleOn') : t('syllabus.freeSampleOff')}
            </Text>
          </View>
          <Feather name={muestra ? 'check-square' : 'square'} size={20} color={colors.text} />
        </Pressable>
      ) : null}

      {etiquetaDeProgreso ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.centrado}>
          {etiquetaDeProgreso}
        </Text>
      ) : null}

      <InlineError message={error} />

      <Button
        label={leccion ? t('common.saveChanges') : t('syllabus.saveLesson')}
        onPress={() => void guardar()}
        loading={guardando}
        disabled={!titulo.trim()}
        style={styles.enviar}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  centro: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xl },
  centrado: { textAlign: 'center' },
  vacio: {
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.md,
  },
  modulo: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  titulo: { flex: 1 },
  descripcion: { marginBottom: spacing.xs },
  leccion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 52,
  },
  textoDeLeccion: { flex: 1 },
  accion: { marginTop: spacing.sm },
  bloque: { gap: spacing.sm, marginBottom: spacing.md },
  etiqueta: { letterSpacing: 1 },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    minHeight: 52,
  },
  tituloDeHoja: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.md,
  },
  enviar: { marginTop: spacing.lg, marginBottom: spacing.md },
});
