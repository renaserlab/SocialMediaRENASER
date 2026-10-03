import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, ViewStyle } from 'react-native';

import { useReduceMotion } from '@/hooks/useReduceMotion';
import { radius } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type SkeletonProps = {
  width?: number | string;
  height?: number;
  circle?: boolean;
  style?: ViewStyle;
};

export function Skeleton({ width = '100%', height = 20, circle = false, style }: SkeletonProps) {
  const { colors } = useAppTheme();
  const opacity = useRef(new Animated.Value(0.3)).current;
  const reducirMovimiento = useReduceMotion();

  useEffect(() => {
    // Con «reducir movimiento», un bloque quieto a media opacidad: sigue
    // diciendo «aquí va algo» sin parpadear en bucle.
    if (reducirMovimiento) {
      opacity.setValue(0.5);
      return undefined;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.7,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 750,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();

    return () => animation.stop();
  }, [opacity, reducirMovimiento]);

  return (
    <Animated.View
      style={[
        styles.skeleton,
        {
          width: width as any,
          height,
          borderRadius: circle ? height / 2 : radius.sm,
          backgroundColor: colors.surfaceAlt,
          opacity,
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  skeleton: {
    alignSelf: 'stretch',
  },
});
