import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AudioPlayer } from '@/components/AudioPlayer';
import { SegmentedControl } from '@/components/SegmentedControl';
import { BarraDeProgreso } from '@/components/BarraDeProgreso';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { ListRow } from '@/components/ListRow';
import { estadoDeGuardados, filaDeAudio } from '@/lib/guardados';
import { AuthRepository } from '@/repositories/AuthRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MyCourse, Post } from '@/types';
import { traduceEnElIdiomaActual } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/** Lo que cabe en un par de pantallas. No se traen todos de golpe. */
const AUDIOS_POR_PAGINA = 20;

/**
 * Lo que esta persona tiene, desde el SERVIDOR.
 *
 * POR QUE CAMBIA. La pantalla se apoyaba en `purchasedCourseIds`, una lista
 * guardada en el telefono. Eso significaba que la biblioteca se vaciaba al
 * reinstalar, no se compartia entre dispositivos y podia seguir ensenando un
 * curso al que ya no se tiene acceso. Lo que alguien tiene es un hecho del
 * servidor, no una preferencia local.
 *
 * Y POR QUE SE SEPARAN LOS ESTADOS. «Empezado» y «terminado» piden cosas
 * opuestas de quien mira: uno invita a continuar y el otro a elegir algo nuevo.
 * Mezclarlos en una lista los convierte a los dos en ruido.
 *
 * «MIS AUDIOS» SON LOS AUDIOS GUARDADOS. Estuvo vacia una temporada: tenia dos
 * audios escritos a mano que ademas abrian los DOS el mismo contenido, y al
 * quitarlos no quedaba de donde sacar la lista. SIGUE SIN HABER HISTORIAL DE
 * ESCUCHA —no hay tabla ni endpoint que registre lo que alguien ha oido— asi
 * que la pestaña ya no lo promete: enseña `/saved-posts?media=audio`, lo que
 * esta persona aparto a proposito. Es un hecho del servidor, no se pierde al
 * reinstalar y se ve igual desde otro telefono. El dia que existan
 * reproducciones seran otra cosa, no esta pestaña.
 */
