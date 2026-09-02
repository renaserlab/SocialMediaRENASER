import React, { useEffect, useState } from 'react';
import { LayoutChangeEvent, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { ScrimDeMedio, SOMBRA_DE_TEXTO } from '@/components/CapaDeContraste';
import { Text } from '@/components/Text';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { getFontFamily, palette, spacing } from '@/theme/tokens';

const media = palette('dark');

/** Ancho de cada hueco. Fijo a proposito: centrar es entonces una resta. */
const ANCHO = 116;

export type ModoDeCreacion = 'publicacion' | 'historia' | 'reel' | 'vivo';

// La etiqueta se guarda como CLAVE, no como texto: el rotulo se resuelve al
// pintar, que es cuando se sabe en que idioma esta la aplicacion.
export const MODOS: Array<{ id: ModoDeCreacion; clave: TranslationKey }> = [
  { id: 'publicacion', clave: 'create.modePost' },
  { id: 'historia', clave: 'create.modeStory' },
  { id: 'reel', clave: 'create.modeReel' },
  { id: 'vivo', clave: 'create.modeLive' },
];

export function posicionDeModo(modo: ModoDeCreacion): number {
  return MODOS.findIndex((m) => m.id === modo);
}

/**
 * Lee el modo que llega por la URL (`/(tabs)/create?modo=historia`).
 *
 * Existe para que TODOS los accesos a crear contenido —el `+` de la cabecera de
 * Inicio, el de la fila de historias, el del muro y la propia pestaña— entren
 * por la misma puerta y solo se diferencien en con que modo abren. Cualquier
 * valor que no reconozcamos cae en Publicacion, que es el modo por defecto.
 */
export function modoDesdeParametro(valor: unknown): ModoDeCreacion {
  return MODOS.some((m) => m.id === valor) ? (valor as ModoDeCreacion) : 'publicacion';
}

type Props = {
  activo: ModoDeCreacion;
  alCambiar: (modo: ModoDeCreacion) => void;
  /**
   * Avance del arrastre en curso, de -1 a 1. Lo aporta la pantalla mientras el
   * dedo se mueve para que la fila SIGA al dedo en vez de saltar al soltar.
   */
  arrastre?: SharedValue<number>;
};

/**
 * Selector de tipo de publicacion, al pie de la pantalla de Crear.
 *
 * La fila se desplaza para que el modo activo quede siempre en el centro, que
 * es lo que convierte cuatro palabras sueltas en algo que se entiende como un
 * carrete. Se cambia tocando una etiqueta o arrastrando en horizontal sobre la
 * pantalla; mientras el dedo se mueve la fila lo acompana (`arrastre`), asi
 * que se ve a donde se va antes de soltar.
 */
export function SelectorDeModo({ activo, alCambiar, arrastre }: Props) {
  const { t } = useTranslation();
  const indice = useSharedValue(posicionDeModo(activo));

  /*
    Ancho real de la franja, medido.

    Hace falta para poder centrar el modo ACTIVO. Antes solo se centraba la
    fila entera —cuatro huecos de 116, es decir 464 px— dentro de una pantalla
    de 375: sobraban 44,5 px por cada lado y las etiquetas de los extremos
    salian cortadas por la mitad. Es el «cación … Viv» del documento, no un
    fallo de fuente ni de recorte.

    Con el ancho se puede desplazar la fila para que el hueco elegido caiga
    justo en el centro, que es lo que hace que se lea como un carrete.
  */
  const [ancho, setAncho] = useState(0);
  const alMedir = (evento: LayoutChangeEvent) => setAncho(evento.nativeEvent.layout.width);

  useEffect(() => {
    // 180 ms: dentro del rango que se percibe como respuesta y no como
    // animacion, el mismo criterio que usa la barra de secciones.
    indice.value = withTiming(posicionDeModo(activo), {
      duration: 180,
      easing: Easing.out(Easing.cubic),
    });
  }, [activo, indice]);

  // Cuanto hay que correr la fila para que el primer hueco quede centrado.
  const centrado = ancho > 0 ? (ancho - ANCHO) / 2 : 0;

  const estilo = useAnimatedStyle(() => ({
    transform: [{ translateX: centrado - (indice.value + (arrastre?.value ?? 0)) * ANCHO }],
  }));

  return (
    <View style={styles.host} pointerEvents="box-none" onLayout={alMedir}>
      {/*
        Estas etiquetas van sobre la camara EN VIVO: el fondo cambia cada
        fotograma, asi que ningun color fijo las hace legibles siempre. El velo
        pone un suelo constante debajo.
      */}
      <ScrimDeMedio borde="abajo" alto={64} style={styles.velo} />
      <Animated.View style={[styles.fila, estilo]}>
        {MODOS.map(({ id, clave }) => {
          const etiqueta = t(clave);
          const seleccionado = id === activo;
          return (
            <Pressable
              key={id}
              onPress={() => alCambiar(id)}
              style={styles.hueco}
              accessibilityRole="tab"
              accessibilityState={{ selected: seleccionado }}
              accessibilityLabel={etiqueta}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.etiqueta,
                  SOMBRA_DE_TEXTO,
                  { color: seleccionado ? media.text : media.textMuted },
                  seleccionado ? styles.activa : null,
                ]}
              >
                {etiqueta}
              </Text>
            </Pressable>
          );
        })}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    // Recorta lo que se sale por los lados: sin esto las etiquetas de los
    // extremos se dibujarian fuera y ensancharian la pantalla.
    overflow: 'hidden',
    justifyContent: 'center',
    height: 40,
  },
  /*
    `alignSelf: flex-start` es lo que permite centrar el hueco ACTIVO en vez de
    la fila entera. Con el centrado de la caja, la fila se colocaba por su
    punto medio —entre Historia y Reel— y desde ahi ningun desplazamiento podia
    dejar bien Publicacion ni Vivo.
  */
  // Cubre el alto del selector sin empujar nada: va detras de la fila.
  velo: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  fila: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  hueco: { width: ANCHO, alignItems: 'center', justifyContent: 'center', minHeight: 40 },
  etiqueta: {
    fontSize: 14,
    fontFamily: getFontFamily('600'),
    fontWeight: Platform.OS === 'ios' ? '600' : undefined,
    paddingHorizontal: spacing.sm,
  },
  activa: {
    fontFamily: getFontFamily('800'),
    fontWeight: Platform.OS === 'ios' ? '800' : undefined,
  },
});
