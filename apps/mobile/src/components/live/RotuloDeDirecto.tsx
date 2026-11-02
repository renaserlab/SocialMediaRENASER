import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text as RNText,
  View,
  type LayoutChangeEvent,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import {
  aireEntreLetras,
  estiloDeLaLetra,
  useLetrasDelRotulo,
} from '@/hooks/useLetrasDelRotulo';
import { claveDelRotulo, type Presentacion, type Rotulo } from '@/live/destacado';
import { huecoParaElTexto, medidasDeLaPildora, type Medida } from '@/live/rotuloEnPantalla';
import { radius, rotuloDeDirecto } from '@/theme/tokens';

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

type Props = {
  rotulo: Rotulo;
  /**
   * Cuándo es OTRO rótulo y se vuelve a animar la entrada. Por omisión,
   * `claveDelRotulo`. La hoja de editar pasa la suya: escribir no lo hace
   * entrar en cada letra.
   */
  claveDeEntrada?: string;
  /** La persona ha pedido menos movimiento en su teléfono. */
  reduceMotion: boolean;
  /** Lo más ancho que puede ser: el ancho de la zona libre. */
  anchoMaximo: number;
  /**
   * El tamaño con el que se pinta AHORA. Mientras el host pellizca va por
   * delante del guardado; el resto del tiempo es el de `rotulo.presentacion`.
   */
  tamano?: number;
  /** Lo que mide la píldora sin girar, cada vez que cambia. */
  alMedir?: (medida: Medida) => void;
};

/** Los colores de la píldora según el color y el fondo elegidos. Todos de tokens. */
export function tintasDelRotulo(presentacion: Pick<Presentacion, 'color' | 'fondo'>): {
  fondo: string;
  borde: string;
  letra: string;
  sombra: string | null;
} {
  const tinta = rotuloDeDirecto.colores[presentacion.color];
  const negra = presentacion.color === 'negro';
  if (presentacion.fondo === 'ninguno') {
    return {
      fondo: 'transparent',
      borde: 'transparent',
      letra: tinta.texto,
      // Sin nada detrás, una sombra en cada letra. Clara si la letra es negra.
      sombra: negra ? rotuloDeDirecto.sombraClara : rotuloDeDirecto.sombra,
    };
  }
  if (presentacion.fondo === 'solido') {
    return {
      fondo: tinta.relleno,
      borde: rotuloDeDirecto.bordeDelRelleno,
      letra: tinta.sobreRelleno,
      sombra: null,
    };
  }
  // El velo: oscuro, salvo con la letra negra, que lo lleva claro.
  return {
    fondo: negra ? rotuloDeDirecto.veloClaro : rotuloDeDirecto.velo,
    borde: negra ? rotuloDeDirecto.bordeDelVeloClaro : rotuloDeDirecto.bordeDelVelo,
    letra: tinta.texto,
    sombra: null,
  };
}

/**
 * La píldora del texto que quien emite pone sobre la imagen.
 *
 * SOLO PINTA. Dónde va, cuánto gira y qué hace el dedo lo decide
 * `CapaDelRotulo`; aquí está cómo se ve —color, fondo, letra y tamaño, todos
 * de la presentación (0114)— y cómo se mueve por dentro:
 *
 *   · `slide`  — entra deslizándose y se queda quieto.
 *   · `pulse`  — entra y late tres veces. Después, quieto.
 *   · `ticker` — corre de lado, pero SOLO si el texto no cabe a lo ancho. Uno
 *     que cabe no tiene por qué moverse: se queda como `slide`.
 *
 * La entrada se repite cuando el rótulo es OTRO (`claveDelRotulo`), no cada vez
 * que se vuelve a preguntar al servidor, ni cuando solo cambia de sitio o de
 * color: un rótulo que entra cada dos segundos no se lee.
 *
 * EL TAMAÑO CAMBIA LA LETRA, NO LA ESCALA. Al 240 % la píldora sigue sin pasar
 * del ancho de la zona y el texto parte en más líneas; escalarla la sacaría de
 * la pantalla.
 *
 * CON «REDUCIR MOVIMIENTO» no se mueve nada: aparece, y un texto largo ocupa
 * varias líneas en vez de correr.
 */
