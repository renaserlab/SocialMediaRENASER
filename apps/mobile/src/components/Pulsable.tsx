import React from 'react';
import {
  GestureResponderEvent,
  Pressable,
  PressableProps,
  StyleProp,
  ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { haptics } from '@/lib/haptics';
import {
  DURACION,
  ESCALA_AL_PULSAR,
  MUELLE,
  escalaPulsada,
  opacidadPulsada,
} from '@/lib/movimiento';

const PressableAnimado = Animated.createAnimatedComponent(Pressable);

export type PulsableProps = Omit<PressableProps, 'style'> & {
  /**
   * Un estilo normal, no una función de `pressed`: el estado pulsado ya lo
   * pinta este componente (encoge y atenúa), y hacerlo en dos sitios daba dos
   * respuestas distintas al mismo toque.
   */
  style?: StyleProp<ViewStyle>;
  /** Cuánto encoge al pulsarlo. Por defecto, lo de un botón o una fila. */
  escala?: number;
  /** Opacidad mínima mientras está pulsado. 1 para no atenuar. */
  atenuar?: number;
  /**
   * La opacidad en reposo. Va aquí y no en `style` porque la opacidad la
   * anima este componente: una escrita en el estilo quedaría pisada, y un
   * botón apagado dejaría de verse apagado.
   */
  opacidad?: number;
  /**
   * Un toque en la mano al pulsar. Apagado por defecto: vibrar en cada botón
   * de la aplicación convierte la señal en ruido. Se enciende en lo que
   * cambia algo —reaccionar, guardar, enviar—.
   */
  haptica?: 'ligera' | 'media' | false;
};

/**
 * Lo que se puede pulsar, con respuesta.
 *
 * Es el `Pressable` de siempre —mismas propiedades, misma accesibilidad— que
 * además se hunde un poco bajo el dedo y vuelve con un muelle corto. La
 * animación corre en el hilo de la interfaz: no espera a que JavaScript esté
 * libre, que es justo cuando un toque parece perdido.
 *
 * CON «REDUCIR MOVIMIENTO» no encoge; solo se atenúa. El toque se sigue
 * viendo, que es lo que importa.
 */
export function Pulsable({
  style,
  escala = ESCALA_AL_PULSAR.superficie,
  atenuar = 0.85,
  opacidad = 1,
  haptica = false,
  onPressIn,
  onPressOut,
  disabled,
  children,
  ...resto
}: PulsableProps) {
  const presion = useSharedValue(0);
  const reducir = useReducedMotion();

  const animado = useAnimatedStyle(() => ({
    opacity: opacidad * opacidadPulsada(presion.value, atenuar),
    transform: [{ scale: escalaPulsada(presion.value, escala, reducir) }],
  }));

  const alBajar = (evento: GestureResponderEvent) => {
    // Baja rápido y sin muelle: el dedo ya está encima, no hay nada que anunciar.
    presion.value = withTiming(1, { duration: DURACION.toque });
    if (haptica === 'ligera') haptics.light();
    else if (haptica === 'media') haptics.medium();
    onPressIn?.(evento);
  };

  const alSubir = (evento: GestureResponderEvent) => {
    presion.value = withSpring(0, MUELLE);
    onPressOut?.(evento);
  };

  return (
    <PressableAnimado
      {...resto}
      disabled={disabled}
      onPressIn={alBajar}
      onPressOut={alSubir}
      style={[style, animado]}
    >
      {children}
    </PressableAnimado>
  );
}
