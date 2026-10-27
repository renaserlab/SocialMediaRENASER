import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import type { CameraMode, CameraType, FlashMode } from 'expo-camera';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Circle } from 'react-native-svg';


import { Button } from '@/components/Button';
import { SuperficieSobreMedio } from '@/components/CapaDeContraste';
import { useEspacioInferior } from '@/components/espacioInferior';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { describeError } from '@/lib/describeError';
import { alturasDeCamara, ALTO_PISTA, ANILLO } from '@/lib/controlesDeCamara';
import { alSoltarElDisparadorDeVideo, MANTENER_MS } from '@/lib/disparadorDeVideo';
import { haptics } from '@/lib/haptics';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { palette, radius, spacing } from '@/theme/tokens';
import type { PickedMedia } from '@/services/storage';
import { MAX_HISTORIA_MS } from '@/lib/historias';
import { useTranslation } from '@/i18n/useTranslation';

/** La camara es una superficie oscura en ambos temas, como los Shorts. */
const media = palette('dark');

/*
  El tope sale de `lib/historias`, no de una copia local. Estaba escrito a mano
  aqui, en el carrete, en el modo historia y en el backend: cuatro numeros que
  habia que cambiar a la vez, y bastaba con olvidar uno para que la camara
  cortara a un tiempo y la subida rechazara a otro.
*/
const MAX_STORY_MS = MAX_HISTORIA_MS;

/**
 * Lo que tarda el cambio de modo en llegar a la camara nativa.
 *
 * `mode` es una prop de React: cambiarla no es inmediato. Ademas la vista se
 * recrea (ver `key` en CameraView), y arrancar la camara lleva su tiempo.
 * Pedirle grabar antes de que este lista falla, que es lo que hacia que el
 * video no funcionara nunca.
 */
const CAMBIO_DE_MODO_MS = 600;

/* --- Medidas del anillo de grabacion. `ANILLO` vive en `controlesDeCamara`,
       que es quien apila los controles y quien lo prueba. --- */
const GROSOR = 4;
/** El radio se mide al CENTRO del trazo, o el circulo se sale del lienzo. */
const RADIO = (ANILLO - GROSOR) / 2;
const PERIMETRO = 2 * Math.PI * RADIO;

/**
 * Pixeles que hay que deslizar para recorrer el zoom entero.
 *
 * Un valor corto hace el zoom nervioso e imposible de ajustar; uno muy largo
 * obliga a un recorrido que no cabe en la pantalla. 220 px permite llegar al
 * maximo sin levantar el dedo y deja controlar los pasos intermedios.
 */
const RECORRIDO_ZOOM_PX = 220;

/**
 * `Circle` animable.
 *
 * `strokeDashoffset` no es una propiedad de estilo, asi que Animated no la
 * toca a menos que el componente este envuelto asi.
 */
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  /** Se llama con lo capturado o elegido. */
  onCaptured: (media: PickedMedia) => void;
  /** Abre la cuadricula del carrete. */
  onOpenGallery: () => void;
  onClose: () => void;
  /** Miniatura de la ultima foto del carrete, para el acceso a la galeria. */
  lastPhotoUri?: string | null;
  /**
   * Tope de grabacion. Por omision el de una historia (15 s, que es lo que
   * admite el CHECK de la migracion 0003); un reel puede pedir mas.
   */
  duracionMaximaMs?: number;
  /**
   * La camara solo graba (Reel): no hay foto que hacer.
   *
   * Un toque empieza y otro termina; mantener tambien graba. La regla esta en
   * `lib/disparadorDeVideo`, que cuenta por que.
   */
  soloVideo?: boolean;
  /**
   * Barra propia, abajo del todo, por debajo de los controles.
   *
   * La usa la pantalla de Crear para poner ahi los tipos de publicacion
   * (Publicacion · Historia · Reel · Vivo) sin duplicar la camara entera: la
   * camara es la misma, lo unico que cambia es que se hace con lo capturado.
   */
  pie?: React.ReactNode;
};

