import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';

import {
  ARRANQUE,
  TOLERANCIA_VERTICAL,
  avanceDeLaFlecha,
  desplazamientoDe,
  escalaDeLaFlecha,
  pasaElUmbral,
  posicionDeVuelta,
} from '@/lib/deslizarParaResponder';
import { haptics } from '@/lib/haptics';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  /**
   * Si a este mensaje se le puede responder. Con `false` el gesto no existe,
   * pero lo que se pinta es lo mismo: así la fila no se vuelve a montar cuando
   * el mensaje pasa de «enviando» a enviado.
   */
  activo: boolean;
  /** Se soltó pasado el umbral: hay que citar este mensaje. */
  alResponder: () => void;
  /**
   * De qué mensaje es la fila. La lista recicla celdas: sin esto, una celda
   * reutilizada a media vuelta enseñaría el mensaje siguiente corrido.
   */
  clave: string;
  /** El estilo de la fila: se le pone a lo que se mueve. */
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

/** Lo que mide el carril de cada flecha, y lo que se separa del borde. */
const CARRIL = 36;
const MARGEN = 6;
/** El tamaño de la flecha cuando todavía no se ha tirado de nada. */
const ESCALA_EN_REPOSO = 0.6;

type Nodo = React.ElementRef<typeof View> | null;

/**
 * Mueve una vista SIN pasar por React.
 *
 * Es lo que permite que la fila sea una vista normal: mientras nadie la toca
 * no hay nada animado montado. En el teléfono se le habla directamente a la
 * vista nativa; en el navegador, al elemento.
 */
function colocar(nodo: Nodo, x: number, opacidad?: number, escala?: number): void {
  if (!nodo) return;
  if (Platform.OS === 'web') {
    const estilo = (nodo as unknown as { style?: { transform: string; opacity: string } }).style;
    if (!estilo) return;
    estilo.transform =
      escala === undefined ? `translateX(${x}px)` : `translateX(${x}px) scale(${escala})`;
    if (opacidad !== undefined) estilo.opacity = String(opacidad);
    return;
  }
  const transform =
    escala === undefined ? [{ translateX: x }] : [{ translateX: x }, { scale: escala }];
  nodo.setNativeProps({
    style: opacidad === undefined ? { transform } : { transform, opacity: opacidad },
  });
}

/**
 * Una fila del chat que se puede deslizar de lado para responder.
 *
 * QUÉ SE VE. La burbuja sigue al dedo, con freno, hacia el lado al que se
 * tire —vale cualquiera de los dos—. Del lado que deja libre aparece una
 * flecha de responder, que está entera cuando soltar ya responde; en ese punto
 * el teléfono da un toque. Al soltar, la burbuja vuelve a su sitio.
 *
 * NO HAY NADA ANIMADO EN REPOSO, y es la regla de este proyecto (ver
 * `lib/movimiento.ts`): un chat tiene decenas de filas, y una vista animada
 * por fila —aunque no se mueva nunca— es lo que dejó la aplicación entera a
 * tirones el 04/10. Aquí la fila es una vista normal; el movimiento se le
 * aplica directamente a la vista solo mientras dura el gesto y su vuelta.
 *
 * NO LE QUITA NADA A LA LISTA. El gesto solo empieza con un movimiento
 * claramente de lado y se rinde en cuanto el dedo se va en vertical: quien
 * sube o baja por el chat nunca mueve una burbuja. Tampoco estorba al toque
 * ni a mantener presionado: no empieza hasta que el dedo se ha movido.
 */
