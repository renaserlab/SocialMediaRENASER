import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { FEATURE_LIVE } from '@/config/features';
import { palette, radius, spacing } from '@/theme/tokens';

const media = palette('dark');

type Props = {
  pie?: React.ReactNode;
  espacioInferior: number;
  /** Salida util: lo mas parecido que SI se puede hacer hoy. */
  alGrabarReel: () => void;
};

/**
 * Modo "Vivo" de Crear.
 *
 * No emite nada, y lo dice. El proyecto no tiene infraestructura de directo
 * —no hay punto de ingesta, ni reparto en tiempo real, ni entidad de emision,
 * ni moderacion de directo— y lo unico que habia era una pantalla que
 * reproducia un video de ejemplo con un chat guardado en memoria. Ensenar eso
 * como si fuera una emision es exactamente lo que el documento prohibe.
 *
 * El detalle del bloqueo y lo que hace falta para levantarlo esta junto a
 * `FEATURE_LIVE` en `config/features.ts`. Cuando exista proveedor, este modo
 * pasa a abrir la emision y el resto de la pantalla no cambia.
 */
export function ModoVivo({ pie, espacioInferior, alGrabarReel }: Props) {
  return (
    <View style={[styles.raiz, { paddingBottom: espacioInferior }]}>
      <View style={styles.centro}>
        <View style={[styles.icono, { borderColor: media.border }]}>
          <Feather name="radio" size={26} color={media.text} />
        </View>
        <Text variant="title" weight="800" color={media.text} style={styles.centrado}>
          Emitir en vivo todavía no está disponible
        </Text>
        <Text variant="body" color={media.textMuted} style={styles.centrado}>
          {FEATURE_LIVE
            ? 'Estamos preparando tu emisión.'
            : 'Estamos montando la infraestructura de directo. Preferimos no ' +
              'darte un botón que no emita de verdad.'}
        </Text>

        <Pressable
          onPress={alGrabarReel}
          style={[styles.boton, { backgroundColor: media.text }]}
          accessibilityRole="button"
        >
          <Text variant="body" weight="700" color={media.background}>
            Grabar un reel
          </Text>
        </Pressable>
      </View>

      {pie ? <View style={styles.pie}>{pie}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  icono: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  centrado: { textAlign: 'center' },
  boton: {
    marginTop: spacing.lg,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
  },
  pie: { paddingBottom: spacing.xl },
});
