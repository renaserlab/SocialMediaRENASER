import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import { Text } from '@/components/Text';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** En la web `Animated` no tiene hilo nativo y avisa por consola si se le pide. */
const HILO_NATIVO = Platform.OS !== 'web';

const PUNTOS = [0, 1, 2] as const;
const PASO_MS = 280;

type Props = {
  /** La frase ya traducida: «Ana está escribiendo». */
  frase: string;
};

/**
 * «Está escribiendo»: tres puntos que suben y bajan, y quién.
 *
 * SOLO EXISTE MIENTRAS ALGUIEN ESCRIBE. Quien lo usa lo monta cuando hay
 * alguien y lo desmonta cuando no: en reposo no queda nada animado en la
 * pantalla, que es la regla de este proyecto. La animación arranca al montar
 * y se detiene al desmontar.
 *
 * Con «reducir movimiento» los puntos se quedan quietos: la frase basta.
 *
 * NO RECIBE TOQUES y va sobre la lista, no dentro: que aparezca o desaparezca
 * no mueve ningún mensaje de su sitio.
 */
export function IndicadorDeEscritura({ frase }: Props) {
  const { colors } = useAppTheme();
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

  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={frase}
      style={[styles.pildora, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={styles.puntos}>
        {fases.map((fase, indice) => (
          <Animated.View
            key={PUNTOS[indice]}
            style={[
              styles.punto,
              { backgroundColor: colors.textMuted },
              reduceMotion
                ? null
                : {
                    opacity: fase.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
                    transform: [
                      { translateY: fase.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) },
                    ],
                  },
            ]}
          />
        ))}
      </View>
      <Text numberOfLines={1} color={colors.textMuted} style={styles.frase}>
        {frase}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pildora: {
    position: 'absolute',
    left: spacing.md,
    bottom: spacing.sm,
    maxWidth: '82%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  puntos: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 12 },
  punto: { width: 6, height: 6, borderRadius: 3 },
  frase: { fontSize: 12, flexShrink: 1 },
});
