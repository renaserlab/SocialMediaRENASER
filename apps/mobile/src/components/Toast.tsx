import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type ToastProps = {
  message: string;
  visible: boolean;
  onHide?: () => void;
  duration?: number;
  icon?: keyof typeof Feather.glyphMap;
  /** Salida opcional: «Ver lista». Sin ella el aviso es el de siempre. */
  accion?: {
    etiqueta: string;
    alPulsar: () => void;
  };
};

export function Toast({
  message,
  visible,
  onHide,
  duration = 3000,
  icon = 'info',
  accion,
}: ToastProps) {
  const { colors } = useAppTheme();
  const slideAnim = useRef(new Animated.Value(-100)).current;

  useEffect(() => {
    if (visible) {
      // Slide down
      Animated.spring(slideAnim, {
        toValue: 50, // Position from top
        useNativeDriver: true,
        tension: 50,
        friction: 8,
      }).start();

      const timer = setTimeout(() => {
        // Slide up
        Animated.timing(slideAnim, {
          toValue: -100,
          duration: 250,
          useNativeDriver: true,
        }).start(() => {
          onHide?.();
        });
      }, duration);

      return () => clearTimeout(timer);
    } else {
      slideAnim.setValue(-100);
    }
  }, [visible, slideAnim, duration, onHide]);

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{ translateY: slideAnim }],
          backgroundColor: colors.primary,
          borderColor: colors.border,
        },
      ]}
    >
      <View style={styles.content}>
        <Feather name={icon} size={18} color={colors.onPrimary} style={styles.icon} />
        <Text style={[styles.message, { color: colors.onPrimary }]}>{message}</Text>
        {/*
          La accion, cuando la hay. Al pulsarla se hace lo suyo y el aviso se
          va: dejarlo puesto despues de haber navegado lo convierte en un
          cartel encima de la pantalla nueva.

          `hitSlop` porque el texto es pequeño y el area de la etiqueta sola no
          llega a lo que se puede pulsar con comodidad.
        */}
        {accion ? (
          <Pressable
            onPress={() => {
              accion.alPulsar();
              onHide?.();
            }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel={accion.etiqueta}
            style={styles.accion}
          >
            <Text style={[styles.etiquetaDeAccion, { color: colors.onPrimary }]}>
              {accion.etiqueta}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 9999,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: spacing.sm,
  },
  message: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  accion: {
    marginLeft: spacing.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  etiquetaDeAccion: {
    fontSize: 13,
    fontWeight: '800',
    // Subrayada para que se lea como algo que se pulsa y no como mas texto del
    // aviso: sobre el color primario un boton sin borde no se distingue solo.
    textDecorationLine: 'underline',
  },
});
