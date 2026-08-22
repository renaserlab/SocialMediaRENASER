import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import {
  abrirAjustes,
  textoDePermiso,
  type EstadoDePermiso,
  type TipoDePermiso,
} from '@/lib/permisos';
import { palette, radius, spacing } from '@/theme/tokens';

const media = palette('dark');

type Props = {
  tipo: TipoDePermiso;
  estado: EstadoDePermiso;
  /** Volver a pedirlo. Solo tiene sentido si el estado lo permite. */
  alPedir: () => void;
  /** Salida alternativa cuando el permiso no se va a conceder. */
  alternativa?: { etiqueta: string; alPulsar: () => void };
};

/**
 * Lo que se pinta cuando falta un permiso.
 *
 * Un permiso denegado no es un error: es una decision de la persona, y la
 * pantalla tiene que seguir siendo util. Por eso siempre hay salida —pedirlo
 * otra vez, ir a los ajustes cuando ya no se puede preguntar, o hacer lo mismo
 * por otro camino (elegir de la galeria en vez de grabar)—, nunca un callejon
 * sin nada que tocar.
 */
export function AvisoDePermiso({ tipo, estado, alPedir, alternativa }: Props) {
  const texto = textoDePermiso(tipo, estado);
  const icono: keyof typeof Feather.glyphMap =
    tipo === 'camara' ? 'camera-off' : tipo === 'microfono' ? 'mic-off' : 'image';

  return (
    <View style={styles.raiz}>
      <View style={[styles.icono, { borderColor: media.border }]}>
        <Feather name={icono} size={26} color={media.text} />
      </View>
      <Text variant="title" weight="800" color={media.text} style={styles.centrado}>
        {texto.titulo}
      </Text>
      <Text variant="body" color={media.textMuted} style={styles.centrado}>
        {texto.cuerpo}
      </Text>

      <View style={styles.acciones}>
        <Pressable
          onPress={texto.vaAAjustes ? abrirAjustes : alPedir}
          style={[styles.boton, { backgroundColor: media.text }]}
          accessibilityRole="button"
        >
          <Text variant="body" weight="700" color={media.background}>
            {texto.accion}
          </Text>
        </Pressable>
        {alternativa ? (
          <Pressable
            onPress={alternativa.alPulsar}
            style={[styles.boton, styles.botonSecundario, { borderColor: media.border }]}
            accessibilityRole="button"
          >
            <Text variant="body" weight="700" color={media.text}>
              {alternativa.etiqueta}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    backgroundColor: media.background,
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
  acciones: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, flexWrap: 'wrap', justifyContent: 'center' },
  boton: {
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
  },
  botonSecundario: { borderWidth: 1 },
});
