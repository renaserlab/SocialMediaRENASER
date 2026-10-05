import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { DURACION, MUELLE } from '@/lib/movimiento';

/*
  LO QUE SE MUEVE, Y SOLO MIENTRAS SE MUEVE.

  Estos dos componentes son lo único animado de un icono, un contador, un globo
  o una fila que entra. NO están montados en reposo: quien los usa pinta una
  vista normal y monta uno de estos cuando algo cambia (`lib/movimiento.ts`
  dice cuándo). Al terminar avisan, y quien los montó vuelve a la vista normal.

  Con el motor de animación de React Native y su controlador nativo: la
  animación corre en el hilo de la interfaz y, al desmontarse, no deja nada
  registrado. Una vista de la otra biblioteca (Reanimated) deja una entrada que
  se reaplica en cada cambio de la pantalla mientras siga montada; con cientos
  de ellas, eso era lo que hacía ir a tirones toda la aplicación.
*/

/** En web no hay controlador nativo: pedirlo solo escribe un aviso. */
const NATIVO = Platform.OS !== 'web';

type PropsDeSalto = Omit<ViewProps, 'style'> & {
  /** La escala en lo alto del salto. Mayor que 1 crece; menor, se hunde. */
  pico: number;
  /** La escala de partida. 1 salvo para lo que aparece desde pequeño. */
  desde?: number;
  /** Ya volvió a su tamaño (o se cortó): se puede desmontar. */
  alTerminar: () => void;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

/** Un salto de escala: va al pico y vuelve a su tamaño con un muelle. Una vez. */
export function SaltoBreve({ pico, desde = 1, alTerminar, style, children, ...resto }: PropsDeSalto) {
  const escala = useRef(new Animated.Value(desde)).current;
  const fin = useRef(alTerminar);
  fin.current = alTerminar;

  useEffect(() => {
    const animacion = Animated.sequence([
      Animated.timing(escala, { toValue: pico, duration: DURACION.toque, useNativeDriver: NATIVO }),
      Animated.spring(escala, {
        toValue: 1,
        damping: MUELLE.damping,
        stiffness: MUELLE.stiffness,
        mass: MUELLE.mass,
        useNativeDriver: NATIVO,
      }),
    ]);
    // También avisa si se corta: quien lo montó no puede quedarse esperando.
    animacion.start(() => fin.current());
    return () => animacion.stop();
    // Se monta para UN salto: sus valores no cambian mientras vive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View {...resto} style={[style, { transform: [{ scale: escala }] }]}>
      {children}
    </Animated.View>
  );
}

type PropsDeEntrada = {
  /** Desde cuántos puntos llega. Positivo sube desde abajo; negativo baja. */
  desde: number;
  duracion: number;
  /** Milisegundos antes de empezar. */
  retraso?: number;
  /**
   * De qué elemento es esta entrada. En una lista que recicla filas, al
   * cambiar se vuelve a decidir: entra de nuevo, o se pone en su sitio.
   */
  clave?: string;
  /** Este elemento ya está en su sitio: no entra. */
  quieta?: boolean;
  /** Ya está en su sitio. Sin esto, se queda montado (y quieto). */
  alTerminar?: () => void;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

/** Algo que entra: aparece y recorre unos puntos hasta su sitio. Una vez por elemento. */
export function EntradaBreve({
  desde,
  duracion,
  retraso = 0,
  clave,
  quieta = false,
  alTerminar,
  style,
  children,
}: PropsDeEntrada) {
  const avance = useRef(new Animated.Value(quieta ? 1 : 0)).current;
  const fin = useRef(alTerminar);
  fin.current = alTerminar;

  useEffect(() => {
    if (quieta) {
      // La fila pasó a un elemento que no entra: en su sitio, sin moverse.
      avance.setValue(1);
      return undefined;
    }
    avance.setValue(0);
    const animacion = Animated.timing(avance, {
      toValue: 1,
      duration: duracion,
      delay: retraso,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: NATIVO,
    });
    animacion.start(() => fin.current?.());
    return () => animacion.stop();
    // Al montar y al cambiar de elemento, no cuando el mismo elemento deja de
    // ser «nuevo»: ese ya entró.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  const translateY = avance.interpolate({ inputRange: [0, 1], outputRange: [desde, 0] });
  return (
    <Animated.View style={[style, { opacity: avance, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}
