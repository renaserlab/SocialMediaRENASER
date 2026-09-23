import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { ESTRELLAS, etiquetaDePuntuacion } from '@/lib/valoracionesDeCurso';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type Props = {
  /** 0 mientras no se ha elegido nada. */
  valor: number;
  onChange: (valor: number) => void;
  disabled?: boolean;
};

/**
 * Elegir una puntuacion del 1 al 5.
 *
 * ES UN GRUPO DE OPCIONES EXCLUYENTES, y se declara como tal: el contenedor es
 * `radiogroup` y cada estrella un `radio` que se llama «N de 5». Sin eso, un
 * lector de pantalla anuncia cinco botones sin nombre y sin decir cual esta
 * elegido: cinco veces «botón», y la unica pista de lo que se acaba de tocar
 * seria el relleno del dibujo.
 *
 * CADA ESTRELLA MIDE 44x44 aunque el icono sea de 28. Es el minimo que se
 * puede pulsar con fiabilidad, y con cinco objetivos pegados el margen de
 * error importa mas que en cualquier otro sitio: fallar aqui no es no acertar,
 * es puntuar otra cosa. El `hitSlop` amplia todavia un poco mas la zona sin
 * separar los dibujos.
 */
export function SelectorDeEstrellas({ valor, onChange, disabled = false }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  return (
    <View>
      <Text variant="secondary" color={colors.textMuted}>
        {t('valoracion.tuPuntuacion')}
      </Text>
      <View
        style={styles.grupo}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('valoracion.grupoDeEstrellas')}
      >
        {ESTRELLAS.map((n) => {
          const elegida = n <= valor;
          return (
            <Pressable
              key={n}
              onPress={() => onChange(n)}
              disabled={disabled}
              hitSlop={8}
              style={styles.estrella}
              accessibilityRole="radio"
              accessibilityLabel={etiquetaDePuntuacion(n, t)}
              // `checked` para el lector de pantalla, `selected` para el foco:
              // los dos hacen falta y no todos los lectores leen el mismo.
              accessibilityState={{ checked: n === valor, selected: n === valor, disabled }}
            >
              <MaterialCommunityIcons
                name={elegida ? 'star' : 'star-outline'}
                size={28}
                color={elegida ? colors.text : colors.textMuted}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grupo: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs },
  // 44x44 es el minimo pulsable; el icono ocupa 28 y el resto es holgura.
  estrella: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
