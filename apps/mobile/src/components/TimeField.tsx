import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

import { fromDisplayTime, toDisplayTime, toHumanTime, type TimeFieldProps } from './TimeField.types';

/**
 * Campo de hora con reloj del sistema (iOS / Android).
 *
 * Hermano de `DateField`: misma forma, mismo comportamiento y misma variante
 * aparte para web (`TimeField.web.tsx`), donde se usa el selector del
 * navegador. Ambas escriben HH:MM, así que quien lo consume no distingue.
 */
export function TimeField({ label, value, onChange, placeholder = '--:--' }: TimeFieldProps) {
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);

  const current = fromDisplayTime(value) ?? new Date();

  return (
    <View style={styles.container}>
      {label ? <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text> : null}

      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.field, { borderColor: colors.border, backgroundColor: colors.background }]}
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${value || 'sin hora'}` : 'Elegir hora'}
      >
        <Text style={{ color: value ? colors.text : colors.textMuted, fontSize: 14 }}>
          {/* Se guarda en 24 h y se lee en el formato de siempre. */}
          {value ? toHumanTime(value) : placeholder}
        </Text>
        <Feather name="clock" size={18} color={colors.textMuted} />
      </Pressable>

      {open ? (
        <DateTimePicker
          value={current}
          mode="time"
          display="default"
          onChange={(event, date) => {
            setOpen(false);
            if (event.type === 'set' && date) onChange(toDisplayTime(date));
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs, width: '100%' },
  label: { fontSize: 12, fontWeight: '600' },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    minHeight: 48,
  },
});