export function LibraryScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const currentUserId = useAppStore((state) => state.user?.id);

  const [pestana, setPestana] = useState(0);
  /** Cual de los tres estados se esta mirando dentro de «Mis cursos». */
  const [estadoElegido, setEstadoElegido] = useState(0);
  const [cursos, setCursos] = useState<MyCourse[] | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  const [audios, setAudios] = useState<Post[] | null>(null);
  const [falloAudios, setFalloAudios] = useState<string | null>(null);
  const [hayMasAudios, setHayMasAudios] = useState(true);
  const [cargandoMasAudios, setCargandoMasAudios] = useState(false);
  /** Fila cuyo reproductor esta montado; solo puede haber una (ver `Audio`). */
  const [sonando, setSonando] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!AuthRepository.enabled) {
      setCursos([]);
      return;
    }
    try {
      setCursos(await LearningRepository.myCourses());
      setFallo(null);
    } catch (error) {
      // Sin biblioteca no se inventa una: se dice que no se pudo cargar.
      setFallo(error instanceof Error ? error.message : t('library.loadFailed'));
      setCursos([]);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /*
    Los audios guardados, del servidor. Cambia solo lo que ESTA PERSONA aparto,
    asi que se pagina por offset: sin nadie mas anadiendo por debajo no hay
    pagina que se descuadre.
  */
  const audiosPedidos = useRef(false);
  const cargarAudios = useCallback(async () => {
    audiosPedidos.current = true;
    if (!AuthRepository.enabled) {
      setAudios([]);
      setHayMasAudios(false);
      return;
    }
    try {
      const pagina = await PostRepository.listSaved(
        { limit: AUDIOS_POR_PAGINA, media: 'audio' },
        currentUserId,
      );
      setAudios(pagina);
      setHayMasAudios(pagina.length === AUDIOS_POR_PAGINA);
      setFalloAudios(null);
    } catch (error) {
      // Un fallo de red no puede convertirse en «no tienes audios guardados».
      setFalloAudios(error instanceof Error ? error.message : t('library.audiosLoadFailed'));
      setAudios([]);
      setHayMasAudios(false);
    }
  }, [currentUserId]);

  /*
    Los audios NO se piden al abrir la biblioteca: solo al entrar en su pestaña.
    Quien viene a por sus cursos —el caso normal— no paga una peticion de algo
    que no ha mirado. El testigo es un `ref` y no el propio `audios` para que el
    efecto no se vuelva a disparar con cada respuesta.
  */
  useEffect(() => {
    if (pestana !== 1 || audiosPedidos.current) return;
    void cargarAudios();
  }, [pestana, cargarAudios]);

  const cargarMasAudios = useCallback(async () => {
    if (!AuthRepository.enabled || cargandoMasAudios || !hayMasAudios || !audios) return;
    setCargandoMasAudios(true);
    try {
      const pagina = await PostRepository.listSaved(
        { limit: AUDIOS_POR_PAGINA, offset: audios.length, media: 'audio' },
        currentUserId,
      );
      setHayMasAudios(pagina.length === AUDIOS_POR_PAGINA);
      // Por id: dos paginas pueden solaparse si se guarda algo mientras se lee.
      setAudios((previos) => {
        const conocidos = new Set((previos ?? []).map((post) => post.id));
        return [...(previos ?? []), ...pagina.filter((post) => !conocidos.has(post.id))];
      });
    } catch {
      // Lo cargado sigue en pantalla; se reintenta bajando otra vez.
    } finally {
      setCargandoMasAudios(false);
    }
  }, [audios, cargandoMasAudios, currentUserId, hayMasAudios]);

  /*
    Al volver de un curso el progreso ha cambiado: se vuelve a pedir en vez de
    ensenar el porcentaje con el que se salio.

    EL PRIMER FOCO SE SALTA A PROPOSITO. `useFocusEffect` tambien dispara al
    MONTAR, asi que junto con el efecto de arriba la biblioteca pedia
    `/catalog/courses/mine` DOS veces en cada apertura, siempre, y la primera
    respuesta se tiraba. Es el mismo fallo que ya estaba resuelto en
    `ProfileSection` (ver el comentario de `yaSeEnfoco` alli); aqui nunca se
    aplico. Al montar ya carga el efecto de arriba; esto solo tiene que
    ocuparse de las VUELTAS.
  */
  const yaSeEnfoco = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!yaSeEnfoco.current) {
        yaSeEnfoco.current = true;
        return;
      }
      void cargar();
      // Los audios, solo si su pestaña llego a abrirse: al volver de una
      // publicacion puede haberse quitado el marcador y esa fila ya no es suya.
      if (audiosPedidos.current) void cargarAudios();
    }, [cargar, cargarAudios]),
  );

  const enCurso = (cursos ?? []).filter((c) => c.state === 'in_progress');
  const terminados = (cursos ?? []).filter((c) => c.state === 'completed');
  const sinEmpezar = (cursos ?? []).filter((c) => c.state === 'not_started');

  const hayCursos = (cursos ?? []).length > 0;
  const estado =
    pestana === 1
      ? estadoDeGuardados(audios, falloAudios)
      : cursos === null
        ? 'loading'
        : hayCursos
          ? 'content'
          : 'empty';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={t('library.title')} />
      <View style={styles.header}>
        <SegmentedControl
          options={[t('library.myCourses'), t('library.myAudios')]}
          selectedIndex={pestana}
          onChange={setPestana}
        />
      </View>

      <StateView
        state={estado}
        icon={pestana === 0 ? 'book' : 'headphones'}
        onRetry={pestana === 0 ? cargar : cargarAudios}
        title={
          pestana === 0
            ? t('library.noCourses')
            : estado === 'error'
              ? t('library.audiosLoadFailedTitle')
              : t('library.noAudios')
        }
        description={
          pestana === 0
            ? (fallo ?? t('library.noCoursesBody'))
            : estado === 'error'
              ? (falloAudios ?? undefined)
              : // El texto anterior prometia recoger lo escuchado. Nada lo
                // registra, asi que dice lo unico que si es verdad: se guarda.
                t('library.noAudiosBody')
        }
      >
        {pestana === 0 ? (
          <ScrollView contentContainerStyle={styles.list}>
            {/*
              LOS TRES ESTADOS, uno cada vez. Apilados, quien tiene doce cursos
              empezados no llegaba nunca a los terminados; y son tres cosas que
              piden acciones opuestas.
            */}
            <SegmentedControl
              options={[
                t('biblioteca.enProgreso'),
                t('biblioteca.noIniciados'),
                t('biblioteca.finalizados'),
              ]}
              selectedIndex={estadoElegido}
              onChange={setEstadoElegido}
              style={styles.filtro}
            />
            {(estadoElegido === 0
              ? enCurso
              : estadoElegido === 1
                ? sinEmpezar
                : terminados
            ).map((curso) => (
              <FilaDeCurso key={curso.id} curso={curso} router={router} />
            ))}
          </ScrollView>
        ) : (
          <FlashList
            data={audios ?? []}
            keyExtractor={(item: Post) => item.id}
            contentContainerStyle={styles.list}
            renderItem={({ item }: { item: Post }) => (
              <Audio
                post={item}
                sonando={sonando === item.id}
                onSonar={() => setSonando((actual) => (actual === item.id ? null : item.id))}
                onAbrir={() => router.push(`/post/${item.id}` as never)}
              />
            )}
            onEndReached={() => void cargarMasAudios()}
            onEndReachedThreshold={0.4}
            showsVerticalScrollIndicator={false}
          />
        )}
      </StateView>
    </View>
  );
}

