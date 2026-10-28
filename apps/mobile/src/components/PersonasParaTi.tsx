import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { Pulsable } from '@/components/Pulsable';
import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { SectionTitle } from '@/components/SectionTitle';
import { Skeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { haptics } from '@/lib/haptics';
import { frasePrincipal, frasesDeMotivos } from '@/lib/motivoDeRecomendacion';
import { toast } from '@/lib/toast';
import { useSeccionActiva } from '@/navigation/foco';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import {
  RecommendationRepository,
  type PeopleRecommendations,
  type RecommendedPerson,
} from '@/repositories/RecommendationRepository';
import { perfilVisto, personaVisible } from '@/services/senales';
import { profileImageUrl } from '@/services/storage';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { aspectoDeTarjeta } from '@/theme/aspecto';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * «Personas para ti»: el corazon de Z, hecho pantalla.
 *
 * DONDE VIVE Y POR QUE. Va dentro de Explorar y no en una pantalla nueva.
 * Explorar es donde ya se viene a buscar gente —tiene el buscador de
 * personas— y anadir una ruta mas habria significado un sitio mas al que
 * llegar, cuando lo que hace falta es que esto aparezca donde ya se mira.
 *
 * QUE SE ENSENA Y QUE NO. Cada tarjeta dice POR QUE aparece esa persona, en
 * castellano. Lo que no se ensena nunca es el numero: «0.87» no significa nada
 * para quien lo lee y aparenta una precision que no existe.
 *
 * SI NO HAY NADIE, NO SE RELLENA. Con una sola persona valida se ensena una.
 * Inventar perfiles para que la fila se vea llena seria mentir sobre quien hay
 * al otro lado.
 */

/** Cuantas caben sin convertir la seccion en una pantalla entera. */
const CUANTAS = 8;

/**
 * Ancho de una tarjeta. Vive aqui, y no solo en los estilos, porque saber que
 * tarjeta se esta viendo se calcula con el: si el numero estuviera escrito dos
 * veces, cambiar el diseno desajustaria las impresiones en silencio.
 */
const ANCHO_TARJETA = 172;

/**
 * Cuanta tarjeta tiene que asomar para contarla como vista. La mitad: un borde
 * de dos pixeles no es haber visto a nadie, y exigir la tarjeta entera dejaria
 * sin contar la ultima de cada pantalla, que casi siempre se ve a medias.
 */
const VISIBLE_MINIMA = ANCHO_TARJETA / 2;

/**
 * Cada cuanto se mira el desplazamiento, como MUCHO.
 *
 * MEDIR NO PUEDE ESTROPEAR LO QUE SE MIDE: sin freno, `onScroll` dispara en
 * cada fotograma y el carrusel se arrastraria a tirones por culpa de contarlo.
 * Doscientos milisegundos son de sobra para saber que tarjetas han estado
 * delante, porque nadie recorre ocho tarjetas en menos que eso.
 */
const CADA_CUANTO_MS = 200;

export function PersonasParaTi() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const requireAuth = useRequireAuth();
  /*
    Las impresiones solo cuentan mientras se esta mirando; la lista se sigue
    pidiendo al montarse. Mismo motivo que en `CursosParaTi`: montada no es
    vista.
  */
  const activa = useSeccionActiva();

  const [datos, setDatos] = useState<PeopleRecommendations | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'error' | 'listo'>('cargando');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<RecommendedPerson | null>(null);

  const cargar = useCallback(() => {
    if (!supabaseEnabled || !signedIn) {
      setEstado('listo');
      setDatos(null);
      return;
    }
    setEstado('cargando');
    RecommendationRepository.listPeople({ limit: CUANTAS })
      .then((respuesta) => {
        setDatos(respuesta);
        setEstado('listo');
      })
      .catch((error) => {
        // Que falle esto NO puede vaciar Explorar: la seccion se retira sola y
        // el resto de la pantalla sigue como si nada.
        console.warn('[personas] no se pudieron cargar las recomendaciones', error);
        setEstado('error');
      });
  }, [supabaseEnabled, signedIn]);

  useEffect(cargar, [cargar]);

  const seguir = async (persona: RecommendedPerson) => {
    let autorizado = false;
    await requireAuth('auth.reasonFollow', () => {
      autorizado = true;
    });
    if (!autorizado) return;

    setOcupado(persona.id);
    const seguiaAntes = persona.isFollowing;
    // Optimista: el boton responde sin esperar a la red.
    setDatos((previo) =>
      previo
        ? {
            ...previo,
            items: previo.items.map((p) =>
              p.id === persona.id ? { ...p, isFollowing: !seguiaAntes } : p,
            ),
          }
        : previo,
    );
    try {
      if (seguiaAntes) await ProfileRepository.unfollow(persona.id);
      else await ProfileRepository.follow(persona.id);
      haptics.light();
    } catch (error) {
      console.warn('[personas] no se pudo cambiar el seguimiento', error);
      setDatos((previo) =>
        previo
          ? {
              ...previo,
              items: previo.items.map((p) =>
                p.id === persona.id ? { ...p, isFollowing: seguiaAntes } : p,
              ),
            }
          : previo,
      );
      // El boton volvia solo a su sitio y nadie decia que habia fallado.
      toast(t('common.tryAgain'), 'alert-circle');
    } finally {
      setOcupado(null);
    }
  };

  /*
    QUE TARJETAS SE HAN VISTO DE VERDAD.

    Una recomendacion puede venir en la respuesta y no verla nadie: el carrusel
    ensena dos tarjetas y media, y las otras cinco y media estan fuera de la
    pantalla. Contarlas todas como mostradas hundiria la tasa de acierto de las
    que si se vieron, y las metricas dirian que el recomendador funciona peor
    de lo que funciona.

    Se calcula a partir del desplazamiento y del ancho visible, no con
    `onLayout` por tarjeta: son ocho elementos de ancho fijo en una fila, asi
    que la aritmetica es exacta y no cuesta ni un render.

    Todo en referencias: esto es MEDICION, y medir no puede provocar un
    repintado por cada pixel de scroll.
  */
  const anchoVisible = useRef(0);
  const ultimaMedicion = useRef(0);

  const medirVisibles = useCallback(
    (desplazamiento: number) => {
      // Fuera de la vista no se ha visto a nadie.
      if (!activa) return;
      const lista = datos?.items;
      if (!lista || lista.length === 0 || anchoVisible.current === 0) return;

      const paso = ANCHO_TARJETA + spacing.md;
      const izquierda = desplazamiento;
      const derecha = desplazamiento + anchoVisible.current;

      lista.forEach((persona, indice) => {
        const inicio = spacing.lg + indice * paso;
        const asomado = Math.min(derecha, inicio + ANCHO_TARJETA) - Math.max(izquierda, inicio);
        if (asomado < VISIBLE_MINIMA) return;
        // `personaVisible` lleva clave propia, asi que repetirlo al ir y volver
        // por el carrusel no cuenta dos veces la misma tarjeta.
        personaVisible(persona.id, {
          surface: 'people_for_you',
          algorithmVersion: datos?.algorithmVersion,
          // El puesto lo decidio el SERVIDOR y viene en la respuesta. No se usa
          // el indice del array: cualquier filtro que hiciera esta pantalla
          // desplazaria los numeros y las metricas medirian otra cosa.
          rank: persona.rank,
        });
      });
    },
    [activa, datos],
  );

  const alMedirAncho = useCallback(
    (evento: LayoutChangeEvent) => {
      anchoVisible.current = evento.nativeEvent.layout.width;
      // La primera pantalla se cuenta en cuanto se sabe cuanto cabe: si solo se
      // midiera al desplazar, quien no toca el carrusel no generaria ninguna
      // impresion y sus tarjetas figurarian como no mostradas.
      medirVisibles(0);
    },
    [medirVisibles],
  );

  const alDesplazar = useCallback(
    (evento: NativeSyntheticEvent<NativeScrollEvent>) => {
      const ahora = Date.now();
      if (ahora - ultimaMedicion.current < CADA_CUANTO_MS) return;
      ultimaMedicion.current = ahora;
      medirVisibles(evento.nativeEvent.contentOffset.x);
    },
    [medirVisibles],
  );

  /*
    Y al llegar una lista nueva. `onLayout` no se vuelve a disparar si el ancho
    no cambia, asi que sin esto la segunda carga —tras seguir a alguien, por
    ejemplo— no contaria ninguna impresion.
  */
  useEffect(() => {
    if (estado === 'listo') medirVisibles(0);
  }, [estado, medirVisibles]);

  const verPerfil = (persona: RecommendedPerson) => {
    /*
      Abrir un perfil es una senal: dice mas que una impresion y menos que un
      seguimiento. Va por la COLA y no por una peticion suelta —tocar cinco
      tarjetas serian cinco peticiones—, y con clave, para que abrir el mismo
      perfil dos veces no lo cuente dos veces.

      Lleva el mismo contexto que la impresion: es lo que permite cruzar
      «se mostro» con «se abrio» y saber si aquella recomendacion sirvio.
    */
    perfilVisto(persona.id, {
      surface: 'people_for_you',
      algorithmVersion: datos?.algorithmVersion,
      rank: persona.rank,
    });
    irAlPerfil(router, persona.id);
  };

  const noInteresa = async (persona: RecommendedPerson) => {
    setDetalle(null);
    /*
      Esta SI va directa y no por la cola. Es una decision explicita y poco
      frecuente, y tiene que surtir efecto en el servidor cuanto antes: si
      esperara los ocho segundos de la cola, refrescar la lista en ese hueco
      devolveria a la persona que se acaba de descartar.
    */
    await RecommendationRepository.sendEvents([
      {
        eventType: 'not_interested',
        entityType: 'profile',
        entityId: persona.id,
        surface: 'people_for_you',
        algorithmVersion: datos?.algorithmVersion,
        rank: persona.rank,
      },
    ]);
    setDatos((previo) =>
      previo ? { ...previo, items: previo.items.filter((p) => p.id !== persona.id) } : previo,
    );
  };

  // Sin sesion, o con la personalizacion apagada en el servidor, la seccion no
  // existe. No se pinta un hueco vacio ni un mensaje de error.
  if (!supabaseEnabled || !signedIn) return null;
  if (estado === 'error') return null;
  if (estado === 'listo' && (!datos || datos.items.length === 0)) return null;
  if (datos?.strategy === 'disabled') return null;

  return (
    <View>
      {/*
        El titulo lleva su propio margen lateral, como el de «Cursos para ti».

        Sin el se pegaba al borde izquierdo mientras la nota y las tarjetas —que
        si lo llevan, ahi abajo en `nota` y `fila`— quedaban a 16: dentro del
        mismo bloque, el encabezado a un lado y su contenido a otro.

        El margen va AQUI y no en el `View` de fuera a proposito: el carrusel
        tiene que poder llegar al borde de la pantalla al desplazarse, y con el
        padding en el contenedor las tarjetas se cortarian antes de llegar.
      */}
      <View style={styles.titulo}>
        <SectionTitle title={t('reco.peopleForYou')} />
      </View>
      {/*
        Se dice de donde sale la lista cuando todavia no hay con que
        personalizarla. Presentar un respaldo como si fuera una coincidencia
        seria mentir sobre lo que Z sabe de esta persona.
      */}
      {datos?.strategy === 'cold_start' ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.nota}>
          {t('reco.coldStart')}
        </Text>
      ) : null}

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
          16 ms es el minimo que admite React Native; el freno de verdad lo pone
          `CADA_CUANTO_MS` dentro del manejador. Se deja bajo aqui para que el
          primer movimiento se note enseguida y no haya que esperar un cuarto de
          segundo a que empiece a contar.
        */
        scrollEventThrottle={16}
      >
        {estado === 'cargando'
          ? [0, 1, 2].map((i) => (
              <View
                key={i}
                style={[
                  styles.tarjeta,
                  { borderColor: colors.border, backgroundColor: colors.surface },
                  aspectoDeTarjeta(colors),
                ]}
              >
                <Skeleton width={64} height={64} circle />
                <Skeleton width={110} height={14} />
                <Skeleton width={140} height={12} />
              </View>
            ))
          : (datos?.items ?? []).map((persona) => {
              const motivo = frasePrincipal(persona.reasons, t);
              return (
                <View
                  key={persona.id}
                  style={[
                    styles.tarjeta,
                    { borderColor: colors.border, backgroundColor: colors.surface },
                  ]}
                >
                  <Pulsable
                    onPress={() => verPerfil(persona)}
                    accessibilityRole="button"
                    accessibilityLabel={t('post.viewProfileOf', { nombre: persona.fullName })}
                  >
                    <Avatar
                      size={64}
                      image={profileImageUrl(persona.avatarPath) ?? null}
                      name={persona.fullName}
                    />
                  </Pulsable>

                  <Text variant="body" weight="700" numberOfLines={1} style={styles.nombre}>
                    {persona.fullName}
                  </Text>

                  {motivo ? (
                    <Text
                      variant="secondary"
                      color={colors.textMuted}
                      numberOfLines={2}
                      style={styles.motivo}
                    >
                      {motivo}
                    </Text>
                  ) : null}

                  <Button
                    label={persona.isFollowing ? t('profile.unfollow') : t('profile.follow')}
                    variant={persona.isFollowing ? 'secondary' : 'primary'}
                    loading={ocupado === persona.id}
                    onPress={() => void seguir(persona)}
                    style={styles.accion}
                  />

                  <Pulsable
                    onPress={() => setDetalle(persona)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('reco.whyNamed', { nombre: persona.fullName })}
                    style={styles.porQue}
                  >
                    <Feather name="info" size={12} color={colors.textMuted} />
                    <Text variant="secondary" color={colors.textMuted}>
                      {t('reco.why')}
                    </Text>
                  </Pulsable>
                </View>
              );
            })}
      </ScrollView>
      </SinCambioDeSeccion>

      {/*
        «Por que aparece» completo. Que alguien pueda auditar la recomendacion
        es parte del producto, no un extra: un orden que no se puede explicar
        no se puede corregir, y quien lo recibe no tiene forma de saber si le
        conviene.
      */}
      <BottomSheet visible={detalle !== null} onClose={() => setDetalle(null)}>
        {detalle ? (
          <View style={styles.hoja}>
            <Text variant="title" weight="900">
              {t('reco.whyWeRecommend', { nombre: detalle.fullName.split(' ')[0] ?? detalle.fullName })}
            </Text>
            <View style={styles.motivos}>
              {frasesDeMotivos(detalle.reasons, t).map((frase) => (
                <View key={frase} style={styles.motivoFila}>
                  <Feather name="check" size={16} color={colors.text} />
                  <Text variant="body" style={styles.motivoTexto}>
                    {frase}
                  </Text>
                </View>
              ))}
            </View>
            <Button
              label={t('members.viewProfile')}
              onPress={() => {
                const persona = detalle;
                setDetalle(null);
                verPerfil(persona);
              }}
            />
            <Button
              label={t('reco.notInterested')}
              variant="ghost"
              onPress={() => void noInteresa(detalle)}
            />
          </View>
        ) : null}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  titulo: { paddingHorizontal: spacing.lg },
  nota: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  fila: { gap: spacing.md, paddingBottom: spacing.xl, paddingHorizontal: spacing.lg },
  tarjeta: {
    width: 172,
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  nombre: { textAlign: 'center' },
  motivo: { textAlign: 'center', minHeight: 32 },
  accion: { alignSelf: 'stretch' },
  porQue: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 },
  hoja: { gap: spacing.lg, paddingBottom: spacing.md },
  motivos: { gap: spacing.md },
  motivoFila: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  motivoTexto: { flex: 1 },
});
