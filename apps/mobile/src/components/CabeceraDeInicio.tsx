import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PestanaDeInicio } from '@/feed/fuenteDeVideos';
import { getFontFamily, palette, spacing } from '@/theme/tokens';

// El Inicio es video a pantalla completa: siempre fondo oscuro, sea cual sea
// el tema de la aplicacion. Un texto en color de tema claro seria ilegible.
const media = palette('dark');

type Props = {
  activa: PestanaDeInicio;
  alCambiar: (pestana: PestanaDeInicio) => void;
  alCrear: () => void;
};

const PESTANAS: Array<{ id: PestanaDeInicio; etiqueta: string }> = [
  { id: 'paraTi', etiqueta: 'Para ti' },
  { id: 'siguiendo', etiqueta: 'Siguiendo' },
  { id: 'live', etiqueta: 'Live' },
];

/**
 * Cabecera del Inicio: crear, y las tres vistas del feed.
 *
 * Va ENCIMA del video, no sobre una banda solida: taparia la parte de arriba
 * del contenido, que es justo donde suele estar la cara de quien habla. El
 * degradado da contraste suficiente para leer los textos sin ocultar nada.
 *
 * Se cambia de vista PULSANDO, no arrastrando. Es deliberado: el arrastre
 * horizontal ya esta ocupado por el carrusel de secciones (Inicio ↔ Explorar ↔
 * Crear…), que es la navegacion principal de la aplicacion. Meter aqui un
 * segundo carrusel horizontal significaria que el mismo gesto hace dos cosas
 * distintas segun donde caiga el dedo, y la primera victima seria el gesto que
 * mas se usa.
 */
export function CabeceraDeInicio({ activa, alCambiar, alCrear }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { paddingTop: Math.max(insets.top, spacing.md) }]}
    >
      <LinearGradient
        colors={[media.overlay, 'transparent']}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <View style={styles.fila} pointerEvents="box-none">
        <Pressable
          onPress={alCrear}
          hitSlop={10}
          style={({ pressed }) => [
            styles.crear,
            { borderColor: media.border, opacity: pressed ? 0.6 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Crear contenido"
        >
          <Feather name="plus" size={20} color={media.text} />
        </Pressable>

        <View style={styles.pestanas} pointerEvents="box-none">
          {PESTANAS.map(({ id, etiqueta }) => {
            const seleccionada = id === activa;
            return (
              <Pressable
                key={id}
                onPress={() => alCambiar(id)}
                hitSlop={8}
                style={styles.pestana}
                accessibilityRole="tab"
                accessibilityState={{ selected: seleccionada }}
                accessibilityLabel={etiqueta}
              >
                <Text
                  style={[
                    styles.etiqueta,
                    { color: seleccionada ? media.text : media.textMuted },
                    seleccionada ? styles.etiquetaActiva : null,
                  ]}
                >
                  {etiqueta}
                </Text>
                {/* Subrayado: marca la vista activa sin depender solo del
                    color, que sobre un video claro casi no se distingue. */}
                <View
                  style={[
                    styles.subrayado,
                    { backgroundColor: seleccionada ? media.text : 'transparent' },
                  ]}
                />
              </Pressable>
            );
          })}
        </View>

        {/* Hueco simetrico al boton de crear: sin el, las pestanas quedarian
            descentradas hacia la derecha. */}
        <View style={styles.crear} pointerEvents="none" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingBottom: spacing.md,
    zIndex: 30,
  },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  crear: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pestanas: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  pestana: { alignItems: 'center', minHeight: 36, justifyContent: 'center' },
  etiqueta: {
    fontSize: 15,
    fontFamily: getFontFamily('700'),
    fontWeight: Platform.OS === 'ios' ? '700' : undefined,
  },
  etiquetaActiva: {
    fontFamily: getFontFamily('800'),
    fontWeight: Platform.OS === 'ios' ? '800' : undefined,
  },
  subrayado: { marginTop: 4, width: 20, height: 2, borderRadius: 1 },
});
