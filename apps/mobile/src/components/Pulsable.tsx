import React from 'react';
import {
  GestureResponderEvent,
  Pressable,
  PressableProps,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { haptics } from '@/lib/haptics';
import { ESCALA_AL_PULSAR, estiloPulsado } from '@/lib/movimiento';

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
   * pinta este componente: una escrita en el estilo quedaría pisada, y un
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
 * además se hunde un poco y se atenúa mientras tiene el dedo encima.
 *
 * NO ES UN COMPONENTE ANIMADO, Y ESO ES A PROPÓSITO (04/10/2026). Lo fue: cada
 * `Pulsable` montaba una vista animada con su valor compartido, y hay cientos
 * —cada botón, cada fila, cada icono de cada publicación—. Solo por estar
 * montados hacían ir a tirones el desplazamiento y la navegación de toda la
 * aplicación. Ver la nota de `lib/movimiento.ts`.
 *
 * Ahora en reposo es una vista normal y no cuesta nada. Al pulsarlo cambia de
 * estilo en el acto: la respuesta se ve igual de pronto, sin muelle.
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
  children,
  ...resto
}: PulsableProps) {
  // Una constante leída al arrancar, no una suscripción por botón.
  const reducir = useReducedMotion();

  const alBajar = haptica
    ? (evento: GestureResponderEvent) => {
        if (haptica === 'ligera') haptics.light();
        else haptics.medium();
        onPressIn?.(evento);
      }
    : onPressIn;

  return (
    <Pressable
      {...resto}
      onPressIn={alBajar}
      style={({ pressed }) => {
        const pulsado = estiloPulsado(pressed, { escala, atenuar, opacidad, reducir });
        return pulsado ? [style, pulsado] : style;
      }}
    >
      {children}
    </Pressable>
  );
}
