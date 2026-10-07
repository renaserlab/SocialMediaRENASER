import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { motion, radius } from '@/theme/tokens';

type Props = {
  activa: boolean;
  color: string;
  /** Cuanto se cine dentro de su celda: cada barra lo decide. */
  style?: StyleProp<ViewStyle>;
  /**
   * Lo que la capsula lleva DENTRO y aparece con ella.
   *
   * Sirve para el rotulo en el color inverso: si el texto cambiara de color por
   * su cuenta mientras la capsula todavia esta apareciendo, durante unas
   * decimas quedaria blanco sobre blanco. Dentro, los dos aparecen a la vez.
   */
  children?: React.ReactNode;
};

/**
 * La capsula que marca la opcion activa en una barra flotante.
 *
 * Vivia dentro de la barra de secciones. Se saca aqui porque la barra de modos
 * de Crear marca su opcion de la misma manera, y dos copias de una animacion
 * son dos sitios donde acordarse de cambiarla.
 */
export function PildoraActiva({ activa, color, style, children }: Props) {
  const progreso = useRef(new Animated.Value(activa ? 1 : 0)).current;

  useEffect(() => {
    // 180 ms: dentro del rango 150-250 que se percibe como respuesta, no como
    // animacion. Native driver: no toca el hilo de JavaScript.
    Animated.timing(progreso, {
      toValue: activa ? 1 : 0,
      duration: motion.fast,
      useNativeDriver: true,
    }).start();
  }, [activa, progreso]);

  return (
    <Animated.View
      pointerEvents="none"
      // Es adorno: la opcion ya dice si esta elegida en su propio estado.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.pildora,
        style,
        {
          backgroundColor: color,
          opacity: progreso,
          transform: [
            { scale: progreso.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pildora: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
