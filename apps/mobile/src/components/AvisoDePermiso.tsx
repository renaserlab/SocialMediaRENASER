import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Aparecer } from '@/components/Aparecer';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { retrasoEnCascada } from '@/lib/movimiento';
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
 *
 * ES LO PRIMERO QUE VE QUIEN VA A PUBLICAR sin haber dado el permiso, y se
 * reporto como «la peor vista de toda la aplicacion»: un icono pequeño, dos
 * frases y dos botones iguales sobre negro. Ahora las piezas entran una tras
 * otra, el icono tiene cuerpo, y cada boton dice con su icono a donde lleva:
 * el principal a los ajustes (o a volver a preguntar) y el secundario al
 * camino que SIEMPRE funciona, el carrete.
 */
export function AvisoDePermiso({ tipo, estado, alPedir, alternativa }: Props) {
  const texto = textoDePermiso(tipo, estado);
  const icono: keyof typeof Feather.glyphMap =
    tipo === 'camara' ? 'camera-off' : tipo === 'microfono' ? 'mic-off' : 'image';
  // A donde lleva el boton principal, dicho con un icono ademas de con texto.
  const iconoDeAccion: keyof typeof Feather.glyphMap = texto.vaAAjustes
    ? 'settings'
    : estado === 'denegado'
      ? 'refresh-cw'
      : 'check';

  return (
    <View style={styles.raiz}>
      <Aparecer>
        {/* Dos circulos concentricos: el de fuera da cuerpo sin añadir color. */}
        <View style={[styles.halo, { borderColor: media.border }]}>
          <View style={[styles.icono, { backgroundColor: media.surface, borderColor: media.glassBorder }]}>
            <Feather name={icono} size={30} color={media.text} />
          </View>
        </View>
      </Aparecer>

      <Aparecer retraso={retrasoEnCascada(1)} style={styles.textos}>
        <Text variant="title" weight="800" color={media.text} style={styles.centrado}>
          {texto.titulo}
        </Text>
        <Text variant="body" color={media.textMuted} style={styles.centrado}>
          {texto.cuerpo}
        </Text>
      </Aparecer>

      <Aparecer retraso={retrasoEnCascada(2)} style={styles.acciones}>
        <Pulsable
          onPress={texto.vaAAjustes ? abrirAjustes : alPedir}
          haptica="ligera"
          style={[styles.boton, { backgroundColor: media.text }]}
          accessibilityRole="button"
          accessibilityLabel={texto.accion}
        >
          <Feather name={iconoDeAccion} size={17} color={media.background} />
          <Text variant="body" weight="700" color={media.background}>
            {texto.accion}
          </Text>
        </Pulsable>
        {alternativa ? (
          <Pulsable
            onPress={alternativa.alPulsar}
            style={[styles.boton, styles.botonSecundario, { borderColor: media.glassBorder }]}
            accessibilityRole="button"
            accessibilityLabel={alternativa.etiqueta}
          >
            <Feather name="image" size={17} color={media.text} />
            <Text variant="body" weight="700" color={media.text}>
              {alternativa.etiqueta}
            </Text>
          </Pulsable>
        ) : null}
      </Aparecer>
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    backgroundColor: media.background,
  },
  halo: {
    width: 108,
    height: 108,
    borderRadius: 54,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icono: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textos: { gap: spacing.sm, alignItems: 'center' },
  centrado: { textAlign: 'center' },
  acciones: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  boton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: 48,
    justifyContent: 'center',
  },
  botonSecundario: { borderWidth: 1 },
});
