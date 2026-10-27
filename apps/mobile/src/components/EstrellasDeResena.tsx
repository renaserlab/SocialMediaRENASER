import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Text } from '@/components/Text';
import { ESTRELLAS } from '@/lib/resenasDeProductos';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Una fila de cinco estrellas: para puntuar, o para leer una puntuación.
 *
 * SIN PUNTUACIÓN NO PINTA NADA, y quien la usa escribe entonces que todavía no
 * hay valoraciones. Cinco estrellas vacías se leen como «lo valoraron mal», y
 * no es eso: es que no lo valoró nadie.
 *
 * CADA ESTRELLA ES UN BOTÓN DE 44 PUNTOS cuando se puede puntuar, que es el
 * área táctil mínima, y lleva su etiqueta hablada («3 de 5»).
 */
type Props = {
  valor: number | null;
  /** Sin esto son de solo lectura. */
  onElegir?: (puntuacion: number) => void;
  tamano?: number;
  /** Para el lector de pantalla: qué se está puntuando. */
  etiqueta?: string;
  /** «de 5», traducido por quien la usa. */
  sufijo?: string;
};

export function EstrellasDeResena({
  valor,
  onElegir,
  tamano = 20,
  etiqueta,
  sufijo,
}: Props) {
  const { colors } = useAppTheme();
  const editable = typeof onElegir === 'function';

  if (valor === null && !editable) return null;

  return (
    <View
      style={styles.fila}
      accessibilityRole={editable ? 'radiogroup' : 'text'}
      accessibilityLabel={
        etiqueta !== undefined && valor !== null
          ? `${etiqueta}: ${valor} ${sufijo ?? ''}`.trim()
          : etiqueta
      }
    >
      {ESTRELLAS.map((n) => {
        const encendida = valor !== null && n <= valor;
        const icono = (
          <Feather
            name="star"
            size={tamano}
            color={encendida ? colors.text : colors.textMuted}
          />
        );
        if (!editable) return <View key={n}>{icono}</View>;
        return (
          <Pressable
            key={n}
            onPress={() => onElegir(n)}
            accessibilityRole="radio"
            accessibilityState={{ selected: valor === n }}
            accessibilityLabel={`${n} ${sufijo ?? ''}`.trim()}
            hitSlop={8}
            style={styles.toque}
          >
            {icono}
          </Pressable>
        );
      })}
      {valor !== null && sufijo !== undefined ? (
        <Text variant="caption" color="muted">
          {`${valor} ${sufijo}`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  // 44 de alto: el área táctil mínima.
  toque: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
