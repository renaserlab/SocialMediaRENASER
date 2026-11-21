import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import Feather from '@expo/vector-icons/Feather';

import { CommentsSheet } from '@/components/CommentsSheet';
import { ReaccionesSheet } from '@/components/ReaccionesSheet';
import { ShortVideoItem, type ReelItem } from '@/components/ShortVideoItem';
import { Text } from '@/components/Text';
import type { FeedDeVideos } from '@/hooks/useFeedDeVideos';
import { usePrecargaDeVideos } from '@/hooks/usePrecargaDeVideos';
import { haptics } from '@/lib/haptics';
import { medicionDeVideo } from '@/lib/medicionDeVideoEnApp';
import { crearCoordinadorDePrecarga, enVentanaDePrecarga } from '@/lib/precargaDeVideos';
import { toast } from '@/lib/toast';
import type { Superficie } from '@/repositories/RecommendationRepository';
import {
  contenidoNoInteresa,
  videoVisible,
  videoVisto,
  type ContextoDeRecomendacion,
} from '@/services/senales';
import { palette, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

// Superficie a pantalla completa sobre video → contexto de media (oscuro).
const media = palette('dark');

/**
 * La web conserva la ventana y la descarga de antes (N-1..N+1, sin perfiles de
 * buffer): alli el reproductor es un `<video>` y lo nuevo no se ha medido.
 */
const ES_WEB = Platform.OS === 'web';

type Props = {
  feed: FeedDeVideos;
  /**
   * Alto de una pagina, COMO ESTIMACION INICIAL.
   *
   * El valor bueno lo mide la propia lista (ver `alMedir`): quien la pinta no
   * puede saberlo. Este solo sirve para el primer fotograma, antes de que haya
   * medida, y para que no se vea un hueco.
   */
  altura: number;
  /** El feed de la pestana que se esta viendo. Los demas no reproducen nada. */
  activo: boolean;
  /** Silencio compartido por todo el Inicio, no video a video. */
  silenciado: boolean;
  alCambiarSilencio: () => void;
  alForzarSilencio: () => void;
  /** Hueco reservado abajo para que la barra no tape los controles. */
  espacioInferior: number;
  /** Que ensenar cuando no hay ni un video (cada pestana dice lo suyo). */
  vacio?: React.ReactNode;
  /**
   * En que superficie se esta ensenando este feed.
   *
   * Viaja con cada impresion. Sin ella, «Para ti» y «Siguiendo» son el mismo
   * dato en el servidor y no hay forma de saber cual de los dos funciona: el
   * segundo lo ordena la gente a la que se sigue y el primero un algoritmo, asi
   * que mezclarlos hace ilegibles a los dos.
   */
  superficie?: Superficie;
  /**
   * Con que version del algoritmo se ordeno lo que se ve, si es que lo ordeno
   * alguna. Vacio en los feeds cronologicos: no se atribuye a nadie un orden
   * que no hizo.
   */
  versionDelAlgoritmo?: string;
};

/**
 * Feed vertical de videos a pantalla completa.
 *
 * Es el corazon del nuevo Inicio y esta separado de la pantalla porque hay
 * TRES usos del mismo componente —"Para ti", "Siguiendo" y cualquier feed
 * futuro— y duplicarlo significaria arreglar cada problema de reproduccion
 * tres veces.
 *
 * Lo que hace que se sienta inmediato, y que conviene no deshacer:
 *  - Solo el video visible reproduce; sus vecinos (el anterior y los dos
 *    siguientes) existen ya preparados, con su primer fotograma listo pero
 *    descargando lo justo (`lib/precargaDeVideos`). Nunca hay mas de cuatro
 *    reproductores vivos, que es lo que evita quedarse sin memoria nativa ni
 *    decodificadores en Android.
 *  - El resto de celdas son su poster: una imagen, cero red y cero memoria.
 *  - La siguiente pagina se pide con dos pantallas de antelacion, asi que al
 *    ritmo de un deslizamiento por video llega antes de hacer falta.
 */
export function FeedVerticalDeVideos({
  feed,
  altura,
  activo,
  silenciado,
  alCambiarSilencio,
  alForzarSilencio,
  espacioInferior,
  vacio,
  superficie,
  versionDelAlgoritmo,
}: Props) {
  const { t } = useTranslation();
  const [indiceActivo, setIndiceActivo] = useState(0);
  const [refrescando, setRefrescando] = useState(false);
  const insets = useSafeAreaInsets();
  // Primer MB de los 5 siguientes en la cache del reproductor. El `1` es el
  // vecino que ya tiene reproductor montado (`preload` mas abajo): si cambia
  // esa ventana, cambia aqui tambien.
  usePrecargaDeVideos(feed.items, indiceActivo, activo, 1);

  /*
    CADA PAGINA MIDE UNA PANTALLA. Pero ¿que pantalla?

    EL FALLO. En Android los videos salian recortados al desplazar, y un poco
    mas con cada deslizamiento. La causa es una discrepancia de medidas: el alto
    de cada celda venia de `useWindowDimensions()` —la VENTANA del sistema— y el
    ajuste de pagina (`pagingEnabled`) lo hace la lista con SU alto, que es el
    de un contenedor `flex: 1` dentro del carrusel de secciones. Con
    `edgeToEdgeEnabled` y sin configuracion de barra de navegacion, esos dos
    numeros no tienen por que coincidir: la ventana incluye franjas del sistema
    que el contenedor no tiene.

    Bastan unos pocos pixeles de diferencia para que se note, porque el error se
    ACUMULA: la pagina N queda desplazada N veces esa diferencia, y por eso el
    recorte crece al bajar. No es un modelo concreto de telefono: es cualquiera
    cuyo contenedor no mida exactamente lo que mide la ventana.

    La correccion es preguntarselo a quien lo sabe. La lista mide su propio
    recuadro y ESE es el alto de una pagina, en cualquier aparato, con
    cualquier barra y despues de girar. La prop `altura` se queda como
    estimacion para el primer fotograma.
  */
  const [altoMedido, setAltoMedido] = useState<number | null>(null);
  const alMedir = useCallback((evento: LayoutChangeEvent) => {
    const alto = Math.round(evento.nativeEvent.layout.height);
    // Se ignoran las medidas absurdas del primer montaje y los cambios de un
    // pixel: reescribir el alto redibuja todas las celdas montadas.
    setAltoMedido((previo) =>
      alto > 0 && (previo === null || Math.abs(previo - alto) > 1) ? alto : previo,
    );
  }, []);
  const altoDePagina = altoMedido ?? altura;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;

  /*
    Quien reparte el ancho de banda entre el activo y sus vecinos. Uno por
    feed y estable: viaja a todas las celdas, que estan memoizadas. Lo que
    cambia dentro (dedo arrastrando, activo con poco buffer) no redibuja nada;
    cada reproductor se entera por su cuenta.
  */
  const coordinador = useRef(crearCoordinadorDePrecarga()).current;
  /*
    El dedo empieza a mover la lista. Es tambien el cero de la medicion de
    «deslizar al siguiente», que no cambia: se sigue llamando igual y en el
    mismo instante.
  */
  const alEmpezarArrastre = useCallback(() => {
    medicionDeVideo.inicioDeGesto();
    coordinador.inicioDeArrastre();
  }, [coordinador]);

  /*
    De donde viene lo que se esta viendo, en una referencia.

    `onViewableItemsChanged` se crea UNA vez —la lista no admite cambiarlo sobre
    la marcha— asi que si leyera las props directamente se quedaria con las del
    primer render y mediria «Para ti» eternamente aunque el feed fuera otro. La
    referencia se reescribe en cada render sin redibujar nada, que es lo unico
    que puede hacer la medicion aqui dentro: no costar.
  */
  // El `rank` NO vive aqui: es de cada elemento, no del feed.
  const contexto = useRef<Omit<ContextoDeRecomendacion, 'rank'>>({});
  contexto.current.surface = superficie;
  contexto.current.algorithmVersion = versionDelAlgoritmo;

  /*
    Cuanto lleva en pantalla el video actual, y cual era.

    Van en referencias y no en estado porque se leen y se escriben dentro del
    mismo manejador: con estado se leeria el valor del render anterior y el
    tiempo medido seria el del video equivocado. Y porque cambiarlas NO debe
    redibujar nada: esto es medicion, y medir no puede costar un render por
    deslizamiento.
  */
  const videoEnPantalla = useRef<{ id: string; desde: number; rank: number } | null>(null);

  const cerrarMedicion = useCallback(() => {
    const anterior = videoEnPantalla.current;
    if (!anterior) return;
    videoEnPantalla.current = null;
    const visible = Date.now() - anterior.desde;
    /*
      No se sabe cuanto dura cada video (la duracion es opcional en el medio),
      asi que se aproxima el interes por el TIEMPO: quince segundos mirando algo
      es una senal fuerte se acabe o no. Es deliberadamente conservador; mejor
      quedarse corto que inventarse un porcentaje.
    */
    videoVisto(anterior.id, Math.min(1, visible / 15000), visible, {
      ...contexto.current,
      rank: anterior.rank,
    });
  }, []);

  const onViewableItemsChanged = useRef(
    ({
      viewableItems,
    }: {
      viewableItems: Array<{ index: number | null; item?: ReelItem }>;
    }) => {
      const primero = viewableItems[0];
      if (!primero || typeof primero.index !== 'number') return;
      setIndiceActivo(primero.index);

      const id = primero.item?.id;
      if (!id || videoEnPantalla.current?.id === id) return;
      cerrarMedicion();
      /*
        El puesto es la POSICION EN LA LISTA, no el orden en que se recibio del
        servidor: es lo que de verdad tuvo delante quien mira. Sin el, la
        primera posicion y la vigesima son el mismo dato, y como lo primero se
        toca mas —sea bueno o no— las tasas no se pueden comparar.
      */
      const rank = primero.index;
      videoEnPantalla.current = { id, desde: Date.now(), rank };
      videoVisible(id, { ...contexto.current, rank });
    },
  ).current;

  /*
    Al salir del feed (cambiar de pestana, de seccion o cerrar) se cierra la
    medicion en curso. Sin esto, el ultimo video de cada sesion no contaria
    nunca: siempre falta el que se estaba viendo al irse.
  */
  useEffect(() => cerrarMedicion, [cerrarMedicion]);
  useEffect(() => {
    if (!activo) cerrarMedicion();
  }, [activo, cerrarMedicion]);

  /*
    Videos de S3 (opcion B): antes de que el video y sus vecinos reproduzcan,
    se renuevan las URLs que caducan (las firma la API y duran horas; una lista
    de la manana, o la instantanea, las trae muertas). Sin nada vencido no se
    pide nada. Depende de la lista para revisar tambien lo recien llegado.
  */
  const renovarCercanos = feed.renovarCercanos;
  useEffect(() => {
    if (activo) renovarCercanos(indiceActivo);
  }, [activo, indiceActivo, feed.items, renovarCercanos]);

  /*
    «No me interesa» sobre ESTE video.

    RECHAZAR UN VIDEO NO ES RECHAZAR A QUIEN LO PUBLICO. Aqui no se deja de
    seguir a nadie, no se bloquea a nadie y no se esconde el resto de su
    contenido: lo unico que ocurre es que esta publicacion sale de la lista y el
    recomendador se entera. Quien quiera dejar de ver a una persona entera tiene
    para eso el boton de dejar de seguir y el de bloquear, que son decisiones
    distintas, se toman en otro sitio y se pueden deshacer.

    `quitarDelFeed` viene del hook y es estable: si su identidad cambiara en
    cada render, esta funcion tambien, y con ella la prop de todos los videos
    montados —que estan memoizados justo para no redibujarse al deslizar.
  */
  const quitarDelFeed = feed.descartar;
  const descartarVideo = useCallback(
    (postId: string) => {
      const enCurso = videoEnPantalla.current;
      const esElQueSeVe = enCurso?.id === postId;
      /*
        La medicion en curso se OLVIDA, no se cierra. Haber tenido el video
        delante unos segundos cuenta como interes, y mandar «se quedo mirandolo»
        junto a «no me interesa» seria darle al recomendador dos senales que se
        contradicen sobre el mismo video.
      */
      if (esElQueSeVe) videoEnPantalla.current = null;

      contenidoNoInteresa(postId, {
        ...contexto.current,
        rank: esElQueSeVe ? enCurso?.rank : undefined,
      });
      quitarDelFeed(postId);
      haptics.light();
      // No se ofrece deshacer: el toast de la aplicacion solo lleva mensaje e
      // icono, no accion. Por eso el texto dice lo que pasa, sin prometer una
      // vuelta atras que no existe.
      toast(t('feed.hidden'), 'eye-off');
    },
    [quitarDelFeed],
  );

  /*
    COMENTARIOS Y REACCIONES, EN HOJA Y SIN SALIR DEL VIDEO.

    Son LAS MISMAS hojas que abre la tarjeta de Explorar (`PostCard`): el mismo
    contenido, la misma consulta por id de publicacion y el mismo seguir desde
    la lista. Como el id del video ES el de la publicacion, lo que se comenta
    aqui aparece alli y al reves.

    Viven en el feed y no en cada celda: una sola pareja para toda la lista, y
    ningun estado dentro de una celda que FlashList recicla para otro video.
    Las funciones son estables (`useCallback` sin dependencias) porque viajan a
    todas las celdas, que estan memoizadas para no redibujarse al deslizar.
  */
  const [comentandoEn, setComentandoEn] = useState<{ postId: string; total: number } | null>(null);
  const [reaccionesDe, setReaccionesDe] = useState<string | null>(null);
  const abrirComentarios = useCallback(
    (postId: string, total: number) => setComentandoEn({ postId, total }),
    [],
  );
  const cerrarComentarios = useCallback(() => setComentandoEn(null), []);
  const verReacciones = useCallback((postId: string) => setReaccionesDe(postId), []);
  const cerrarReacciones = useCallback(() => setReaccionesDe(null), []);

  const refrescar = useCallback(async () => {
    setRefrescando(true);
    try {
      await feed.refrescar();
    } finally {
      setRefrescando(false);
    }
  }, [feed]);

  const aviso =
    feed.estado === 'cargando' ? (
      <View style={styles.aviso}>
        <ActivityIndicator color={media.text} />
      </View>
    ) : feed.estado === 'error' ? (
      <View style={styles.aviso}>
        <Feather name="wifi-off" size={32} color={media.text} />
        <Text variant="title" weight="800" color={media.text} style={styles.avisoTexto}>
          {t('common.loadFailed')}
        </Text>
        <Text variant="body" color={media.textMuted} style={styles.avisoTexto}>
          {/* Se dice el motivo real: si el telefono esta sin cobertura, saberlo
              evita leerlo como un fallo de la aplicacion. */}
          {feed.error ?? t('common.checkConnection')}
        </Text>
        <Pressable
          onPress={feed.reintentar}
          style={[styles.avisoBoton, { borderColor: media.border }]}
          accessibilityRole="button"
        >
          <Text variant="body" weight="700" color={media.text}>
            {t('common.retry')}
          </Text>
        </Pressable>
      </View>
    ) : feed.items.length === 0 ? (
      <View style={styles.aviso}>{vacio}</View>
    ) : null;

  return (
    <View style={styles.raiz} onLayout={alMedir}>
      {aviso}

      {/*
        Se dice que lo que se ve esta guardado y que los videos no van a sonar.
        Callarlo dejaria a alguien tocando una portada sin que pasara nada, sin
        entender por que.
      */}
      {feed.desdeCache && activo ? (
        <View
          /*
            Justo debajo de la cabecera, que ya respeta la zona segura. Con un
            valor fijo, en un movil con muesca alta el aviso se solapaba con
            las pestañas de arriba.
          */
          style={[styles.sinRed, { borderColor: media.border, top: Math.max(insets.top, spacing.md) + 56 }]}
          pointerEvents="none"
        >
          <Feather name="wifi-off" size={13} color={media.text} />
          <Text variant="caption" weight="700" color={media.text}>
            {t('feed.offlineCached')}
          </Text>
        </View>
      ) : null}
      <FlashList
        data={feed.items}
        keyExtractor={(item: ReelItem) => item.id}
        renderItem={({ item, index }: { item: ReelItem; index: number }) => {
          // Solo dentro de la ventana: fuera no hay reproductor y un numero
          // cambiante redibujaria celdas que solo ensenan su poster.
          const distancia =
            !ES_WEB && activo && enVentanaDePrecarga(index, indiceActivo) ? index - indiceActivo : undefined;
          return (
          <ShortVideoItem
            short={item}
            /*
              Un feed que no se esta viendo NO reproduce. Sin esto, al pasar a
              "Siguiendo" el video de "Para ti" seguiria sonando por debajo.
            */
            active={activo && index === indiceActivo}
            preload={activo && enVentanaDePrecarga(index, indiceActivo, ES_WEB)}
            distanciaAlActivo={distancia}
            coordinadorDePrecarga={ES_WEB ? undefined : coordinador}
            height={altoDePagina}
            muted={silenciado}
            onToggleMuted={alCambiarSilencio}
            onForcedMute={alForzarSilencio}
            espacioInferior={espacioInferior}
            alFallarVideo={feed.alFallarVideo}
            alDescartar={descartarVideo}
            alAbrirComentarios={abrirComentarios}
            alVerReacciones={verReacciones}
            medir
          />
          );
        }}
        pagingEnabled
        // El siguiente se prepara con antelacion: montarlo justo al llegar deja
        // un parpadeo en blanco que se percibe como un tiron. En telefonos son
        // DOS pantallas, para que exista la celda N+2 de la ventana; las
        // celdas de mas lejos solo pintan su poster.
        drawDistance={ES_WEB ? altoDePagina : altoDePagina * 2}
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        // El cero de «deslizar al siguiente»: el dedo empieza a mover la
        // lista. Funciones estables, sin estado ni render. Mientras dura el
        // gesto (arrastre + inercia) los vecinos dejan de pedir mas datos.
        onScrollBeginDrag={alEmpezarArrastre}
        onScrollEndDrag={coordinador.finDeArrastre}
        onMomentumScrollBegin={coordinador.inicioDeInercia}
        onMomentumScrollEnd={coordinador.finDeInercia}
        viewabilityConfig={viewabilityConfig}
        onEndReached={feed.cargarMas}
        onEndReachedThreshold={2}
        refreshControl={
          <RefreshControl
            refreshing={refrescando}
            onRefresh={refrescar}
            tintColor={media.text}
            colors={[media.text]}
            progressBackgroundColor={media.background}
          />
        }
      />

      <CommentsSheet
        postId={comentandoEn?.postId ?? null}
        totalConocido={comentandoEn?.total}
        visible={comentandoEn !== null}
        onClose={cerrarComentarios}
      />
      <ReaccionesSheet
        postId={reaccionesDe}
        visible={reaccionesDe !== null}
        onClose={cerrarReacciones}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  aviso: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    zIndex: 10,
  },
  avisoTexto: { textAlign: 'center' },
  sinRed: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    backgroundColor: media.overlay,
    zIndex: 26,
  },
  avisoBoton: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    minHeight: 44,
    justifyContent: 'center',
  },
});
