import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Text } from '@/components/Text';
import { aspectoDeArchivo } from '@/lib/mediosDeChat';
import { iconoDeTarjeta } from '@/lib/nombresDeAdjuntos';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

type Props = {
  adjunto: Pick<MessageAttachment, 'kind' | 'title' | 'voiceNote' | 'mimeType' | 'fileName'>;
  /** Va en una burbuja propia: la tinta es la de esa burbuja. */
  mio: boolean;
  /** Solo la línea de debajo del título (en Contenido, quién y cuándo). */
  pie?: string;
  style?: StyleProp<ViewStyle>;
};

/** El lado del cuadrito del tipo, el del lienzo aprobado. */
export const LADO_DEL_CUADRITO = 40;

/**
 * La cabecera de LA TARJETA (audios y temas, 30/10/2026): el cuadrito con el
 * tipo y el nombre que le pusieron, encima del contenido de siempre.
 *
 * SOLO EXISTE CON NOMBRE. Sin él no pinta nada y la burbuja se ve exactamente
 * como antes, que es lo que pidió el lienzo («Sin nombre (como hoy)»).
 *
 * El tipo se dice con la forma, no con el color: micrófono para una nota de
 * voz, nota musical para un archivo de audio, cámara para un video y la sigla
 * en un documento. Todo con tokens del tema: el cuadrito de una burbuja ajena
 * es la superficie con su borde; el de una propia, la tinta de la burbuja muy
 * rebajada, que se lee igual en claro y en oscuro.
 *
 * No es pulsable: va como HERMANO de lo que se toca (el play, la descarga, el
 * video), nunca envolviéndolo. En la web un botón dentro de otro es HTML
 * inválido.
 */
export function CabeceraDeAdjunto({ adjunto, mio, pie, style }: Props) {
  const { colors } = useAppTheme();
  const titulo = adjunto.title?.trim();
  if (!titulo || adjunto.kind === 'image') return null;

  const tinta = mio ? colors.sobreBurbujaPropia : colors.text;
  const icono = iconoDeTarjeta(adjunto);
  const aspecto = icono ? null : aspectoDeArchivo(adjunto.mimeType, adjunto.fileName);

  return (
    <View style={[styles.fila, style]}>
      <View
        style={[
          styles.cuadrito,
          mio ? null : { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        {mio ? (
          // El relleno de la propia es la tinta de la burbuja, muy rebajada:
          // un cuadrito más claro sobre negro y más oscuro sobre blanco.
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: tinta, opacity: 0.16 }]}
          />
        ) : null}
        {icono ? (
          <Feather name={icono} size={18} color={tinta} />
        ) : aspecto?.sigla ? (
          <Text weight="800" numberOfLines={1} color={tinta} style={styles.sigla}>
            {aspecto.sigla}
          </Text>
        ) : (
          <Feather name={aspecto?.icono ?? 'file'} size={18} color={tinta} />
        )}
      </View>
      <View style={styles.textos}>
        <Text weight="700" numberOfLines={2} color={tinta} style={styles.titulo}>
          {titulo}
        </Text>
        {pie ? (
          <Text numberOfLines={1} color={tinta} style={styles.pie}>
            {pie}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2 },
  cuadrito: {
    width: LADO_DEL_CUADRITO,
    height: LADO_DEL_CUADRITO,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sigla: { fontSize: 11, lineHeight: 14, letterSpacing: 0.3 },
  textos: { flex: 1, minWidth: 0 },
  titulo: { fontSize: 14, lineHeight: 18 },
  pie: { fontSize: 12, lineHeight: 16, opacity: 0.75 },
});