/**
 * Un audio guardado: se oye AQUI, sin salir de la biblioteca.
 *
 * Solo se monta el reproductor de la fila abierta, y por eso el estado vive en
 * la pantalla y no en cada fila: montar uno por audio dejaria tantos
 * decodificadores abiertos a la vez (el mismo motivo que en `PodcastList`).
 */
function Audio({
  post,
  sonando,
  onSonar,
  onAbrir,
}: {
  post: Post;
  sonando: boolean;
  onSonar: () => void;
  onAbrir: () => void;
}) {
  const { t } = useTranslation();
  const fila = filaDeAudio(post, t);
  return (
    <View>
      <ListRow
        title={fila.titulo}
        subtitle={fila.detalle || undefined}
        leftIcon="headphones"
        rightIcon={fila.reproducible ? (sonando ? 'x' : 'play') : 'chevron-right'}
        // Sin URL firmada no hay nada que sonar: la fila lleva al detalle, que
        // vuelve a pedir la firma en vez de ofrecer un play mudo.
        onPress={fila.reproducible ? onSonar : onAbrir}
      />
      {sonando && post.mediaUrl ? <AudioPlayer uri={post.mediaUrl} title={fila.titulo} /> : null}
    </View>
  );
}

/**
 * Un curso de la biblioteca, con lo que hace falta para retomarlo.
 *
 * EL PORCENTAJE Y LA SIGUIENTE LECCION VIENEN DEL SERVIDOR (`/me/courses`).
 * Aqui no se calcula ninguno de los dos: lo que significa «completada» vive en
 * `progreso.py` y deducirlo otra vez en el telefono seria tener dos reglas.
 *
 * «CONTINUAR» SOLO SI HAY A DONDE IR. Un curso sin lecciones, o ya terminado,
 * no tiene siguiente leccion y el servidor manda `null`; ofrecer el boton
 * llevaria a una pantalla que no existe.
 */
function FilaDeCurso({
  curso,
  router,
}: {
  curso: MyCourse;
  router: ReturnType<typeof useRouter>;
}) {
  const { colors } = useAppTheme();
  const t = traduceEnElIdiomaActual;
  const abrir = () => router.push(`/course/${curso.id}` as never);

  return (
    <View style={[styles.tarjeta, { borderColor: colors.border }]}>
      <ListRow
        title={curso.title}
        subtitle={subtituloDe(curso)}
        leftIcon={curso.state === 'completed' ? 'check-circle' : 'play-circle'}
        rightIcon="chevron-right"
        onPress={abrir}
      />

      {/* La barra SOLO cuando el curso tiene contenido: una barra vacia sobre
          un curso sin lecciones parece un avance de cero, y no lo es. */}
      {curso.lessonsTotal > 0 ? (
        <View style={styles.progresoDeCurso}>
          <BarraDeProgreso porcentaje={curso.progressPercent} style={styles.barra} />
          <Text style={[styles.porcentaje, { color: colors.textMuted }]}>
            {t('biblioteca.completado', { porcentaje: curso.progressPercent })}
          </Text>
        </View>
      ) : null}

      {curso.nextLessonId ? (
        <Button
          label={
            curso.state === 'not_started'
              ? t('biblioteca.empezar')
              : t('biblioteca.continuar')
          }
          variant="secondary"
          onPress={() => router.push(`/lesson/${curso.nextLessonId}` as never)}
          style={styles.continuar}
        />
      ) : null}
    </View>
  );
}

/**
 * Lo que de verdad se sabe del avance, sin adornos.
 *
 * Cada frase va en UNA clave con sus huecos: partida en trozos («Completado» +
 * « · » + el numero + « lecciones») no se puede recolocar en un idioma que
 * ordene las palabras de otra forma.
 */
function subtituloDe(curso: MyCourse): string {
  const t = traduceEnElIdiomaActual;
  if (curso.lessonsTotal === 0) return t('library.noContentYet');
  if (curso.state === 'completed') {
    return t('library.completedWith', { total: curso.lessonsTotal });
  }
  if (curso.state === 'in_progress') {
    return t('library.progress', {
      porcentaje: curso.progressPercent,
      hechas: curso.lessonsCompleted,
      total: curso.lessonsTotal,
    });
  }
  return t('course.lessons', { count: curso.lessonsTotal });
}

const styles = StyleSheet.create({
  header: {
    padding: spacing.lg,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  filtro: { marginBottom: spacing.lg },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  progresoDeCurso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  barra: { flex: 1 },
  porcentaje: { fontSize: 12 },
  continuar: { marginTop: spacing.md },
  grupo: { marginBottom: spacing.lg },
  tituloDeGrupo: {
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
});
