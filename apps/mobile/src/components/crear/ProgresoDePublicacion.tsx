import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import type { FaseDePublicacion } from '@/hooks/usePublicacion';
import { palette, radius, spacing } from '@/theme/tokens';

const media = palette('dark');

const TEXTO: Partial<Record<FaseDePublicacion, string>> = {
  comprimiendo: 'Optimizando…',
  subiendo: 'Subiendo…',
  publicando: 'Publicando…',
};

type Props = {
  fase: FaseDePublicacion;
  progreso: number;
  error: string | null;
  puedeReintentar: boolean;
  alReintentar: () => void;
  alCancelar: () => void;
  /** Paleta clara para el editor de texto; oscura sobre la camara. */
  sobreOscuro?: boolean;
  colores?: { texto: string; suave: string; borde: string; peligro: string };
};

/**
 * Lo que pasa mientras algo se publica, y que hacer si sale mal.
 *
 * Sin esto, subir un video de dos minutos era un boton girando: nadie sabia si
 * quedaba mucho, si se habia colgado, ni que hacer cuando fallaba salvo
 * empezar de cero —y volver a empezar es justo lo que produce publicaciones
 * duplicadas—. Aqui siempre hay tres cosas: en que va, cuanto lleva y una
 * salida (cancelar mientras sube, reintentar si fallo).
 */
export function ProgresoDePublicacion({
  fase,
  progreso,
  error,
  puedeReintentar,
  alReintentar,
  alCancelar,
  sobreOscuro = true,
  colores,
}: Props) {
  const c = colores ?? {
    texto: media.text,
    suave: media.textMuted,
    borde: media.border,
    peligro: media.danger,
  };

  if (fase === 'error') {
    return (
      <View style={[styles.caja, { borderColor: c.peligro }]}>
        <Feather name="alert-triangle" size={18} color={c.peligro} />
        <View style={styles.contenido}>
          <Text variant="secondary" weight="700" color={c.peligro}>
            {error ?? 'No se pudo publicar.'}
          </Text>
          {puedeReintentar ? (
            <Pressable
              onPress={alReintentar}
              style={[styles.boton, { borderColor: c.borde }]}
              accessibilityRole="button"
            >
              <Text variant="secondary" weight="700" color={c.texto}>
                Reintentar
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  const enMarcha = fase === 'comprimiendo' || fase === 'subiendo' || fase === 'publicando';
  if (!enMarcha) return null;

  return (
    <View style={[styles.caja, { borderColor: c.borde }]}>
      <View style={styles.contenido}>
        <View style={styles.fila}>
          <Text variant="secondary" weight="600" color={c.suave}>
            {TEXTO[fase]}
          </Text>
          {fase !== 'publicando' ? (
            <Text variant="secondary" weight="600" color={c.suave}>
              {Math.round(progreso * 100)}%
            </Text>
          ) : null}
        </View>
        <View style={[styles.pista, { backgroundColor: sobreOscuro ? '#FFFFFF22' : c.borde }]}>
          <View
            style={[
              styles.relleno,
              { width: `${Math.max(2, progreso * 100)}%`, backgroundColor: c.texto },
            ]}
          />
        </View>
        {/*
          Cancelar solo mientras hay algo que cancelar. Durante «Publicando» ya
          se ha soltado la peticion al servidor y ofrecer una salida que no
          existe seria peor que no ofrecerla.
        */}
        {fase !== 'publicando' ? (
          <Pressable
            onPress={alCancelar}
            hitSlop={8}
            style={styles.cancelar}
            accessibilityRole="button"
          >
            <Text variant="caption" weight="700" color={c.suave}>
              Cancelar
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  caja: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  contenido: { flex: 1, gap: spacing.sm },
  fila: { flexDirection: 'row', justifyContent: 'space-between' },
  pista: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  relleno: { height: '100%', borderRadius: radius.pill },
  boton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    minHeight: 36,
    justifyContent: 'center',
  },
  cancelar: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
});
