import React, { useState } from 'react';
import { StyleSheet, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type InputProps = TextInputProps & {
  label?: string;
  error?: string;
  disabled?: boolean;
  containerStyle?: ViewStyle;
  /**
   * `pastilla` para los redactores (chat, comentarios): los extremos
   * redondos y un fondo suave lo distinguen de un campo de formulario, que es
   * una `caja`. Mismo componente, mismo foco, mismo error.
   */
  forma?: 'caja' | 'pastilla';
};

export function Input({
  label,
  error,
  disabled = false,
  containerStyle,
  forma = 'caja',
  onFocus,
  onBlur,
  style,
  ...props
}: InputProps) {
  const { colors } = useAppTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={[styles.container, containerStyle]}>
      {label && (
        <Text style={[styles.label, { color: error ? colors.danger : colors.textMuted }]}>
          {label}
        </Text>
      )}
      <View
        style={[
          styles.inputWrapper,
          forma === 'pastilla' && styles.pastilla,
          {
            borderColor: error ? colors.danger : focused ? colors.primary : colors.border,
            backgroundColor: forma === 'pastilla' ? colors.surfaceAlt : colors.background,
            opacity: disabled ? 0.5 : 1,
          },
        ]}
      >
        <TextInput
          editable={!disabled}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          placeholderTextColor={colors.textMuted}
          style={[styles.input, { color: colors.text }, style]}
          accessibilityLabel={label || props.placeholder}
          {...props}
        />
      </View>
      {error && (
        <View style={styles.errorContainer} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Feather name="alert-circle" size={14} color={colors.danger} />
          <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
    width: '100%',
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
  },
  inputWrapper: {
    minHeight: 48,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  pastilla: {
    borderRadius: 22,
    paddingHorizontal: spacing.lg,
  },
  input: {
    fontSize: 14,
    padding: 0,
    minHeight: 44,
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  errorText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
