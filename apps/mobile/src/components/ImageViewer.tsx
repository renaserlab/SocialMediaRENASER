import React from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Image as ExpoImage } from 'expo-image';
import Feather from '@expo/vector-icons/Feather';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Text';
import { palette, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

/** El visor es siempre oscuro: lo que importa es la imagen. */
const media = palette('dark');

const AnimatedImage = Animated.createAnimatedComponent(ExpoImage);

/** Hasta donde se puede acercar. Suficiente para leer un texto pequeno. */
const ZOOM_MAXIMO = 5;
/** Al soltar por debajo de esto, se vuelve al tamano completo. */
const ZOOM_MINIMO = 1;
/** Arrastrar hacia abajo mas de esto cierra el visor. */
const CIERRE_POR_ARRASTRE_PX = 120;

type Props = {
  /** URL de la imagen. `null` mantiene el visor cerrado. */
  uri: string | null;
  /**
   * Con qué nombre está (o se guarda) en el disco. Para imágenes cuya URL
   * cambia aunque el archivo sea el mismo —las firmadas del chat—: con la
   * misma clave que usó la burbuja, abrirla a pantalla completa no la vuelve
   * a descargar.
   */
  claveDeCache?: string;
  onClose: () => void;
  /** Texto opcional bajo la imagen (el pie del testimonio, por ejemplo). */
  caption?: string | null;
  /**
   * Una barra propia arriba, EN LUGAR del botón de cerrar.
   *
   * OPCIONAL: sin ella el visor es exactamente el de siempre. La usa el chat,
   * que necesita decir de quién es la foto y ofrecer qué hacer con ella. Quien
   * la pasa se encarga de que incluya cómo cerrar.
   */
  cabecera?: React.ReactNode;
  /** Algo propio abajo del todo, EN LUGAR de la ayuda de la pinza. */
  pie?: React.ReactNode;
};

/**
 * Imagen a pantalla completa, como al tocar una foto en Facebook.
 *
 * Existe porque en las tarjetas las imagenes van recortadas (`contentFit:
 * cover` con alto fijo), y cuando lo que se comparte es la captura de un texto
 * —un testimonio, un mensaje— recortarla la vuelve ilegible.
 *
 * Aqui la imagen se ve ENTERA (`contain`) y ademas se puede acercar con dos
 * dedos, que es lo que hace falta para leer letra pequena.
 *
 * Se cierra con la X, tocando fuera o arrastrando hacia abajo.
 */
export function ImageViewer({ uri, claveDeCache, onClose, caption, cabecera, pie }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const escala = useSharedValue(1);
  const escalaBase = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const xBase = useSharedValue(0);
  const yBase = useSharedValue(0);

  const reiniciar = () => {
    escala.value = withTiming(1);
    escalaBase.value = 1;
    x.value = withTiming(0);
    y.value = withTiming(0);
    xBase.value = 0;
    yBase.value = 0;
  };

  const cerrar = () => {
    reiniciar();
    onClose();
  };

  const pinza = Gesture.Pinch()
    .onUpdate((e) => {
      escala.value = Math.min(ZOOM_MAXIMO, Math.max(0.5, escalaBase.value * e.scale));
    })
    .onEnd(() => {
      // Por debajo del tamano original vuelve solo: dejarlo mas pequeno que la
      // pantalla no aporta nada y descoloca.
      if (escala.value < ZOOM_MINIMO) {
        escala.value = withTiming(1);
        escalaBase.value = 1;
        x.value = withTiming(0);
        y.value = withTiming(0);
        xBase.value = 0;
        yBase.value = 0;
      } else {
        escalaBase.value = escala.value;
      }
    });

  const arrastre = Gesture.Pan()
    .onUpdate((e) => {
      x.value = xBase.value + e.translationX;
      y.value = yBase.value + e.translationY;
    })
    .onEnd((e) => {
      /*
        Sin acercar, arrastrar hacia abajo cierra —el gesto que ya espera
        cualquiera en un visor de fotos—. Con la imagen ampliada NO, porque ahi
        arrastrar sirve para moverse por ella.
      */
      if (escala.value <= 1 && e.translationY > CIERRE_POR_ARRASTRE_PX) {
        runOnJS(cerrar)();
        return;
      }
      if (escala.value <= 1) {
        x.value = withTiming(0);
        y.value = withTiming(0);
        xBase.value = 0;
        yBase.value = 0;
        return;
      }
      xBase.value = x.value;
      yBase.value = y.value;
    });

  // Dos toques: acerca si esta al tamano normal, y devuelve al completo si ya
  // estaba acercada. Es mas rapido que hacer la pinza para un vistazo.
  const dobleToque = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (escala.value > 1) {
        escala.value = withTiming(1);
        escalaBase.value = 1;
        x.value = withTiming(0);
        y.value = withTiming(0);
        xBase.value = 0;
        yBase.value = 0;
      } else {
        escala.value = withTiming(2.5);
        escalaBase.value = 2.5;
      }
    });

  const gesto = Gesture.Simultaneous(Gesture.Exclusive(dobleToque, arrastre), pinza);

  const estiloImagen = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { scale: escala.value },
    ],
  }));

  return (
    <Modal
      visible={!!uri}
      transparent={false}
      animationType="fade"
      onRequestClose={cerrar}
      // Sin esto, en iOS la barra de estado clara queda ilegible sobre el fondo
      // negro del visor.
      statusBarTranslucent
    >
      {/*
        `GestureHandlerRootView` DENTRO del Modal: los gestos declarados fuera
        no llegan al contenido de un Modal, que se monta en otra jerarquia de
        vistas. Sin esto la pinza no responde en Android.
      */}
      <GestureHandlerRootView style={styles.root}>
        <GestureDetector gesture={gesto}>
          <View style={styles.lienzo}>
            {uri ? (
              <AnimatedImage
                source={claveDeCache ? { uri, cacheKey: claveDeCache } : { uri }}
                style={[styles.imagen, estiloImagen]}
                // `contain` y no `cover`: se ve ENTERA, que es el motivo de
                // que este visor exista.
                contentFit="contain"
                cachePolicy="memory-disk"
                transition={120}
              />
            ) : null}
          </View>
        </GestureDetector>

        {cabecera ? (
          <View style={styles.cabecera}>{cabecera}</View>
        ) : (
          <Pressable
            onPress={cerrar}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('media.closeImage')}
            style={styles.cerrar}
          >
            <Feather name="x" size={24} color={media.text} />
          </Pressable>
        )}

        {/*
          Medidos desde encima de los botones de Android: el `Modal` tambien se
          pinta de canto a canto (la app es `edgeToEdgeEnabled`), y con los tres
          botones —48 px— la ayuda, a 32 del borde, quedaba debajo de ellos.
        */}
        {caption ? (
          <View style={[styles.pie, { bottom: 76 + insets.bottom }]} pointerEvents="none">
            <Text variant="body" color={media.text} style={styles.pieTexto}>
              {caption}
            </Text>
          </View>
        ) : null}

        {pie ? (
          <View style={[styles.pieDelVisor, { paddingBottom: insets.bottom + spacing.sm }]}>
            {pie}
          </View>
        ) : (
          <Text
            variant="secondary"
            color={media.textMuted}
            style={[styles.ayuda, { bottom: 32 + insets.bottom }]}
          >
            {t('media.pinchToZoom')}
          </Text>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  lienzo: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cabecera: { position: 'absolute', top: 0, left: 0, right: 0 },
  pieDelVisor: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.md },
  imagen: { width: '100%', height: '100%' },
  cerrar: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: media.overlay,
  },
  pie: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: 76,
    padding: spacing.md,
    borderRadius: 12,
    backgroundColor: media.overlay,
  },
  pieTexto: { lineHeight: 21 },
  ayuda: { position: 'absolute', bottom: 32, alignSelf: 'center' },
});