/**
 * Camara de historias a pantalla completa.
 *
 * Un toque hace foto; mantener pulsado graba video, como en Instagram. El
 * limite de 15 s lo aplica la propia camara (`maxDuration`), no una
 * comprobacion posterior: asi no se graba de mas para descartarlo despues.
 */
export function StoryCaptureScreen({
  onCaptured,
  onOpenGallery,
  onClose,
  lastPhotoUri,
  duracionMaximaMs = MAX_STORY_MS,
  soloVideo = false,
  pie,
}: Props) {
  const { t } = useTranslation();
  // El tope efectivo. Se usa en TODOS los sitios que antes miraban la
  // constante, para que el anillo de progreso, el corte de seguridad y el
  // limite de la camara no puedan decir cosas distintas.
  const topeMs = duracionMaximaMs;

  /*
    LOS CONTROLES SE APOYAN EN LA BARRA DE ABAJO, NO EN UN NUMERO.

    El disparador estuvo clavado a 58 px del borde con una barra flotante
    encima que ocupa hasta 104: casi dos tercios del boton quedaban tapados, y
    el dedo que iba a hacer la foto pulsaba en realidad la barra.

    La camara solo se abre desde Crear, donde la barra de secciones se retira y
    en su sitio va la de los tipos de publicacion (`pie`). Lo que hay que dejar
    libre por debajo lo dice `useEspacioInferior`, que es quien lo sabe, para
    que cambiar una barra no obligue a acordarse de corregir numeros aqui.
  */
  const espacioInferior = useEspacioInferior();
  /*
    De abajo arriba: barra de tipos de publicacion, pista, disparador y nivel
    de zoom, sin solaparse y ninguno por debajo del margen. El calculo y su
    prueba estan en `lib/controlesDeCamara`.
  */
  const alturas = alturasDeCamara(espacioInferior);

  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  // El microfono solo hace falta para el video, asi que se pide al grabar y no
  // al abrir: pedir todo de golpe al entrar hace que se rechace mas.
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * Modo de la camara. Se lleva aparte de `recording` a proposito.
   *
   * `recordAsync` SOLO funciona si la vista nativa ya esta en modo video, y el
   * modo se cambia con una prop de React: hay que cambiarlo y esperar a que
   * llegue abajo. Derivarlo de `recording` fallaba siempre, porque se pedia
   * grabar en el mismo instante en que se pedia el cambio, cuando la camara
   * seguia en modo foto.
   */
  const [mode, setMode] = useState<CameraMode>(soloVideo ? 'video' : 'picture');
  /** El modo en reposo: al que se vuelve al terminar de grabar. */
  const modoEnReposo: CameraMode = soloVideo ? 'video' : 'picture';

  /**
   * Distingue el toque de la pulsacion larga.
   *
   * `onLongPress` de Pressable no sirve aqui: necesitamos empezar a grabar al
   * mantener Y parar al soltar, y eso son dos eventos distintos.
   */
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** El dedo sigue sobre el disparador. */
  const pressing = useRef(false);
  /** La pulsacion ya se considero larga: al soltar NO se hace foto. */
  const holdFired = useRef(false);
  /** La grabacion llego a empezar: al soltar hay que cortarla. */
  const didRecord = useRef(false);
  /** Solo video: cuando se apoyo el dedo, y si entonces ya se estaba grabando. */
  const apoyadoEn = useRef(0);
  const yaGrababa = useRef(false);

  /**
   * Zoom de 0 a 1, como lo espera la camara.
   *
   * Se guarda ademas en una `ref` porque el PanResponder se crea UNA vez y sus
   * funciones capturarian el primer valor del estado para siempre.
   */
  const [zoom, setZoom] = useState(0);
  const zoomRef = useRef(0);
  /** Zoom al empezar el gesto; el deslizamiento suma sobre el. */
  const zoomInicial = useRef(0);

  // Anillo de progreso mientras se graba.
  const progress = useRef(new Animated.Value(0)).current;

  /*
    AQUI NO SE PIDE EL PERMISO DE CAMARA. Lo pide quien abre esta pantalla
    (`PasoDeCaptura`), que es el unico que sabe en que momento del flujo esta la
    persona.

    Lo que habia era un efecto que llamaba a `requestPermission()` solo, nada
    mas montarse, y ademas dependia del propio permiso: cada rechazo lo volvia a
    lanzar. En Android eso quema los dos intentos que da el sistema en un par de
    segundos y deja el permiso bloqueado PARA SIEMPRE —a partir de ahi la camara
    no aparece nunca mas y no hay forma de arreglarlo desde la aplicacion—. Y
    como el que abre esta pantalla estaba consultando el permiso a la vez, el
    dialogo saltaba justo cuando esta vista se desmontaba: la respuesta se
    perdia.

    El estado se sigue LEYENDO (`useCameraPermissions`) porque el permiso puede
    revocarse desde los ajustes con la aplicacion abierta, y entonces hay que
    dejar de ensenar un visor negro y decir lo que pasa. Pero preguntar, solo a
    peticion de la persona: el boton de abajo.
  */

  /*
    Al irse de la camara no puede quedar nada corriendo.

    Dos cosas se escapaban: el temporizador de la pulsacion larga, que podia
    pedir grabar a una camara ya desmontada, y una grabacion en curso cuando se
    cambia de seccion a media captura. Cerrar la sesion de captura a mano es lo
    que apaga el piloto de la camara del telefono; dejarlo a la destruccion de
    la vista nativa lo dejaba encendido unos segundos.
  */
  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      pressing.current = false;
      if (didRecord.current) cameraRef.current?.stopRecording();
    },
    [],
  );

  const stopProgress = useCallback(() => {
    progress.stopAnimation();
    progress.setValue(0);
  }, [progress]);

  const takePhoto = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      haptics.medium();
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (photo?.uri) {
        onCaptured({ uri: photo.uri, kind: 'image', mimeType: 'image/jpeg', name: null });
      }
    } catch (error) {
      notify(t('camera.photoFailed'), describeError(error, t('common.tryAgain')));
    } finally {
      setBusy(false);
    }
  }, [busy, onCaptured]);

  const startRecording = useCallback(async () => {
    // `didRecord`: en solo video un segundo toque llega con la grabacion en
    // marcha; pedir otra encima la corta con error.
    if (!cameraRef.current || busy || didRecord.current) return;
    // El video lleva sonido: sin permiso de microfono se graba mudo y nadie
    // entiende por que. Se pide justo aqui, cuando ya tiene sentido.
    if (!micPermission?.granted) {
      const asked = await requestMicPermission();
      if (!asked.granted) {
        notify(
          t('camera.micMissing'),
          t('camera.micMissingBody'),
        );
        return;
      }
    }
    // La camara pasa a modo video ANTES de grabar, y se espera a que el cambio
    // llegue a la vista nativa: `recordAsync` sobre una camara en modo foto
    // falla siempre. Sin esta espera, grabar no funcionaba nunca.
    //
    // Una camara que solo graba ya esta en modo video desde que se monta: no
    // hay cambio que esperar, y soltar el dedo no cancela nada (alli un toque
    // corto ES la peticion de grabar).
    if (!soloVideo) {
      setMode('video');
      await new Promise((resolve) => setTimeout(resolve, CAMBIO_DE_MODO_MS));

      // Se solto mientras cambiaba el modo: fue una pulsacion corta de mas, no
      // una peticion de grabar.
      if (!pressing.current) {
        setMode('picture');
        return;
      }
    }

    didRecord.current = true;
    setRecording(true);
    haptics.medium();
    Animated.timing(progress, {
      toValue: 1,
      duration: topeMs,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();

    /*
      Corte propio a los 15 s.

      `maxDuration` deberia bastar, pero no siempre se respeta y grabando de
      mas se acababa subiendo un video que el backend rechaza (la migracion
      0003 tiene un CHECK). Este temporizador garantiza el limite pase lo que
      pase; si la camara corta antes, se cancela en el `finally`.
    */
    const inicio = Date.now();
    const corte = setTimeout(() => {
      cameraRef.current?.stopRecording();
    }, topeMs);

    try {
      const video = await cameraRef.current.recordAsync({
        maxDuration: topeMs / 1000,
      });
      if (video?.uri) {
        /*
          La duracion se mide aqui y se pasa adelante.

          Sin ella el visor recibia 0 y mostraba el video UN SEGUNDO: pasaba
          volando y parecia que la reproduccion iba acelerada. `recordAsync` no
          devuelve la duracion, asi que se cronometra.
        */
        const duracion = Math.min(Date.now() - inicio, topeMs);
        onCaptured({
          uri: video.uri,
          kind: 'video',
          mimeType: 'video/mp4',
          name: null,
          durationMs: Math.max(1000, duracion),
        });
      }
    } catch (error) {
      notify(t('camera.recordFailed'), describeError(error, t('common.tryAgain')));
    } finally {
      clearTimeout(corte);
      didRecord.current = false;
      setRecording(false);
      // El zoom no se hereda de una grabacion a la siguiente.
      zoomRef.current = 0;
      setZoom(0);
      // Se vuelve al modo en reposo: foto en la camara de historias, que es lo
      // que se usa la mayor parte del tiempo; video en la que solo graba.
      setMode(modoEnReposo);
      stopProgress();
    }
  }, [busy, micPermission, requestMicPermission, onCaptured, progress, stopProgress, soloVideo, modoEnReposo, topeMs]);

  const onPressIn = () => {
    pressing.current = true;
    if (soloVideo) {
      // Sin temporizador: aqui no hay foto de la que distinguirse. Se graba
      // desde el primer contacto, y al soltar se decide si fue un toque (sigue)
      // o una pulsacion mantenida (termina).
      apoyadoEn.current = Date.now();
      yaGrababa.current = didRecord.current;
      if (!didRecord.current) void startRecording();
      return;
    }
    holdFired.current = false;
    holdTimer.current = setTimeout(() => {
      holdFired.current = true;
      void startRecording();
    }, MANTENER_MS);
  };

  const onPressOut = () => {
    pressing.current = false;
    if (soloVideo) {
      const queHacer = alSoltarElDisparadorDeVideo({
        grabando: didRecord.current,
        yaGrababa: yaGrababa.current,
        duroMs: Date.now() - apoyadoEn.current,
      });
      if (queHacer === 'parar') cameraRef.current?.stopRecording();
      return;
    }
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (didRecord.current) {
      // Se solto: se corta la grabacion y `recordAsync` resuelve con el video.
      cameraRef.current?.stopRecording();
      return;
    }
    /*
      Si la pulsacion ya se considero larga no se hace foto, aunque todavia no
      hubiera empezado a grabar: en ese hueco la camara esta cambiando a modo
      video, y pedirle una foto ahi falla. `startRecording` ve que se solto y
      cancela solo.
    */
    if (holdFired.current) return;
    void takePhoto();
  };

  /**
   * Disparador con zoom por deslizamiento, como en Instagram.
   *
   * Se usa `PanResponder` y no `Pressable` porque hace falta seguir el dedo
   * MIENTRAS sigue apoyado: `Pressable` avisa de que se pulsa y de que se
   * suelta, pero no de por donde se mueve entre medias.
   *
   * Subir el dedo acerca; bajarlo aleja. La grabacion no se corta al salirse
   * del boton —eso es justo lo que hay que hacer para acercar— y solo termina
   * al levantar el dedo o al llegar al limite de tiempo.
   */
  /*
    El PanResponder se crea UNA vez, asi que capturaria las funciones del primer
    render para siempre: se quedaria con un `micPermission` viejo y volveria a
    pedir el permiso ya concedido. Esta ref se actualiza en cada render y el
    gesto llama siempre a la version buena.
  */
  const acciones = useRef({ onPressIn, onPressOut });
  acciones.current = { onPressIn, onPressOut };

  const disparador = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      // Reclama el gesto tambien al moverse, o el dedo saliendo del boton
      // cancelaria la pulsacion y cortaria la grabacion.
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        zoomInicial.current = zoomRef.current;
        acciones.current.onPressIn();
      },
      onPanResponderMove: (_event, gesto) => {
        // Solo mientras se graba: en una foto el deslizamiento no significa nada.
        if (!didRecord.current) return;
        // `dy` es negativo hacia arriba; se invierte para que subir = acercar.
        const delta = -gesto.dy / RECORRIDO_ZOOM_PX;
        const nuevo = Math.min(1, Math.max(0, zoomInicial.current + delta));
        zoomRef.current = nuevo;
        setZoom(nuevo);
      },
      onPanResponderRelease: () => acciones.current.onPressOut(),
      // Si el sistema se lleva el gesto (una llamada, un aviso), se trata como
      // soltar: mejor cerrar la grabacion que dejarla colgada.
      onPanResponderTerminate: () => acciones.current.onPressOut(),
    }),
  ).current;

  // Sin permiso no se puede ni mostrar la vista previa: se explica y se ofrece
  // la galeria, que no necesita camara.
  if (permission && !permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Feather name="camera-off" size={34} color={media.textMuted} />
        <Text variant="body" weight="700" color={media.text} style={styles.deniedTitle}>
          {t('camera.noAccess')}
        </Text>
        <Text variant="secondary" color={media.textMuted} style={styles.deniedBody}>
          {permission.canAskAgain
            ? t('camera.grantPermission')
            : t('camera.enableInSettings')}
        </Text>
        {permission.canAskAgain ? (
          <Button
            label={t('media.givePermission')}
            variant="secondary"
            onPress={() => void requestPermission()}
            style={styles.deniedCta}
          />
        ) : null}
        <Pressable onPress={onOpenGallery} hitSlop={10} style={styles.deniedLink}>
          <Text variant="secondary" weight="700" color={media.text}>
            {t('profile.pickFromGallery')}
          </Text>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={10} style={styles.deniedLink}>
          <Text variant="secondary" color={media.textMuted}>
            {t('common.cancel')}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        /*
          `key` fuerza a recrear la vista nativa al cambiar de modo.

          Cambiar `mode` sobre una camara ya montada no siempre surte efecto en
          iOS: la prop cambia en React pero la sesion de captura sigue
          configurada para fotos, y `recordAsync` falla. Recrearla garantiza que
          arranca en el modo correcto. Cuesta un parpadeo, que es preferible a
          que grabar no funcione.
        */
        key={mode}
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        mode={mode}
        zoom={zoom}
      />

      {/* Barra superior: cerrar y flash. */}
      <View style={styles.topBar} pointerEvents="box-none">
        <Pressable onPress={onClose} hitSlop={12} style={styles.roundButton} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <Feather name="x" size={24} color={media.text} />
        </Pressable>
        <Pressable
          onPress={() => setFlash((f) => (f === 'off' ? 'on' : 'off'))}
          hitSlop={12}
          style={styles.roundButton}
          accessibilityRole="button"
          accessibilityLabel={flash === 'off' ? 'Activar flash' : 'Desactivar flash'}
        >
          {/* El estado no se distingue solo por color: cambia el icono. */}
          <Feather name={flash === 'off' ? 'zap-off' : 'zap'} size={22} color={media.text} />
        </Pressable>
      </View>

      {recording ? (
        <View style={styles.recordingPill}>
          <View style={styles.recordingDot} />
          <Text variant="secondary" weight="700" color={media.text}>
            {t('camera.recording')}
          </Text>
        </View>
      ) : null}

      {/*
        Nivel de zoom. Solo aparece cuando se esta usando: un indicador fijo en
        1.0x seria ruido permanente. Sin el no hay forma de saber cuanto se ha
        acercado ni si el gesto esta haciendo algo.
      */}
      {recording && zoom > 0.01 ? (
        // Por encima del disparador, que es lo que se esta deslizando.
        <View style={[styles.zoomPill, { bottom: alturas.zoom }]}>
          <Feather name="search" size={13} color={media.text} />
          <Text variant="secondary" weight="700" color={media.text}>
            {(1 + zoom * 4).toFixed(1)}x
          </Text>
        </View>
      ) : null}

      {pie ? (
        <View style={[styles.pie, { bottom: alturas.selector }]} pointerEvents="box-none">
          {pie}
        </View>
      ) : null}

      {/* Barra inferior: galeria, disparador y girar camara. */}
      <View style={[styles.bottomBar, { bottom: alturas.controles }]} pointerEvents="box-none">
        <Pressable
          onPress={onOpenGallery}
          style={styles.thumb}
          accessibilityRole="button"
          accessibilityLabel={t('profile.pickFromGallery')}
        >
          {lastPhotoUri ? (
            <ExpoImage source={{ uri: lastPhotoUri }} style={styles.thumbImage} contentFit="cover" />
          ) : (
            <Feather name="image" size={20} color={media.text} />
          )}
        </Pressable>

        {/*
          El disparador NO cambia de seccion ni de modo.

          Dentro de las pestanas hay dos arrastres horizontales por encima —el
          carrusel de secciones y el selector de tipo de publicacion de Crear— y
          cuando uno de ellos se activa CANCELA el gesto nativo de lo que haya
          debajo. Aqui debajo hay un `PanResponder`, asi que mantener pulsado
          con el dedo minimamente inclinado abortaba la foto o cortaba la
          grabacion, y deslizar para acercar se iba a cambiar de modo.

          `activarAlTocar` porque esto no es un ScrollView: hay que reservar el
          gesto desde el primer contacto, que no hay ningun desplazamiento
          nativo al que asomarse. Es el mismo blindaje que ya usa la barra de
          avance del video, que tambien es un `PanResponder`.
        */}
        <SinCambioDeSeccion activarAlTocar>
        <View
          {...disparador.panHandlers}
          accessibilityRole="button"
          accessibilityLabel={t(soloVideo ? 'camera.shutterVideoA11y' : 'camera.shutterA11y')}
          style={styles.shutterHit}
        >
          <View style={styles.shutterRing}>
            {/*
              Anillo de progreso.

              Antes se animaba un valor que no estaba enlazado a ningun estilo,
              asi que la grabacion avanzaba pero no se veia nada. Se dibuja con
              un circulo SVG y `strokeDashoffset`: el trazo se va descubriendo
              conforme baja, que es como se hace un arco de progreso.
            */}
            <Svg width={ANILLO} height={ANILLO} style={StyleSheet.absoluteFill}>
              {/* Pista de fondo, siempre visible. */}
              <Circle
                cx={ANILLO / 2}
                cy={ANILLO / 2}
                r={RADIO}
                stroke={media.textMuted}
                strokeWidth={GROSOR}
                fill="none"
              />
              {recording ? (
                <AnimatedCircle
                  cx={ANILLO / 2}
                  cy={ANILLO / 2}
                  r={RADIO}
                  stroke={media.text}
                  strokeWidth={GROSOR}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={PERIMETRO}
                  strokeDashoffset={progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [PERIMETRO, 0],
                  })}
                  // Empieza arriba en vez de a la derecha, que es donde
                  // arranca un circulo SVG por defecto.
                  rotation={-90}
                  originX={ANILLO / 2}
                  originY={ANILLO / 2}
                />
              ) : null}
            </Svg>

            {busy ? (
              <ActivityIndicator color={media.text} />
            ) : (
              <View
                style={[
                  styles.shutterCore,
                  { backgroundColor: media.text },
                  // Cuadrado al grabar: el icono universal de "parar".
                  recording ? { borderRadius: radius.sm, width: 28, height: 28 } : null,
                ]}
              />
            )}
          </View>
        </View>
        </SinCambioDeSeccion>

        <Pressable
          /*
            Frontal ↔ trasera. No se puede voltear MIENTRAS se graba: cambiar de
            camara reinicia la sesion de captura y `recordAsync` termina con
            error, asi que el video se perderia entero. Se apaga y se dice por
            que en la etiqueta, en vez de dejar un boton que estropea la toma.
          */
          onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
          disabled={recording}
          hitSlop={12}
          style={[styles.roundButton, recording ? styles.apagado : null]}
          accessibilityRole="button"
          accessibilityState={{ disabled: recording }}
          accessibilityLabel={
            recording
              ? t('camera.cannotFlipWhileRecording')
              : facing === 'back'
                ? t('camera.flipToFront')
                : t('camera.flipToBack')
          }
        >
          <Feather name="refresh-cw" size={22} color={media.text} />
        </Pressable>
      </View>

      {/*
        LA PISTA VA SOBRE UNA SUPERFICIE, NO SOBRE LA IMAGEN. Era una linea gris
        escrita directamente encima de la camara: sobre una mesa clara o una
        pared no se distinguia, y como no cabia a lo ancho se salia por los dos
        lados. Ahora lleva fondo propio, letra clara, margenes y dos lineas.

        No se queda los toques: esta entre el disparador y la barra.
      */}
      <View style={[styles.hint, { bottom: alturas.pista }]} pointerEvents="none">
        <SuperficieSobreMedio forma="pildora" style={styles.hintPill}>
          <Text
            variant="secondary"
            weight="600"
            color={media.text}
            numberOfLines={2}
            style={styles.hintText}
          >
            {t(soloVideo ? 'camera.hintVideo' : 'camera.hint')}
          </Text>
        </SuperficieSobreMedio>
      </View>
    </View>
  );
}

