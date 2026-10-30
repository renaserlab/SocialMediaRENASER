import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Pulsable } from '@/components/Pulsable';
import { ESCALA_AL_PULSAR, MUELLE } from '@/lib/movimiento';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  onPress: () => void;
  /** Hay algo que enviar. Sin ello el botón se ve, apagado, y no responde. */
  listo: boolean;
  /** Se está enviando: enseña la espera y no admite otro toque. */
  enviando?: boolean;
  accessibilityLabel: string;
  icono?: keyof typeof Feather.glyphMap;
  tamano?: number;
};

/**
 * El botón redondo de enviar de los compositores (comentarios y chat).
 *
 * Sustituye a la palabra «Enviar» en gris, que no parecía un botón. Está
 * siempre en su sitio —no aparece y desaparece moviendo el campo— y CRECE un
 * poco cuando hay algo que enviar: es la señal de que ya se puede pulsar, sin
 * depender solo del color.
 *
 * Mientras envía enseña un indicador en el mismo círculo, sin cambiar de
 * tamaño, y se anuncia como ocupado.
 */
export function BotonDeEnviar({
  onPress,
  listo,
  enviando = false,
  accessibilityLabel,
  icono = 'arrow-up',
  tamano = 40,
}: Props) {
  const { colors } = useAppTheme();
  const reducir = useReducedMotion();
  const presencia = useSharedValue(listo ? 1 : 0.86);

  useEffect(() => {
    const destino = listo ? 1 : 0.86;
    presencia.value = reducir ? destino : withSpring(destino, MUELLE);
  }, [listo, presencia, reducir]);

  const animado = useAnimatedStyle(() => ({ transform: [{ scale: presencia.value }] }));
  const apagado = !listo || enviando;
  /*
    APAGADO CON COLOR. El apagado era el mismo botón al 35 %: en negro daba un
    gris, pero con un color de resalte en `accion` (el rosa del 27/10) salía
    un tono lavado que parecía otro estado. Por eso el apagado es `enviarApagado` (el gris `disabled`), opaco.
    Sin ese token, el botón al 35 % de siempre.
  */
  const grisApagado = !listo && colors.enviarApagado ? colors.enviarApagado : null;

  return (
    <Animated.View style={animado}>
      <Pulsable
        onPress={onPress}
        disabled={apagado}
        escala={ESCALA_AL_PULSAR.icono}
        haptica="ligera"
        opacidad={listo || grisApagado ? 1 : 0.35}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: apagado, busy: enviando }}
        style={[
          styles.boton,
          {
            width: tamano,
            height: tamano,
            borderRadius: tamano / 2,
            backgroundColor: grisApagado ?? colors.accion,
          },
        ]}
      >
        {enviando ? (
          <ActivityIndicator size="small" color={colors.sobreAccion} />
        ) : (
          <Feather
            name={icono}
            size={Math.round(tamano * 0.5)}
            color={grisApagado ? (colors.sobreEnviarApagado ?? colors.sobreAccion) : colors.sobreAccion}
          />
        )}
      </Pulsable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  boton: { alignItems: 'center', justifyContent: 'center' },
});