export function RotuloDeDirecto({
  rotulo,
  claveDeEntrada,
  reduceMotion,
  anchoMaximo,
  tamano,
  alMedir,
}: Props) {
  const presentacion = rotulo.presentacion;
  const clave = claveDeEntrada ?? claveDelRotulo(rotulo);
  const tam = tamano ?? presentacion.tamano;
  const m = medidasDeLaPildora(tam);
  const cargadas = useLetrasDelRotulo([presentacion.letra]);
  const tintas = tintasDelRotulo(presentacion);

  const quiereCorrer = rotulo.estilo === 'ticker' && !reduceMotion;

  const entrada = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const latido = useRef(new Animated.Value(1)).current;
  const paso = useRef(new Animated.Value(0)).current;

  /** Lo que mide el texto entero en una línea, para saber si cabe. */
  const [largo, setLargo] = useState(0);
  const hueco = huecoParaElTexto(anchoMaximo, tam);
  const corre = quiereCorrer && largo > 0 && largo > hueco;

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
    if (!corre) {
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
  }, [corre, hueco, largo, paso, clave]);

  const letra: TextStyle = {
    ...estiloDeLaLetra(presentacion.letra, cargadas[presentacion.letra]),
    letterSpacing: aireEntreLetras(presentacion.letra, m.letra),
    fontSize: m.letra,
    lineHeight: m.linea,
    color: tintas.letra,
    ...(tintas.sombra
      ? {
          textShadowColor: tintas.sombra,
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3 * (tam / 100),
        }
      : null),
  };

  const pildora: ViewStyle = {
    maxWidth: anchoMaximo,
    gap: m.separacion,
    paddingHorizontal: m.rellenoHorizontal,
    paddingVertical: m.rellenoVertical,
    minHeight: m.altoMinimo,
    backgroundColor: tintas.fondo,
    borderColor: tintas.borde,
  };

  const medir = (evento: LayoutChangeEvent) => {
    const { width, height } = evento.nativeEvent.layout;
    alMedir?.({ ancho: width, alto: height });
  };

  const movimiento = {
    opacity: entrada,
    transform: [
      { translateY: entrada.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) },
      { scale: latido },
    ],
  };

  return (
    <Animated.View style={movimiento} pointerEvents="none">
      <View
        style={[estilos.pildora, pildora, corre ? { width: anchoMaximo } : null]}
        onLayout={medir}
      >
        <Feather
          name="volume-2"
          size={m.icono}
          color={tintas.letra}
          style={tintas.sombra ? letraDeSombra(letra) : null}
        />
        {corre ? (
          <View style={[estilos.hueco, { height: m.linea }]}>
            <Animated.View style={[estilos.rail, { transform: [{ translateX: paso }] }]}>
              <RNText numberOfLines={1} style={letra}>
                {rotulo.texto}
              </RNText>
            </Animated.View>
          </View>
        ) : (
          <RNText style={[letra, estilos.texto]}>{rotulo.texto}</RNText>
        )}
      </View>
      {/*
        La regla de la cinta: el texto entero en UNA línea, invisible y fuera
        del sitio, para saber cuánto mide. Solo existe si la cinta podría
        correr.
      */}
      {quiereCorrer ? (
        <View
          style={estilos.regla}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <View style={estilos.rail}>
            <RNText
              numberOfLines={1}
              style={letra}
              onLayout={(evento) => setLargo(evento.nativeEvent.layout.width)}
            >
              {rotulo.texto}
            </RNText>
          </View>
        </View>
      ) : null}
    </Animated.View>
  );
}

function letraDeSombra(letra: TextStyle): TextStyle {
  return {
    textShadowColor: letra.textShadowColor,
    textShadowOffset: letra.textShadowOffset,
    textShadowRadius: letra.textShadowRadius,
  };
}

const estilos = StyleSheet.create({
  pildora: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  texto: { flexShrink: 1, textAlign: 'center' },
  hueco: { flex: 1, overflow: 'hidden' },
  // Ancho de sobra para que el texto se mida ENTERO, sin puntos suspensivos.
  rail: { width: RAIL, flexDirection: 'row' },
  // Una caja de 0 × 0 que recorta: el raíl de 4000 puntos se mide entero pero
  // no ensancha nada (en la web daría barra de desplazamiento lateral).
  regla: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    overflow: 'hidden',
    opacity: 0,
  },
});
