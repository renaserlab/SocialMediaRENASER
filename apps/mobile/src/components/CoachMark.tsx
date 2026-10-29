import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Text } from '@/components/Text';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type CoachMarkProps = {
  /** Identificador estable; con el se recuerda que el usuario la cerro. */
  id: string;
  /** Mensaje corto. El "Toca aquí" lo pone el propio componente. */
  text: string;
  /** Hacia donde apunta la flecha: al elemento de arriba o al de abajo. */
  arrow?: 'up' | 'down';
  /** Condicion externa. En false la guia no se muestra (ni se recuerda). */
  visible?: boolean;
  /** Accion directa: la burbuja tambien es pulsable, no solo el destino. */
  onPress?: () => void;
  style?: ViewStyle;
};

/**
 * Guia de primeros pasos: una burbuja con flecha que senala donde tocar.
 *
 * Se coloca en linea junto al elemento que senala en vez de flotar sobre la
 * pantalla. Evita medir posiciones en tiempo de ejecucion, que es fragil dentro
 * de listas virtualizadas y con teclado abierto, y sigue funcionando igual en
 * web y en iOS.
 *
 * Desaparece de dos formas: cerrandola a mano (se recuerda) o cuando la
 * condicion `visible` deja de cumplirse porque el usuario ya hizo la accion.
 */
export function CoachMark({
  id,
  text,
  arrow = 'up',
  visible = true,
  onPress,
  style,
}: CoachMarkProps) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const dismissed = useAppStore((state) => state.dismissedGuides.includes(id));
  const dismissGuide = useAppStore((state) => state.dismissGuide);

  const reducirMovimiento = useReduceMotion();
  const debeLatir = visible && !dismissed && !reducirMovimiento;

  // Latido corto hacia el elemento senalado: llama la atencion sin animar
  // nada permanente que distraiga mientras se lee el feed.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Solo late mientras se ve. Una guia cerrada o que no toca no pinta nada,
    // pero su bucle seguia moviendo el valor y Android repintaba Explorar sin
    // parar (gasta bateria y Maestro nunca encuentra la pantalla quieta). Con
    // «reducir movimiento» la burbuja se queda fija en su sitio.
    if (!debeLatir) {
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, debeLatir]);

  if (!visible || dismissed) return null;

  const up = arrow === 'up';
  const translateY = pulse.interpolate({ inputRange: [0, 1], outputRange: [0, up ? -3 : 3] });

  const notch = (
    <View
      style={[
        styles.notch,
        up
          ? { borderBottomColor: colors.primary, borderBottomWidth: 8 }
          : { borderTopColor: colors.primary, borderTopWidth: 8 },
      ]}
    />
  );

  return (
    <Animated.View style={[styles.wrap, { transform: [{ translateY }] }, style]}>
      {up ? notch : null}
      <View style={[styles.bubble, { backgroundColor: colors.primary }]}>
        {/*
          La zona pulsable va DETRAS del contenido, nunca envolviendolo: en web
          cada Pressable es un <button> y el de cerrar quedaria anidado dentro
          del otro (HTML invalido, error de hidratacion).
        */}
        {onPress ? (
          <Pressable
            onPress={onPress}
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={t('coach.tapHereA11y', { texto: text })}
          />
        ) : null}

        <View style={styles.row} pointerEvents="none">
          <Feather name="arrow-up-right" size={16} color={colors.onPrimary} />
          <View style={styles.copy}>
            <Text variant="secondary" weight="800" color={colors.onPrimary}>
              {t('coach.tapHere')}
            </Text>
            <Text variant="secondary" color={colors.onPrimary} style={styles.text}>
              {text}
            </Text>
          </View>
        </View>

        <Pressable
          onPress={() => dismissGuide(id)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('coach.close')}
          style={styles.close}
        >
          <Feather name="x" size={15} color={colors.onPrimary} />
        </Pressable>
      </View>
      {up ? null : notch}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  notch: {
    width: 0,
    height: 0,
    alignSelf: 'flex-start',
    marginLeft: spacing.xl,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  bubble: {
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xxl,
    flexDirection: 'row',
    alignItems: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  copy: { flex: 1, gap: 2 },
  text: { lineHeight: 18, opacity: 0.9 },
  close: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
