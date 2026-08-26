import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Chip } from '@/components/Chip';
import { Text } from '@/components/Text';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { RecommendationRepository, type TopicDto } from '@/repositories/RecommendationRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  valor: string | null;
  alCambiar: (topicId: string | null) => void;
};

/**
 * La categoría PRINCIPAL del curso: una sola, de la taxonomía común.
 *
 * Es distinta de `SelectorDeTemas`, que elige varios: aquí se responde «¿dónde
 * se encuentra este curso?», y esa pregunta tiene una respuesta. Los demás
 * temas siguen eligiéndose aparte y sirven para recomendarlo.
 *
 * La categoría cuenta TAMBIÉN como tema del curso —el servidor la pone la
 * primera de `topic_ids`—, así que elegirla aquí no deja el curso sin
 * clasificar.
 *
 * Si la taxonomía no llega, el selector no se pinta y el curso se sigue
 * pudiendo editar. Un fallo en algo accesorio no puede dejar a nadie sin poder
 * guardar lo suyo.
 */
export function SelectorDeCategoriaPrincipal({ valor, alCambiar }: Props) {
  const { colors } = useAppTheme();
  const [temas, setTemas] = useState<TopicDto[]>([]);

  useEffect(() => {
    let vivo = true;
    RecommendationRepository.listTopics('curso')
      .then((lista) => {
        if (vivo) setTemas(lista);
      })
      .catch((error) => {
        console.warn('[curso] no se pudo cargar la taxonomía', error);
      });
    return () => {
      vivo = false;
    };
  }, []);

  if (temas.length === 0) return null;

  return (
    <View style={styles.raiz}>
      <Text variant="caption" weight="800" color={colors.textMuted} style={styles.etiqueta}>
        CATEGORÍA PRINCIPAL
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        Es donde se encuentra el curso. Elige una.
      </Text>
      {/*
        Blindado frente al gesto de cambiar de sección: sin esto, arrastrar la
        fila se llevaría la pantalla entera (ver `navigation/tabSwipe.tsx`).
      */}
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.fila}
          keyboardShouldPersistTaps="handled"
        >
          {temas.map((tema) => (
            <Chip
              key={tema.id}
              label={tema.name}
              selected={valor === tema.id}
              // Volver a pulsar la elegida la quita: sin eso, una categoría
              // puesta por error no se puede deshacer.
              onPress={() => alCambiar(valor === tema.id ? null : tema.id)}
            />
          ))}
        </ScrollView>
      </SinCambioDeSeccion>
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { gap: spacing.xs, marginBottom: spacing.lg },
  etiqueta: { letterSpacing: 1 },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
});
