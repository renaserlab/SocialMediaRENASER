import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Keyboard, Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { runOnJS, useAnimatedKeyboard, useAnimatedReaction } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  TECLADO_CERRADO,
  altoQueSeAvisa,
  margenInferiorConTeclado,
  tecladoALaVista,
  type EstadoDelTeclado,
} from '@/lib/huecoDelTeclado';

/**
 * LO QUE SE SABE DEL TECLADO, EN UN SOLO SITIO.
 *
 * Se monta UNA vez, en la raíz, y lo leen todos los `SinTecladoDelante`. Reúne
 * los dos datos que explica `lib/huecoDelTeclado`:
 *
 *   · el aviso de React Native, que llega enseguida pero no se entera cuando
 *     el teclado cambia de alto estando abierto; y
 *   · el alto asentado, que sale de los márgenes de la ventana y sí lo sigue.
 *
 * POR QUÉ EN LA RAÍZ Y NO EN CADA PANTALLA. El seguimiento de los márgenes lo
 * hace Reanimated enganchándose a la ventana de la aplicación, y se suelta
 * cuando deja de usarlo el último que lo pidió. Pedido desde cada pantalla se
 * engancharía y soltaría con cada navegación; aquí se engancha una vez y se
 * queda.
 *
 * LAS DOS BARRAS SE DECLARAN TRANSLÚCIDAS, y no es un detalle. La aplicación
 * es de borde a borde: su contenido ya llega hasta los bordes de la ventana.
 * Sin decirlo, Reanimated metería sus propios márgenes para la barra de estado
 * y la de navegación, encima de los que la aplicación ya respeta.
 *
 * NO ANIMA NADA. El alto se lee en el hilo de la interfaz, pero a JavaScript
 * solo se le dice cuando el teclado se ha asentado o ha cambiado: un puñado de
 * avisos por cada vez que se abre, no uno por fotograma. Lo que se aparta es
 * estado normal de React.
 *
 * SOLO EN ANDROID. En iOS `KeyboardAvoidingView` hace bien su trabajo, y en la
 * web no hay teclado que apartar.
 */

const Contexto = createContext<EstadoDelTeclado>(TECLADO_CERRADO);

/** Lo que se sabe del teclado ahora mismo. Fuera de Android, siempre cerrado. */
export function useTeclado(): EstadoDelTeclado {
  return useContext(Contexto);
}

/** Si hay teclado delante. En iOS y en la web, nunca: allí lo aparta otro. */
export function useTecladoALaVista(): boolean {
  return tecladoALaVista(useContext(Contexto));
}

/**
 * El margen inferior del teléfono para lo que va DENTRO de `SinTecladoDelante`:
 * el de siempre, y cero con el teclado abierto. Por qué, en
 * `lib/huecoDelTeclado.margenInferiorConTeclado`.
 */
export function useMargenInferior(): number {
  const { bottom } = useSafeAreaInsets();
  return margenInferiorConTeclado(bottom, useContext(Contexto));
}

function ProveedorEnAndroid({ children }: React.PropsWithChildren) {
  const [visible, setVisible] = useState(false);
  const [bordeSegunElAviso, setBordeSegunElAviso] = useState<number | null>(null);
  const [altoAsentado, setAltoAsentado] = useState(0);
  const [altoDeLaVentana, setAltoDeLaVentana] = useState(0);

  // --- El aviso de React Native ------------------------------------------
  useEffect(() => {
    const alMostrar = Keyboard.addListener('keyboardDidShow', (evento) => {
      setBordeSegunElAviso(evento.endCoordinates.screenY);
      setVisible(true);
    });
    const alOcultar = Keyboard.addListener('keyboardDidHide', () => {
      setVisible(false);
      setBordeSegunElAviso(null);
      // Y el alto asentado, a cero: si los márgenes de la ventana no llegaran a
      // avisar del cierre, se quedaría puesto el del teclado que ya no está.
      setAltoAsentado(0);
    });

    // Se puede arrancar con el teclado ya abierto: no habrá «se ha mostrado».
    if (Keyboard.isVisible()) {
      const medidas = Keyboard.metrics();
      if (medidas) {
        setBordeSegunElAviso(medidas.screenY);
        setVisible(true);
      }
    }

    return () => {
      alMostrar.remove();
      alOcultar.remove();
    };
  }, []);

  // --- El alto asentado ----------------------------------------------------
  const teclado = useAnimatedKeyboard({
    isStatusBarTranslucentAndroid: true,
    isNavigationBarTranslucentAndroid: true,
  });

  const alAsentarse = useCallback((alto: number) => {
    setAltoAsentado(alto);
  }, []);

  useAnimatedReaction(
    () => altoQueSeAvisa(teclado.state.value, teclado.height.value),
    (ahora, antes) => {
      // -1 es «abriéndose»: no se dice nada hasta que se asiente.
      if (ahora === antes || ahora < 0) return;
      runOnJS(alAsentarse)(ahora);
    },
  );

  const alMedirLaVentana = useCallback((evento: LayoutChangeEvent) => {
    setAltoDeLaVentana(evento.nativeEvent.layout.height);
  }, []);

  const valor = useMemo<EstadoDelTeclado>(
    () => ({ visible, bordeSegunElAviso, altoAsentado, altoDeLaVentana }),
    [visible, bordeSegunElAviso, altoAsentado, altoDeLaVentana],
  );

  return (
    <Contexto.Provider value={valor}>
      {/*
        Esta vista ocupa la ventana entera y sirve de regla: el alto del
        teclado se cuenta desde su borde inferior, y cada marco se mide contra
        la raíz de la pantalla con `measure`, que es la misma medida.
      */}
      <View style={styles.ventana} onLayout={alMedirLaVentana}>
        {children}
      </View>
    </Contexto.Provider>
  );
}

function ProveedorSinTeclado({ children }: React.PropsWithChildren) {
  return <>{children}</>;
}

export const ProveedorDelTeclado = Platform.OS === 'android' ? ProveedorEnAndroid : ProveedorSinTeclado;

const styles = StyleSheet.create({
  ventana: { flex: 1 },
});
