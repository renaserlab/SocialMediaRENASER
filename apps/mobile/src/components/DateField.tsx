import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

import { fromDisplay, toDisplay, type DateFieldProps } from './DateField.types';

/**
 * Campo de fecha con calendario (iOS / Android).
 *
 * En web hay una variante que usa el selector nativo del navegador; ver
 * `DateField.web.tsx`. Ambas escriben el mismo dd/mm/aaaa, así que la
 * validación del formulario no cambia.
 */
export function DateField({
  label,
  value,
  onChange,
  placeholder = 'dd/mm/aaaa',
  minDate,
}: DateFieldProps) {
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);

  const current = fromDisplay(value) ?? new Date();

  return (
    <View style={styles.container}>
      {label ? (
        <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text>
      ) : null}

      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.field, { borderColor: colors.border, backgroundColor: colors.background }]}
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${value || 'sin fecha'}` : 'Elegir fecha'}
      >
        <Text style={{ color: value ? colors.text : colors.textMuted, fontSize: 14 }}>
          {value || placeholder}
        </Text>
        <Feather name="calendar" size={18} color={colors.textMuted} />
      </Pressable>

      {open ? (
        <DateTimePicker
          value={current}
          mode="date"
          /*
            El calendario no ofrece los dias anteriores a `minDate`: salen
            atenuados y no se pueden tocar. Es cortesia, no seguridad —quien
            decide es el servidor con su reloj—, pero un selector que deja
            elegir el martes pasado para despues decir que no vale se equivoca
            a proposito.
          */
          minimumDate={minDate}
          // En Android el dialogo es del sistema y se cierra solo; en iOS el
          // selector va embebido, por eso se oculta al confirmar.
          display="default"
          onChange={(event, date) => {
            setOpen(false);
            if (event.type === 'set' && date) onChange(toDisplay(date));
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
