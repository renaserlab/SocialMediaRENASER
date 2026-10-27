import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { Pulsable } from '@/components/Pulsable';
import { SectionTitle } from '@/components/SectionTitle';
import { Skeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { etiquetaDePrecio } from '@/lib/dinero';
import { haptics } from '@/lib/haptics';
import { frasePrincipalDeCurso, type NombresDeTema } from '@/lib/motivoDeCurso';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import {
  RecommendationRepository,
  type CourseRecommendations,
  type RecommendedCourse,
} from '@/repositories/RecommendationRepository';
import { cursoAbierto, cursoNoInteresa, cursoVisible } from '@/services/senales';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { traduceEnElIdiomaActual } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * «Cursos para ti»: lo que alguien puede APRENDER, ordenado para esta persona.
 *
 * DONDE VIVE Y POR QUE. Va en Explorar, por encima del muro de publicaciones.
 * En esta iteracion un curso pesa mas que una publicacion: es lo que alguien
 * viene a buscar cuando quiere aprender algo, y enterrarlo bajo el muro lo
 * convertia en algo que solo encontraba quien ya bajaba mucho.
 *
 * QUE SE ENSENA Y QUE NO. Portada, titulo, cuanto ocupa, cuanto cuesta y POR
 * QUE aparece. Nada de estrellas, ni «1500 alumnos», ni «bestseller», ni
 * «certificado»: nada de eso existe en la base, y ponerlo convertiria la
 * tarjeta en publicidad. Tampoco sale el numero del recomendador: «0.87» no
 * significa nada para quien lo lee y aparenta una precision que no existe.
 *
 * EL AUTOR NO SE PINTA, Y ES UNA DECISION. El endpoint devuelve `author_id`,
 * no el nombre, y no hay forma de resolver varios perfiles en una sola
 * peticion: serian hasta diez peticiones para pintar una fila. Antes que
 * inventarse un nombre o encarecer la seccion, no se dice quien lo firma; se
 * ve al abrir el curso, que es donde la informacion es completa.
 *
 * SI NO HAY CURSOS, NO SE RELLENA. Ni un hueco vacio, ni un error: si la
 * peticion falla, la seccion se retira sola y Explorar sigue como si nada.
 */

/** Cuantos caben sin convertir la seccion en una pantalla entera. */
const CUANTOS = 10;

/**
 * Ancho de una tarjeta. Vive aqui, y no solo en los estilos, porque saber que
 * tarjeta se esta viendo se calcula con el: si el numero estuviera escrito dos
 * veces, cambiar el diseno desajustaria las impresiones en silencio.
 */
const ANCHO_TARJETA = 220;

/** Alto de la portada: 16:9 sobre el ancho de la tarjeta. */
const ALTO_PORTADA = Math.round((ANCHO_TARJETA * 9) / 16);

/**
 * Cuanta tarjeta tiene que asomar para contarla como vista. La mitad: un borde
 * de dos pixeles no es haber visto nada, y exigir la tarjeta entera dejaria sin
 * contar la ultima de cada pantalla, que casi siempre se ve a medias.
 */
const VISIBLE_MINIMA = ANCHO_TARJETA / 2;

/**
 * Cada cuanto se mira el desplazamiento, como MUCHO.
 *
 * MEDIR NO PUEDE ESTROPEAR LO QUE SE MIDE: sin freno, `onScroll` dispara en
 * cada fotograma y el carrusel se arrastraria a tirones por culpa de contarlo.
 */
const CADA_CUANTO_MS = 200;

/**
 * Cuanto ocupa el curso, en palabras.
 *
 * Los ceros se OMITEN en vez de escribirse. «0 lecciones» es cierto y no sirve
 * para nada: solo dice que el temario todavia no esta montado, y eso no es
 * informacion que ayude a decidir si un curso interesa.
 */
function resumenDeContenido(modulos: number, lecciones: number): string {
  const t = traduceEnElIdiomaActual;
  const partes: string[] = [];
  if (modulos > 0) {
    partes.push(
      modulos === 1 ? t('course.moduleOne') : t('course.modules', { count: modulos }),
    );
  }
  if (lecciones > 0) {
    partes.push(
      lecciones === 1 ? t('course.lessonOne') : t('course.lessons', { count: lecciones }),
    );
  }
  return partes.join(' · ');
}

export function CursosParaTi() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');

  const [datos, setDatos] = useState<CourseRecommendations | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'error' | 'listo'>('cargando');
  /**
   * Nombres de tema por id, para poder escribir el motivo.
   *
   * Puede quedarse vacio —catalogo caido, o los temas de curso todavia sin
   * habilitar en el servidor— y no pasa nada: las frases degradan solas a su
   * version sin tema. Ver `lib/motivoDeCurso.ts`.
   */
  const [nombresDeTema, setNombresDeTema] = useState<NombresDeTema>({});
  /**
   * Descartados con «No me interesa». Solo en esta pantalla y en esta sesion:
   * quien manda es el servidor, que ya recibio la senal y dejara de
   * proponerlos. Esto es lo que hace que el curso desaparezca AL INSTANTE, sin
   * esperar a una recarga.
   */
  const [ocultos, setOcultos] = useState<ReadonlySet<string>>(() => new Set());

  const cargar = useCallback(() => {
    if (!supabaseEnabled || !signedIn) {
      setEstado('listo');
      setDatos(null);
      return;
    }
    setEstado('cargando');
    /*
      Las dos peticiones van juntas y por separado a proposito: el catalogo de
      temas solo sirve para redactar el motivo, asi que si falla se pintan los
      cursos igual con las frases sin tema. Al reves no: sin cursos no hay
      seccion que pintar.
    */
    void Promise.allSettled([
      RecommendationRepository.listCourses({ limit: CUANTOS }),
      RecommendationRepository.listTopics('curso'),
    ]).then(([cursos, temas]) => {
      if (temas.status === 'fulfilled') {
        const mapa: Record<string, string> = {};
        for (const tema of temas.value) mapa[tema.id] = tema.name;
        setNombresDeTema(mapa);
      }
      if (cursos.status === 'fulfilled') {
        setDatos(cursos.value);
        setEstado('listo');
        return;
      }
      // Que falle esto NO puede vaciar Explorar: la seccion se retira sola y el
      // resto de la pantalla sigue como si nada.
      console.warn('[cursos] no se pudieron cargar las recomendaciones', cursos.reason);
      setEstado('error');
    });
  }, [supabaseEnabled, signedIn]);

  useEffect(cargar, [cargar]);

  /*
    La lista que se PINTA, con el puesto que le dio el servidor pegado.

    El puesto es el indice en la respuesta ORIGINAL, no en la lista ya filtrada:
    descartar el segundo curso no asciende al tercero. Si el rank se recalculara
    aqui, dos personas veriendo la misma lista reportarian puestos distintos y
    las metricas de posicion dejarian de significar nada.
  */
  const visibles = useMemo(
    () =>
      (datos?.items ?? [])
        .map((curso, indice) => ({ curso, rank: indice }))
        .filter(({ curso }) => !ocultos.has(curso.id)),
    [datos, ocultos],
  );

  /*
    QUE TARJETAS SE HAN VISTO DE VERDAD.

    Un curso puede venir en la respuesta y no verlo nadie: el carrusel ensena
    dos tarjetas y media, y las otras siete y media estan fuera de la pantalla.
    Contarlas todas como mostradas hundiria la tasa de acierto de las que si se
    vieron, y las metricas dirian que el recomendador funciona peor de lo que
    funciona.

    Se calcula a partir del desplazamiento y del ancho visible: son elementos de
    ancho fijo en una fila, asi que la aritmetica es exacta y no cuesta ni un
    render. Todo en referencias: medir no puede provocar un repintado por cada
    pixel de scroll.
  */
  const anchoVisible = useRef(0);
  const ultimaMedicion = useRef(0);
  /**
   * Por donde va el carrusel AHORA.
   *
   * Hace falta porque la fila cambia debajo del dedo: al descartar un curso,
   * los siguientes se corren a la izquierda y hay que volver a mirar quien esta
   * delante. Volver a medir desde el principio contaria las tarjetas del
   * arranque —que ya no se ven— y no contaria la que acaba de asomar.
   */
  const desplazamiento = useRef(0);

  const medirVisibles = useCallback(
    (desplazamiento: number) => {
      if (visibles.length === 0 || anchoVisible.current === 0) return;

      const paso = ANCHO_TARJETA + spacing.md;
      const izquierda = desplazamiento;
      const derecha = desplazamiento + anchoVisible.current;

      visibles.forEach(({ curso, rank }, indice) => {
        const inicio = spacing.lg + indice * paso;
        const asomado = Math.min(derecha, inicio + ANCHO_TARJETA) - Math.max(izquierda, inicio);
        if (asomado < VISIBLE_MINIMA) return;
        // `cursoVisible` lleva clave propia, asi que repetirlo al ir y volver
        // por el carrusel no cuenta dos veces la misma tarjeta.
        cursoVisible(curso.id, {
          surface: 'courses_for_you',
          // La version la decidio el SERVIDOR y viene en la respuesta. Escrita
          // a mano aqui, una aplicacion sin actualizar mediria para siempre
          // contra una etiqueta equivocada.
          algorithmVersion: datos?.algorithmVersion,
          rank,
        });
      });
    },
    [visibles, datos],
  );

  const alMedirAncho = useCallback(
    (evento: LayoutChangeEvent) => {
      anchoVisible.current = evento.nativeEvent.layout.width;
      // La primera pantalla se cuenta en cuanto se sabe cuanto cabe: si solo se
      // midiera al desplazar, quien no toca el carrusel no generaria ninguna
      // impresion y sus tarjetas figurarian como no mostradas.
      medirVisibles(desplazamiento.current);
    },
    [medirVisibles],
  );

  const alDesplazar = useCallback(
    (evento: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Se apunta SIEMPRE, aunque toque no medir: el freno es para no contar en
      // cada fotograma, no para perder de vista donde esta el carrusel.
      desplazamiento.current = evento.nativeEvent.contentOffset.x;
      const ahora = Date.now();
      if (ahora - ultimaMedicion.current < CADA_CUANTO_MS) return;
      ultimaMedicion.current = ahora;
      medirVisibles(desplazamiento.current);
    },
    [medirVisibles],
  );

  /*
    Y al llegar una lista nueva. `onLayout` no se vuelve a disparar si el ancho
    no cambia, asi que sin esto la segunda carga no contaria ninguna impresion.
  */
  useEffect(() => {
    if (estado === 'listo') medirVisibles(desplazamiento.current);
  }, [estado, medirVisibles]);

  const abrir = (curso: RecommendedCourse, rank: number) => {
    /*
      Abrir un curso desde aqui dice mucho mas que haberlo visto pasar. Va por
      la COLA y no por una peticion suelta —tocar cinco tarjetas serian cinco
      peticiones—, y con clave, para que volver y entrar otra vez al mismo curso
      no lo cuente dos veces.

      Lleva el MISMO contexto que la impresion: es lo que permite cruzar «se
      mostro» con «se abrio» y saber si aquella recomendacion sirvio.
    */
    cursoAbierto(curso.id, {
      surface: 'courses_for_you',
      algorithmVersion: datos?.algorithmVersion,
      rank,
    });
    // La pantalla del curso ya existe; esta seccion solo lleva hasta ella.
    router.push(`/course/${curso.id}` as never);
  };

  const noInteresa = (curso: RecommendedCourse, rank: number) => {
    haptics.light();
    // Primero la senal, que sale sin esperar al lote (ver `cursoNoInteresa`), y
    // luego se retira de la lista. Rechazar un curso NO toca a su autor: ni deja
    // de seguirse, ni se bloquea, ni desaparece el resto de lo suyo.
    cursoNoInteresa(curso.id, {
      surface: 'courses_for_you',
      algorithmVersion: datos?.algorithmVersion,
      rank,
    });
    setOcultos((previo) => new Set(previo).add(curso.id));
  };

  // Sin sesion, o con la personalizacion apagada en el servidor, la seccion no
  // existe. No se pinta un hueco vacio ni un mensaje de error.
  if (!supabaseEnabled || !signedIn) return null;
  if (estado === 'error') return null;
  if (datos?.strategy === 'disabled') return null;
  if (estado === 'listo' && visibles.length === 0) return null;

  return (
    <View>
      <View style={styles.titulo}>
        <SectionTitle title={t('reco.coursesForYou')} />
      </View>

      {/*
        El carrusel es horizontal DENTRO de una pestana, y el carrusel de
        secciones escucha el arrastre horizontal desde arriba. Sin blindarlo,
        deslizar para ver la siguiente tarjeta se llevaria por delante la
        pantalla entera y saltaria a otra seccion.
      */}
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.fila}
          onLayout={alMedirAncho}
          onScroll={alDesplazar}
          /*
            16 ms es el minimo que admite React Native; el freno de verdad lo
            pone `CADA_CUANTO_MS` dentro del manejador. Se deja bajo aqui para
            que el primer movimiento se note enseguida.
          */
          scrollEventThrottle={16}
        >
          {estado === 'cargando'
            ? [0, 1].map((i) => (
                <View
                  key={i}
                  style={[
                    styles.tarjeta,
                    { borderColor: colors.border, backgroundColor: colors.surface },
                  ]}
                >
                  {/* Sin ancho: se estira solo, y asi el borde de la tarjeta no lo recorta. */}
                  <Skeleton height={ALTO_PORTADA} />
                  <View style={styles.cuerpo}>
                    <Skeleton width={160} height={14} />
                    <Skeleton width={120} height={12} />
                  </View>
                </View>
              ))
            : visibles.map(({ curso, rank }) => {
                const motivo = frasePrincipalDeCurso(curso.reasons, nombresDeTema, t);
                const resumen = resumenDeContenido(curso.modules, curso.lessons);
                return (
                  <View
                    key={curso.id}
                    style={[
                      styles.tarjeta,
                      { borderColor: colors.border, backgroundColor: colors.surface },
                    ]}
                  >
                    {/*
                      La zona pulsable va DETRAS del contenido, como en
                      `CourseCard`: en web cada Pressable es un <button> y
                      anidar «No me interesa» dentro del de la tarjeta rompe la
                      hidratacion.
                    */}
                    <Pulsable
                      onPress={() => abrir(curso, rank)}
                      style={StyleSheet.absoluteFill}
                      accessibilityRole="button"
                      accessibilityLabel={`Ver el curso ${curso.title}`}
                    />

                    {/* La imagen local solo mientras el curso no tenga portada propia. */}
                    <ExpoImage
                      source={curso.coverUrl ? { uri: curso.coverUrl } : assets.course}
                      style={styles.portada}
                      contentFit="cover"
                      transition={150}
                      pointerEvents="none"
                    />

                    <View style={styles.cuerpo} pointerEvents="box-none">
                      <View style={styles.texto} pointerEvents="none">
                        <Text variant="body" weight="700" numberOfLines={2}>
                          {curso.title}
                        </Text>

                        {resumen ? (
                          <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
                            {resumen}
                          </Text>
                        ) : null}

                        {/* «Gratis» y no «S/ 0.00»: son dos afirmaciones distintas. */}
                        <Text variant="secondary" weight="700">
                          {etiquetaDePrecio(curso.priceMinor, curso.currency)}
                        </Text>

                        {motivo ? (
                          <Text variant="secondary" color={colors.textMuted} numberOfLines={2}>
                            {motivo}
                          </Text>
                        ) : null}
                      </View>

                      <Pulsable
                        onPress={() => noInteresa(curso, rank)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={t('reco.notInterestedCourse', { titulo: curso.title })}
                        style={styles.descartar}
                      >
                        <Feather name="x" size={12} color={colors.textMuted} />
                        <Text variant="caption" color={colors.textMuted}>
                          {t('reco.notInterested')}
                        </Text>
                      </Pulsable>
                    </View>
                  </View>
                );
              })}
        </ScrollView>
      </SinCambioDeSeccion>
    </View>
  );
}

const styles = StyleSheet.create({
  titulo: { paddingHorizontal: spacing.lg },
  fila: { gap: spacing.md, paddingBottom: spacing.lg, paddingHorizontal: spacing.lg },
  tarjeta: {
    // El ancho sale de la constante que usa la medicion de impresiones: escrito
    // dos veces, cambiar el diseno desajustaria las metricas en silencio.
    width: ANCHO_TARJETA,
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  portada: { width: '100%', height: ALTO_PORTADA },
  cuerpo: { padding: spacing.md, gap: spacing.sm },
  texto: { gap: 2 },
  descartar: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28 },
});
