import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';

import { AccesoDeCreador } from '@/components/AccesoDeCreador';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Chip } from '@/components/Chip';
import { CreateCatalogSheet } from '@/components/CreateCatalogSheet';
import { CursosParaTi } from '@/components/CursosParaTi';
import { IconoQueSeEnciende } from '@/components/IconoQueSeEnciende';
import { PortadaVacia } from '@/components/PortadaVacia';
import { Pulsable } from '@/components/Pulsable';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { useTranslation } from '@/i18n/useTranslation';
import { etiquetaDePrecio } from '@/lib/dinero';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { LearningRepository } from '@/repositories/LearningRepository';
import type { FiltrosDeCatalogo } from '@/repositories/LearningRepository';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useAuthStore } from '@/store/useAuthStore';
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
 * EL BUSCADOR Y EL FILTRO DE NIVEL VAN AL SERVIDOR, y ahí está todo el asunto:
 * filtrando aquí sobre la página que llega, pedir «avanzado» devolvería los
 * avanzados QUE HUBIERA en los primeros veinticuatro y la pantalla juraría que
 * no hay más.
 *
 * NO HAY FILTRO DE DURACIÓN NI DE GARANTÍA, y no por olvido: no existe columna
 * de duración que filtrar, y la garantía es de 168 horas para todos, así que no
 * separaría nada. Tampoco de objetivo: no hay taxonomía de objetivos.
 */
