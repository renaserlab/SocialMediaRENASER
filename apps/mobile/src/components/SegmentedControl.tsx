import React, { useEffect, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { ESCALA_AL_PULSAR, MUELLE_DE_PANEL } from '@/lib/movimiento';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type SegmentedControlProps = {
  options: string[];
  selectedIndex: number;
  onChange: (index: number) => void;
  style?: ViewStyle;
};

/**
 * Dos o tres opciones excluyentes, con una pastilla que SE DESLIZA de una a
 * otra.
 *
 * Antes la opción elegida cambiaba de fondo de golpe: se veía cuál estaba
 * activa pero no de dónde venía. La pastilla es UNA sola vista que se mueve
 * debajo de las etiquetas; así el cambio se lee como un desplazamiento y no
 * como dos botones parpadeando.
 *
 * El ancho se mide (`onLayout`) porque la pastilla se coloca con una
 * traslación, que es lo que puede animar el hilo de la interfaz. Hasta que hay
 * medida no se pinta: aparece ya en su sitio, sin recorrer el control en el
 * primer fotograma.
 */
export function SegmentedControl({
  options,
  selectedIndex,
  onChange,
  style,
}: SegmentedControlProps) {
  const { colors } = useAppTheme();
  const reducir = useReducedMotion();
  const [ancho, setAncho] = useState(0);
  const posicion = useSharedValue(selectedIndex);
  const paso = options.length > 0 ? ancho / options.length : 0;

  useEffect(() => {
    posicion.value = reducir ? selectedIndex : withSpring(selectedIndex, MUELLE_DE_PANEL);
  }, [selectedIndex, posicion, reducir]);

  const pastilla = useAnimatedStyle(() => ({
    transform: [{ translateX: posicion.value * paso }],
  }));

  // El interior: lo que queda dentro del relleno del contenedor.
  const medir = (evento: LayoutChangeEvent) => setAncho(evento.nativeEvent.layout.width);

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.container,
        { backgroundColor: colors.backgroundAlt, borderColor: colors.border },
        style,
      ]}
    >
      <View style={styles.pista} onLayout={medir}>
        {paso > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.pastilla, { width: paso, backgroundColor: colors.primary }, pastilla]}
          />
        ) : null}
        {options.map((option, index) => {
          const selected = index === selectedIndex;
          return (
            <Pulsable
              key={option}
              onPress={() => onChange(index)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={option}
              escala={ESCALA_AL_PULSAR.chip}
              atenuar={0.75}
              style={styles.segment}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  {
                    color: selected ? colors.onPrimary : colors.textMuted,
                    fontWeight: selected ? '700' : '500',
                  },
                ]}
              >
                {option}
              </Text>
            </Pulsable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.xs,
  },
  pista: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  pastilla: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: radius.sm,
  },
  segment: {
    flex: 1,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  label: {
    fontSize: 13,
  },
});