export function DeslizarParaResponder({ activo, alResponder, clave, style, children }: Props) {
  const { colors } = useAppTheme();
  const reducir = useReducedMotion();
  const contenido = useRef<Nodo>(null);
  /*
    UNA FLECHA A CADA LADO, cada una en su sitio desde el principio. Con una
    sola habría que saber cuánto mide la fila para llevarla al otro lado, y
    eso obliga a medir cada fila aunque nadie la toque.
  */
  const flechaIzquierda = useRef<Nodo>(null);
  const flechaDerecha = useRef<Nodo>(null);
  /** Dónde está ahora la burbuja, en puntos. */
  const posicion = useRef(0);
  /** El desplazamiento que ya traía el dedo cuando el gesto empezó. */
  const origen = useRef(0);
  const avisado = useRef(false);
  const cuadro = useRef<number | null>(null);
  // Siempre la última: el gesto se crea una vez y no puede citar un mensaje viejo.
  const responder = useRef(alResponder);
  responder.current = alResponder;

  const pararLaVuelta = useCallback(() => {
    if (cuadro.current !== null) cancelAnimationFrame(cuadro.current);
    cuadro.current = null;
  }, []);

  const dejarEnSuSitio = useCallback(() => {
    pararLaVuelta();
    posicion.current = 0;
    colocar(contenido.current, 0);
    colocar(flechaIzquierda.current, 0, 0, ESCALA_EN_REPOSO);
    colocar(flechaDerecha.current, 0, 0, ESCALA_EN_REPOSO);
  }, [pararLaVuelta]);

  const mover = useCallback((dx: number) => {
    const x = desplazamientoDe(dx);
    posicion.current = x;
    colocar(contenido.current, x);
    // La flecha, en el lado que la burbuja deja libre; la otra, escondida, por
    // si el dedo cruzó de un lado al otro sin soltar.
    const haciaLaIzquierda = dx < 0;
    colocar(
      (haciaLaIzquierda ? flechaDerecha : flechaIzquierda).current,
      0,
      avanceDeLaFlecha(dx),
      escalaDeLaFlecha(dx),
    );
    colocar((haciaLaIzquierda ? flechaIzquierda : flechaDerecha).current, 0, 0, ESCALA_EN_REPOSO);
    // Un toque en la mano al llegar al punto en que soltar ya responde; uno
    // solo por gesto, aunque el dedo vaya y venga.
    if (pasaElUmbral(dx)) {
      if (!avisado.current) {
        avisado.current = true;
        haptics.light();
      }
    } else {
      avisado.current = false;
    }
  }, []);

  const volver = useCallback(() => {
    pararLaVuelta();
    const desde = posicion.current;
    // No se había movido: un toque, o un dedo que solo desplazaba la lista.
    // No hay nada que devolver a su sitio.
    if (desde === 0) return;
    // Con «reducir movimiento» la burbuja está en su sitio de golpe.
    if (reducir) {
      dejarEnSuSitio();
      return;
    }
    const inicio = Date.now();
    const paso = () => {
      const x = posicionDeVuelta(desde, Date.now() - inicio);
      if (Math.abs(x) < 0.5) {
        dejarEnSuSitio();
        return;
      }
      posicion.current = x;
      colocar(contenido.current, x);
      // La flecha se va con la burbuja: lo que queda de camino es lo que se ve.
      const queda = Math.abs(x / desde);
      colocar(
        (desde < 0 ? flechaDerecha : flechaIzquierda).current,
        0,
        queda,
        ESCALA_EN_REPOSO + (1 - ESCALA_EN_REPOSO) * queda,
      );
      cuadro.current = requestAnimationFrame(paso);
    };
    cuadro.current = requestAnimationFrame(paso);
  }, [dejarEnSuSitio, pararLaVuelta, reducir]);

  const gesto = useMemo(
    () =>
      Gesture.Pan()
        .enabled(activo)
        // En el hilo de JavaScript: mueve UNA fila durante un gesto corto, y
        // así no hace falta montar nada animado para moverla.
        .runOnJS(true)
        .activeOffsetX([-ARRANQUE, ARRANQUE])
        .failOffsetY([-TOLERANCIA_VERTICAL, TOLERANCIA_VERTICAL])
        .onStart((evento) => {
          pararLaVuelta();
          // Lo que el dedo ya se había movido para arrancar no cuenta: la
          // burbuja empieza a moverse desde donde está, sin salto.
          origen.current = evento.translationX;
          avisado.current = false;
        })
        .onUpdate((evento) => mover(evento.translationX - origen.current))
        .onEnd((evento) => {
          if (pasaElUmbral(evento.translationX - origen.current)) responder.current();
        })
        // Pase lo que pase —se soltó, lo canceló la lista, llegó otra cosa—,
        // la burbuja vuelve a su sitio.
        .onFinalize(() => volver()),
    [activo, mover, pararLaVuelta, volver],
  );

  // La celda pasa a ser de otro mensaje: lo que quedara a medias, a su sitio.
  useEffect(() => {
    if (posicion.current !== 0) dejarEnSuSitio();
  }, [clave, dejarEnSuSitio]);

  useEffect(() => pararLaVuelta, [pararLaVuelta]);

  return (
    <GestureDetector gesture={gesto}>
      {/*
        `collapsable={false}`: son vistas a las que se les habla directamente
        y tienen que existir de verdad; sin esto el sistema puede fundirlas con
        su padre para ahorrar, y no habría nada que mover.
      */}
      <View collapsable={false}>
        {[
          { ref: flechaIzquierda, lado: styles.aLaIzquierda },
          { ref: flechaDerecha, lado: styles.aLaDerecha },
        ].map(({ ref, lado }, indice) => (
          <View
            key={indice}
            ref={ref}
            collapsable={false}
            pointerEvents="none"
            style={[styles.carril, lado]}
          >
            <View
              style={[
                styles.flecha,
                { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
              ]}
            >
              <Feather name="corner-up-left" size={16} color={colors.text} />
            </View>
          </View>
        ))}
        <View ref={contenido} collapsable={false} style={style}>
          {children}
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  // De arriba abajo de la fila, para que la flecha quede a media altura de la
  // burbuja mida lo que mida. Invisible hasta que se tira.
  carril: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: CARRIL,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0,
  },
  aLaIzquierda: { left: MARGEN },
  aLaDerecha: { right: MARGEN },
  flecha: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
