import React, { useEffect, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { DURACION, duracionDeSalida } from '@/lib/movimiento';

type Props = {
  abierto: boolean;
  children: React.ReactNode;
};

/**
 * Lo que se despliega: el cuerpo de un acordeón.
 *
 * Antes el contenido aparecía y desaparecía de golpe, empujando de un salto
 * todo lo que había debajo. Aquí se ABRE: la altura crece desde cero hasta lo
 * que mide el contenido mientras este gana opacidad, y lo de debajo baja con
 * él. Al cerrar hace el camino contrario, algo más rápido.
 *
 * CÓMO MIDE. El contenido vive en una capa absoluta, que se dispone a su alto
 * natural aunque la caja de fuera mida cero; `onLayout` dice cuánto es y la
 * caja anima hasta ahí. Si el contenido cambia de alto —llegan datos— la caja
 * lo sigue.
 *
 * SI NACE ABIERTO, mientras todavía no hay medida el contenido va en el flujo
 * normal, a su alto: sin eso la caja mediría cero un fotograma y lo de debajo
 * daría un salto al llegar la medida.
 *
 * CERRADO NO SE PUEDE TOCAR NI LEER: sin `pointerEvents` ni las marcas de
 * accesibilidad, un lector de pantalla seguiría recorriendo lo que no se ve.
 *
 * CON «REDUCIR MOVIMIENTO» abre y cierra de golpe, como antes.
 */
export function Desplegable({ abierto, children }: Props) {
  const reducir = useReducedMotion();
  const [alto, setAlto] = useState(0);
  const avance = useSharedValue(abierto ? 1 : 0);
  const medido = alto > 0;

  useEffect(() => {
    const destino = abierto ? 1 : 0;
    if (reducir) {
      avance.value = destino;
      return;
    }
    avance.value = withTiming(destino, {
      duration: abierto ? DURACION.panel : duracionDeSalida(DURACION.panel),
      easing: Easing.out(Easing.cubic),
    });
  }, [abierto, avance, reducir]);

  const caja = useAnimatedStyle(() => ({
    height: avance.value * alto,
    opacity: avance.value,
  }));

  const medir = (evento: LayoutChangeEvent) => {
    const nuevo = Math.ceil(evento.nativeEvent.layout.height);
    if (nuevo !== alto) setAlto(nuevo);
  };

  // Sin medida todavía: abierto, a su alto natural; cerrado, a cero.
  const sinMedida = abierto ? null : styles.cerrada;

  return (
    <Animated.View
      style={[styles.caja, medido ? caja : sinMedida]}
      pointerEvents={abierto ? 'auto' : 'none'}
      accessibilityElementsHidden={!abierto}
      importantForAccessibility={abierto ? 'auto' : 'no-hide-descendants'}
      // Para el navegador, que no entiende las dos de arriba.
      aria-hidden={!abierto}
    >
      <View style={medido || !abierto ? styles.contenido : null} onLayout={medir}>
        {children}
      </View>
    </Animated.View>
  );
}

/**
 * La flecha de un acordeón: GIRA media vuelta al abrirse.
 *
 * En reposo se ve igual que antes —abajo cerrada, arriba abierta—, que es lo
 * que se lee siempre en un sistema en blanco y negro. Lo nuevo es el giro, que
 * une los dos estados en vez de cambiar un dibujo por otro.
 */
export function FlechaDeDesplegable({ abierto, color }: { abierto: boolean; color: string }) {
  const reducir = useReducedMotion();
  const giro = useSharedValue(abierto ? 1 : 0);

  useEffect(() => {
    const destino = abierto ? 1 : 0;
    giro.value = reducir ? destino : withTiming(destino, { duration: DURACION.normal });
  }, [abierto, giro, reducir]);

  const animado = useAnimatedStyle(() => ({ transform: [{ rotate: `${giro.value * 180}deg` }] }));
  return (
    <Animated.View style={animado}>
      <Feather name="chevron-down" size={20} color={color} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  caja: { overflow: 'hidden' },
  cerrada: { height: 0, opacity: 0 },
  contenido: { position: 'absolute', left: 0, right: 0, top: 0 },
});
