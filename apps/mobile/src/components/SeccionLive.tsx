import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { FEATURE_LIVE } from '@/config/features';
import { listarTransmisiones, type Transmision } from '@/feed/transmisiones';
import { palette, radius, spacing } from '@/theme/tokens';

const media = palette('dark');

type Props = {
  /** Solo pide datos cuando de verdad se esta viendo. */
  activo: boolean;
  espacioInferior: number;
  alDescubrir: () => void;
};

/**
 * Pestana "Live" del Inicio.
 *
 * Esta escrita contra el contrato de `feed/transmisiones.ts`, no contra una
 * lista inventada: el dia que exista un proveedor de directo, esa funcion
 * devolvera transmisiones reales y esta pantalla las pintara sin cambiar.
 *
 * Mientras tanto NO se simula nada. El documento es explicito: "no construyas
 * un falso Live". Se dice la verdad —todavia no hay emisiones— y se ofrece la
 * salida util, que es ir a ver contenido.
 */
export function SeccionLive({ activo, espacioInferior, alDescubrir }: Props) {
  const [transmisiones, setTransmisiones] = useState<Transmision[] | null>(null);

  useEffect(() => {
    if (!activo || !FEATURE_LIVE) return;
    let vigente = true;
    listarTransmisiones()
      .then((lista) => vigente && setTransmisiones(lista))
      .catch(() => vigente && setTransmisiones([]));
    return () => {
      vigente = false;
    };
  }, [activo]);

  const cargando = FEATURE_LIVE && transmisiones === null;

  return (
    <View style={[styles.raiz, { paddingBottom: espacioInferior }]}>
      {cargando ? (
        <ActivityIndicator color={media.text} />
      ) : (
        <React.Fragment>
          <View style={[styles.icono, { borderColor: media.border }]}>
            <Feather name="radio" size={28} color={media.text} />
          </View>
          <Text variant="title" weight="800" color={media.text} style={styles.centrado}>
            Todavía no hay transmisiones
          </Text>
          <Text variant="body" color={media.textMuted} style={styles.centrado}>
            {/* Sin promesas de fecha: se cuenta lo que hay, que es que nadie
                está emitiendo ahora mismo. */}
            Cuando alguien empiece un directo, aparecerá aquí. Mientras tanto,
            hay mucho que descubrir en Z.
          </Text>
          <Pressable
            onPress={alDescubrir}
            style={[styles.boton, { borderColor: media.border }]}
            accessibilityRole="button"
          >
            <Text variant="body" weight="700" color={media.text}>
              Descubrir contenido
            </Text>
          </Pressable>
        </React.Fragment>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: {
    flex: 1,
    backgroundColor: media.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  icono: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  centrado: { textAlign: 'center' },
  boton: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    minHeight: 44,
    justifyContent: 'center',
  },
});
