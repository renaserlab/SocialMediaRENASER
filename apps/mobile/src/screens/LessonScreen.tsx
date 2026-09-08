import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { LessonResources } from '@/components/LessonResources';
import { ListRow } from '@/components/ListRow';
import { NotasDeLaLeccion } from '@/components/NotasDeLaLeccion';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Skeleton } from '@/components/Skeleton';
import { StateView } from '@/components/StateView';
import { VideoPlayer } from '@/components/VideoPlayer';
import { useCourse } from '@/hooks/useCourse';
import { useLesson } from '@/hooks/useLesson';
import { vecinasDe } from '@/lib/vecinasDeLaLeccion';
import { useProgresoDeLeccion } from '@/hooks/useProgresoDeLeccion';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { CourseContentRepository } from '@/repositories/CourseContentRepository';
import { AuthRepository } from '@/repositories/AuthRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { assets } from '@/data/assets';
import { SAMPLE_VIDEO_URL } from '@/data/media';
import { signCourseUrls } from '@/services/storage';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

export function LessonScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();

  const { lesson, loading, error, reload } = useLesson(id);
  // El temario del curso: de ahi salen la anterior y la siguiente.
  const { lessons: temario } = useCourse(lesson?.courseId);
  const vecinas = vecinasDe(temario, id ?? '');
  /*
    Quien puede editar ESTA leccion lo decide el SERVIDOR (`can_manage`), no el
    rol de administrador. Antes se usaba `isAdmin`, asi que el autor de un curso
    no podia tocar su propia leccion: podia crearla por la base de datos y no
    veia un solo boton para editarla. Y esconder un boton no es seguridad: el
    servidor y la RLS vuelven a comprobarlo en cada escritura.
  */
  const canManage = lesson?.canManage === true;
  /*
    Guardar el avance NO es una peticion por aviso del reproductor: el hook
    decide cada cuanto (ver `lib/ritmoDeProgreso.ts`) y fuerza el guardado en
    los momentos en que puede no haber otra oportunidad —pausa, salir, segundo
    plano, final—.

    Solo con acceso: sin el, el servidor devolveria 403 en cada tramo y seria
    ruido en el registro por algo que ya se sabe de antemano.
  */
  const { alAvanzar, alTerminar } = useProgresoDeLeccion(id, {
    habilitado: lesson?.hasAccess === true,
    alCompletar: (cursoCompleto) => {
      toast(cursoCompleto ? t('lesson.courseCompleted') : t('lesson.completed'));
    },
  });

  /*
    Las tres pestañas de la lección. El contenido estaba apilado en un solo
    scroll, así que los recursos quedaban por debajo de todo y las notas no
    tenían dónde ir.
  */
  const [pestana, setPestana] = useState(0);
  /*
    El segundo por el que va el vídeo AHORA. Sale del mismo aviso que ya usa el
    progreso: no se mide nada nuevo. Sirve para que una nota pueda decir en qué
    minuto se tomó, y es `null` mientras no haya llegado ninguno —cero diría
    «al principio», que es una afirmación distinta—.
  */
  const [posicionDelVideo, setPosicionDelVideo] = useState<number | null>(null);
  const [completandoLeccion, setCompletandoLeccion] = useState(false);

  /**
   * Darla por terminada a mano.
   *
   * Cerrojo sincrono antes del primer `await`: dos toques no mandan dos
   * peticiones. El endpoint es idempotente de todos modos, pero el segundo
   * toque no tiene por que costar un viaje.
   */
  const completandoRef = useRef(false);
  const marcarCompletada = async () => {
    if (completandoRef.current || !id) return;
    completandoRef.current = true;
    setCompletandoLeccion(true);
    try {
      const guardado = await LearningRepository.completeLesson(id);
      toast(
        guardado.courseCompleted
          ? t('lesson.courseCompleted')
          : t('lesson.completed'),
      );
      await reload();
    } catch (error) {
      notify(
        t('common.saveFailed'),
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : t('common.tryAgain'),
      );
    } finally {
      completandoRef.current = false;
      setCompletandoLeccion(false);
    }
  };

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
  /**
   * La leccion tiene video aunque no se haya recibido su ruta.
   *
   * El servidor dejo de entregar `media_path` a quien no tiene acceso: repartir
   * la ruta de todos los videos de un curso de pago a cualquiera que abra la
   * ficha era regalar informacion. Pero sin este dato, «no tienes acceso» se
   * veria como «esta leccion todavia no tiene video», que se resuelve de otra
   * manera y encima hace pensar que el curso esta a medias.
   */
  const hayVideo = lesson?.hasMedia ?? Boolean(lesson?.mediaPath);
  useEffect(() => {
    let alive = true;
    if (!AuthRepository.enabled) {
      setVideoUrl(SAMPLE_VIDEO_URL);
      return;
    }
    if (!mediaPath) {
      setVideoUrl(null);
      // Hay video pero no ha llegado su ruta: falta el acceso, no el video.
      setLocked(hayVideo);
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
  }, [mediaPath, hayVideo]);

  if (loading) {
    /*
      LA LECCION SE VE ANTES DE ESTAR CARGADA.

      Aqui habia un `StateView state="loading"`: la pantalla entera era una
      rueda girando hasta que llegaba la leccion. Con un video de curso —los
      pesados— eso significa varios segundos delante de un fondo vacio, y no se
      distingue de que la aplicacion se haya colgado.

      Ahora se pinta ya la ESTRUCTURA que va a haber: el marco del reproductor
      con su portada (una imagen del paquete, cero red) y el sitio del titulo y
      la descripcion. Cuando llegan los datos, cada cosa aparece donde ya estaba
      su hueco, sin que nada salte.
    */
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('lesson.headerTitle')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <View
          style={[
            styles.playerContainer,
            { borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
          ]}
        >
          <ExpoImage source={assets.course} style={StyleSheet.absoluteFill} contentFit="cover" />
        </View>
        <View style={styles.details}>
          <Skeleton width="70%" height={20} />
          <Skeleton width="40%" height={13} />
          <Skeleton width="100%" height={13} />
          <Skeleton width="85%" height={13} />
        </View>
      </View>
    );
  }

  if (error || !lesson) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('lesson.headerTitle')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  /** La descripcion se guarda en course_lessons.body, que ya existia. */
  const saveDescription = async () => {
    setSavingDescription(true);
    try {
      // SIN `moduleId`: el detalle de la lección devuelve `module_title` pero
      // no su id, así que lo resuelve el repositorio. Ver `moduloDeLaLeccion`.
      await CourseContentRepository.updateLesson(
        { courseId: lesson.courseId, lessonId: lesson.id },
        { body: descriptionDraft.trim() },
      );
      toast(t('lesson.descriptionSaved'));
      setEditingDescription(false);
      reload();
    } catch (error) {
      notify(
        t('common.saveFailed'),
        error instanceof Error ? error.message : t('common.tryAgain'),
      );
    } finally {
      setSavingDescription(false);
    }
  };

  /** Solo la administracion borra; la RLS lo impone de verdad. */
  const removeLesson = async () => {
    const accepted = await confirm({
      title: t('lesson.deleteTitle'),
      message: t('common.cannotBeUndone'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!accepted) return;
    try {
      await CourseContentRepository.removeLesson({
        courseId: lesson.courseId,
        lessonId: lesson.id,
      });
      toast(t('lesson.deleted'));
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch {
      notify(t('common.deleteFailed'), t('common.tryAgain'));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('lesson.headerTitle')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        // Eliminar vive aqui y no en el temario: alli tocar la fila borraba la
        // leccion, de modo que no habia forma de abrirla para revisarla.
        rightIcon={canManage ? 'trash-2' : undefined}
        onRightPress={canManage ? () => void removeLesson() : undefined}
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
            // Retomar por donde iba. Es la diferencia entre «volver al curso» y
            // «volver a empezar el curso».
            startAtSeconds={lesson.progressSeconds ?? 0}
            onProgressSeconds={(segundos) => {
              setPosicionDelVideo(segundos);
              alAvanzar(segundos);
            }}
            onEnded={alTerminar}
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
                  {t('lesson.locked')}
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
                  {t('lesson.lockedBody')}
                </Text>
              </>
            ) : (
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>
                {t('lesson.noVideo')}
              </Text>
            )}
          </View>
        )}

        <View style={styles.details}>
          <Text style={[styles.title, { color: colors.text }]}>
            {t('lesson.numbered', { numero: lesson.order + 1, titulo: lesson.title })}
          </Text>
          <Text style={[styles.duration, { color: colors.textMuted }]}>
            {t('lesson.duration', { minutos: lesson.durationMin })}
            {lesson.mentor ? t('lesson.mentorSuffix', { mentor: lesson.mentor }) : ''}
          </Text>

          {/*
            MARCAR COMO COMPLETADA. El vídeo ya la cierra solo al llegar al
            final, pero una lección puede ser texto, o verse fuera de la app, o
            quedarse a treinta segundos. Sin este botón no había forma de
            terminarla a mano, y el curso no se cerraba nunca.

            Solo con acceso: sin él el servidor responde 403, y el estado lo
            decide él —aquí solo se pide—.
          */}
          {lesson.hasAccess ? (
            <Button
              label={
                lesson.completed
                  ? t('lesson.alreadyComplete')
                  : t('lesson.markComplete')
              }
              variant="secondary"
              disabled={lesson.completed || completandoLeccion}
              loading={completandoLeccion}
              onPress={() => void marcarCompletada()}
            />
          ) : null}

          <SegmentedControl
            options={[
              t('lesson.description'),
              t('lesson.tabResources'),
              t('lesson.tabNotes'),
            ]}
            selectedIndex={pestana}
            onChange={setPestana}
          />

          {/* Descripcion de la leccion; solo la edita la administracion. */}
          {pestana === 0 && (lesson.summary || canManage) ? (
            <>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: colors.text, flex: 1 }]}>
                  {t('lesson.description')}
                </Text>
                {canManage ? (
                  <Pressable
                    onPress={() => {
                      setDescriptionDraft(lesson.summary ?? '');
                      setEditingDescription(true);
                    }}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={t('lesson.editDescription')}
                  >
                    <Feather name="edit-2" size={16} color={colors.textMuted} />
                  </Pressable>
                ) : null}
              </View>
              <Text style={[styles.bodyText, { color: lesson.summary ? colors.text : colors.textMuted, lineHeight: 22 }]}>
                {lesson.summary || t('lesson.noDescription')}
              </Text>
            </>
          ) : null}

          {pestana === 1 ? (
            <LessonResources
              lessonId={lesson.id}
              courseId={lesson.courseId}
              canEdit={canManage}
            />
          ) : null}

          {/*
            NOTAS. Solo para quien tiene el curso: sin acceso el servidor
            responde 403 y no hay nada que apuntar. La pestaña entera se calla
            si esta instalación no tiene la migración 0057.
          */}
          {pestana === 2 ? (
            lesson.hasAccess ? (
              <>
                <Text style={[styles.bodyText, { color: colors.textMuted }]}>
                  {t('nota.privadas')}
                </Text>
                <NotasDeLaLeccion
                  leccionId={lesson.id}
                  posicionActual={posicionDelVideo}
                />
              </>
            ) : (
              <Text style={[styles.bodyText, { color: colors.textMuted }]}>
                {t('nota.necesitaAcceso')}
              </Text>
            )
          ) : null}

          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.vecinas}>
            <Button
              label={t('lesson.previous')}
              variant="ghost"
              disabled={!vecinas.anterior}
              onPress={() =>
                vecinas.anterior && router.replace(`/lesson/${vecinas.anterior}`)
              }
            />
            <Button
              label={t('lesson.next')}
              variant="ghost"
              disabled={!vecinas.siguiente}
              onPress={() =>
                vecinas.siguiente && router.replace(`/lesson/${vecinas.siguiente}`)
              }
            />
          </View>

        </View>
      </ScrollView>

      <BottomSheet visible={editingDescription} onClose={() => setEditingDescription(false)}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>
          {t('lesson.descriptionSheet')}
        </Text>
        <Input
          value={descriptionDraft}
          onChangeText={setDescriptionDraft}
          placeholder={t('lesson.descriptionPlaceholder')}
          placeholderTextColor={colors.textMuted}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
          style={{ color: colors.text, minHeight: 120 }}
        />
        <Button
          label={t('common.save')}
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
  vecinas: { flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
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
