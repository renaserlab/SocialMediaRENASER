import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { useTranslation } from '@/i18n/useTranslation';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageStoryContext } from '@/types';

/**
 * La cinta que va ENCIMA del texto cuando un mensaje responde a una historia.
 *
 * QUE PROBLEMA RESUELVE. Sin ella, «jajaja qué bueno» aparece en el chat sin
 * nada delante y no se entiende: quien lo recibe no sabe a qué se refiere, y
 * quien lo escribió tampoco lo sabrá dentro de una semana. La cinta dice a qué
 * respondía, y lo dice con estructura —no con un enlace pegado dentro del
 * texto, que es el atajo que el encargo prohíbe expresamente—.
 *
 * LOS DOS ESTADOS, Y EL SEGUNDO ES EL NORMAL:
 *
 *  - LA HISTORIA SIGUE AHI: se ve su miniatura y de quién es.
 *  - LA HISTORIA YA NO EXISTE: «Historia no disponible», sin miniatura, pero
 *    diciendo todavía de quién era. Y esto NO es el caso raro: una historia
 *    dura 24 horas y el mensaje dura para siempre, así que pasado un día TODAS
 *    las respuestas del historial están en este estado. Es el que hay que
 *    diseñar bien, no el que hay que tolerar.
 *
 * La cinta se pinta atenuada y con una barra lateral, como una cita: tiene que
 * leerse como contexto de otra persona, no como parte de lo que se escribió.
 */

type Props = {
  contexto: MessageStoryContext;
  /** Va dentro de una burbuja propia: el texto va sobre el color primario. */
  mio?: boolean;
};

export function RespuestaAHistoria({ contexto, mio = false }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const color = mio ? colors.onPrimary : colors.text;

  return (
    <View
      style={[
        styles.cinta,
        { borderLeftColor: color, backgroundColor: mio ? 'rgba(0,0,0,0.12)' : colors.surfaceAlt },
      ]}
    >
      <View style={styles.texto}>
        <Text numberOfLines={1} style={[styles.quien, { color, opacity: 0.9 }]}>
          {t('chat.storyReplyTo', { nombre: contexto.autor.nombre })}
        </Text>
        <Text numberOfLines={1} style={[styles.detalle, { color, opacity: 0.7 }]}>
          {contexto.disponible
            ? contexto.caption || t('chat.storyReplyHint')
            : /*
                LO QUE SE VE CUANDO LA HISTORIA SE FUE. No es un error ni un
                hueco: es lo que de verdad ha pasado, dicho con todas las
                letras. El mensaje sigue enteramente legible.
              */
              t('chat.storyGone')}
        </Text>
      </View>

      {contexto.disponible && contexto.mediaUrl ? (
        <View>
          <ExpoImage
            source={{ uri: contexto.mediaUrl }}
            style={styles.mini}
            contentFit="cover"
            transition={120}
          />
          {contexto.mediaType === 'video' ? (
            <View style={styles.play} pointerEvents="none">
              <Feather name="play" size={10} color="#FFF" />
            </View>
          ) : null}
        </View>
      ) : (
        /*
          El hueco de la miniatura se RESERVA aunque no haya nada que enseñar.
          Sin él, la cinta de una historia caducada es más estrecha que la de una
          vigente y el historial da un tirón cada vez que aparece una de cada.
        */
        <View style={[styles.mini, styles.miniVacia, { borderColor: color }]}>
          <Feather name="clock" size={14} color={color} style={{ opacity: 0.55 }} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cinta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    marginBottom: 6,
  },
  texto: { flex: 1, gap: 1 },
  quien: { fontSize: 11, fontWeight: '700' },
  detalle: { fontSize: 11 },
  mini: { width: 34, height: 44, borderRadius: 6 },
  miniVacia: {
    borderWidth: 1,
    opacity: 0.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  play: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