/** Ultima foto del carrete, para la miniatura. Null si no hay permiso. */
export async function lastGalleryPhoto(): Promise<string | null> {
  try {
    const permission = await MediaLibrary.getPermissionsAsync();
    if (!permission.granted) return null;
    const page = await MediaLibrary.getAssetsAsync({ first: 1, sortBy: ['creationTime'] });
    return page.assets[0]?.uri ?? null;
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  deniedTitle: { marginTop: spacing.lg },
  deniedBody: { textAlign: 'center', marginTop: spacing.sm, lineHeight: 20 },
  deniedCta: { marginTop: spacing.xl, minWidth: 200 },
  deniedLink: { marginTop: spacing.lg, minHeight: 44, justifyContent: 'center' },
  topBar: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: media.overlay,
  },
  /** Un control apagado se ve apagado; no basta con que no responda. */
  apagado: { opacity: 0.35 },
  recordingPill: {
    position: 'absolute',
    top: 108,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: media.overlay,
  },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: media.danger },
  zoomPill: {
    // `bottom` lo pone la vista: depende de la zona segura del aparato.
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: media.overlay,
  },
  // Abajo del todo, donde iba la barra de secciones. Los margenes a los lados
  // los pone la propia barra.
  pie: { position: 'absolute', left: 0, right: 0 },
  bottomBar: {
    position: 'absolute',
    left: spacing.xl,
    right: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: media.overlay,
    borderWidth: 1,
    borderColor: media.textMuted,
  },
  thumbImage: { width: '100%', height: '100%' },
  shutterHit: { alignItems: 'center', justifyContent: 'center' },
  shutterRing: {
    // El circulo lo pinta el SVG de dentro; este View solo centra el nucleo.
    width: ANILLO,
    height: ANILLO,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterCore: { width: 58, height: 58, borderRadius: 29 },
  // La franja mide siempre lo mismo y la pista se centra dentro: en una
  // pantalla ancha, donde la frase cabe en una linea, no queda descolgada.
  hint: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    height: ALTO_PISTA,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hintPill: { maxWidth: '100%', paddingVertical: 6 },
  // `flexShrink` es lo que deja partir la frase: la pildora es una fila.
  hintText: { textAlign: 'center', flexShrink: 1 },
});
