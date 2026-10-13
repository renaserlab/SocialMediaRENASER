import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';

import { seAnimaElPaso, type EstadoDeEntrega } from '@/lib/lecturaDeMensajes';

/** En la web `Animated` no tiene hilo nativo y avisa por consola si se le pide. */
const HILO_NATIVO = Platform.OS !== 'web';

type Props = {
  estado: EstadoDeEntrega;
  /** El color de la marca mientras no está leído: el del texto de la burbuja. */
  color: string;
  /** El color de las dos marcas de «leído». */
  colorDeLeido: string;
  /** El alto. La doble marca es algo más ancha que alta. */
  size?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * La marca de un mensaje propio:
 *
 *   · una      → saliendo (todavía no llegó al servidor);
 *   · dos      → enviado;
 *   · dos, en celeste → leído;
 *   · un aviso → no se envió.
 *
 * VAN DIBUJADAS. Feather no trae la doble marca; las dos llevan su mismo trazo
 * —rejilla de 24, puntas redondas— y la sencilla es la PRIMERA de la doble, en
 * el mismo sitio: al pasar de una a dos, la que ya estaba no se mueve.
 *
 * SE ANIMA SOLO AL AVANZAR, Y SOLO MIENTRAS DURA. Cuando el mensaje sale o lo
 * leen, la marca nueva entra con un pequeño salto sobre la anterior. Terminado
 * el salto vuelve a ser un dibujo quieto: en un chat hay una marca por mensaje,
 * y cientos de vistas animadas siempre montadas dejan la lista a tirones.
 *
 * No lleva accesibilidad propia: la franja donde va ya dice con palabras si el
 * mensaje se envió o se leyó.
 */
export function MarcaDeEntrega({ estado, color, colorDeLeido, size = 13, style }: Props) {
  /** De qué estado se viene, mientras dura el salto. `null`: quieta. */
  const [viniendoDe, setViniendoDe] = useState<EstadoDeEntrega | null>(null);
  const anterior = useRef(estado);
  const avance = useRef<Animated.Value | null>(null);

  useEffect(() => {
    const antes = anterior.current;
    anterior.current = estado;
    setViniendoDe(null);
    if (antes === estado || !seAnimaElPaso(antes, estado)) return;

    let vigente = true;
    let salto: Animated.CompositeAnimation | null = null;
    /*
      «Reducir movimiento» se pregunta AQUÍ, cuando hay algo que animar, y no
      con el gancho de siempre: ese deja una escucha por componente, y hay una
      marca por mensaje. En reposo una marca no pregunta ni escucha nada.
    */
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reducir) => {
        if (!vigente || reducir) return;
        // El valor animado se crea la primera vez que hace falta.
        const valor = (avance.current ??= new Animated.Value(0));
        valor.setValue(0);
        setViniendoDe(antes);
        salto = Animated.timing(valor, {
          toValue: 1,
          duration: 320,
          easing: Easing.out(Easing.back(2.2)),
          useNativeDriver: HILO_NATIVO,
        });
        salto.start(({ finished }) => {
          if (finished && vigente) setViniendoDe(null);
        });
      });
    return () => {
      vigente = false;
      salto?.stop();
    };
  }, [estado]);

  const ancho = anchoDe(estado, size);
  if (viniendoDe === null || !avance.current) {
    return <Dibujo estado={estado} color={color} colorDeLeido={colorDeLeido} size={size} style={style} />;
  }

  const valor = avance.current;
  return (
    <View style={[{ width: ancho, height: size }, styles.fijo, style]}>
      {/* Debajo, la que había: la nueva crece encima de ella. */}
      <Dibujo estado={viniendoDe} color={color} colorDeLeido={colorDeLeido} size={size} style={styles.debajo} />
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: valor.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }),
            transform: [{ scale: valor.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }) }],
          },
        ]}
      >
        <Dibujo estado={estado} color={color} colorDeLeido={colorDeLeido} size={size} />
      </Animated.View>
    </View>
  );
}

/** Algo más ancha que alta: son dos marcas, una asomando detrás de la otra. */
const anchoDe = (estado: EstadoDeEntrega, size: number): number =>
  estado === 'fallido' ? size : Math.round(size * 1.35);

function Dibujo({
  estado,
  color,
  colorDeLeido,
  size,
  style,
}: {
  estado: EstadoDeEntrega;
  color: string;
  colorDeLeido: string;
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  if (estado === 'fallido') {
    return <Feather name="alert-circle" size={size} color={color} style={style as never} />;
  }
  const tinta = estado === 'leido' ? colorDeLeido : color;
  return (
    <Svg
      width={anchoDe(estado, size)}
      height={size}
      viewBox="0 0 27 20"
      fill="none"
      style={[styles.fijo, style]}
    >
      <Path
        d="M2 11l5 5L18 4"
        stroke={tinta}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {estado === 'enviando' ? null : (
        <Path
          d="M25 4L14 16l-1.5-1.5"
          stroke={tinta}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </Svg>
  );
}

const styles = StyleSheet.create({
  // En el navegador un `<svg>` encoge por defecto junto a un texto.
  fijo: { flexShrink: 0 },
  debajo: { position: 'absolute', left: 0, top: 0 },
});
