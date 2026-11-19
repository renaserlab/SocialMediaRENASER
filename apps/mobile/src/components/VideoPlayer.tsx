import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useEventListener } from 'expo';
import { Image as ExpoImage } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';

import { VideoScrubber } from '@/components/VideoScrubber';
import { perfMark } from '@/lib/perf';
import { medicionDeVideo } from '@/lib/medicionDeVideoEnApp';
import { palette } from '@/theme/tokens';
import type { VideoPlayerProps } from './VideoPlayer.types';
import { useTranslation } from '@/i18n/useTranslation';

// Las superficies de video son siempre oscuras → usamos la paleta dark como
// contexto de "media" para que los overlays sean legibles en ambos temas.
const media = palette('dark');

/**
 * Oscurecido minimo sobre el video en reposo: lo justo para que el boton de
 * reproduccion se distinga sobre un fotograma claro, sin llegar a ocultar de que
 * va el video.
 */
const SOFT_VEIL = 'rgba(0,0,0,0.18)';

/**
 * Cada cuantos segundos avisa el reproductor de por donde va.
 *
 * Cuatro veces por segundo basta para que la barra se vea avanzar sin saltos y
 * no obliga a repintar en cada fotograma.
 */
const PROGRESS_INTERVAL_SECONDS = 0.25;

/**
 * Cuanta memoria puede reservar el reproductor para adelantar la descarga.
 *
 * Sin limite, decide por su cuenta y con un video largo se adelanta cuanto
 * puede. Este tope acompana a la regla de fondo —que solo exista reproductor
 * mientras el video se ve— y le pone suelo: aunque coincidan dos en pantalla,
 * entre ambos no llegan a comprometer la memoria de la aplicacion.
 *
 * Doce megas son unos siete segundos por delante incluso en los videos mas
 * pesados que hay subidos, de sobra para que no se entrecorte en un muro donde
 * se cambia de video constantemente.
 *
 * Bajo de dieciseis a doce porque en el muro ahora puede haber hasta cuatro
 * reproductores vivos (los visibles reproduciendo, mas el siguiente
 * preparandose) en vez de dos. Menos por reproductor, mismo techo de memoria.
 */
const MAX_BUFFER_BYTES = 12 * 1024 * 1024;
const BUFFER_SECONDS = 15;

/**
 * Ejecuta una accion sobre el reproductor tolerando que ya no exista.
 *
 * `useVideoPlayer` libera el reproductor NATIVO al desmontar el componente,
 * pero las limpiezas de los efectos de React corren despues. Al salir de una
 * pantalla con video, `player.pause()` se ejecutaba sobre un objeto ya
 * liberado y lanzaba NativeSharedObjectNotFoundException, que tumbaba la app
 * con una pantalla roja.
 *
 * expo-video no expone forma de saber si el reproductor sigue vivo, asi que se
 * captura el fallo. Es seguro porque estas llamadas son de control de
 * reproduccion: si el reproductor ya no esta, no hay nada que pausar.
 */
function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Reproductor ya liberado; no queda nada que hacer.
  }
}

/** Lee un numero del reproductor devolviendo 0 si ya no esta disponible. */
function readNumber(read: () => number): number {
  try {
    const value = read();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Barra de avance, con su propio estado.
 *
 * Vive aparte a proposito: el reproductor avisa de por donde va cuatro veces
 * por segundo, y mientras ese dato se guardaba en el componente grande, CADA
 * aviso repintaba el video entero, la portada y la zona pulsable. Con dos o
 * tres videos a la vez en el muro eso eran una docena de repintados por
 * segundo tirando del mismo hilo que anima el desplazamiento. Aqui dentro,
 * cada aviso repinta solo esta barra.
 */
function VideoProgress({
  player,
  onSeek,
  bottom,
}: {
  player: ReturnType<typeof useVideoPlayer>;
  onSeek: (seconds: number) => void;
  bottom: number;
}) {
  const [progress, setProgress] = useState({ currentTime: 0, duration: 0 });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    setProgress({ currentTime, duration: readNumber(() => player.duration) });
  });

  const seek = useCallback(
    (seconds: number) => {
      onSeek(seconds);
      // Se adelanta el pintado: el reproductor tarda en confirmar la nueva
      // posicion y, mientras, la barra volveria un instante a donde estaba.
      setProgress((prev) => ({ ...prev, currentTime: seconds }));
    },
    [onSeek],
  );

  return (
    <VideoScrubber
      currentTime={progress.currentTime}
      duration={progress.duration}
      onSeek={seek}
      bottom={bottom}
    />
  );
}

