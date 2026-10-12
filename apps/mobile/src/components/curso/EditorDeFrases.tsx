import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { moviendo } from '@/lib/asistenteDeCurso';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  etiqueta: string;
  /** Una frase que explique PARA QUÉ sirve la lista, no qué es. */
  ayuda: string;
  valores: string[];
  alCambiar: (valores: string[]) => void;
  marcador: string;
  /** Tope, por si alguien se anima. El servidor aplica el suyo igualmente. */
  maximo?: number;
};

/**
 * Una lista de frases que se escribe línea a línea y se puede reordenar.
 *
 * La usan «lo que aprenderás», «para quién es» y «qué necesitas antes»: las
 * tres son lo mismo —una lista corta y ordenada— y darles tres editores
 * distintos sería tres sitios donde arreglar el mismo fallo.
 *
 * EL ORDEN IMPORTA y por eso se puede cambiar. En la ficha del curso estas
 * frases se leen de arriba abajo y la primera es la que más gente lee.
 *
 * No hay `ScrollView` horizontal aquí a propósito: las flechas de subir y bajar
 * son botones. Una fila que se arrastra dentro de las pestañas necesitaría
 * `SinCambioDeSeccion`, y para reordenar cuatro frases un botón es más claro
 * que un gesto que además compite con el carrusel de secciones.
 */
export function EditorDeFrases({
  etiqueta,
  ayuda,
  valores,
  alCambiar,
  marcador,
  maximo = 8,
}: Props) {
  const { colors } = useAppTheme();
  const [borrador, setBorrador] = useState('');

  const anadir = () => {
    const frase = borrador.trim();
    if (!frase || valores.length >= maximo) return;
    // Repetir una frase no aporta nada y en la ficha se ve como un error.
    if (valores.some((v) => v.trim().toLowerCase() === frase.toLowerCase())) {
      setBorrador('');
      return;
    }
    alCambiar([...valores, frase]);
    setBorrador('');
  };

  const quitar = (indice: number) => {
    alCambiar(valores.filter((_, i) => i !== indice));
  };

  const mover = (desde: number, hacia: number) => {
    const siguiente = moviendo(valores, desde, hacia);
    if (siguiente !== valores) alCambiar(siguiente);
  };

  const lleno = valores.length >= maximo;

  return (
    <View style={styles.raiz}>
      <Text variant="caption" weight="800" color={colors.textMuted} style={styles.etiqueta}>
        {etiqueta.toUpperCase()}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {ayuda}
      </Text>

      {valores.map((frase, indice) => (
        <View key={`${frase}-${indice}`} style={[styles.fila, { borderColor: colors.border }]}>
          <Feather name="check" size={14} color={colors.text} />
          <Text variant="secondary" style={styles.frase}>
            {frase}
          </Text>
          <Pressable
            onPress={() => mover(indice, indice - 1)}
            disabled={indice === 0}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Subir «${frase}»`}
            style={{ opacity: indice === 0 ? 0.3 : 1 }}
          >
            <Feather name="chevron-up" size={16} color={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={() => mover(indice, indice + 1)}
            disabled={indice === valores.length - 1}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Bajar «${frase}»`}
            style={{ opacity: indice === valores.length - 1 ? 0.3 : 1 }}
          >
            <Feather name="chevron-down" size={16} color={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={() => quitar(indice)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Quitar «${frase}»`}
          >
            <Feather name="x" size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      ))}

      {lleno ? (
        <Text variant="caption" color={colors.textMuted}>
          Máximo {maximo}. Quita una para escribir otra.
        </Text>
      ) : (
        <View style={styles.alta}>
          <Input
            value={borrador}
            onChangeText={setBorrador}
            placeholder={marcador}
            placeholderTextColor={colors.textMuted}
            onSubmitEditing={anadir}
            returnKeyType="done"
            containerStyle={styles.campo}
            style={{ color: colors.text }}
          />
          <Pressable
            onPress={anadir}
            disabled={!borrador.trim()}
            accessibilityRole="button"
            accessibilityLabel={`Agregar a ${etiqueta}`}
            style={({ pressed }) => [
              styles.anadir,
              {
                borderColor: colors.border,
                backgroundColor: colors.surface,
                opacity: !borrador.trim() ? 0.4 : pressed ? 0.7 : 1,
              },
            ]}
          >
            <Feather name="plus" size={18} color={colors.text} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { gap: spacing.sm, marginBottom: spacing.lg },
  etiqueta: { letterSpacing: 1 },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  frase: { flex: 1 },
  alta: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  campo: { flex: 1 },
  anadir: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
  },
});
