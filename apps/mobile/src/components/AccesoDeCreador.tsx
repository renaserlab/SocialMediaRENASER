import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  icono: keyof typeof Feather.glyphMap;
  titulo: string;
  detalle: string;
  onPress: () => void;
};

/**
 * La puerta para CREAR, en la pantalla donde se busca lo mismo.
 *
 * POR QUE EXISTE. Crear un evento, un curso o un producto solo se podia desde
 * rincones del perfil —«Mis eventos» incluso habia quedado sin ningun enlace—,
 * y nadie busca «organizar un evento» dentro de su propio perfil: lo busca en
 * Eventos. Esta fila va debajo del buscador de Eventos, Cursos y Productos.
 *
 * UNA FILA Y NO UN ICONO EN LA CABECERA: la cabecera compartida admite un solo
 * icono a la derecha y ya lo usan la biblioteca y la bolsa. Un icono suelto,
 * ademas, no dice «esto es para crear».
 *
 * SOLO SE PINTA CON SESION: sin ella el destino pediria iniciar sesion, y eso
 * lo decide quien la coloca.
 */
export function AccesoDeCreador({ icono, titulo, detalle, onPress }: Props) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={titulo}
      accessibilityHint={detalle}
      style={({ pressed }) => [
        styles.fila,
        { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={[styles.icono, { backgroundColor: colors.surfaceAlt }]}>
        <Feather name={icono} size={16} color={colors.text} />
      </View>
      <View style={styles.textos}>
        <Text variant="secondary" weight="700">
          {titulo}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {detalle}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  icono: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textos: { flex: 1, gap: 2 },
});
