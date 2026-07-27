import React, { useEffect, useState } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useReduceMotion } from '@/hooks/useReduceMotion';
import { haptics } from '@/lib/haptics';
import { palette } from '@/theme/tokens';

// El corazón se dibuja sobre media (imagen/video) → contexto oscuro.
const media = palette('dark');

type DoubleTapLikeProps = {
  children: React.ReactNode;
  /** Se invoca al hacer doble-tap (el padre solo debe DAR like, nunca quitarlo). */
  onDoubleTap: () => void;
  /** Opcional: acción de un solo tap (p. ej. abrir el detalle). */
  onSingleTap?: () => void;
  style?: StyleProp<ViewStyle>;
};

/** Corazón que aparece y desaparece con un pop; se remonta por `key` en cada like. */
function HeartBurst({ reduceMotion }: { reduceMotion: boolean }) {
  const scale = useSharedValue(0.3);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) {
      opacity.value = withSequence(withTiming(1, { duration: 10 }), withDelay(500, withTiming(0, { duration: 150 })));
      scale.value = withTiming(1, { duration: 10 });
    } else {
      opacity.value = withSequence(withTiming(1, { duration: 120 }), withDelay(350, withTiming(0, { duration: 220 })));
      scale.value = withSequence(
        withTiming(1.15, { duration: 150 }),
        withTiming(0.92, { duration: 120 }),
        withTiming(1, { duration: 120 }),
      );
    }
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center, animatedStyle]}>
      <Feather name="heart" size={96} color={media.text} />
    </Animated.View>
  );
}

export function DoubleTapLike({ children, onDoubleTap, onSingleTap, style }: DoubleTapLikeProps) {
  const reduceMotion = useReduceMotion();
  const [burst, setBurst] = useState(0);

  const handleDouble = () => {
    onDoubleTap();
    haptics.light();
    setBurst((b) => b + 1);
  };

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd(() => {
      runOnJS(handleDouble)();
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      if (onSingleTap) runOnJS(onSingleTap)();
    });

  // Exclusive: el single-tap solo dispara si NO hubo un segundo tap.
  const gesture = Gesture.Exclusive(doubleTap, singleTap);

  return (
    /*
      `touchAction` es solo para navegador. Sin ella, la libreria de gestos
      marca la foto con «yo me encargo de todo lo que pase aqui» y el navegador
      deja de desplazar la pagina: en el movil la lista solo se movia si el
      dedo caia en un hueco entre fotos, nunca sobre una.

      `pan-y` reparte el trabajo: el desplazamiento vertical sigue siendo del
      navegador y aqui solo se escuchan los toques. Un toque no desplaza, asi
      que ninguno de los dos gestos le quita nada al otro.
    */
    <GestureDetector gesture={gesture} touchAction="pan-y">
      <View style={style}>
        {children}
        {burst > 0 ? <HeartBurst key={burst} reduceMotion={reduceMotion} /> : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
