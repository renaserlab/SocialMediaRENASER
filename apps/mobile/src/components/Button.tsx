import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

type ButtonProps = {
  label: string;
  /**
   * SI DEVUELVE UNA PROMESA, el botón queda ocupado hasta que termina: enseña
   * la espera y no admite otro toque. Es el cerrojo común contra el doble
   * envío; pasar la función asíncrona tal cual (`onPress={guardar}`) basta.
   * Quien ya lleva su propio cerrojo (`() => void guardar()`) sigue igual, y
   * lo que devuelva sin ser una promesa se ignora.
   */
  onPress: () => unknown;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  icon?: keyof typeof Feather.glyphMap;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
  icon,
}: ButtonProps) {
  const { colors } = useAppTheme();
  const primary = variant === 'primary';
  const ghost = variant === 'ghost';

  // El cerrojo va en una referencia: se cierra en el mismo toque, antes de que
  // React vuelva a pintar. El estado solo sirve para enseñarlo.
  const enCurso = useRef(false);
  const montado = useRef(true);
  const [pendiente, setPendiente] = useState(false);
  useEffect(
    () => () => {
      montado.current = false;
    },
    [],
  );

  const ocupado = loading || pendiente;
  const tinta = primary ? colors.onPrimary : colors.text;

  const pulsar = () => {
    if (enCurso.current) return;
    const resultado = onPress();
    if (!resultado || typeof (resultado as { then?: unknown }).then !== 'function') return;
    enCurso.current = true;
    setPendiente(true);
    const soltar = () => {
      enCurso.current = false;
      if (montado.current) setPendiente(false);
    };
    (resultado as Promise<unknown>).then(soltar, (error: unknown) => {
      soltar();
      // El fallo sigue siendo de quien llamó: no se traga.
      throw error;
    });
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || ocupado, busy: ocupado }}
      onPress={pulsar}
      disabled={disabled || ocupado}
      style={({ pressed }: { pressed: boolean }) => [
        styles.base,
        {
          backgroundColor: primary ? colors.primary : ghost ? 'transparent' : colors.background,
          borderColor: primary ? colors.primary : colors.border,
          borderWidth: ghost ? 0 : 1,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
          // Se hunde un poco al tocarlo. Es un cambio de estado, no una
          // animación: no hay nada que reducir.
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {/*
        El texto NO se quita mientras espera: se vuelve transparente y el
        indicador va encima. Así el botón no cambia de ancho ni de alto.
      */}
      <View style={[styles.contenido, ocupado && styles.oculto]}>
        {icon && <Feather name={icon} size={18} color={tinta} style={styles.icon} />}
        <Text style={[styles.label, { color: tinta }]}>{label}</Text>
      </View>
      {ocupado ? (
        <View style={styles.espera} pointerEvents="none">
          <ActivityIndicator color={tinta} size="small" />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  contenido: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 1,
  },
  oculto: {
    opacity: 0,
  },
  espera: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  icon: {
    marginRight: spacing.sm,
  },
});
