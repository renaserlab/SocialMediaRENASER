import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

import { fromIso, toIso, toIsoDate, type DateFieldProps } from './DateField.types';

/**
 * Campo de fecha en web.
 *
 * Usa `<input type="date">`: el navegador ya trae su propio calendario, mejor
 * integrado (teclado, idioma, accesibilidad) que cualquiera que dibujemos, y
 * evita cargar el módulo nativo, que no funciona aquí.
 */
export function DateField({
  label,
  value,
  onChange,
  placeholder = 'dd/mm/aaaa',
  minDate,
}: DateFieldProps) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.container}>
      {label ? (
        <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text>
      ) : null}

      {/*
        `min` atenua los dias anteriores en el calendario del navegador. Es
        cortesia, no seguridad: quien decide si una fecha vale es el servidor,
        con SU reloj. Pero un selector que deja elegir el martes pasado para
        despues decir que no vale se equivoca a proposito.
      */}
      <input
        type="date"
        value={toIso(value)}
        placeholder={placeholder}
        min={minDate ? toIsoDate(minDate) : undefined}
        aria-label={label ?? 'Fecha'}
        onChange={(event) => onChange(fromIso(event.target.value))}
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
          // El navegador hereda la fuente del sistema si no se fuerza.
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
