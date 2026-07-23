import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type InlineErrorProps = {
  /** null o cadena vacia: no se pinta nada. */
  message?: string | null;
};

/**
 * Error mostrado DENTRO de la propia hoja, no en un dialogo aparte.
 *
 * En iOS un Modal no se puede presentar encima de otro Modal. Como los sheets
 * de la app son Modales, cualquier `notify()` lanzado desde dentro de uno se
 * quedaba invisible: el usuario pulsaba "Publicar", no pasaba nada visible y no
 * habia forma de saber que habia fallado. Aqui el mensaje vive en el mismo
 * arbol que el formulario, asi que siempre se ve.
 *
 * Lleva icono ademas del color: el rojo nunca es el unico portador del mensaje.
 */
export function InlineError({ message }: InlineErrorProps) {
  const { colors } = useAppTheme();
  if (!message) return null;

  return (
    <View
      style={[styles.box, { borderColor: colors.danger, backgroundColor: colors.backgroundAlt }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Feather name="alert-circle" size={16} color={colors.danger} />
      <Text variant="secondary" color={colors.danger} style={styles.text}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  text: { flex: 1, lineHeight: 18 },
});
