import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Text';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

import { type TimeFieldProps } from './TimeField.types';

/**
 * Campo de hora en web.
 *
 * Usa `<input type="time">` por lo mismo que la fecha: el navegador ya trae su
 * propio selector, mejor integrado que uno dibujado a mano, y así no se carga
 * el módulo nativo, que aquí no funciona.
 *
 * `<input type="time">` habla en HH:MM, que es justo cómo se guarda el valor,
 * de modo que no hace falta convertir nada.
 */
export function TimeField({ label, value, onChange, placeholder = '--:--' }: TimeFieldProps) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.container}>
      {label ? <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text> : null}

      <input
        type="time"
        value={value}
        placeholder={placeholder}
        aria-label={label ?? 'Hora'}
        onChange={(event) => onChange(event.target.value)}
        style={{
          width: '100%',
          minHeight: 48,
          boxSizing: 'border-box',
          borderRadius: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: colors.border,
          backgroundColor: colors.background,
          color: colors.text,
          paddingLeft: 16,
          paddingRight: 12,
          fontSize: 14,
          fontFamily: 'inherit',
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs, width: '100%' },
  label: { fontSize: 12, fontWeight: '600' },
});
