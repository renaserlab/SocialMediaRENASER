import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Pulsable } from '@/components/Pulsable';
import type { PestanaDeInicio } from '@/feed/fuenteDeVideos';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/i18n';
import { getFontFamily, palette, spacing } from '@/theme/tokens';

// El Inicio es video a pantalla completa: siempre fondo oscuro, sea cual sea
// el tema de la aplicacion. Un texto en color de tema claro seria ilegible.
const media = palette('dark');

type Props = {
  activa: PestanaDeInicio;
  alCambiar: (pestana: PestanaDeInicio) => void;
  alCrear: () => void;
};

// La etiqueta se guarda como CLAVE, no como texto: el rotulo se resuelve al
// pintar, que es cuando se sabe en que idioma esta la aplicacion.
const PESTANAS: Array<{ id: PestanaDeInicio; clave: TranslationKey }> = [
  { id: 'paraTi', clave: 'home.forYou' },
  { id: 'siguiendo', clave: 'home.following' },
  { id: 'live', clave: 'home.live' },
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
  const { t } = useTranslation();

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
        {/*
          El `+` es la puerta a publicar: lleva un fondo propio para que se
          lea como un boton sobre cualquier video —un contorno fino sobre una
          escena clara desaparecia— y se hunde al tocarlo, con un toque en la
          mano. Es de las pocas cosas de la cabecera que merecen vibrar.
        */}
        <Pulsable
          onPress={alCrear}
          hitSlop={10}
          escala={ESCALA_AL_PULSAR.icono}
          haptica="ligera"
          style={[styles.crear, { borderColor: media.border, backgroundColor: media.overlay }]}
          accessibilityRole="button"
          accessibilityLabel={t('home.createContent')}
        >
          <Feather name="plus" size={22} color={media.text} />
        </Pulsable>

        <View style={styles.pestanas} pointerEvents="box-none">
          {PESTANAS.map(({ id, clave }) => {
            const seleccionada = id === activa;
            const etiqueta = t(clave);
            return (
              <Pulsable
                key={id}
                onPress={() => alCambiar(id)}
                hitSlop={8}
                atenuar={0.6}
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
              </Pulsable>
            );
          })}
        </View>

        {/*
          Hueco simetrico al boton de crear: sin el, las pestañas quedarian
          descentradas hacia la derecha.

          Tiene estilo PROPIO. Antes reutilizaba `styles.crear`, que lleva
          `borderWidth: 1` y `borderRadius: 10`; el color del borde solo se le
          daba al boton de verdad, asi que este se quedaba con el negro por
          defecto y se dibujaba encima del video como un recuadro vacio en la
          esquina. Se veia, no hacia nada y nadie sabia que era. Un hueco solo
          tiene que ocupar sitio.
        */}
        <View style={styles.hueco} pointerEvents="none" />
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
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Mismo tamaño que el boton, cero decoracion: reserva sitio y nada mas.
  hueco: { width: 40, height: 40 },
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
