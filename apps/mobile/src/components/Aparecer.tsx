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
  /**
   * Ya está en su sitio: no entra. Sirve para animar solo ALGUNOS elementos de
   * una lista —el mensaje que se acaba de enviar, no el historial— sin cambiar
   * de componente, que remontaría la fila al pasar de uno a otro.
   */
  inmediato?: boolean;
  /**
   * De qué elemento es esta entrada. Hace falta en las listas que RECICLAN
   * celdas (FlashList): ahí el componente no se vuelve a montar al pasar a
   * otro elemento, solo cambia de datos, y sin esto la entrada no se repetiría
   * nunca —o se quedaría a medias de la del elemento anterior—. Fuera de una
   * lista así no hace falta.
   */
  clave?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Algo que entra: aparece y sube unos puntos hasta su sitio. Una vez por
 * elemento.
 *
 * Es la entrada de los estados vacíos, de las tarjetas que llegan y de los
 * mensajes nuevos. Solo anima opacidad y traslación, que no obligan a
 * recalcular la disposición.
 *
 * CON «REDUCIR MOVIMIENTO» el contenido está en su sitio desde el primer
 * fotograma: no se pierde nada, solo no se mueve.
 */
export function Aparecer({
  children,
  retraso = 0,
  desde = DESPLAZAMIENTO_DE_ENTRADA,
  inmediato = false,
  clave,
  style,
}: Props) {
  const reducir = useReducedMotion();
  const quieto = reducir || inmediato;
  const avance = useSharedValue(quieto ? 1 : 0);

  useEffect(() => {
    if (quieto) {
      // Una celda reciclada puede venir de un elemento que estaba entrando.
      avance.value = 1;
      return;
    }
    avance.value = 0;
    avance.value = withDelay(
      retraso,
      withTiming(1, { duration: DURACION.normal, easing: Easing.out(Easing.cubic) }),
    );
    // Al montar y al cambiar de elemento, no cuando el mismo elemento deja de
    // ser «nuevo»: ese ya entró.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  const animado = useAnimatedStyle(() => ({
    opacity: avance.value,
    transform: [{ translateY: (1 - avance.value) * desde }],
  }));

  return <Animated.View style={[style, animado]}>{children}</Animated.View>;
}
