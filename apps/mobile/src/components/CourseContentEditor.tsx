import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { BarraDeProgreso } from '@/components/BarraDeProgreso';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { StateView } from '@/components/StateView';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  ContenidoDelCursoCambiado,
  CourseContentRepository,
  nuevaClaveDeCreacion,
  type CourseModule,
} from '@/repositories/CourseContentRepository';
import { pickVideo, uploadCourseMedia, type UploadProgress } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type Props = {
  courseId: string;
  /** Solo la administracion edita; el resto ve el temario. */
  canEdit: boolean;
  /**
   * Si el curso esta anunciado pero sin contenido disponible.
   *
   * LLEGA DESDE LA PANTALLA, que ya lo tiene del detalle del curso. Antes este
   * componente lo pedia por su cuenta a Supabase mientras `CourseScreen` usaba
   * el que devuelve la API: dos fuentes para el MISMO dato, una peticion de mas
   * en cada visita, y la posibilidad real de que la etiqueta «Próximamente» de
   * arriba y el bloque de aqui abajo dijeran cosas distintas.
   */
  comingSoon: boolean;
  /**
   * Que lecciones estan completadas, por su id. Llega del detalle del curso;
   * `undefined` mientras no se sabe, que NO es lo mismo que «ninguna».
   */
  completadas?: ReadonlySet<string>;
  /** El avance del curso en entero, calculado por el servidor. */
  progresoDelCurso?: number;
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
/*
  CUANTO PUEDE DURAR UNA LECCION.

  Aqui habia un limite duro de 15 a 20 minutos, y una leccion de catorce
  minutos y medio no se podia guardar. No responde a ninguna regla del producto
  que se haya podido encontrar: el backend tenia la misma validacion escrita en
  `LessonCreate`, pero ese esquema NO lo usa ningun endpoint —el contenido se
  escribe contra Supabase directamente— asi que la regla solo existia aqui y
  nunca se aplico en el servidor.

  Se sustituye por un limite de cordura: lo justo para que un toque accidental
  no se guarde como leccion y para que un archivo de doce horas no se suba por
  error. Si el producto SI quiere una duracion pedagogica concreta, se cambian
  estas dos constantes y vuelve, pero como decision tomada y no heredada.
*/
const DURACION_MINIMA = 30;
const DURACION_MAXIMA = 4 * 60 * 60;

export function CourseContentEditor({
  courseId,
  canEdit,
  comingSoon,
  completadas,
  progresoDelCurso,
  onOpenLesson,
  onChanged,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const [modules, setModules] = useState<CourseModule[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * No se pudo leer el temario.
   *
   * ES DISTINTO DE «no tiene modulos». El `catch` dejaba la lista vacia y la
   * ficha decia «este curso todavia no tiene contenido», que es una afirmacion
   * sobre el curso: un fallo de red se leia como una carencia, y quien miraba
   * podia decidir no comprarlo por eso. Sin reintento, ademas.
   */
  const [falloAlCargar, setFalloAlCargar] = useState(false);

  const [moduleTitle, setModuleTitle] = useState('');
  const [addingModule, setAddingModule] = useState(false);
  const [moduleError, setModuleError] = useState<string | null>(null);
  /** La petición de crear el módulo está en vuelo: el botón gira y se apaga. */
  const [guardandoModulo, setGuardandoModulo] = useState(false);
  /**
   * La clave de idempotencia del módulo que se está creando.
   *
   * ES UNA REFERENCIA Y NO UN ESTADO a propósito: se escribe y se lee en la
   * MISMA vuelta, antes de cualquier `await`, así que el segundo toque —que
   * llega antes de que React repinte nada— lee ya la clave del primero y el
   * servidor devuelve el módulo que ya creó en vez de crear otro. Con `useState`
   * el segundo toque leería todavía el valor viejo, que es el fallo entero.
   *
   * Se conserva mientras la hoja siga abierta: reintentar tras un corte de red
   * o tras un conflicto tiene que mandar LA MISMA clave, porque la primera
   * petición pudo llegar aunque la respuesta no volviera.
   */
  const claveDeModulo = useRef<string | null>(null);
  /** Modulo al que se le esta anadiendo una leccion. */
  const [lessonFor, setLessonFor] = useState<CourseModule | null>(null);

  const load = useCallback(async () => {
    try {
      setModules(await CourseContentRepository.listContent(courseId));
      setFalloAlCargar(false);
    } catch (error) {
      console.warn('[curso] no se pudo cargar el temario:', error);
      setModules([]);
      setFalloAlCargar(true);
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

  /**
   * Cambia el estado del contenido: «Próximamente» o publicado.
   *
   * Al terminar se avisa a la pantalla (`onChanged`) en vez de guardarlo aquí:
   * el dato vive en el detalle del curso, y esa es también la etiqueta que se
   * pinta arriba. Sin este aviso, tocar el interruptor cambiaba el bloque de
   * abajo y dejaba la etiqueta de arriba diciendo lo contrario hasta que
   * alguien volviera a entrar.
   */
  const toggleComingSoon = async () => {
    const next = !comingSoon;
    try {
      await CourseContentRepository.setComingSoon(courseId, next);
      toast(next ? t('syllabus.markedSoon') : t('syllabus.published'));
      onChanged?.();
    } catch (error) {
      notify(
        t('syllabus.changeFailed'),
        error instanceof Error ? error.message : t('common.tryAgain'),
      );
    }
  };

  const addModule = async () => {
    const title = moduleTitle.trim();
    if (!title) return;
    setModuleError(null);
    // Se reserva ANTES del `await`: es lo que hace que el segundo toque use la
    // clave del primero. Ya no se manda posición, el módulo va al final.
    claveDeModulo.current ??= nuevaClaveDeCreacion();
    // Sin esto el botón se quedaba igual mientras viajaba la petición: no se
    // sabía si el toque había llegado, y la respuesta era volver a tocar.
    setGuardandoModulo(true);
    try {
      await CourseContentRepository.createModule({
        courseId,
        title,
        claveDeIdempotencia: claveDeModulo.current,
      });
      claveDeModulo.current = null;
      setModuleTitle('');
      setAddingModule(false);
      toast(t('syllabus.moduleAdded'));
      await reloadAndNotify();
    } catch (error) {
      // El temario cambió por debajo mientras se escribía: guardar otra vez sin
      // mirar pisaría lo que acaba de hacer el otro, así que se recarga lo que
      // hay de verdad y se deja el aviso —que ya dice qué pasó y qué hacer— en
      // la hoja, que sigue abierta.
      if (error instanceof ContenidoDelCursoCambiado) await reloadAndNotify();
      // La hoja sigue abierta al fallar: el aviso tiene que vivir dentro de
      // ella, porque en iOS un dialogo no se abre encima de un Modal.
      setModuleError(error instanceof Error ? error.message : t('syllabus.addFailed'));
    } finally {
      setGuardandoModulo(false);
    }
  };

  const removeModule = async (module: CourseModule) => {
    const accepted = await confirm({
      title: t('syllabus.deleteModule'),
      message:
        module.lessons.length > 0
          ? t('syllabus.deleteModuleWithLessons', { count: module.lessons.length })
          : t('common.cannotBeUndone'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!accepted) return;
    try {
      await CourseContentRepository.removeModule(courseId, module.id);
      toast(t('syllabus.moduleDeleted'));
      await reloadAndNotify();
    } catch (error) {
      // «Inténtalo de nuevo» sería un mal consejo aquí: lo que hay que hacer es
      // mirar el temario que hay ahora, y por eso se recarga y se enseña lo que
      // dice el servidor en vez del texto de reintento.
      if (error instanceof ContenidoDelCursoCambiado) {
        await reloadAndNotify();
        notify(t('common.deleteFailed'), error.message);
        return;
      }
      notify(t('common.deleteFailed'), t('common.tryAgain'));
    }
  };

  const removeLesson = async (lessonId: string) => {
    const accepted = await confirm({
      title: t('lesson.deleteTitle'),
      message: t('common.cannotBeUndone'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!accepted) return;
    try {
      await CourseContentRepository.removeLesson({ courseId, lessonId });
      toast(t('lesson.deleted'));
      await reloadAndNotify();
    } catch (error) {
      if (error instanceof ContenidoDelCursoCambiado) {
        await reloadAndNotify();
        notify(t('common.deleteFailed'), error.message);
        return;
      }
      notify(t('common.deleteFailed'), t('common.tryAgain'));
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
          {t('common.comingSoon')}
        </Text>
        <Text variant="secondary" color={colors.textMuted} style={styles.soonBody}>
          {t('syllabus.soonBody')}
        </Text>
      </View>
    );
  }

  return (
    <View>
      {canEdit ? (
        /*
          EL INTERRUPTOR DE «PRÓXIMAMENTE», Y POR QUÉ SE REESCRIBIÓ.

          Este control decía, a la derecha, `live.hide` — «Ocultar» —, una
          cadena del módulo de EMISIONES EN VIVO («¿Ocultar este mensaje?»).
          Reutilizarla aquí convertía la fila en una trampa: un toque, sin
          preguntar nada, sobre algo rotulado «Ocultar» dejaba el temario
          entero invisible para todos los alumnos y el curso anunciado como
          «Próximamente» aunque tuviera módulos y lecciones publicados. Quien lo
          pulsara no tenía forma de saber que eso era lo que iba a pasar.

          Ahora dice las dos cosas que hacen falta y en el orden en que se
          necesitan: en qué estado está el contenido, y qué ocurre si se toca.
          El icono de interruptor lo declara como lo que es —un conmutador— y
          no como un enlace más.

          `accessibilityState.checked` para que un lector de pantalla lo anuncie
          como el interruptor que es, en vez de leer dos frases sueltas.
        */
        <Pressable
          onPress={() => void toggleComingSoon()}
          style={({ pressed }) => [
            styles.stateRow,
            { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
          accessibilityRole="switch"
          accessibilityState={{ checked: comingSoon }}
          accessibilityLabel={comingSoon ? t('syllabus.publishContent') : t('syllabus.markSoon')}
        >
          <Feather name={comingSoon ? 'clock' : 'check-circle'} size={16} color={colors.text} />
          <View style={styles.stateTexts}>
            <Text variant="secondary" weight="700">
              {comingSoon ? t('syllabus.stateSoon') : t('syllabus.statePublished')}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {comingSoon ? t('syllabus.publishContent') : t('syllabus.markSoon')}
            </Text>
          </View>
          <Feather
            name={comingSoon ? 'toggle-right' : 'toggle-left'}
            size={22}
            color={colors.textMuted}
          />
        </Pressable>
      ) : null}

      <Text variant="body" weight="900" style={styles.heading}>
        {t('syllabus.title')}
      </Text>

      {falloAlCargar ? (
        <StateView
          state="error"
          description={t('syllabus.loadFailed')}
          onRetry={() => void load()}
        />
      ) : modules.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.empty}>
          {canEdit ? t('syllabus.emptyEditable') : t('syllabus.emptyReader')}
        </Text>
      ) : null}

      {/*
        EL AVANCE DEL CURSO. Llega calculado del servidor (`progreso.py`); aquí
        no se cuenta nada. Solo se pinta cuando hay lecciones de las que hablar
        y cuando quien mira es alumno: para quien edita, «62 % completado» sobre
        su propio curso no dice nada útil.
      */}
      {!canEdit && progresoDelCurso !== undefined && modules.length > 0 ? (
        <View style={styles.progresoDelCurso}>
          <View style={styles.progresoCabecera}>
            <Text variant="secondary" weight="700">
              {t('temario.progresoDelCurso')}
            </Text>
            <Text variant="secondary" color={colors.textMuted}>
              {t('biblioteca.completado', { porcentaje: progresoDelCurso })}
            </Text>
          </View>
          <BarraDeProgreso porcentaje={progresoDelCurso} />
        </View>
      ) : null}

      {modules.map((module, index) => (
        <View key={module.id} style={[styles.module, { borderColor: colors.border }]}>
          <View style={styles.moduleHeader}>
            <Text variant="body" weight="700" style={{ flex: 1 }}>
              {index + 1}. {module.title}
            </Text>
            {/* Cuántas van de este módulo. Solo con lecciones y solo si se sabe
                qué está hecho: sin `completadas` diría «0 / 4» a todo el mundo. */}
            {completadas && module.lessons.length > 0 ? (
              <Text variant="caption" color={colors.textMuted}>
                {t('temario.leccionesDelModulo', {
                  hechas: module.lessons.filter((l) => completadas.has(l.id)).length,
                  total: module.lessons.length,
                })}
              </Text>
            ) : null}
            {canEdit ? (
              <Pressable
                onPress={() => void removeModule(module)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('syllabus.deleteModuleNamed', { titulo: module.title })}
              >
                <Feather name="trash-2" size={16} color={colors.textMuted} />
              </Pressable>
            ) : null}
          </View>

          {module.lessons.length === 0 ? (
            <Text variant="secondary" color={colors.textMuted} style={styles.moduleEmpty}>
              {t('syllabus.noLessons')}
            </Text>
          ) : (
            module.lessons.map((lesson) => (
              <ListRow
                key={lesson.id}
                title={lesson.title}
                subtitle={
                  [
                    lesson.mediaPath ? t('video.video') : t('syllabus.noVideo'),
                    formatDuration(lesson.durationSeconds),
                  ]
                    .filter(Boolean)
                    .join(' · ')
                }
                // El check dice que ESA lección está terminada. Sin saberlo
                // —`completadas` sin definir— se enseña el icono de siempre en
                // vez de un círculo vacío, que afirmaría que no lo está.
                leftIcon={
                  completadas?.has(lesson.id)
                    ? 'check-circle'
                    : lesson.mediaPath
                      ? 'play-circle'
                      : 'file-text'
                }
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
              label={t('syllabus.addLesson')}
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
          label={t('syllabus.addModule')}
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
          // Cerrar la hoja termina el intento: el módulo siguiente es OTRO
          // módulo, y con la clave vieja el servidor devolvería el anterior.
          claveDeModulo.current = null;
        }}
      >
        <Text style={styles.sheetTitle} color={colors.text}>
          {t('syllabus.newModule')}
        </Text>
        <Input
          value={moduleTitle}
          onChangeText={setModuleTitle}
          placeholder={t('syllabus.moduleTitle')}
          placeholderTextColor={colors.textMuted}
          style={{ color: colors.text }}
        />
        <InlineError message={moduleError} />
        <Button
          label={t('syllabus.createModule')}
          onPress={() => void addModule()}
          loading={guardandoModulo}
          disabled={!moduleTitle.trim() || guardandoModulo}
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
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const [title, setTitle] = useState('');
  const [video, setVideo] = useState<Awaited<ReturnType<typeof pickVideo>>>(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  // Dentro de una hoja el error se pinta en la propia hoja: en iOS un dialogo
  // no puede abrirse sobre un Modal y el aviso no llegaba a verse.
  const [error, setError] = useState<string | null>(null);
  /**
   * La clave de idempotencia de ESTA lección. Ver `claveDeModulo`.
   *
   * Aquí importa todavía más: antes de crear la lección se sube el vídeo, así
   * que el guardado puede tardar mucho y quien mira tiene tiempo de sobra para
   * volver a pulsar. La hoja se monta y se desmonta con cada alta, de modo que
   * la referencia nace vacía por sí sola y no hay que limpiarla.
   */
  const claveDeLeccion = useRef<string | null>(null);

  const choose = async () => {
    try {
      const picked = await pickVideo();
      if (picked) {
        setVideo(picked);
        const dur = picked.durationMs ? Math.round(picked.durationMs / 1000) : 0;
        if (dur > 0 && (dur < 900 || dur > 1200)) {
          setError(t('syllabus.lessonDuration'));
        } else {
          setError(null);
        }
      }
    } catch {
      setError(t('resources.pickerFailed'));
    }
  };

  const save = async () => {
    if (!title.trim()) return;
    const durationSeconds = video?.durationMs ? Math.round(video.durationMs / 1000) : 0;
    if (video && (durationSeconds < DURACION_MINIMA || durationSeconds > DURACION_MAXIMA)) {
      setError(
        t('syllabus.videoLength', {
          minimo: Math.round(DURACION_MINIMA / 60),
          maximo: Math.round(DURACION_MAXIMA / 3600),
        }),
      );
      return;
    }
    setSaving(true);
    setError(null);
    claveDeLeccion.current ??= nuevaClaveDeCreacion();
    try {
      const mediaPath = video
        ? // `module.courseId` y no una prop nueva: el modulo ya sabe de que curso es,
          // y pasarlo otra vez seria un segundo sitio donde equivocarse.
          await uploadCourseMedia(video, module.courseId, setProgress)
        : null;
      await CourseContentRepository.createLesson({
        courseId: module.courseId,
        moduleId: module.id,
        title: title.trim(),
        mediaPath,
        // El selector informa la duracion en ms; la base la guarda en segundos.
        durationSeconds,
        claveDeIdempotencia: claveDeLeccion.current,
      });
      claveDeLeccion.current = null;
      onCreated();
      // Cerrar antes del aviso: la hoja es un Modal y en iOS tapa el toast.
      onClose();
      toast(t('syllabus.lessonAdded'));
    } catch (failure) {
      // El conflicto de versión se lee aquí dentro, en la hoja, que sigue
      // abierta: el mensaje del servidor ya dice que el curso cambió y que hay
      // que volver a cargarlo. NO se llama a `onCreated`, que recargaría: no se
      // creó nada, y decir lo contrario es lo que confunde a quien lo lee.
      setError(failure instanceof Error ? failure.message : t('highlights.saveFailed'));
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  const progressLabel =
    progress?.phase === 'compressing'
      ? t('syllabus.compressing', { porcentaje: Math.round(progress.ratio * 100) })
      : progress?.phase === 'uploading'
      ? t('syllabus.uploading', { porcentaje: Math.round(progress.ratio * 100) })
      : null;

  return (
    <BottomSheet visible onClose={onClose}>
      <Text style={styles.sheetTitle} color={colors.text}>
        {t('syllabus.newLesson', { modulo: module.title })}
      </Text>
      <Input
        value={title}
        onChangeText={setTitle}
        placeholder={t('syllabus.lessonTitle')}
        placeholderTextColor={colors.textMuted}
        style={{ color: colors.text }}
      />

      <ListRow
        title={video ? video.name || t('syllabus.videoPicked') : t('syllabus.pickVideo')}
        subtitle={video ? t('syllabus.tapToChange') : t('syllabus.optional')}
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
        label={t('syllabus.saveLesson')}
        onPress={() => void save()}
        loading={saving}
        disabled={!title.trim()}
        style={styles.submit}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  progresoDelCurso: { gap: spacing.sm, marginBottom: spacing.lg },
  progresoCabecera: { flexDirection: 'row', justifyContent: 'space-between' },
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
  stateTexts: { flex: 1, gap: 2 },
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
