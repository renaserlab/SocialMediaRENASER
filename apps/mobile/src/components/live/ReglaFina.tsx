import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Platform,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from 'react-native';

import { Text } from '@/components/Text';
import { haptics } from '@/lib/haptics';
import { crearLimitador, type Limitador } from '@/live/mejorasDeVideo';
import { fraccionDe, pasoEnLaRegla, tramoRelleno, valorEn, type Regla } from '@/live/reglaFina';
import { hojaDelRotulo as tinta, spacing } from '@/theme/tokens';

/** Dos toques en menos de esto, y cerca, vuelven al imán. */
const DOBLE_TOQUE_MS = 320;
const DOBLE_TOQUE_PX = 32;

/** Lo que queda libre a cada lado del carril, para que el pulgar no se corte. */
const MARGEN_DEL_CARRIL = 8;

/**
 * Cada cuánto llega a la pantalla un valor mientras se arrastra. El texto de
 * detrás se repinta con cada uno: sin esto, la pantalla entera del directo se
 * volvería a pintar con cada punto que se mueve el dedo.
 */
const INTERVALO_DE_PINTADO_MS = 50;

type Props = {
  regla: Regla;
  valor: number;
  /** Lo que dice el lector de pantalla: «Tamaño», «Giro». */
  etiqueta: string;
  /** El valor escrito: «100 %», «0°». */
  texto: (valor: number) => string;
  alCambiar: (valor: number) => void;
};

/**
 * La barra fina de la hoja del texto (tamaño y giro), la misma que la de
 * «Mejorar»: arrastrar, tocar para saltar, doble toque al imán y el número al
 * lado. Con lector de pantalla es un regulador, y en la web se lleva también
 * con las flechas.
 *
 * `PanResponder` y no el gestor de gestos: va dentro de un `Modal`, que en
 * Android es otra ventana y pediría su propia raíz de gestos.
 */
