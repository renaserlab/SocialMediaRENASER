import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Text } from '@/components/Text';
import { partirEnEtiquetas } from '@/lib/etiquetasEnTexto';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { PersonaEtiquetada } from '@/types';

type Props = {
  cuerpo: string;
  /** A quien etiqueta la publicacion. Sin nadie, no se pinta la fila. */
  menciones?: PersonaEtiquetada[];
  /** Numero maximo de lineas del cuerpo (el muro recorta, el detalle no). */
  numberOfLines?: number;
};

/**
 * El texto de una publicacion, con sus etiquetas y su gente tocables.
 *
 * POR QUE LAS MENCIONES VAN EN UNA FILA APARTE Y NO DENTRO DEL TEXTO. Porque
 * no estan dentro del texto: se eligen de una lista al publicar y viven en su
 * propia tabla. Inyectar «@bruno» en mitad de una frase que nadie escribio asi
 * cambiaria lo que la persona dijo, y ademas dejaria de cuadrar en cuanto
 * alguien editara el cuerpo.
 *
 * DEGRADA SOLO: sin la migracion 0031 no llegan etiquetas (pero el texto se
 * pinta igual, con sus almohadillas, porque el reconocedor trabaja sobre el
 * cuerpo) y sin la 0032 no llegan menciones y la fila no aparece.
 */
export function TextoDePublicacion({ cuerpo, menciones, numberOfLines }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();

  const trozos = useMemo(() => partirEnEtiquetas(cuerpo ?? ''), [cuerpo]);
  const etiquetados = menciones ?? [];

  return (
    <View style={styles.raiz}>
      {cuerpo ? (
        <Text variant="body" style={styles.cuerpo} numberOfLines={numberOfLines}>
          {trozos.map((trozo, indice) =>
            trozo.tipo === 'texto' ? (
              // La clave es el indice a proposito: los trozos no se reordenan
              // nunca, se recalculan enteros cuando cambia el cuerpo.
              <Text key={indice} variant="body">
                {trozo.valor}
              </Text>
            ) : (
              <Text
                key={indice}
                variant="body"
                weight="700"
                color={colors.mencion}
                accessibilityRole="link"
                accessibilityLabel={`Ver publicaciones de #${trozo.valor}`}
                onPress={() => router.push(`/hashtag/${encodeURIComponent(trozo.valor)}` as never)}
              >
                #{trozo.valor}
              </Text>
            ),
          )}
        </Text>
      ) : null}

      {etiquetados.length > 0 ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.menciones}>
          Con{' '}
          {etiquetados.map((persona, indice) => (
            <Text key={persona.id} variant="secondary">
              <Text
                variant="secondary"
                weight="700"
                color={colors.mencion}
                accessibilityRole="link"
                accessibilityLabel={`Ver el perfil de ${persona.nombre}`}
                /*
                  `irAlPerfil` y no `router.push`: pide el perfil y sus
                  publicaciones en el MISMO gesto, asi que viajan durante la
                  animacion de entrada en vez de empezar cuando la pantalla ya
                  esta montada y vacia. Hay una prueba que lo vigila.
                */
                onPress={() => irAlPerfil(router, persona.id)}
              >
                {persona.usuario ? `@${persona.usuario}` : persona.nombre}
              </Text>
              {/*
                El separador va fuera del trozo tocable: si entrara dentro, la
                coma seria parte del enlace y tocarla abriria un perfil.
              */}
              {indice < etiquetados.length - 1 ? ', ' : ''}
            </Text>
          ))}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Sin margenes propios: el espaciado lo pone quien lo coloca (la tarjeta del
  // muro y el detalle usan el suyo). Un margen aqui se sumaria al de fuera y
  // desplazaria el texto solo en uno de los dos sitios.
  raiz: { gap: spacing.xs },
  cuerpo: {},
  menciones: { lineHeight: 18 },
});
