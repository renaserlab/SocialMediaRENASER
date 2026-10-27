import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CabeceraDeInicio } from '@/components/CabeceraDeInicio';
import { FeedVerticalDeVideos } from '@/components/FeedVerticalDeVideos';
import { espacioParaLaBarra } from '@/components/FloatingGlassTabBar';
import { SeccionLive } from '@/components/SeccionLive';
import { Text } from '@/components/Text';
import { fuenteDeInicio, type PestanaDeInicio } from '@/feed/fuenteDeVideos';
import { useBackgroundAudio } from '@/hooks/useBackgroundAudio';
import { useFeedDeVideos } from '@/hooks/useFeedDeVideos';
import { useTranslation } from '@/i18n/useTranslation';
import { useSeccionActiva } from '@/navigation/foco';
import { perfMark } from '@/lib/perf';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { palette, radius, spacing } from '@/theme/tokens';

const media = palette('dark');

/**
 * Inicio: video vertical a pantalla completa.
 *
 * QUE CAMBIA Y POR QUE. Lo que antes era "Shorts de la comunidad" —una pantalla
 * escondida detras de una fila de Explorar, sin barra de secciones y sin forma
 * de volver que no fuera una flecha— pasa a ser la primera pantalla de la
 * aplicacion. El muro de publicaciones que habia aqui no desaparece: se muda a
 * Explorar entero (ver `ExploreScreen`).
 *
 * La barra de secciones NO se va. Antes desaparecia porque los shorts vivian en
 * `/reels`, una ruta fuera del grupo de pestanas; ahora esto ES la pestana
 * Inicio, asi que la barra flotante se pinta encima como en cualquier otra
 * seccion. El video sigue ocupando la pantalla completa y pasa por debajo de
 * ella; lo unico que se aparta son los controles (`espacioInferior`).
 *
 * Las tres vistas —Para ti, Siguiendo, Live— se quedan montadas una vez
 * visitadas. Volver a una pestana no vuelve a pedir su contenido ni reinicia
 * su posicion, que es lo que se espera y lo que evita peticiones repetidas.
 * Solo la vista activa reproduce: los demas reproductores existen callados.
 */
