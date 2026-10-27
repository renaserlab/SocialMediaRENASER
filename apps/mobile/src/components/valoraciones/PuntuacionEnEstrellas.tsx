import React from 'react';
import { StyleSheet, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { Text } from '@/components/Text';
import { ESTRELLAS, etiquetaDePuntuacion } from '@/lib/valoracionesDeCurso';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type Props = {
  /** Del 1 al 5. */
  valor: number;
  tamano?: number;
  /** Si ademas del dibujo se escribe «N de 5». Por defecto si. */
  conTexto?: boolean;
};

/**
 * Una puntuacion, DIBUJADA Y DICHA.
 *
 * LAS ESTRELLAS SOLAS NO VALEN. Cuatro siluetas iguales que solo se distinguen
 * por estar rellenas o no es informacion que viaja en la forma y en el color, y
 * nada mas; quien usa un lector de pantalla oiria cinco iconos sin nombre, y
 * quien no distingue bien los contornos tendria que contarlos. Por eso el
 * numero va escrito al lado —«4 de 5»— y ademas es lo unico que se anuncia: el
 * dibujo queda marcado como decorativo para que no se lea dos veces.
 *
 * Relleno y contorno son DOS ICONOS DISTINTOS, no el mismo con otro color, por
 * lo mismo que en `AccionDePublicacion`: Feather solo tiene contornos, asi que
 * la diferencia la pone `MaterialCommunityIcons`, que viene en el mismo
 * paquete.
 */
export function PuntuacionEnEstrellas({ valor, tamano = 14, conTexto = true }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const etiqueta = etiquetaDePuntuacion(valor, t);

  return (
    <View style={styles.fila} accessible accessibilityLabel={etiqueta}>
      <View
        style={styles.estrellas}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {ESTRELLAS.map((n) => (
          <MaterialCommunityIcons
            key={n}
            name={n <= valor ? 'star' : 'star-outline'}
            size={tamano}
            color={n <= valor ? colors.text : colors.textMuted}
          />
        ))}
      </View>
      {conTexto ? (
        <Text variant="caption" color={colors.textMuted}>
          {etiqueta}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  estrellas: { flexDirection: 'row', alignItems: 'center' },
});
