import React, { useEffect, useRef } from 'react';
import { StyleProp, StyleSheet, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/Text';
import { DURACION, MUELLE } from '@/lib/movimiento';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  /** Cuántos hay sin leer. Con cero no se pinta nada. */
  cuenta: number;
  /** Diámetro. 20 en una fila de lista; 16 sobre un icono de la barra. */
  tamano?: number;
  /**
   * Sin número: solo el punto. Para donde no cabe una cifra o donde lo que
   * importa es «hay algo», no cuánto.
   */
  soloPunto?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Más de 99 no cabe y tampoco aporta: lo que importa es «muchos». */
export function textoDelGlobo(cuenta: number): string {
  return cuenta > 99 ? '99+' : String(cuenta);
}

/**
 * El globo de «sin leer»: el de las conversaciones, el de la barra inferior y
 * el de la campana.
 *
 * Eran tres dibujos distintos del mismo dato. Aquí es uno, y AVISA cuando
 * cambia: aparece creciendo desde su centro y, si la cuenta sube estando ya en
 * pantalla, da un pequeño salto. Un número que cambia sin moverse no se ve
 * con el rabillo del ojo, que es justo como se mira una barra de navegación.
 *
 * No lleva `accessibilityLabel` propio: quien lo pinta ya anuncia la cuenta en
 * la etiqueta del botón o de la fila, y decirlo dos veces sería ruido.
 */
export function GloboDeNoLeidos({ cuenta, tamano = 20, soloPunto = false, style }: Props) {
  const { colors } = useAppTheme();
  const reducir = useReducedMotion();
  const visible = cuenta > 0;
  const escala = useSharedValue(visible ? 1 : 0);
  const anterior = useRef(cuenta);

  useEffect(() => {
    const antes = anterior.current;
    anterior.current = cuenta;
    if (reducir) {
      escala.value = visible ? 1 : 0;
      return;
    }
    if (!visible) {
      escala.value = withTiming(0, { duration: DURACION.toque });
    } else if (antes <= 0) {
      escala.value = withSpring(1, MUELLE);
    } else if (cuenta > antes) {
      escala.value = withSequence(withTiming(1.25, { duration: DURACION.toque }), withSpring(1, MUELLE));
    }
  }, [cuenta, visible, escala, reducir]);

  const animado = useAnimatedStyle(() => ({
    opacity: escala.value > 0.05 ? 1 : 0,
    transform: [{ scale: escala.value }],
  }));

  if (!visible) return null;

  const lado = soloPunto ? Math.round(tamano / 2) : tamano;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.globo,
        {
          minWidth: lado,
          height: lado,
          borderRadius: lado / 2,
          backgroundColor: colors.primary,
          paddingHorizontal: soloPunto ? 0 : 5,
        },
        style,
        animado,
      ]}
    >
      {soloPunto ? null : (
        <Text
          variant="caption"
          weight="700"
          color={colors.onPrimary}
          style={{ fontSize: Math.max(9, Math.round(tamano * 0.5)), fontVariant: ['tabular-nums'] }}
        >
          {textoDelGlobo(cuenta)}
        </Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  globo: { alignItems: 'center', justifyContent: 'center' },
});
