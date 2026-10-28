import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { BottomSheet } from '@/components/BottomSheet';
import { ListRow } from '@/components/ListRow';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { useTecladoALaVista } from '@/components/teclado';
import { VideoPlayer } from '@/components/VideoPlayer';
import { assets } from '@/data/assets';
import {
  ESPERA_MAXIMA_MS,
  barraAvanza,
  cargaDe,
  muestraCargando,
  precargasDelVisor,
  seHaVisto,
  trasAviso,
  type AvisoDeCarga,
  type CargaDelTramo,
} from '@/lib/cargaDeHistorias';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { MessageRepository } from '@/repositories/MessageRepository';
import { StoryRepository } from '@/repositories/StoryRepository';
import {
  pausarPrecargas,
  precargaEnCurso,
  precargarHistorias,
} from '@/services/precargaDeHistorias';
import { useAppStore } from '@/store/useAppStore';
import { palette, radius, spacing } from '@/theme/tokens';
import type { StoryViewer } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

// Visor a pantalla completa sobre imagen → contexto de media (siempre oscuro).
const media = palette('dark');

/** Los bordes que reserva la pantalla: todos, y sin el de abajo con el teclado. */
const BORDES_SIN_TECLADO = ['top', 'right', 'bottom', 'left'] as const;
const BORDES_CON_TECLADO = ['top', 'right', 'left'] as const;

