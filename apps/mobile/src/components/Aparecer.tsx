import React, { useEffect } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { DESPLAZAMIENTO_DE_ENTRADA, DURACION } from '@/lib/movimiento';

type Props = {
  children: React.ReactNode;
  /** Milisegundos antes de empezar: para entrar en cascada (`retrasoEnCascada`). */
  retraso?: number;
  /** Desde cuántos puntos por debajo sube. 0 para que solo aparezca. */
  desde?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * Algo que entra: aparece y sube unos puntos hasta su sitio. Una vez, al
 * montarse.
 *
 * Es la entrada de los estados vacíos, de las tarjetas que llegan y de los
 * mensajes nuevos. Solo anima opacidad y traslación, que no obligan a
 * recalcular la disposición.
 *
 * CON «REDUCIR MOVIMIENTO» el contenido está en su sitio desde el primer
 * fotograma: no se pierde nada, solo no se mueve.
 */
export function Aparecer({ children, retraso = 0, desde = DESPLAZAMIENTO_DE_ENTRADA, style }: Props) {
  const reducir = useReducedMotion();
  const avance = useSharedValue(reducir ? 1 : 0);

  useEffect(() => {
    if (reducir) return;
    avance.value = withDelay(
      retraso,
      withTiming(1, { duration: DURACION.normal, easing: Easing.out(Easing.cubic) }),
    );
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animado = useAnimatedStyle(() => ({
    opacity: avance.value,
    transform: [{ translateY: (1 - avance.value) * desde }],
  }));

  return <Animated.View style={[style, animado]}>{children}</Animated.View>;
}