export function ReglaFina({ regla, valor, etiqueta, texto, alCambiar }: Props) {
  const [arrastrando, setArrastrando] = useState<number | null>(null);
  const ancho = useRef(0);
  const inicio = useRef<number | null>(null);
  const ultimoToque = useRef({ t: 0, x: 0 });
  const ultimo = useRef(valor);
  if (inicio.current === null) ultimo.current = valor;

  const avisar = useRef(alCambiar);
  avisar.current = alCambiar;
  const limitador = useRef<Limitador<number> | null>(null);
  if (!limitador.current) {
    limitador.current = crearLimitador<number>({
      intervaloMs: INTERVALO_DE_PINTADO_MS,
      ahora: () => Date.now(),
      programar: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      enviar: (v) => avisar.current(v),
    });
  }
  // Desmontarla a mitad de un arrastre deja lo último: es lo que se eligió.
  useEffect(() => () => limitador.current?.soltar(), []);

  const reglaActual = useRef(regla);
  reglaActual.current = regla;

  const responder = useMemo(() => {
    const desdeX = (x: number) =>
      valorEn(
        (x - MARGEN_DEL_CARRIL) / Math.max(1, ancho.current - 2 * MARGEN_DEL_CARRIL),
        reglaActual.current,
      );
    const mover = (x: number) => {
      const v = desdeX(x);
      if (v === ultimo.current) return;
      if (v === reglaActual.current.iman) haptics.seleccion();
      ultimo.current = v;
      setArrastrando(v);
      limitador.current?.empujar(v);
    };
    const terminar = () => {
      if (inicio.current === null) return;
      inicio.current = null;
      limitador.current?.soltar();
      setArrastrando(null);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (evento) => {
        const x = evento.nativeEvent.locationX;
        const ahora = Date.now();
        const anterior = ultimoToque.current;
        if (ahora - anterior.t < DOBLE_TOQUE_MS && Math.abs(x - anterior.x) < DOBLE_TOQUE_PX) {
          ultimoToque.current = { t: 0, x: 0 };
          inicio.current = null;
          limitador.current?.cancelar();
          setArrastrando(null);
          ultimo.current = reglaActual.current.iman;
          haptics.seleccion();
          avisar.current(reglaActual.current.iman);
          return;
        }
        ultimoToque.current = { t: ahora, x };
        inicio.current = x;
        mover(x);
      },
      onPanResponderMove: (_evento, gesto) => {
        if (inicio.current !== null) mover(inicio.current + gesto.dx);
      },
      onPanResponderRelease: terminar,
      onPanResponderTerminate: terminar,
    });
  }, []);

  const paso = (sentido: 1 | -1) => {
    const v = pasoEnLaRegla(valor, sentido, regla);
    if (v !== valor) alCambiar(v);
  };
  const alAccion = (evento: AccessibilityActionEvent) =>
    paso(evento.nativeEvent.actionName === 'increment' ? 1 : -1);

  // En la web, las flechas: el lector de pantalla del navegador no manda
  // «increment» ni «decrement».
  const teclado =
    Platform.OS === 'web'
      ? {
          tabIndex: 0,
          onKeyDown: (evento: { key: string; preventDefault: () => void }) => {
            const sentido =
              evento.key === 'ArrowRight' || evento.key === 'ArrowUp'
                ? 1
                : evento.key === 'ArrowLeft' || evento.key === 'ArrowDown'
                  ? -1
                  : 0;
            if (sentido === 0) return;
            evento.preventDefault();
            paso(sentido);
          },
        }
      : {};

  const pintado = arrastrando ?? valor;
  const relleno = tramoRelleno(pintado, regla);
  const enElIman = pintado === regla.iman;

  return (
    <View style={estilos.fila}>
      <View
        style={estilos.barra}
        onLayout={(evento: LayoutChangeEvent) => {
          ancho.current = evento.nativeEvent.layout.width;
        }}
        {...responder.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={etiqueta}
        accessibilityValue={{ min: regla.minimo, max: regla.maximo, now: valor, text: texto(valor) }}
        // La web ya no lee `accessibilityValue`: sin esto el regulador no
        // diría su valor en el navegador.
        aria-valuemin={regla.minimo}
        aria-valuemax={regla.maximo}
        aria-valuenow={valor}
        aria-valuetext={texto(valor)}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={alAccion}
        {...(teclado as object)}
      >
        {/* Nada de dentro recibe el dedo: las coordenadas son siempre de la barra. */}
        <View style={estilos.carril} pointerEvents="none">
          <View
            style={[
              estilos.relleno,
              { left: `${relleno.desde * 100}%`, width: `${(relleno.hasta - relleno.desde) * 100}%` },
            ]}
          />
          <View
            style={[
              estilos.muesca,
              {
                left: `${fraccionDe(regla.iman, regla) * 100}%`,
                backgroundColor: enElIman ? tinta.muescaEnganchada : tinta.muesca,
              },
            ]}
          />
          <View style={[estilos.pulgar, { left: `${fraccionDe(pintado, regla) * 100}%` }]} />
        </View>
      </View>
      <Text
        variant="caption"
        weight="600"
        color={tinta.texto}
        style={estilos.cifra}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {texto(pintado)}
      </Text>
    </View>
  );
}

const estilos = StyleSheet.create({
  fila: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  barra: { flex: 1, height: 36, justifyContent: 'center' },
  carril: {
    marginHorizontal: MARGEN_DEL_CARRIL,
    height: 2,
    borderRadius: 1,
    backgroundColor: tinta.carril,
  },
  relleno: { position: 'absolute', top: 0, bottom: 0, borderRadius: 1, backgroundColor: tinta.relleno },
  muesca: { position: 'absolute', top: -3, width: 2, height: 8, marginLeft: -1, borderRadius: 1 },
  pulgar: {
    position: 'absolute',
    top: -7,
    width: 16,
    height: 16,
    marginLeft: -8,
    borderRadius: 8,
    backgroundColor: tinta.pulgar,
    shadowColor: tinta.sombra,
    shadowOpacity: 0.6,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  cifra: { width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
