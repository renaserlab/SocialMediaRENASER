import React, { useEffect, useRef } from 'react';
import { StyleProp, TextStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/Text';
import { DURACION } from '@/lib/movimiento';

type Props = {
  valor: number;
  /** De qué elemento es el número, en las listas que reciclan celdas. */
  clave?: string;
  style?: StyleProp<TextStyle>;
  color?: string;
  variant?: React.ComponentProps<typeof Text>['variant'];
  weight?: React.ComponentProps<typeof Text>['weight'];
};

/** Cuánto recorre el número al cambiar. Poco: es un contador, no un marcador. */
const RECORRIDO = 6;

/**
 * Un número que cambia sin saltar.
 *
 * Cuando sube, el nuevo valor entra desde abajo; cuando baja, desde arriba. El
 * sentido del movimiento dice si se ha sumado o restado antes de leer la cifra.
 *
 * Las cifras son de ancho fijo (`tabular-nums`): pasar de 9 a 10 o de 1 a 2 no
 * mueve de sitio lo que hay al lado.
 *
 * NO ANIMA AL MONTARSE, ni con «reducir movimiento»: el número cambia y ya.
 */
export function ContadorAnimado({ valor, clave, style, color, variant, weight }: Props) {
  const reducir = useReducedMotion();
  const desplazamiento = useSharedValue(0);
  const opacidad = useSharedValue(1);
  const anterior = useRef(valor);
  const claveAnterior = useRef(clave);

  useEffect(() => {
    if (claveAnterior.current !== clave) {
      // Otro elemento en la misma celda: su número no «cambia», es otro.
      claveAnterior.current = clave;
      anterior.current = valor;
      return;
    }
    if (anterior.current === valor) return;
    const sube = valor > anterior.current;
    anterior.current = valor;
    if (reducir) return;
    desplazamiento.value = sube ? RECORRIDO : -RECORRIDO;
    opacidad.value = 0;
    desplazamiento.value = withTiming(0, { duration: DURACION.breve });
    opacidad.value = withTiming(1, { duration: DURACION.breve });
  }, [valor, clave, desplazamiento, opacidad, reducir]);

  const animado = useAnimatedStyle(() => ({
    opacity: opacidad.value,
    transform: [{ translateY: desplazamiento.value }],
  }));

  return (
    <Animated.View style={animado}>
      <Text
        variant={variant}
        weight={weight}
        color={color}
        style={[{ fontVariant: ['tabular-nums'] }, style]}
      >
        {valor}
      </Text>
    </Animated.View>
  );
}
