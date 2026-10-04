import React, { useEffect, useRef } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { DURACION, ESCALA_AL_ENCENDER, MUELLE } from '@/lib/movimiento';

type Props = {
  /** El estado: gustado, guardado, republicado. */
  activo: boolean;
  /**
   * El servidor todavía no ha confirmado. El icono YA muestra lo que se pidió,
   * un poco atenuado; al confirmarse recupera toda su tinta. Así se ve que el
   * toque se ha recibido y también cuándo ha quedado hecho.
   */
  pendiente?: boolean;
  /**
   * De qué elemento es este icono, en las listas que reciclan celdas. Al
   * cambiar de elemento el estado nuevo se pinta SIN saltar: que la celda pase
   * a una publicación ya gustada no es que alguien acabe de reaccionar.
   */
  clave?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Un icono de estado que SALTA al encenderse.
 *
 * Al pasar a encendido sube un poco y vuelve con un muelle; al apagarse se
 * encoge un instante. Es la respuesta al toque en el corazón, el marcador y
 * las flechas de republicar: el dibujo cambia de forma (relleno o contorno) y
 * este salto es lo que hace que ese cambio se note.
 *
 * NO ANIMA AL MONTARSE. Una lista de publicaciones ya gustadas no puede
 * aparecer con veinte corazones saltando.
 *
 * CON «REDUCIR MOVIMIENTO» no salta: el cambio de dibujo sigue diciéndolo.
 */
export function IconoQueSeEnciende({ activo, pendiente = false, clave, children, style }: Props) {
  const reducir = useReducedMotion();
  const escala = useSharedValue(1);
  const tinta = useSharedValue(pendiente ? 0.55 : 1);
  const anterior = useRef(activo);
  const claveAnterior = useRef(clave);

  useEffect(() => {
    if (claveAnterior.current !== clave) {
      // Otro elemento en la misma celda: se toma su estado tal cual.
      claveAnterior.current = clave;
      anterior.current = activo;
      return;
    }
    if (anterior.current === activo) return;
    anterior.current = activo;
    if (reducir) return;
    escala.value = withSequence(
      withTiming(activo ? ESCALA_AL_ENCENDER : 0.86, { duration: DURACION.toque }),
      withSpring(1, MUELLE),
    );
  }, [activo, clave, escala, reducir]);

  useEffect(() => {
    tinta.value = withTiming(pendiente ? 0.55 : 1, { duration: reducir ? 0 : DURACION.breve });
  }, [pendiente, tinta, reducir]);

  const animado = useAnimatedStyle(() => ({
    opacity: tinta.value,
    transform: [{ scale: escala.value }],
  }));

  return <Animated.View style={[style, animado]}>{children}</Animated.View>;
}
