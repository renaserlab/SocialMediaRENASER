import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { sobreMedio } from '@/components/CapaDeContraste';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { claveDelRotulo, type Rotulo } from '@/live/destacado';
import { radius, spacing } from '@/theme/tokens';

/** En la web `Animated` no tiene hilo nativo y avisa por consola si se le pide. */
const HILO_NATIVO = Platform.OS !== 'web';

const ENTRADA_MS = 320;
const LATIDO_MS = 260;
/** Cuántas veces late un rótulo de aviso. Después se queda quieto. */
const LATIDOS = 3;
/** Puntos por segundo a los que corre la cinta: se lee sin perseguirla. */
const VELOCIDAD_DE_LA_CINTA = 48;
/** Ancho del raíl donde se mide el texto de la cinta sin que se corte. */
const RAIL = 4_000;
/** Lo que mide la línea del rótulo. La cinta necesita un alto fijo. */
const LINEA = 20;

type Props = {
  rotulo: Rotulo;
  /** La persona ha pedido menos movimiento en su teléfono. */
  reduceMotion: boolean;
  /** Lo que se le dice a un lector de pantalla. */
  etiqueta: string;
  /** Quien gestiona la emisión lo toca para cambiarlo. */
  alPulsar?: () => void;
  /** Qué hace tocarlo, para un lector de pantalla. */
  pista?: string;
};

/**
 * El texto que quien emite pone sobre la imagen, a la vista de toda la sala.
 *
 * TRES FORMAS DE MOVERSE, y las tres ANIMAN SOLO MIENTRAS HACE FALTA:
 *
 *   · `slide`  — entra deslizándose y se queda quieto.
 *   · `pulse`  — entra y late tres veces. Después, quieto.
 *   · `ticker` — corre de lado, pero SOLO si el texto no cabe a lo ancho. Uno
 *     que cabe no tiene por qué moverse: se queda como `slide`.
 *
 * La entrada se repite cuando el rótulo es OTRO (`claveDelRotulo`), no cada vez
 * que se vuelve a preguntar al servidor: con cada aviso de la sala el mismo
 * texto volvería a entrar, y un rótulo que entra cada dos segundos no se lee.
 *
 * CON «REDUCIR MOVIMIENTO» no se mueve nada: aparece, y un texto largo ocupa
 * dos líneas en vez de correr.
 *
 * Va con el hilo nativo y sobre UNA vista: no repinta la pantalla ni compite
 * con el vídeo.
 */
export function RotuloDeDirecto({ rotulo, reduceMotion, etiqueta, alPulsar, pista }: Props) {
  const clave = claveDelRotulo(rotulo);
  const corre = rotulo.estilo === 'ticker' && !reduceMotion;

  const entrada = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const latido = useRef(new Animated.Value(1)).current;
  const paso = useRef(new Animated.Value(0)).current;

  /** Ancho del hueco de la cinta y del texto entero, para saber si cabe. */
  const [hueco, setHueco] = useState(0);
  const [largo, setLargo] = useState(0);
  const noCabe = corre && hueco > 0 && largo > hueco;

  // La entrada: una vez por rótulo.
  useEffect(() => {
    latido.setValue(1);
    if (reduceMotion) {
      entrada.setValue(1);
      return;
    }
    entrada.setValue(0);
    const pasos: Animated.CompositeAnimation[] = [
      Animated.timing(entrada, {
        toValue: 1,
        duration: ENTRADA_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: HILO_NATIVO,
      }),
    ];
    if (rotulo.estilo === 'pulse') {
      for (let i = 0; i < LATIDOS; i++) {
        pasos.push(
          Animated.timing(latido, {
            toValue: 1.06,
            duration: LATIDO_MS,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: HILO_NATIVO,
          }),
          Animated.timing(latido, {
            toValue: 1,
            duration: LATIDO_MS,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: HILO_NATIVO,
          }),
        );
      }
    }
    const animacion = Animated.sequence(pasos);
    animacion.start();
    return () => animacion.stop();
    // Depende de la CLAVE, no del objeto: releer el mismo rótulo no lo reinicia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave, reduceMotion]);

  // La cinta: solo mientras el texto no cabe.
  useEffect(() => {
    if (!noCabe) {
      paso.setValue(0);
      return;
    }
    // Entra por la derecha del hueco y sale entero por la izquierda.
    paso.setValue(hueco);
    const vuelta = Animated.loop(
      Animated.timing(paso, {
        toValue: -largo,
        duration: ((hueco + largo) / VELOCIDAD_DE_LA_CINTA) * 1_000,
        easing: Easing.linear,
        useNativeDriver: HILO_NATIVO,
      }),
    );
    vuelta.start();
    return () => vuelta.stop();
  }, [noCabe, hueco, largo, paso, clave]);

  const contenido = (
    <>
      <Feather name="volume-2" size={14} color={sobreMedio.text} />
      {corre ? (
        <View
          style={estilos.hueco}
          onLayout={(evento) => setHueco(evento.nativeEvent.layout.width)}
        >
          <Animated.View style={[estilos.rail, { transform: [{ translateX: paso }] }]}>
            <Text
              variant="secondary"
              weight="800"
              color={sobreMedio.text}
              numberOfLines={1}
              style={estilos.linea}
              onLayout={(evento) => setLargo(evento.nativeEvent.layout.width)}
            >
              {rotulo.texto}
            </Text>
          </Animated.View>
        </View>
      ) : (
        <Text
          variant="secondary"
          weight="800"
          color={sobreMedio.text}
          numberOfLines={2}
          style={estilos.texto}
        >
          {rotulo.texto}
        </Text>
      )}
    </>
  );

  const movimiento = {
    opacity: entrada,
    transform: [
      { translateY: entrada.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) },
      { scale: latido },
    ],
  };

  return (
    <Animated.View
      style={[estilos.zona, corre ? estilos.zonaDeCinta : null, movimiento]}
      // Quien entra a media emisión lo oye; no se vuelve a anunciar al releer.
      accessibilityLiveRegion="polite"
    >
      {alPulsar ? (
        <Pulsable
          onPress={alPulsar}
          escala={1}
          accessibilityRole="button"
          accessibilityLabel={etiqueta}
          accessibilityHint={pista}
          style={estilos.pildora}
        >
          {contenido}
        </Pulsable>
      ) : (
        <View style={estilos.pildora} accessible accessibilityRole="text" accessibilityLabel={etiqueta}>
          {contenido}
        </View>
      )}
    </Animated.View>
  );
}

const estilos = StyleSheet.create({
  zona: {
    alignSelf: 'center',
    maxWidth: '100%',
    marginTop: spacing.xs,
  },
  // La cinta ocupa todo el ancho: necesita sitio por donde correr.
  zonaDeCinta: { alignSelf: 'stretch' },
  pildora: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    // Opaco: es el texto de quien emite y tiene que leerse sobre cualquier
    // imagen, también una clara.
    backgroundColor: 'rgba(0,0,0,0.78)',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: sobreMedio.glassBorder,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    minHeight: 34,
  },
  texto: { flexShrink: 1, textAlign: 'center' },
  hueco: { flex: 1, height: LINEA, overflow: 'hidden' },
  // Ancho de sobra para que el texto se mida ENTERO, sin puntos suspensivos.
  rail: { width: RAIL, flexDirection: 'row' },
  linea: { lineHeight: LINEA },
});