export function CursosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const conSesion = useAuthStore((state) => state.status === 'authenticated');
  /** La hoja de alta de un curso. Al crearlo, ella misma abre el asistente. */
  const [creandoCurso, setCreandoCurso] = useState(false);

  const [enCurso, setEnCurso] = useState<MyCourse[]>([]);
  const [catalogo, setCatalogo] = useState<Course[]>([]);
  /** Lo que se está escribiendo ahora mismo. */
  const [texto, setTexto] = useState('');
  /**
   * Lo que se le ha pedido al servidor.
   *
   * SON DOS ESTADOS Y NO UNO. Buscando con cada tecla, escribir «liderazgo» son
   * nueve peticiones y ocho respuestas que llegan tarde y se pisan entre sí: la
   * lista parpadea y puede acabar enseñando los resultados de «liderazg».
   */
  const [textoAplicado, setTextoAplicado] = useState('');
  const [nivel, setNivel] = useState<FiltrosDeCatalogo['nivel']>(undefined);
  const [guardados, setGuardados] = useState<Course[]>([]);
  /** Ids guardados, para pintar el marcador sin recorrer la lista. */
  const [idsGuardados, setIdsGuardados] = useState<Set<string>>(new Set());
  /** Cerrojo por curso: dos toques seguidos no mandan dos peticiones. */
  const guardando = useRef<Set<string>>(new Set());
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);
  /**
   * Si la portada ya se pintó alguna vez.
   *
   * LA CARGA A PANTALLA COMPLETA ES SOLO LA PRIMERA. Cada búsqueda vuelve a
   * pedir el catálogo, y con el retorno temprano de siempre se desmontaba la
   * pantalla entera —buscador incluido—: el teclado se cerraba a media palabra.
   * Después de la primera, la carga y el fallo se pintan DEBAJO del buscador.
   */
  const [yaCargo, setYaCargo] = useState(false);

  /**
   * LA SALIDA DE LA PANTALLA, que antes no existía.
   *
   * `/cursos` vive FUERA de `app/(tabs)/`, así que aquí no hay barra inferior
   * —es una pantalla completa, y eso es a propósito—. Pero entonces el único
   * camino de vuelta es el encabezado: sin «Atrás» quien entraba desde los
   * accesos de Explorar se quedaba encerrado, sin pestañas y sin salida.
   *
   * El respaldo es `/explore` PORQUE ES DE DONDE SE VIENE: el acceso a esta
   * vertical está en Explorar. Sin historial —un enlace directo, un recargar
   * en web— `back()` no hace nada, y mandar a otro sitio sería inventarse un
   * origen que la persona nunca visitó.
   */
  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/explore' as never);

  // Medio segundo de calma antes de preguntar. Se cancela al teclear otra vez.
  useEffect(() => {
    const espera = setTimeout(() => setTextoAplicado(texto), 500);
    return () => clearTimeout(espera);
  }, [texto]);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      // EL CATÁLOGO ES LO OBLIGATORIO Y «MIS CURSOS» NO. Sin sesión, o con la
      // petición de mis cursos caída, la portada tiene que seguir enseñando el
      // catálogo: convertir un fallo de lo accesorio en una pantalla vacía deja
      // sin ver la tienda a quien solo venía a mirar.
      const cursos = await LearningRepository.listCourses(24, { texto: textoAplicado, nivel });
      setCatalogo(cursos);
      setYaCargo(true);
      try {
        const suyos = await LearningRepository.savedCourses();
        setGuardados(suyos);
        setIdsGuardados(new Set(suyos.map((c) => c.id)));
      } catch {
        setGuardados([]);
        setIdsGuardados(new Set());
      }
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
  }, [t, textoAplicado, nivel]);

  const alternarGuardado = useCallback(async (curso: Course) => {
    if (guardando.current.has(curso.id)) return;
    guardando.current.add(curso.id);
    const estaba = idsGuardados.has(curso.id);
    // Se pinta antes de saber el resultado y se deshace si falla: el
    // marcador tiene que responder al dedo, no a la red.
    setIdsGuardados((previos) => {
      const siguiente = new Set(previos);
      if (estaba) siguiente.delete(curso.id);
      else siguiente.add(curso.id);
      return siguiente;
    });
    setGuardados((previos) =>
      estaba ? previos.filter((c) => c.id !== curso.id) : [curso, ...previos],
    );
    try {
      if (estaba) await LearningRepository.unsaveCourse(curso.id);
      else await LearningRepository.saveCourse(curso.id);
    } catch (e) {
      setIdsGuardados((previos) => {
        const siguiente = new Set(previos);
        if (estaba) siguiente.add(curso.id);
        else siguiente.delete(curso.id);
        return siguiente;
      });
      setGuardados((previos) =>
        estaba ? [curso, ...previos] : previos.filter((c) => c.id !== curso.id),
      );
      notify(t('cursos.noSePudoGuardar'), e instanceof Error ? e.message : '');
    } finally {
      guardando.current.delete(curso.id);
    }
  }, [idsGuardados, t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /*
    AL VOLVER A ESTA PANTALLA SE VUELVE A PREGUNTAR. Quien publica un curso
    sale del asistente hacia aquí (`volverA`), y la lista que quedó debajo
    es la de antes de crearlo: sin esto el curso recién publicado no
    aparecía hasta salir y volver a entrar.

    NO LA PRIMERA VEZ: esa carga ya la hace el efecto de arriba, y pedirla
    dos veces al abrir eran dos peticiones para pintar lo mismo. Y por una
    referencia, no como dependencia: `cargar` cambia con cada filtro, y
    atarlo al foco repetiría la petición del efecto en cada búsqueda.
  */
  const cargarVigente = useRef(cargar);
  cargarVigente.current = cargar;
  const yaTuvoElFoco = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!yaTuvoElFoco.current) {
        yaTuvoElFoco.current = true;
        return;
      }
      void cargarVigente.current();
    }, []),
  );

  if (cargando && !yaCargo) {
    return (
      <AppScreen>
        {/* También cargando: si la petición se eterniza, la salida tiene que
            estar ahí desde el primer momento. */}
        <AppHeader title={t('verticales.cursos')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null && !yaCargo) {
    return (
      <AppScreen>
        {/* Y en el error con más razón: quedarse encerrado en una pantalla que
            además no enseña nada es lo peor de los tres casos. */}
        <AppHeader title={t('verticales.cursos')} onBack={volver} />
        <StateView state="error" description={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }

  return (
    <AppScreen>
      {/*
        LA PUERTA A «MIS CURSOS». La biblioteca existia y no se enlazaba desde
        ninguna parte fuera del modo de desarrollo, asi que quien habia comprado
        un curso no tenia por donde volver a el. Vive aqui porque es donde va
        quien busca sus cursos.
      */}
      <AppHeader
        title={t('verticales.cursos')}
        onBack={volver}
        rightIcon="book-open"
        rightLabel={t('library.title')}
        onRightPress={() => router.push('/library' as never)}
      />
      <View style={[styles.buscador, { borderColor: colors.border }]}>
        <Feather name="search" size={16} color={colors.textMuted} />
        <TextInput
          placeholder={t('cursos.queQuieresAprender')}
          placeholderTextColor={colors.textMuted}
          value={texto}
          onChangeText={setTexto}
          style={[styles.entrada, { color: colors.text }]}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t('cursos.queQuieresAprender')}
        />
        {texto.length > 0 ? (
          <Pulsable
            onPress={() => setTexto('')}
            hitSlop={12}
            escala={ESCALA_AL_PULSAR.icono}
            accessibilityRole="button"
            accessibilityLabel={t('search.clear')}
          >
            <Feather name="x" size={16} color={colors.textMuted} />
          </Pulsable>
        ) : null}
      </View>

      {/*
        CREAR UN CURSO, DONDE SE BUSCAN CURSOS. Solo se podía desde el perfil
        (Cursos › «Agregar curso»). Es la misma hoja: crea el borrador y abre el
        asistente, donde se completa y se envía a revisión.
      */}
      {conSesion ? (
        <View style={styles.accesoDeCreador}>
          <AccesoDeCreador
            icono="book"
            titulo={t('creadores.cursoTitulo')}
            detalle={t('creadores.cursoDetalle')}
            onPress={() => setCreandoCurso(true)}
          />
        </View>
      ) : null}
      {creandoCurso ? (
        <CreateCatalogSheet kind="curso" visible onClose={() => setCreandoCurso(false)} />
      ) : null}

      {/*
        Blindada contra el carrusel de secciones, como toda lista horizontal
        dentro de las pestañas.
      */}
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.niveles}
          /*
            QUE NO CREZCA. Un `ScrollView` trae `flexGrow: 1` de serie, y esta
            fila es hermana del contenido dentro de una columna que sí tiene
            alto libre (`AppScreen` pone `flexGrow: 1` en su contenedor): el
            hueco sobrante se repartía entre las dos y los cuatro filtros
            salían como columnas altísimas en vez de píldoras. Es el mismo
            defecto ya arreglado en `AccesosAVerticales`.
          */
          style={styles.carrilDeNiveles}
        >
          {([undefined, 'beginner', 'intermediate', 'advanced'] as const).map((cual) => {
            const activo = nivel === cual;
            return (
              /*
                LA PÍLDORA DE TODA LA APLICACIÓN (`Chip`), y no una dibujada
                aquí: la de Cursos y la de Eventos eran dos dibujos distintos
                de lo mismo —una se rellenaba al elegirla, la otra solo se
                sombreaba— y ninguna respondía al dedo como el resto.
              */
              <Chip
                key={cual ?? 'todos'}
                label={t(cual ? `cursos.nivel.${cual}` : 'cursos.nivel.todos')}
                selected={activo}
                onPress={() => setNivel(cual)}
                rol="radio"
              />
            );
          })}
        </ScrollView>
      </SinCambioDeSeccion>

      {/*
        LA CARGA Y EL FALLO, DEBAJO DEL BUSCADOR. Al buscar o cambiar de nivel
        se vuelve a pedir el catálogo: lo que cambia es esta zona, y el buscador
        de arriba sigue montado con su texto y su teclado.
      */}
      <StateView
        state={cargando ? 'loading' : fallo !== null ? 'error' : 'content'}
        description={fallo ?? undefined}
        onRetry={() => void cargar()}
      >
        <ScrollView contentContainerStyle={styles.contenido}>
          {enCurso.length > 0 ? (
            <View style={styles.seccion}>
              <View style={styles.tituloDeSeccion}>
                <SectionTitle title={t('cursos.continuaAprendiendo')} />
              </View>
              {enCurso.map((curso) => (
                <Pulsable
                  key={curso.id}
                  escala={ESCALA_AL_PULSAR.superficie}
                  style={[styles.fila, { borderColor: colors.border }]}
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
                    <PortadaVacia icono="book-open" tamano={18} style={styles.miniatura} />
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
                </Pulsable>
              ))}
            </View>
          ) : null}

          <CursosParaTi />

          {guardados.length > 0 ? (
            <View style={styles.seccion}>
              <View style={styles.tituloDeSeccion}>
                <SectionTitle title={t('cursos.guardados')} />
              </View>
              <SinCambioDeSeccion>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.carrusel}
                >
                  {guardados.map((curso) => (
                    <Pulsable
                      key={curso.id}
                      escala={ESCALA_AL_PULSAR.superficie}
                      style={styles.guardado}
                      onPress={() => router.push(`/course/${curso.id}`)}
                      accessibilityRole="button"
                      accessibilityLabel={curso.title}
                    >
                      {curso.coverUrl ? (
                        <ExpoImage source={{ uri: curso.coverUrl }} style={styles.portada} />
                      ) : (
                        <PortadaVacia icono="book-open" style={styles.portada} />
                      )}
                      <Text numberOfLines={2} style={[styles.tituloDeTarjeta, { color: colors.text }]}>
                        {curso.title}
                      </Text>
                    </Pulsable>
                  ))}
                </ScrollView>
              </SinCambioDeSeccion>
            </View>
          ) : null}

          <View style={styles.seccion}>
            <View style={styles.tituloDeSeccion}>
              <SectionTitle title={t('cursos.todoElCatalogo')} />
            </View>
            {catalogo.length === 0 ? (
              <StateView state="empty" description={t('cursos.catalogoVacio')} />
            ) : (
              <View style={styles.rejilla}>
                {catalogo.map((curso) => {
                  const guardado = idsGuardados.has(curso.id);
                  return (
                    /*
                      LA TARJETA NO ES UN BOTÓN: lleva DOS, hermanos. Antes el
                      marcador iba DENTRO del que abre el curso, y en web un
                      botón dentro de otro es HTML inválido —React lo avisaba
                      como error de hidratación al entrar en Cursos— y guardar
                      podía acabar abriendo el curso.
                    */
                    <View key={curso.id} style={styles.tarjeta}>
                      <Pulsable
                        style={styles.cuerpoDeTarjeta}
                        escala={ESCALA_AL_PULSAR.superficie}
                        onPress={() => router.push(`/course/${curso.id}`)}
                        accessibilityRole="button"
                        accessibilityLabel={curso.title}
                      >
                        {curso.coverUrl ? (
                          <ExpoImage source={{ uri: curso.coverUrl }} style={styles.portada} />
                        ) : (
                          <PortadaVacia icono="book-open" style={styles.portada} />
                        )}
                        <Text numberOfLines={2} style={[styles.tituloDeTarjeta, { color: colors.text }]}>
                          {curso.title}
                        </Text>
                        {/* Precio y moneda son columnas reales. Valoración, número de
                            alumnos, duración y nivel NO lo son, y por eso no están. */}
                        <Text style={[styles.precio, { color: colors.textMuted }]}>
                          {etiquetaDePrecio(curso.priceMinor, curso.currency)}
                        </Text>
                      </Pulsable>
                      <Pulsable
                        onPress={() => void alternarGuardado(curso)}
                        hitSlop={10}
                        escala={ESCALA_AL_PULSAR.icono}
                        haptica="ligera"
                        // El fondo sale del tema: antes era un blanco fijo y,
                        // en oscuro, el marcador encendido —blanco— no se veía.
                        style={[styles.marcador, { backgroundColor: colors.glassSurfaceStrong }]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: guardado }}
                        accessibilityLabel={
                          guardado ? t('cursos.quitarDeGuardados') : t('cursos.guardar')
                        }
                      >
                        {/*
                          Relleno si está guardado, contorno si no. Antes los
                          dos estados eran el MISMO dibujo en dos grises: el
                          color era lo único que decía si estaba guardado.
                        */}
                        <IconoQueSeEnciende activo={guardado}>
                          {guardado ? (
                            <MaterialCommunityIcons name="bookmark" size={18} color={colors.text} />
                          ) : (
                            <Feather name="bookmark" size={18} color={colors.textMuted} />
                          )}
                        </IconoQueSeEnciende>
                      </Pulsable>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
      </StateView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  accesoDeCreador: { marginHorizontal: spacing.md, marginBottom: spacing.sm },
  contenido: { paddingBottom: spacing.xl, gap: spacing.lg },
  buscador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
  },
  entrada: { flex: 1, fontSize: 15, padding: 0 },
  carrilDeNiveles: { flexGrow: 0 },
  niveles: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    /*
      Y QUE NO SE ESTIREN. En una fila horizontal el eje cruzado es el vertical:
      sin esto cada filtro se estira hasta el alto del carril, que es lo que
      convertía las píldoras en cuatro columnas.
    */
    alignItems: 'flex-start',
  },
  /*
    Los títulos de sección, a la misma distancia del borde que lo que titulan.
    `SectionTitle` no trae margen lateral —quien lo usa suele estar ya dentro
    de una caja con el suyo— y aquí cada bloque pone su propio margen: los
    títulos se quedaban pegados al borde de la pantalla, fuera de la columna.
  */
  tituloDeSeccion: { paddingHorizontal: spacing.md },
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
  // Dos columnas que llenan el ancho: con 47 % sobraba un margen a la derecha
  // que no había a la izquierda.
  tarjeta: { width: '48.5%' },
  cuerpoDeTarjeta: { gap: 6 },
  marcador: {
    position: 'absolute',
    top: 6,
    right: 6,
    padding: 6,
    borderRadius: 999,
  },
  carrusel: { gap: spacing.sm, paddingHorizontal: spacing.md },
  guardado: { width: 160, gap: 6 },
  portada: { width: '100%', aspectRatio: 16 / 10, borderRadius: radius.md },
  tituloDeTarjeta: { fontSize: 14, fontWeight: '600' },
  precio: { fontSize: 13 },
});
