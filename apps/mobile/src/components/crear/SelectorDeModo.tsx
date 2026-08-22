import React, { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { Text } from '@/components/Text';
import { getFontFamily, palette, spacing } from '@/theme/tokens';

const media = palette('dark');

/** Ancho de cada hueco. Fijo a proposito: centrar es entonces una resta. */
const ANCHO = 116;

export type ModoDeCreacion = 'publicacion' | 'historia' | 'reel' | 'vivo';

export const MODOS: Array<{ id: ModoDeCreacion; etiqueta: string }> = [
  { id: 'publicacion', etiqueta: 'Publicación' },
  { id: 'historia', etiqueta: 'Historia' },
  { id: 'reel', etiqueta: 'Reel' },
  { id: 'vivo', etiqueta: 'Vivo' },
];

export function posicionDeModo(modo: ModoDeCreacion): number {
  return MODOS.findIndex((m) => m.id === modo);
}

type Props = {
  activo: ModoDeCreacion;
  alCambiar: (modo: ModoDeCreacion) => void;
  /**
   * Avance del arrastre en curso, de -1 a 1. Lo aporta la pantalla mientras el
   * dedo se mueve para que la fila SIGA al dedo en vez de saltar al soltar.
   */
  arrastre?: SharedValue<number>;
};

/**
 * Selector de tipo de publicacion, al pie de la pantalla de Crear.
 *
 * La fila se desplaza para que el modo activo quede siempre en el centro, que
 * es lo que convierte cuatro palabras sueltas en algo que se entiende como un
 * carrete. Se cambia tocando una etiqueta o arrastrando en horizontal sobre la
 * pantalla; mientras el dedo se mueve la fila lo acompana (`arrastre`), asi
 * que se ve a donde se va antes de soltar.
 */
export function SelectorDeModo({ activo, alCambiar, arrastre }: Props) {
  const indice = useSharedValue(posicionDeModo(activo));

  useEffect(() => {
    // 180 ms: dentro del rango que se percibe como respuesta y no como
    // animacion, el mismo criterio que usa la barra de secciones.
    indice.value = withTiming(posicionDeModo(activo), {
      duration: 180,
      easing: Easing.out(Easing.cubic),
    });
  }, [activo, indice]);

  const estilo = useAnimatedStyle(() => ({
    transform: [{ translateX: -(indice.value + (arrastre?.value ?? 0)) * ANCHO }],
  }));

  return (
    <View style={styles.host} pointerEvents="box-none">
      <Animated.View style={[styles.fila, estilo]}>
        {MODOS.map(({ id, etiqueta }) => {
          const seleccionado = id === activo;
          return (
            <Pressable
              key={id}
              onPress={() => alCambiar(id)}
              style={styles.hueco}
              accessibilityRole="tab"
              accessibilityState={{ selected: seleccionado }}
              accessibilityLabel={etiqueta}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.etiqueta,
                  { color: seleccionado ? media.text : media.textMuted },
                  seleccionado ? styles.activa : null,
                ]}
              >
                {etiqueta}
              </Text>
            </Pressable>
          );
        })}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    // Recorta lo que se sale por los lados: sin esto las etiquetas de los
    // extremos se dibujarian fuera y ensancharian la pantalla.
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
  },
  fila: { flexDirection: 'row', alignItems: 'center' },
  hueco: { width: ANCHO, alignItems: 'center', justifyContent: 'center', minHeight: 40 },
  etiqueta: {
    fontSize: 14,
    fontFamily: getFontFamily('600'),
    fontWeight: Platform.OS === 'ios' ? '600' : undefined,
    paddingHorizontal: spacing.sm,
  },
  activa: {
    fontFamily: getFontFamily('800'),
    fontWeight: Platform.OS === 'ios' ? '800' : undefined,
  },
});