export function InicioScreen() {
  const router = useRouter();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  const usuario = useAppStore((state) => state.user);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);

  /*
    Prepara la sesion de audio del sistema. Sin esto, en un iPhone con el
    interruptor de silencio puesto el video se ve pero no se oye, y parece que
    el sonido siga roto.
  */
  useBackgroundAudio();

  /*
    Si ESTA seccion es la que se esta viendo.

    Nada de lo de abajo puede reproducir sin esto. El carrusel deja montadas las
    secciones vecinas —y una vez montada, una seccion ya no se desmonta—, asi
    que sin preguntarlo el video de Inicio seguia sonando desde Explorar, desde
    Perfil, con la aplicacion en segundo plano y hasta en una pestaña del
    navegador que ni se veia. Se midio: el tiempo del video seguia corriendo.

    Va aqui, en la PANTALLA, y no dentro del reproductor, porque es la pantalla
    la que sabe que le toca a cada vista. El reproductor solo obedece.
  */
  const seccionActiva = useSeccionActiva();

  useEffect(() => {
    perfMark('INICIO_MONTADO');
  }, []);

  const [pestana, setPestana] = useState<PestanaDeInicio>('paraTi');
  /*
    El sonido se decide una vez para todo el Inicio, no video a video: si cada
    uno recordase el suyo, bajar la lista seria un sobresalto continuo.
  */
  const [silenciado, setSilenciado] = useState(false);
  const cambiarSilencio = useCallback(() => setSilenciado((s) => !s), []);
  const forzarSilencio = useCallback(() => setSilenciado(true), []);

  /*
    Pestanas ya abiertas. Montar las tres de entrada significaria pedir dos
    feeds en el arranque, compitiendo por la misma conexion justo cuando lo que
    importa es que se vea el PRIMER video. Una vez abierta, se queda.
  */
  const [visitadas, setVisitadas] = useState<Set<PestanaDeInicio>>(
    () => new Set<PestanaDeInicio>(['paraTi']),
  );
  const cambiarPestana = useCallback((siguiente: PestanaDeInicio) => {
    setPestana(siguiente);
    setVisitadas((previas) =>
      previas.has(siguiente) ? previas : new Set(previas).add(siguiente),
    );
  }, []);

  const usuarioId = usuario?.id ?? null;
  /*
    Solo se personaliza con sesion. Y la condicion mira la SESION, no el
    perfil: el perfil llega despues y con el habriamos pedido la primera pagina
    —la unica que se mide— sin personalizar, sin poder rehacerla luego.
  */
  const personalizar = !supabaseEnabled ? false : signedIn;
  const fuenteParaTi = useMemo(
    () => fuenteDeInicio('paraTi', usuarioId, { personalizar }),
    [usuarioId, personalizar],
  );
  const fuenteSiguiendo = useMemo(() => fuenteDeInicio('siguiendo', usuarioId), [usuarioId]);

  const feedParaTi = useFeedDeVideos(fuenteParaTi);
  const feedSiguiendo = useFeedDeVideos(fuenteSiguiendo, {
    // Sin sesion no hay a quien seguir: pedirlo devolveria vacio siempre.
    activo: visitadas.has('siguiendo') && (!supabaseEnabled || signedIn),
  });

  const espacioInferior = espacioParaLaBarra(insets.bottom);

  /*
    "Siguiendo" sin contenido no es un caso, son cuatro, y cada uno pide una
    salida distinta. Mezclarlos en un unico "no hay nada" es lo que deja al
    usuario sin saber si le falta seguir a alguien, iniciar sesion, o si la
    aplicacion esta rota.
  */
  const sigueAAlguien = (usuario?.following ?? 0) > 0;
  const sinSesion = supabaseEnabled && !signedIn;
  const siguiendoVacio = feedSiguiendo.estado === 'listo' && feedSiguiendo.items.length === 0;
  /*
    Sigue a gente pero no hay nada reciente suyo. En vez de dejar la pestana
    muerta se ensena contenido sugerido —el mismo de "Para ti", ya cargado, sin
    una segunda peticion— pero DICIENDOLO. Colarlo en silencio como si fuera de
    quien sigue seria enganar sobre el origen del contenido.
  */
  const conSugerencias = siguiendoVacio && sigueAAlguien && !sinSesion;
  /** El feed que pinta «Siguiendo»: el suyo, o el de «Para ti» si esta vacio. */
  const feedDeEstaPestana = conSugerencias ? feedParaTi : feedSiguiendo;

  const irACrear = useCallback(() => router.navigate('/(tabs)/create'), [router]);
  const irAExplorar = useCallback(() => router.navigate('/(tabs)/explore'), [router]);

  return (
    <View style={styles.raiz}>
      {/* PARA TI */}
      <Pane visible={pestana === 'paraTi'}>
        <FeedVerticalDeVideos
          feed={feedParaTi}
          altura={height}
          activo={seccionActiva && pestana === 'paraTi'}
          silenciado={silenciado}
          alCambiarSilencio={cambiarSilencio}
          alForzarSilencio={forzarSilencio}
          espacioInferior={espacioInferior}
          /*
            De donde sale cada impresion. «Para ti» y «Siguiendo» son dos
            superficies distintas —una la ordena un algoritmo y la otra la
            gente a la que se sigue—, asi que sin distinguirlas las metricas de
            las dos quedan mezcladas y no se puede leer ninguna.

            La version del algoritmo la pone el feed, y solo cuando la hay: si
            el recomendador se cayo al orden cronologico, no llega ninguna y no
            se le atribuye nada.
          */
          superficie="for_you_feed"
          versionDelAlgoritmo={feedParaTi.versionDelAlgoritmo}
          vacio={
            <Vacio
              icono="video-off"
              titulo={t('home.emptyVideosTitle')}
              cuerpo={t('home.emptyVideosBody')}
              accion={{ etiqueta: t('home.publishFirst'), alPulsar: irACrear }}
              espacioInferior={espacioInferior}
            />
          }
        />
      </Pane>

      {/* SIGUIENDO */}
      {visitadas.has('siguiendo') ? (
        <Pane visible={pestana === 'siguiendo'}>
          {sinSesion ? (
            <Vacio
              icono="user-plus"
              titulo={t('home.signInTitle')}
              cuerpo={t('home.signInBody')}
              accion={{
                etiqueta: t('auth.signUp'),
                alPulsar: () => router.push('/register' as never),
              }}
              secundaria={{
                etiqueta: t('auth.signIn'),
                alPulsar: () => router.push('/login' as never),
              }}
              espacioInferior={espacioInferior}
            />
          ) : siguiendoVacio && !sigueAAlguien ? (
            <Vacio
              icono="users"
              titulo={t('home.followPeopleTitle')}
              cuerpo={t('home.followPeopleBody')}
              accion={{ etiqueta: t('home.discoverPeople'), alPulsar: irAExplorar }}
              espacioInferior={espacioInferior}
            />
          ) : (
            <View style={styles.lleno}>
              <FeedVerticalDeVideos
                feed={feedDeEstaPestana}
                altura={height}
                activo={seccionActiva && pestana === 'siguiendo'}
                silenciado={silenciado}
                alCambiarSilencio={cambiarSilencio}
                alForzarSilencio={forzarSilencio}
                espacioInferior={espacioInferior}
                /*
                  La superficie es DONDE se vio, no de donde salio el contenido:
                  aunque con sugerencias los videos vengan de «Para ti», quien
                  los mira esta en «Siguiendo». La version del algoritmo si sale
                  del feed que se este pintando, que es quien lo ordeno.
                */
                superficie="following_feed"
                versionDelAlgoritmo={feedDeEstaPestana.versionDelAlgoritmo}
                vacio={
                  <Vacio
                    icono="users"
                    titulo={t('home.nothingNewTitle')}
                    cuerpo={t('home.nothingNewBody')}
                    accion={{ etiqueta: t('home.discoverPeople'), alPulsar: irAExplorar }}
                    espacioInferior={espacioInferior}
                  />
                }
              />
              {conSugerencias ? (
                <View
                  pointerEvents="none"
                  style={[styles.aviso, { top: insets.top + 68, borderColor: media.border }]}
                >
                  <Feather name="info" size={13} color={media.text} />
                  <Text variant="caption" weight="700" color={media.text}>
                    {t('home.suggestionsNotice')}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
        </Pane>
      ) : null}

      {/* LIVE */}
      {visitadas.has('live') ? (
        <Pane visible={pestana === 'live'}>
          <SeccionLive
            activo={seccionActiva && pestana === 'live'}
            espacioInferior={espacioInferior}
            alDescubrir={irAExplorar}
          />
        </Pane>
      ) : null}

      <CabeceraDeInicio activa={pestana} alCambiar={cambiarPestana} alCrear={irACrear} />
    </View>
  );
}

/**
 * Una vista del Inicio.
 *
 * Las no visibles se quedan montadas pero fuera del alcance del dedo y sin
 * pintar. Desmontarlas obligaria a recargar y a perder la posicion cada vez
 * que se cambia de pestana, que es justo lo que no se quiere.
 */
function Pane({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <View
      style={[StyleSheet.absoluteFill, { opacity: visible ? 1 : 0, zIndex: visible ? 1 : 0 }]}
      pointerEvents={visible ? 'auto' : 'none'}
      // Sin esto, la vista oculta seguiria recibiendo el foco del lector de
      // pantalla y se leerian dos feeds a la vez.
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
    >
      {children}
    </View>
  );
}

function Vacio({
  icono,
  titulo,
  cuerpo,
  accion,
  secundaria,
  espacioInferior,
}: {
  icono: keyof typeof Feather.glyphMap;
  titulo: string;
  cuerpo: string;
  accion?: { etiqueta: string; alPulsar: () => void };
  secundaria?: { etiqueta: string; alPulsar: () => void };
  espacioInferior: number;
}) {
  return (
    <View style={[styles.vacio, { paddingBottom: espacioInferior }]}>
      <View style={[styles.vacioIcono, { borderColor: media.border }]}>
        <Feather name={icono} size={26} color={media.text} />
      </View>
      <Text variant="title" weight="800" color={media.text} style={styles.centrado}>
        {titulo}
      </Text>
      <Text variant="body" color={media.textMuted} style={styles.centrado}>
        {cuerpo}
      </Text>
      <View style={styles.vacioAcciones}>
        {accion ? (
          <Pressable
            onPress={accion.alPulsar}
            style={[styles.boton, { backgroundColor: media.text }]}
            accessibilityRole="button"
          >
            <Text variant="body" weight="700" color={media.background}>
              {accion.etiqueta}
            </Text>
          </Pressable>
        ) : null}
        {secundaria ? (
          <Pressable
            onPress={secundaria.alPulsar}
            style={[styles.boton, { borderWidth: 1, borderColor: media.border }]}
            accessibilityRole="button"
          >
            <Text variant="body" weight="700" color={media.text}>
              {secundaria.etiqueta}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  lleno: { flex: 1 },
  vacio: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  vacioIcono: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  centrado: { textAlign: 'center' },
  vacioAcciones: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  boton: {
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
  },
  aviso: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    backgroundColor: media.overlay,
    zIndex: 25,
  },
});
