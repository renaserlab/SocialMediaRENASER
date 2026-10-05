import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { empujarNivel } from '@/lib/notaDeVoz';

/** Cuántas barras caben: unos cinco segundos a cinco lecturas por segundo. */
const BARRAS = 26;
const ALTO = 22;
/** Una barra nunca desaparece del todo: en silencio queda una línea de puntos. */
const MINIMO = 0.14;

type Props = {
  /**
   * El nivel del micrófono, de 0 a 1, en la última lectura. `null` cuando la
   * plataforma no mide: entonces NO se dibuja una onda.
   */
  nivel: number | null;
  /**
   * Cambia en cada lectura del grabador (es el reloj de la grabación). Hace
   * falta porque dos lecturas seguidas pueden traer el mismo nivel, y aun así
   * cada una es una muestra nueva que tiene que entrar en la onda.
   */
  latido: number;
  color: string;
};

/**
 * La onda de la grabación.
 *
 * CUANDO HAY MEDICIÓN ES LA VOZ DE VERDAD: cada barra es una lectura del
 * micrófono y la fila se desplaza hacia la izquierda según se habla. Con el
 * micrófono tapado las barras se quedan planas, que es exactamente lo que
 * tiene que pasar —y lo que permite darse cuenta de que no se está oyendo—.
 *
 * CUANDO NO LA HAY (web, o un teléfono que no mide) NO SE FINGE. En vez de una
 * onda inventada se pintan tres puntos que respiran: dicen «grabando» sin
 * pretender que representan el sonido.
 *
 * RENDIMIENTO. Llegan cinco lecturas por segundo —las mismas que ya movían el
 * reloj—, no una por fotograma. Entre lectura y lectura la altura se desliza
 * en el hilo de la interfaz; JavaScript no pinta nada a alta frecuencia.
 */
export function OndaDeVoz({ nivel, latido, color }: Props) {
  const [historia, setHistoria] = useState<number[]>([]);

  useEffect(() => {
    if (nivel === null) return;
    setHistoria((previa) => empujarNivel(previa, nivel, BARRAS));
    // `latido` y no `nivel`: cada lectura cuenta, aunque repita valor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latido]);

  if (nivel === null) return <ActividadDecorativa color={color} />;

  // Las barras se alinean a la DERECHA: lo último que se ha dicho entra por
  // ahí y lo anterior se va yendo hacia la izquierda.
  const huecos = BARRAS - historia.length;
  return (
    <View
      style={styles.onda}
      // Decorativa para el lector de pantalla: «Grabando» y el reloj ya lo dicen.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: BARRAS }, (_, indice) => (
        <Barra
          key={indice}
          nivel={indice < huecos ? 0 : (historia[indice - huecos] ?? 0)}
          color={color}
        />
      ))}
    </View>
  );
}

function Barra({ nivel, color }: { nivel: number; color: string }) {
  const reducir = useReducedMotion();
  const altura = useSharedValue(MINIMO);

  useEffect(() => {
    const destino = Math.max(MINIMO, nivel);
    altura.value = reducir ? destino : withTiming(destino, { duration: 160 });
  }, [nivel, altura, reducir]);

  const animado = useAnimatedStyle(() => ({ transform: [{ scaleY: altura.value }] }));
  return <Animated.View style={[styles.barra, { backgroundColor: color }, animado]} />;
}

/** Tres puntos que respiran por turnos. No representan el sonido, y no lo parecen. */
function ActividadDecorativa({ color }: { color: string }) {
  return (
    <View
      style={styles.puntos}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {[0, 1, 2].map((indice) => (
        <Punto key={indice} retraso={indice * 180} color={color} />
      ))}
    </View>
  );
}

function Punto({ retraso, color }: { retraso: number; color: string }) {
  const reducir = useReducedMotion();
  const opacidad = useSharedValue(reducir ? 0.7 : 0.25);

  useEffect(() => {
    // Con «reducir movimiento», tres puntos quietos: siguen diciendo que hay
    // algo en marcha —el texto y el reloj lo confirman— sin moverse en bucle.
    if (reducir) return undefined;
    opacidad.value = withDelay(
      retraso,
      withRepeat(
        withSequence(withTiming(1, { duration: 420 }), withTiming(0.25, { duration: 420 })),
        -1,
      ),
    );
    return () => cancelAnimation(opacidad);
  }, [opacidad, retraso, reducir]);

  const animado = useAnimatedStyle(() => ({ opacity: opacidad.value }));
  return <Animated.View style={[styles.punto, { backgroundColor: color }, animado]} />;
}

const styles = StyleSheet.create({
  onda: {
    flex: 1,
    height: ALTO,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    overflow: 'hidden',
  },
  barra: { width: 3, height: ALTO, borderRadius: 1.5 },
  puntos: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5, height: ALTO },
  punto: { width: 6, height: 6, borderRadius: 3 },
});
