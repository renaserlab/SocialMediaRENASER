import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Aparecer } from '@/components/Aparecer';
import { Text } from '@/components/Text';
import { ZLogo } from '@/components/ZLogo';
import { DURACION, MUELLE_DE_PANEL } from '@/lib/movimiento';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  titulo: string;
  subtitulo: string;
  /** Lado de la marca. Más pequeña donde el formulario es más largo. */
  tamano?: number;
};

/**
 * Lo primero que se ve al entrar o al crear la cuenta: la marca, y debajo qué
 * se viene a hacer.
 *
 * Las dos pantallas empezaban con un título pegado a la izquierda y un logo de
 * 34 puntos al final de la frase. Funcionaba y no decía nada: son las únicas
 * pantallas que ve TODO el mundo, y las primeras.
 *
 * LA MARCA LLEGA UNA VEZ: crece hasta su tamaño con un muelle y suelta una
 * onda que se abre y se apaga. No se repite ni se queda latiendo. Con «reducir
 * movimiento» está en su sitio desde el primer fotograma y no hay onda.
 */
export function CabeceraDeAcceso({ titulo, subtitulo, tamano = 72 }: Props) {
  const { colors } = useAppTheme();
  const reducir = useReducedMotion();
  const llegada = useSharedValue(reducir ? 1 : 0);
  const onda = useSharedValue(reducir ? 1 : 0);

  useEffect(() => {
    if (reducir) return;
    llegada.value = withSpring(1, MUELLE_DE_PANEL);
    onda.value = withDelay(
      DURACION.breve,
      withTiming(1, { duration: DURACION.panel * 2, easing: Easing.out(Easing.cubic) }),
    );
    // Solo al montar: la marca ya llegó.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const marca = useAnimatedStyle(() => ({
    opacity: Math.min(1, llegada.value),
    transform: [{ scale: 0.8 + 0.2 * llegada.value }],
  }));
  const halo = useAnimatedStyle(() => ({
    opacity: (1 - onda.value) * 0.5,
    transform: [{ scale: 1 + onda.value * 0.6 }],
  }));

  return (
    <View style={styles.cabecera}>
      <View style={[styles.sitio, { width: tamano, height: tamano }]}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            { borderColor: colors.text, borderRadius: tamano * 0.22 },
            halo,
          ]}
        />
        <Animated.View style={marca}>
          <ZLogo size={tamano} />
        </Animated.View>
      </View>
      <Aparecer retraso={DURACION.toque} style={styles.textos}>
        <Text variant="display" weight="900" accessibilityRole="header" style={styles.centrado}>
          {titulo}
        </Text>
        <Text variant="body" color={colors.textMuted} style={styles.centrado}>
          {subtitulo}
        </Text>
      </Aparecer>
    </View>
  );
}

const styles = StyleSheet.create({
  cabecera: { alignItems: 'center', gap: spacing.lg, marginBottom: spacing.sm },
  sitio: { alignItems: 'center', justifyContent: 'center' },
  halo: { ...StyleSheet.absoluteFillObject, borderWidth: 1 },
  textos: { alignItems: 'center', gap: spacing.xs },
  centrado: { textAlign: 'center' },
});
