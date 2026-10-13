import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import { useReduceMotion } from '@/hooks/useReduceMotion';

/** En la web `Animated` no tiene hilo nativo y avisa por consola si se le pide. */
const HILO_NATIVO = Platform.OS !== 'web';

const PUNTOS = [0, 1, 2] as const;
const PASO_MS = 260;

type Props = {
  color: string;
  /** El diámetro de cada punto. */
  size?: number;
};

/**
 * Los tres puntos de «está escribiendo»: una ola que sube y baja.
 *
 * SOLO EXISTEN MIENTRAS ALGUIEN ESCRIBE. Quien los usa los monta cuando hay
 * alguien y los desmonta cuando no: en reposo no queda nada animado en la
 * pantalla, que es la regla de este proyecto. La animación arranca al montar
 * y se detiene al desmontar.
 *
 * Con «reducir movimiento» se quedan quietos: la frase que los acompaña basta.
 *
 * Los usan el indicador del chat y la fila de la bandeja.
 */
export function PuntosDeEscritura({ color, size = 7 }: Props) {
  const reduceMotion = useReduceMotion();
  const fases = useRef(PUNTOS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (reduceMotion) return;
    const vuelta = Animated.loop(
      Animated.stagger(
        PASO_MS / 2,
        fases.map((fase) =>
          Animated.sequence([
            Animated.timing(fase, {
              toValue: 1,
              duration: PASO_MS,
              easing: Easing.out(Easing.quad),
              useNativeDriver: HILO_NATIVO,
            }),
            Animated.timing(fase, {
              toValue: 0,
              duration: PASO_MS,
              easing: Easing.in(Easing.quad),
              useNativeDriver: HILO_NATIVO,
            }),
          ]),
        ),
      ),
    );
    vuelta.start();
    return () => vuelta.stop();
  }, [fases, reduceMotion]);

  // Suben más de la mitad de su tamaño: con menos, de lejos parecen quietos.
  const salto = -Math.round(size * 0.7);

  return (
    <View style={[styles.fila, { gap: Math.round(size * 0.6), height: size * 2 }]}>
      {fases.map((fase, indice) => (
        <Animated.View
          key={PUNTOS[indice]}
          style={[
            { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
            reduceMotion
              ? null
              : {
                  opacity: fase.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
                  transform: [
                    { translateY: fase.interpolate({ inputRange: [0, 1], outputRange: [0, salto] }) },
                    { scale: fase.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] }) },
                  ],
                },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', alignItems: 'center' },
});