export function VideoPlayer({
  uri,
  poster,
  posterCacheKey,
  onError,
  cacheToDisk = false,
  style,
  loop = false,
  autoPlay = false,
  muted = false,
  contentFit = 'cover',
  nativeControls = true,
  active,
  visible,
  shortsControls = false,
  controlsBottomInset = 0,
  hidePlayButton = false,
  startAtSeconds = 0,
  onProgressSeconds,
  onEnded,
  onFirstFrame,
  medirComo,
}: VideoPlayerProps) {
  const { t } = useTranslation();
  /*
    `useCaching` guarda el video en la cache de disco de expo-video: volver a
    un short ya visto no toca la red. Se activa por prop porque la cache no
    soporta HLS en iOS; quien reproduce streams lo deja apagado.
  */
  const source: VideoSource = cacheToDisk ? { uri, useCaching: true } : uri;
  const player = useVideoPlayer(source, (p) => {
    p.loop = loop;
    p.muted = muted;
    p.bufferOptions = {
      maxBufferBytes: MAX_BUFFER_BYTES,
      preferredForwardBufferDuration: BUFFER_SECONDS,
    };
    if (shortsControls || onProgressSeconds) {
      // Sin esto el reproductor no informa de su avance: la barra se quedaria
      // clavada en el minuto cero y el progreso del curso no se guardaria.
      p.timeUpdateEventInterval = PROGRESS_INTERVAL_SECONDS;
    }
    /*
      Arranca aqui, en la propia creacion del reproductor, y no en un efecto
      posterior.

      Antes, un video del muro nacia parado y solo se le decia `play()` cuando
      React terminaba de montar y corria el efecto de `active`: dos pasadas de
      render de retraso antes siquiera de empezar a pedir bytes. Pidiendolo en
      la fabrica, la descarga empieza en el mismo instante en que el
      reproductor existe.
    */
    if (autoPlay || active) {
      p.play();
    }
  });

  // Nace ya iniciado si le toca reproducir: sin esto se pintaba un instante la
  // portada con su boton encima antes de que el efecto lo quitara.
  const [started, setStarted] = useState(autoPlay || active === true);
  const [playing, setPlaying] = useState(autoPlay || active === true);
  /*
    La persona ha pausado a proposito.

    Solo sirve para decidir si se ensena el circulo de reproduccion cuando se
    pidio esconderlo (`hidePlayButton`): en un muro que reproduce solo, el
    circulo sobra... salvo justo despues de que alguien toque para pausar, que
    es cuando hace falta ver que esta parado y como seguir.
  */
  const [userPaused, setUserPaused] = useState(false);
  /*
    El reproductor ya pinto su primer fotograma. Hasta ese momento, si hay
    poster, se mantiene por encima: sin esto, en los shorts el poster
    desaparecia al arrancar y quedaba un rectangulo negro mientras el video
    descargaba lo suficiente para empezar.
  */
  const [firstFrame, setFirstFrame] = useState(false);

  /*
    APAGAR ANTES DE QUE SE LO LLEVEN. La unica pausa que llega a tiempo.

    EL FALLO. Un video de Inicio seguia SONANDO al cambiar de seccion. No era
    que nadie diera la orden de parar: era que la orden llegaba tarde siempre.

    Como se para hoy un video del feed: la pantalla deja de estar activa, el
    elemento deja de pintar `<VideoPlayer />` y React lo DESMONTA. Es decir, la
    forma de callar el sonido era destruir el reproductor. Y destruir no es
    parar:

      1. `useVideoPlayer` suelta el reproductor nativo en la limpieza de un
         `useEffect` suyo, declarado ANTES que cualquiera de los de aqui. Las
         limpiezas pasivas corren en orden de declaracion, asi que al desmontar
         se libera PRIMERO y solo despues corren las nuestras: el
         `player.pause()` de `useFocusEffect` cae sobre un objeto ya liberado y
         se lo traga `safely()`. Es la misma razon por la que existe `safely()`
         —ver su comentario—: lo que alli se documento como «no reventar» era,
         ademas, «no parar».
      2. Con lo cual el silencio dependia entero de `release()`. Y en Android
         `release()` no para nada de inmediato: expo-video hace
         `GlobalScope.launch(Dispatchers.Main) { player.release() }`, o sea que
         la parada de ExoPlayer queda encolada para un ciclo posterior del hilo
         principal —justo el que esta ocupado montando la seccion nueva—. Ese
         hueco es el audio que se oye encima de Explorar o de Perfil.

    LA CORRECCION, en la capa que corresponde: decir «para» mientras el
    reproductor todavia existe. `useLayoutEffect` y no `useEffect` es TODA la
    diferencia: React ejecuta las limpiezas de layout en la fase de mutacion,
    sincronamente, ANTES de las pasivas —y por tanto antes del `release()` de
    expo-video—. Aqui el reproductor esta vivo y `pause()` de verdad pausa.

    Va atado al CICLO DE VIDA DE ESTE REPRODUCTOR, no a un silencio global: se
    dispara solo cuando este componente concreto desaparece o cuando cambia su
    fuente. Los reels, los cursos y las historias no se enteran de nada, porque
    sus reproductores no se estan desmontando.

    Se silencia ademas de pausar por lo mismo que dice el punto 2: entre esta
    llamada y la liberacion nativa hay un hueco de milisegundos en el que un
    buffer ya entregado puede seguir saliendo por el altavoz. Pausar es la
    orden; silenciar es la garantia de que ese hueco no se oye.
  */
  useLayoutEffect(() => {
    return () => {
      safely(() => {
        player.pause();
        player.muted = true;
      });
    };
  }, [player]);

  // El silencio puede cambiarlo la persona en cualquier momento (boton de
  // sonido); el ajuste inicial del reproductor solo vale para el primer render.
  useEffect(() => {
    safely(() => {
      player.muted = muted;
    });
  }, [muted, player]);

  /*
    MEDICION DE VIDEO (Inicio en telefonos). Que reproductor se mide va en una
    referencia: los oyentes leen el valor actual sin volver a suscribirse, y
    nada de esto toca el estado de React.

    Se elige `playingChange` como «ya reproduce» porque es el unico aviso que
    significa lo mismo en las dos plataformas: en iOS sale de
    `timeControlStatus == .playing` (no de haber pedido `play()`), y en Android
    de `onIsPlayingChanged` de ExoPlayer, que solo es cierto con datos y
    avanzando. `readyToPlay` llega antes de que haya imagen y el primer
    fotograma puede pintarse en pausa (el vecino precargado), asi que ninguno
    de los dos sirve para eso. Las esperas son `statusChange → loading`
    despues de haber arrancado.
  */
  const medida = useRef(medirComo);
  medida.current = medirComo;
  // Layout y no efecto: corre en el mismo commit, antes de que pueda llegar
  // ningun aviso nativo de este reproductor (los avisos son asincronos).
  useLayoutEffect(() => {
    const m = medida.current;
    if (active && m) medicionDeVideo.videoActivo(m.id, m);
  }, [active, medirComo?.id]);

  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    setPlaying(isPlaying);
    if (isPlaying && medida.current) medicionDeVideo.reproduciendo(medida.current.id);
  });
  useEventListener(player, 'statusChange', ({ status }) => {
    if (medida.current) medicionDeVideo.estado(medida.current.id, status);
  });

  /*
    Progreso hacia fuera y final del video.

    Se avisa del avance en crudo; decidir cada cuanto guardarlo es de quien
    escucha (ver `useProgresoDeLeccion`). Aqui mandar una peticion por aviso
    seria cuatro por segundo.

    Las referencias evitan volver a suscribir el listener en cada render: sin
    ellas, una funcion nueva por render reiniciaria la suscripcion
    constantemente.
  */
  const avisoDeProgreso = useRef(onProgressSeconds);
  avisoDeProgreso.current = onProgressSeconds;
  const avisoDeFinal = useRef(onEnded);
  avisoDeFinal.current = onEnded;

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    avisoDeProgreso.current?.(currentTime);
  });

  useEventListener(player, 'playToEnd', () => {
    avisoDeFinal.current?.();
  });

  /*
    Fallos del reproductor hacia fuera, con la misma referencia que arriba
    para no resuscribir en cada render. Un video de S3 con la URL caducada
    termina aqui, y el feed pide otra (ver `onError` en los tipos).
  */
  const avisoDeError = useRef(onError);
  avisoDeError.current = onError;
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'error') avisoDeError.current?.();
  });

  /*
    Retomar por donde iba. UNA sola vez: si se reaplicara con cada cambio de
    `startAtSeconds`, rebobinar devolveria al punto guardado al instante.
  */
  const yaSeSalto = useRef(false);
  useEffect(() => {
    if (yaSeSalto.current || startAtSeconds <= 0) return;
    yaSeSalto.current = true;
    safely(() => {
      player.currentTime = startAtSeconds;
    });
  }, [player, startAtSeconds]);

  /*
    Muro: pausar al perder de vista, sin arrancar al aparecer.

    Un video que se queda atras seguia sonando y decodificando. Aqui solo se
    pausa: empezar solo al desplazarse seria intrusivo y gastaria datos, asi que
    quien decide reproducir sigue siendo la persona.
  */
  useEffect(() => {
    if (visible === undefined || visible) return;
    safely(() => player.pause());
  }, [visible, player]);

  // Reproducción por viewport: play/pausa según `active` (feeds tipo reels).
  useEffect(() => {
    if (active === undefined) return;
    if (active) {
      setStarted(true);
      // Volver a entrar en pantalla borra la pausa manual: si no, el circulo
      // de play se quedaria pegado sobre un video que ya esta reproduciendo.
      setUserPaused(false);
      safely(() => player.play());
    } else {
      safely(() => player.pause());
    }
  }, [active, player]);

  // Con el Stack, las pantallas anteriores siguen montadas: sin esto un video
  // seguiría decodificando en segundo plano (batería y hasta 4-7 players a la
  // vez). Pausamos al perder el foco y reanudamos solo si debía reproducir.
  useFocusEffect(
    useCallback(() => {
      if (autoPlay || active) {
        safely(() => player.play());
      }
      return () => {
        // Esta limpieza corre tambien al desmontar, cuando el reproductor
        // nativo ya puede estar liberado: de ahi la guarda.
        safely(() => player.pause());
      };
    }, [player, autoPlay, active]),
  );

  /*
    Salir de la aplicacion no cambia el foco de navegacion: la pantalla sigue
    siendo la activa. Sin esto, un video con sonido seguiria sonando con el
    movil en el bolsillo.
  */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') safely(() => player.pause());
    });
    return () => subscription.remove();
  }, [player]);

  const start = () => {
    setStarted(true);
    player.play();
  };

  /** Un toque en el video: pausa si sonaba, reanuda si estaba parado. */
  const toggle = useCallback(() => {
    safely(() => {
      if (player.playing) {
        player.pause();
        setUserPaused(true);
      } else {
        player.play();
        setUserPaused(false);
      }
    });
  }, [player]);

  const seek = useCallback(
    (seconds: number) => {
      safely(() => {
        player.currentTime = seconds;
      });
    },
    [player],
  );

  // Antes de arrancar manda la portada, que ya ofrece su propio boton de play.
  const showShortsControls = shortsControls && started;

  /*
    La cache de disco de expo-image se indexa por URL, y la URL firmada del
    poster cambia con cada firma. Con `cacheKey` (la ruta en Storage) la misma
    miniatura se reutiliza aunque la firma sea nueva.
  */
  const posterSource =
    poster && typeof poster === 'object' && !Array.isArray(poster) && posterCacheKey
      ? { ...(poster as { uri?: string }), cacheKey: posterCacheKey }
      : poster;

  return (
    <View style={[styles.wrap, style]}>
      <VideoView
        style={StyleSheet.absoluteFill}
        player={player}
        contentFit={contentFit}
        nativeControls={nativeControls && !shortsControls && started}
        onFirstFrameRender={() => {
          perfMark('VIDEO_FIRST_FRAME');
          if (medirComo) medicionDeVideo.primerFotograma(medirComo.id);
          setFirstFrame(true);
          onFirstFrame?.();
        }}
        // `allowsFullscreen` está deprecada en expo-video. Además, en un feed
        // vertical (reels) no tiene sentido ofrecer pantalla completa.
        fullscreenOptions={{ enable: nativeControls && !shortsControls }}
        allowsPictureInPicture={false}
      />
      {/*
        Poster sobre el video mientras el primer fotograma llega. No captura
        toques: los controles de debajo siguen funcionando. La transicion corta
        hace que el paso poster→video se sienta continuo y no como un salto.
      */}
      {started && !firstFrame ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {posterSource ? (
            <ExpoImage
              source={posterSource}
              style={StyleSheet.absoluteFill}
              contentFit={contentFit === 'fill' ? 'cover' : contentFit}
              cachePolicy="disk"
              recyclingKey={posterCacheKey}
              transition={80}
            />
          ) : (
            /*
              Sin miniatura guardada no hay nada que ensenar todavia, y un
              rectangulo negro y quieto se lee como algo roto. Un indicador
              dice lo que de verdad pasa: esta cargando. Desaparece en cuanto
              llega el primer fotograma.

              Los videos subidos antes del pipeline de miniaturas son los
              unicos que pasan por aqui; en cuanto se reprocesan, entran por
              la rama de arriba y el salto a negro desaparece del todo.
            */
            <View style={styles.centered}>
              <ActivityIndicator color={media.textMuted} />
            </View>
          )}
        </View>
      ) : null}
      {showShortsControls ? (
        <>
          {/*
            La zona de toque va DETRAS de los botones laterales, que son
            hermanos de este reproductor y se pintan despues: asi pulsar el
            corazon no pausa el video.
          */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={toggle}
            accessibilityRole="button"
            accessibilityLabel={playing ? t('video.pause') : t('video.play')}
          >
            {/*
              El circulo solo aparece si de verdad aporta algo: cuando el video
              esta parado Y (o bien esta pantalla usa play manual, o bien la
              persona acaba de pausarlo aqui mismo). En el muro, mientras el
              video se prepara para arrancar solo, no se pinta nada.
            */}
            {!playing && (!hidePlayButton || userPaused) ? (
              <View style={styles.centered} pointerEvents="none">
                <View style={[styles.playCircle, { backgroundColor: media.overlay, borderColor: media.text }]}>
                  <Feather name="play" size={30} color={media.text} />
                </View>
              </View>
            ) : null}
          </Pressable>
          <VideoProgress player={player} onSeek={seek} bottom={controlsBottomInset} />
        </>
      ) : null}
      {/*
        Reproductor montado pero todavia sin arrancar porque le toca esperar
        turno (es el SIGUIENTE video del muro, preparandose). Solo la portada:
        ni boton, ni velo, ni zona pulsable. Es exactamente lo que se veia mal
        en la captura del documento —el segundo video con un play enorme
        encima— y lo que hacia que pareciera roto.
      */}
      {!started && hidePlayButton ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {posterSource ? (
            <ExpoImage
              source={posterSource}
              style={StyleSheet.absoluteFill}
              contentFit={contentFit === 'fill' ? 'cover' : contentFit}
              cachePolicy="disk"
              recyclingKey={posterCacheKey}
              transition={120}
            />
          ) : null}
        </View>
      ) : null}
      {!started && !hidePlayButton && (
        <Pressable
          style={styles.posterLayer}
          onPress={start}
          accessibilityRole="button"
          accessibilityLabel={t('video.play')}
        >
          {posterSource ? (
            <ExpoImage
              source={posterSource}
              style={StyleSheet.absoluteFill}
              /*
                El MISMO encuadre que el video, no uno fijo.

                Estaba clavado en `cover` mientras las otras dos capas de
                portada obedecian la propiedad: en el muro, que pide `contain`,
                la portada salia recortada y al arrancar el video daba un salto
                —cambiaba de encuadre delante de quien mira—.
              */
              contentFit={contentFit === 'fill' ? 'cover' : contentFit}
              cachePolicy="disk"
              recyclingKey={posterCacheKey}
              transition={120}
            />
          ) : null}
          {/*
            Velo MUY tenue. Antes cubria el video con un negro al 72 %, asi que
            en el muro un video sin portada se veia como un rectangulo negro:
            el primer fotograma que ya pinta el reproductor quedaba tapado y
            parecia que no hubiera nada hasta pulsar play.

            El circulo de reproduccion lleva su propio fondo, de modo que se lee
            igual sobre una imagen clara sin necesidad de oscurecerla entera.
          */}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: SOFT_VEIL }]} />
          <View style={[styles.playCircle, { backgroundColor: media.overlay, borderColor: media.text }]}>
            <Feather name="play" size={30} color={media.text} />
          </View>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Gris muy oscuro en vez de negro puro: mientras el fotograma llega, un
  // rectangulo negro se lee como un hueco roto; este se lee como algo cargando
  // (mismo criterio que la variante web).
  wrap: { overflow: 'hidden', backgroundColor: media.surface },
  posterLayer: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  centered: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
