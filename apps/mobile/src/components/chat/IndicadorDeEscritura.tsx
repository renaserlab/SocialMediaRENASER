import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import { PuntosDeEscritura } from '@/components/chat/PuntosDeEscritura';
import { Text } from '@/components/Text';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** En la web `Animated` no tiene hilo nativo y avisa por consola si se le pide. */
const HILO_NATIVO = Platform.OS !== 'web';

type Props = {
  /** La frase ya traducida: «Ana está escribiendo». */
  frase: string;
};

/**
 * «Está escribiendo»: una burbuja como las de quien escribe, con tres puntos
 * que hacen la ola y, al lado, quién.
 *
 * QUE SE VEA (12/10/2026). La primera versión era una pastilla gris de letra
 * pequeña y pasó inadvertida en el teléfono: «se ve muy poco llamativa». Ahora
 * es una burbuja del tamaño de un mensaje, con los puntos y la frase en el
 * verde de «en marcha», y entra creciendo desde su esquina, como un mensaje
 * que llega.
 *
 * SOLO EXISTE MIENTRAS ALGUIEN ESCRIBE. Quien lo usa lo monta cuando hay
 * alguien y lo desmonta cuando no: en reposo no queda nada animado en la
 * pantalla. La entrada corre una vez, al montar.
 *
 * VA DENTRO DE LA LISTA, al final, como un mensaje más: ocupa su sitio y no
 * tapa nada. La primera versión flotaba encima y tapaba la hora y las marcas
 * del último mensaje. No recibe toques.
 */
export function IndicadorDeEscritura({ frase }: Props) {
  const { colors } = useAppTheme();
  const reduceMotion = useReduceMotion();
  const entrada = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) return;
    const llegada = Animated.timing(entrada, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.back(1.6)),
      useNativeDriver: HILO_NATIVO,
    });
    llegada.start();
    return () => llegada.stop();
  }, [entrada, reduceMotion]);

  return (
    <Animated.View
      pointerEvents="none"
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={frase}
      style={[
        styles.burbuja,
        { backgroundColor: colors.surface, borderColor: colors.border, shadowColor: colors.text },
        {
          opacity: entrada,
          transform: [
            { scale: entrada.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
            { translateY: entrada.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
          ],
        },
      ]}
    >
      <PuntosDeEscritura color={colors.success} size={8} />
      <View style={styles.texto}>
        <Text numberOfLines={1} weight="700" color={colors.success} style={styles.frase}>
          {frase}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  burbuja: {
    // En el flujo de la lista, a la izquierda, donde llegan los mensajes.
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    maxWidth: '86%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    // La misma forma que la burbuja de un mensaje recibido.
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    // Se despega del fondo del chat, que puede ser una foto.
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  texto: { flexShrink: 1 },
  frase: { fontSize: 14 },
});