export function StoriesScreen() {
  const tecladoAbierto = useTecladoALaVista();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const groups = useAppStore((state) => state.storyGroups);
  const markStoryViewed = useAppStore((state) => state.markStoryViewed);
  const deleteStory = useAppStore((state) => state.deleteStory);

  // El parametro es el id del autor; se admite el indice como alternativa.
  const initialAuthor = useMemo(() => {
    const byId = groups.findIndex((g) => g.authorId === id);
    if (byId >= 0) return byId;
    const asIndex = Number(id);
    return Number.isFinite(asIndex) && asIndex >= 0 && asIndex < groups.length ? asIndex : 0;
  }, [id, groups]);

  const [authorIndex, setAuthorIndex] = useState(initialAuthor);
  const [segIndex, setSegIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewersOpen, setViewersOpen] = useState(false);
  const [viewers, setViewers] = useState<StoryViewer[] | null>(null);

  // Responder a la historia: el texto y si se está mandando.
  const [respuesta, setRespuesta] = useState('');
  const [enviandoRespuesta, setEnviandoRespuesta] = useState(false);

  const group = groups[authorIndex];
  const items = group?.items ?? [];
  const item = items[segIndex];

  /**
   * Progreso del tramo. Se anima con `Animated` en vez del `setInterval` de
   * antes, que forzaba un render cada 60 ms. `useNativeDriver` no admite
   * `width`, pero aun asi el valor deja de pasar por el estado de React.
   */
  const progress = useRef(new Animated.Value(0)).current;
  const resumeFrom = useRef(0);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  }, [router]);

  const goNext = useCallback(() => {
    if (segIndex + 1 < items.length) {
      setSegIndex(segIndex + 1);
      return;
    }
    if (authorIndex + 1 < groups.length) {
      setAuthorIndex(authorIndex + 1);
      setSegIndex(0);
      return;
    }
    close();
  }, [segIndex, items.length, authorIndex, groups.length, close]);

  const goPrev = useCallback(() => {
    if (segIndex > 0) {
      setSegIndex(segIndex - 1);
      return;
    }
    if (authorIndex > 0) {
      const prev = authorIndex - 1;
      setAuthorIndex(prev);
      setSegIndex(Math.max(0, (groups[prev]?.items.length ?? 1) - 1));
      return;
    }
    setSegIndex(0);
  }, [segIndex, authorIndex, groups]);

  const nextAuthor = useCallback(() => {
    if (authorIndex + 1 < groups.length) {
      setAuthorIndex(authorIndex + 1);
      setSegIndex(0);
    } else {
      close();
    }
  }, [authorIndex, groups.length, close]);

  const prevAuthor = useCallback(() => {
    if (authorIndex > 0) {
      setAuthorIndex(authorIndex - 1);
      setSegIndex(0);
    }
  }, [authorIndex]);

  /*
    `goNext` cambia con cada tramo; la animacion lo lee de aqui al terminar.
    Asi `runProgress` no cambia nunca y la barra solo se reinicia cuando cambia
    el tramo o su carga, no porque se haya creado una funcion nueva.
  */
  const goNextRef = useRef(goNext);
  goNextRef.current = goNext;

  const runProgress = useCallback(
    (from: number, totalMs: number) => {
      progress.setValue(from);
      // Para pararla basta `progress.stopAnimation`: no hace falta guardarla.
      Animated.timing(progress, {
        toValue: 1,
        duration: Math.max(0, totalMs * (1 - from)),
        easing: Easing.linear,
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished) goNextRef.current();
      });
    },
    [progress],
  );

  /*
    LA BARRA ESPERA A LA FOTO.

    Antes el tramo empezaba a contar al abrirse, y la foto tarda en llegar
    (bucket privado, sin CDN: hasta 1,8 s solo de primer byte). Ese tiempo se
    descontaba del tramo mirando negro. Ahora cuenta desde que la foto —o el
    primer fotograma del video— esta en pantalla; si falla o pasa el tope de
    espera, arranca igual para que el visor nunca se quede parado. Las reglas
    viven en `lib/cargaDeHistorias.ts`, donde estan probadas.

    El estado va marcado con el id del tramo: lo guardado de OTRO tramo no
    vale (`cargaDe` lo descarta), asi que al pasar al siguiente no hay un solo
    render en el que la barra arranque con la carga del anterior.

    Y todo lo que sigue depende del ID del tramo, no del objeto: marcarlo como
    visto reescribe el almacen y crea un objeto nuevo para el mismo tramo, y
    eso antes reiniciaba la barra justo al abrir.
  */
  const [cargaGuardada, setCargaGuardada] = useState<CargaDelTramo | null>(null);
  const carga = item ? cargaDe(cargaGuardada, item) : null;
  const tramoActual = useRef(item);
  tramoActual.current = item;

  /** Avisos de la imagen, del video y del tope. Los de otro tramo se ignoran. */
  const avisarCarga = useCallback((tramoId: string, aviso: AvisoDeCarga) => {
    setCargaGuardada((guardada) => {
      const actual = tramoActual.current;
      return actual ? trasAviso(cargaDe(guardada, actual), tramoId, aviso) : guardada;
    });
  }, []);

  const tramoId = item?.id;
  const duracion = item?.durationMs ?? 0;
  const avanza = carga ? barraAvanza(carga, paused) : false;
  const esperandoFoto = carga ? muestraCargando(carga) : false;
  const visto = carga ? seHaVisto(carga) : false;
  const fotoResuelta = !!carga && carga.fase !== 'cargando';

  // Tramo nuevo: la barra vuelve a cero y espera a su foto. Va ANTES que el
  // efecto que la arranca: React ejecuta las puestas en marcha en orden.
  useEffect(() => {
    resumeFrom.current = 0;
    progress.setValue(0);
  }, [tramoId, progress]);

  /*
    La barra corre mientras el tramo puede contar y nadie lo tiene en pausa
    (mantener pulsado, escribir una respuesta, la hoja de «Visto por»). Al
    pararse se guarda por donde iba y al seguir se retoma desde ahi; si para
    porque cambio el tramo, el efecto de arriba lo devuelve a cero.
  */
  useEffect(() => {
    if (!tramoId || !avanza) return;
    runProgress(resumeFrom.current, duracion);
    return () => {
      progress.stopAnimation((value) => {
        resumeFrom.current = value;
      });
    };
  }, [tramoId, avanza, duracion, progress, runProgress]);

  // El tope: pasado `ESPERA_MAXIMA_MS` sin foto, el tramo arranca igual.
  useEffect(() => {
    if (!tramoId || !esperandoFoto) return;
    const tope = setTimeout(() => avisarCarga(tramoId, 'espera-agotada'), ESPERA_MAXIMA_MS);
    return () => clearTimeout(tope);
  }, [tramoId, esperandoFoto, avisarCarga]);

  /*
    Visto cuando SE VE, no al abrir: quien pasa al siguiente antes de que
    llegue la foto, o la abre sin red, no la ha visto. Asi su anillo sigue
    encendido y el autor no suma una visita que no hubo.
  */
  useEffect(() => {
    if (tramoId && visto) markStoryViewed(tramoId);
  }, [tramoId, visto, markStoryViewed]);

  /*
    Lo siguiente, en cuanto lo de ahora esta resuelto: el proximo tramo de este
    autor y el primero del siguiente. No antes, para no quitarle ancho de banda
    a la foto que se esta esperando. `delante` porque es mas urgente que lo que
    se adelanto desde la fila.
  */
  useEffect(() => {
    if (!fotoResuelta) return;
    precargarHistorias(precargasDelVisor(groups, authorIndex, segIndex), { delante: true });
  }, [fotoResuelta, groups, authorIndex, segIndex]);

  /*
    Y al reves: mientras la foto de pantalla no ha llegado, la cola no empieza
    ninguna precarga nueva. Medido: la foto que se toca compartiendo linea con
    la precarga de otro autor llegaba mas tarde que sin precargar nada.
  */
  useEffect(() => {
    if (!esperandoFoto) return;
    return pausarPrecargas();
  }, [tramoId, esperandoFoto]);

  /*
    SI ESTA FOTO YA VIENE DE CAMINO POR LA PRECARGA, SE ESPERA A ESA DESCARGA
    en vez de lanzar otra. En Android serian dos descargas de la misma foto
    repartiendose la linea (ver `services/precargaDeHistorias.ts`); al
    terminar, la foto sale de la cache. Si la precarga falla, el visor la pide
    por su cuenta; el tope de espera sigue corriendo igual.
  */
  const claveDeFoto = item?.mediaType === 'image' && item.mediaUrl ? item.storagePath : null;
  const precargaPendiente = claveDeFoto ? precargaEnCurso(claveDeFoto) : undefined;
  const [precargaTerminada, setPrecargaTerminada] = useState<string | null>(null);
  useEffect(() => {
    if (!claveDeFoto || !precargaPendiente) return;
    let vivo = true;
    void precargaPendiente.then(() => {
      if (vivo) setPrecargaTerminada(claveDeFoto);
    });
    return () => {
      vivo = false;
    };
  }, [claveDeFoto, precargaPendiente]);
  const fotoEnCamino = !!precargaPendiente && precargaTerminada !== claveDeFoto;

  const openViewers = async () => {
    if (!item) return;
    setPaused(true);
    setViewersOpen(true);
    try {
      setViewers(await StoryRepository.listViewers(item.id));
    } catch {
      setViewers([]);
    }
  };

  const removeStory = async () => {
    if (!item) return;
    setPaused(true);
    const accepted = await confirm({
      title: t('stories.deleteTitle'),
      message: t('stories.deleteBody'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!accepted) {
      setPaused(false);
      return;
    }
    try {
      await deleteStory(item.id);
      toast(t('stories.deleted'));
      close();
    } catch {
      notify(t('common.deleteFailed'), t('common.tryAgain'));
      setPaused(false);
    }
  };

  /*
    Al cambiar de tramo o de autor se vacía lo escrito.

    Sin esto, empezar a responder a la historia de Ana, pasar a la de Bruno y
    pulsar enviar le mandaría a Bruno un texto pensado para Ana. Es el fallo que
    parece imposible hasta que pasa: el visor avanza SOLO cuando se acaba el
    tiempo del tramo, así que nadie tiene que tocar nada para que ocurra.
  */
  useEffect(() => {
    setRespuesta('');
  }, [item?.id, group?.authorId]);

  /**
   * Responde a la historia que se está viendo.
   *
   * EL CAMINO ES EL QUE YA EXISTE, y eso es deliberado: se pide la conversación
   * directa con `getOrCreateDirect`, que es IDEMPOTENTE en el servidor desde la
   * migración 0039 —la clave primaria de `direct_conversation_pairs` impide que
   * dos peticiones a la vez creen dos chats con la misma persona—. Inventar aquí
   * otro obtener-o-crear reabriría por otro sitio el fallo que esa migración
   * cerró: la misma persona repetida en la bandeja.
   *
   * EL MENSAJE VIAJA CON `story_id`, NO CON UN ENLACE DENTRO DEL TEXTO. El
   * cuerpo es lo que se escribió y nada más; a qué historia respondía es
   * estructura aparte (`message_story_context`). Es lo que permite que el chat
   * lo entienda, que la bandeja pueda filtrar «Respuestas a historias», y que el
   * mensaje siga leyéndose cuando la historia caduque mañana.
   *
   * NO SE NAVEGA AL CHAT. Quien está viendo historias quiere seguir viéndolas;
   * sacarle de aquí para enseñarle su propio mensaje es una interrupción que no
   * ha pedido. Se confirma con un aviso corto y el visor continúa.
   */
  const responder = useCallback(async () => {
    const texto = respuesta.trim();
    if (!texto || !item || !group || enviandoRespuesta) return;

    setEnviandoRespuesta(true);
    try {
      const conversacion = await MessageRepository.getOrCreateDirect(group.authorId);
      await MessageRepository.sendMessage(
        conversacion.id,
        texto,
        undefined,
        [],
        item.id,
      );
      setRespuesta('');
      toast(t('stories.replySent', { nombre: group.author }));
    } catch {
      notify(t('chat.sendFailed'), t('common.checkConnection'));
    } finally {
      setEnviandoRespuesta(false);
      // El tramo sigue donde estaba: se reanuda al cerrar el teclado.
      setPaused(false);
    }
  }, [respuesta, item, group, enviandoRespuesta, t]);

  // Swipe: horizontal cambia de autor, hacia abajo cierra.
  const pan = Gesture.Pan().onEnd((e) => {
    if (e.translationY > 90) {
      runOnJS(close)();
      return;
    }
    if (e.translationX < -60) {
      runOnJS(nextAuthor)();
      return;
    }
    if (e.translationX > 60) {
      runOnJS(prevAuthor)();
    }
  });

  const hold = Gesture.LongPress()
    .minDuration(180)
    .onStart(() => runOnJS(setPaused)(true))
    .onFinalize(() => runOnJS(setPaused)(false));

  const gesture = Gesture.Simultaneous(pan, hold);

  if (!group || !item) {
    return (
      <View style={[styles.root, styles.empty]}>
        <Text style={[styles.author, { color: media.text }]}>No hay historias que mostrar.</Text>
        <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <Feather name="x" size={26} color={media.text} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/*
        `contain` y no `cover`: una historia se ve ENTERA. Con `cover` se
        rellenaba la pantalla recortando lo que sobraba, asi que una foto que no
        fuera justo vertical perdia los bordes —y con ellos, a menudo, la cara
        de quien la subio—. Lo que queda libre alrededor es negro, como en
        Instagram o TikTok.
      */}
      {item.mediaType === 'video' && item.mediaUrl ? (
        /*
          Un reproductor por tramo (`key`): asi cada video avisa de SU primer
          fotograma. Reutilizando el componente, el aviso del segundo video
          dependia de que expo-video lo repitiera al cambiar de fuente.
          Mientras llega, el propio reproductor ya enseña su indicador.
        */
        <VideoPlayer
          key={item.id}
          uri={item.mediaUrl}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          active={!paused}
          onFirstFrame={() => avisarCarga(item.id, 'cargada')}
        />
      ) : (
        /*
          `cacheKey` = ruta de Storage: la firma cambia cada ~50 min y, sin
          clave, una historia ya vista se volvia a descargar entera. Es tambien
          la clave con la que la guarda la precarga (ver
          `services/precargaDeHistorias.ts`).

          `recyclingKey` por tramo: sin el, mientras llega la foto nueva se
          seguia viendo la ANTERIOR, con el texto del tramo nuevo encima.
        */
        <ExpoImage
          source={
            !item.mediaUrl
              ? assets.hero
              : fotoEnCamino
              ? null
              : { uri: item.mediaUrl, cacheKey: item.storagePath }
          }
          recyclingKey={item.id}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={150}
          onLoad={() => avisarCarga(item.id, 'cargada')}
          onError={() => avisarCarga(item.id, 'fallida')}
        />
      )}
      <LinearGradient
        colors={[media.overlay, 'transparent', media.overlay]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* La foto esta en camino: el mismo indicador que el resto de la app. */}
      {esperandoFoto && item.mediaType !== 'video' ? (
        <View style={styles.cargando} pointerEvents="none">
          <ActivityIndicator
            size="large"
            color={media.text}
            accessibilityLabel={t('common.loading')}
          />
        </View>
      ) : null}

      {/* Zonas de tap: izquierda retrocede, derecha avanza */}
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={styles.zoneLeft} onPress={goPrev} accessibilityRole="button" accessibilityLabel="Tramo anterior" />
          <Pressable style={styles.zoneRight} onPress={goNext} accessibilityRole="button" accessibilityLabel="Siguiente tramo" />
        </View>
      </GestureDetector>

      {/*
        EL TECLADO NO PUEDE TAPAR EL CAMPO DE RESPUESTA. Se usa el componente de
        siempre (`KeyboardAvoidingView` con `padding` en iOS y `height` en
        Android), no un margen a mano: en Android la aplicación es
        `edgeToEdgeEnabled`, así que la ventana NO se reajusta sola al abrirse el
        teclado y sin esto el campo queda literalmente debajo.

        `pointerEvents="box-none"` para que las zonas de toque de debajo —avanzar
        y retroceder tramo— sigan funcionando a través de él.
      */}
      <SinTecladoDelante style={StyleSheet.absoluteFill as never}>
      {/* Con el teclado abierto no se reserva el borde inferior: el marco de
          fuera ya deja el campo justo encima del teclado. */}
      <SafeAreaView
        style={styles.safe}
        pointerEvents="box-none"
        edges={tecladoAbierto ? BORDES_CON_TECLADO : BORDES_SIN_TECLADO}
      >
        {/* Barras de progreso, una por tramo */}
        <View style={styles.progressRow} pointerEvents="none">
          {items.map((seg, i) => (
            <View key={seg.id} style={[styles.progressTrack, { backgroundColor: media.border }]}>
              {i === segIndex ? (
                <Animated.View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: media.text,
                      width: progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['0%', '100%'],
                      }),
                    },
                  ]}
                />
              ) : (
                <View
                  style={[
                    styles.progressFill,
                    { backgroundColor: media.text, width: i < segIndex ? '100%' : '0%' },
                  ]}
                />
              )}
            </View>
          ))}
        </View>

        <View style={styles.header}>
          <ExpoImage
            source={group.avatarUrl ? { uri: group.avatarUrl } : assets.avatar}
            style={styles.avatar}
            contentFit="cover"
          />
          <Text style={[styles.author, { color: media.text }]} numberOfLines={1}>
            {group.author}
          </Text>
          {group.isOwn ? (
            <Pressable
              onPress={() => void removeStory()}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('stories.deleteTitle')}
            >
              <Feather name="trash-2" size={20} color={media.text} />
            </Pressable>
          ) : null}
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('stories.close')}>
            <Feather name="x" size={24} color={media.text} />
          </Pressable>
        </View>

        <View style={styles.spacer} pointerEvents="none" />

        {item.caption ? (
          <Text style={[styles.caption, { color: media.text }]} pointerEvents="none">
            {item.caption}
          </Text>
        ) : null}

        {/* Solo el autor ve quien miro su historia. */}
        {group.isOwn ? (
          <Pressable
            onPress={() => void openViewers()}
            style={styles.viewsRow}
            accessibilityRole="button"
            accessibilityLabel={t('stories.whoViewed')}
          >
            <Feather name="eye" size={16} color={media.text} />
            <Text style={[styles.viewsText, { color: media.text }]}>
              {item.viewsCount === 1
                ? t('stories.viewsOne')
                : t('stories.viewsMany', { count: item.viewsCount })}
            </Text>
          </Pressable>
        ) : (
          /*
            RESPONDER A LA HISTORIA. Solo en las ajenas: responderse a uno mismo
            no significa nada, y el autor ya tiene ahí su lista de quién la vio.

            AL ESCRIBIR SE PAUSA EL TRAMO, y no es un detalle: sin eso la historia
            avanza sola mientras alguien teclea y el mensaje acaba mandándose
            —o peor, vaciándose— sobre otra historia distinta.
          */
          <View style={[styles.replyRow, { borderColor: media.border }]}>
            <TextInput
              value={respuesta}
              onChangeText={setRespuesta}
              onFocus={() => setPaused(true)}
              onBlur={() => setPaused(false)}
              onSubmitEditing={() => void responder()}
              placeholder={t('stories.replyTo', { nombre: group.author })}
              placeholderTextColor={media.textMuted}
              returnKeyType="send"
              editable={!enviandoRespuesta}
              style={[styles.replyInput, { color: media.text }]}
              accessibilityLabel={t('stories.replyTo', { nombre: group.author })}
            />
            {/*
              El botón solo aparece cuando hay algo que mandar. Un avión de papel
              siempre visible y siempre inerte es un botón muerto.
            */}
            {respuesta.trim() ? (
              <Pressable
                onPress={() => void responder()}
                disabled={enviandoRespuesta}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('chat.sendMessage')}
              >
                {enviandoRespuesta ? (
                  <ActivityIndicator size="small" color={media.text} />
                ) : (
                  <Feather name="send" size={20} color={media.text} />
                )}
              </Pressable>
            ) : null}
          </View>
        )}
      </SafeAreaView>
      </SinTecladoDelante>

      <BottomSheet
        visible={viewersOpen}
        onClose={() => {
          setViewersOpen(false);
          setPaused(false);
        }}
      >
        <Text style={styles.sheetTitle}>VISTO POR</Text>
        {viewers === null ? (
          <Text style={styles.sheetEmpty}>{t('common.loading')}</Text>
        ) : viewers.length === 0 ? (
          <Text style={styles.sheetEmpty}>Todavía no la ha visto nadie.</Text>
        ) : (
          viewers.map((viewer) => (
            <ListRow
              key={viewer.id}
              title={viewer.fullName}
              subtitle={viewer.username}
              leftComponent={
                <ExpoImage
                  source={viewer.avatarUrl ? { uri: viewer.avatarUrl } : assets.avatar}
                  style={styles.viewerAvatar}
                  contentFit="cover"
                />
              }
            />
          ))
        )}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  empty: { alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  cargando: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  safe: { flex: 1, paddingHorizontal: spacing.lg },
  zoneLeft: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '32%' },
  zoneRight: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '68%' },
  progressRow: { flexDirection: 'row', gap: 4, marginTop: spacing.sm },
  progressTrack: { flex: 1, height: 3, borderRadius: radius.pill, overflow: 'hidden' },
  progressFill: { height: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  author: { flex: 1, fontSize: 14, fontWeight: '800' },
  spacer: { flex: 1 },
  caption: { fontSize: 15, lineHeight: 21, fontWeight: '600', marginBottom: spacing.lg },
  viewsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xxl },
  viewsText: { fontSize: 13, fontWeight: '700' },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xxl,
  },
  // `minHeight` y no `height`: en Android un campo sin altura mínima se queda
  // de una línea aplastada cuando el sistema usa una fuente grande.
  replyInput: { flex: 1, fontSize: 14, minHeight: 24, padding: 0 },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
    color: media.text,
  },
  sheetEmpty: { fontSize: 13, paddingVertical: spacing.md, color: media.textMuted },
  viewerAvatar: { width: 36, height: 36, borderRadius: 18 },
});
