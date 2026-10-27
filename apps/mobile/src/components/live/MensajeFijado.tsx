import React from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { sobreMedio } from '@/components/CapaDeContraste';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import type { MensajeDeEmision } from '@/repositories/LiveRepository';
import { radius, spacing } from '@/theme/tokens';

type Props = {
  mensaje: MensajeDeEmision;
  /** Quien gestiona la emisión puede soltarlo desde aquí. */
  puedeSoltar: boolean;
  ocupado: boolean;
  alSoltar: () => void;
};

/**
 * El mensaje que quien emite ha fijado.
 *
 * VA ENCIMA DEL CHAT Y NO DENTRO. Dentro se lo llevaría la conversación, que es
 * justo lo que se quiere evitar; y fuera de la lista no depende de que el
 * mensaje siga en la ventana de los últimos —quien entra una hora después lo
 * ve igual, aunque el original se escribiera mucho antes—.
 *
 * SE DISTINGUE DE UN MENSAJE NORMAL por tres cosas que no dependen del color:
 * la chincheta, el rótulo «Mensaje fijado» y un fondo opaco (los del chat son
 * translúcidos). Dos líneas como mucho: es un recordatorio, no un párrafo, y
 * cada línea de más se la quita al vídeo.
 */
export function MensajeFijado({ mensaje, puedeSoltar, ocupado, alSoltar }: Props) {
  const { t } = useTranslation();
  return (
    <View
      style={estilos.caja}
      accessible={!puedeSoltar}
      accessibilityRole="text"
      accessibilityLabel={t('live.pinnedA11y', {
        nombre: mensaje.usuarioNombre,
        texto: mensaje.cuerpo,
      })}
    >
      <MaterialCommunityIcons name="pin" size={15} color={sobreMedio.text} style={estilos.chincheta} />
      <View style={estilos.textos}>
        <Text variant="caption" weight="800" color={sobreMedio.textMuted} numberOfLines={1}>
          {t('live.pinned')}
          {'  ·  '}
          {mensaje.usuarioNombre}
        </Text>
        <Text variant="secondary" weight="600" color={sobreMedio.text} numberOfLines={2}>
          {mensaje.cuerpo}
        </Text>
      </View>
      {puedeSoltar ? (
        <Pulsable
          onPress={alSoltar}
          disabled={ocupado}
          opacidad={ocupado ? 0.45 : 1}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('live.unpin')}
          accessibilityState={{ disabled: ocupado }}
          style={estilos.soltar}
        >
          <Feather name="x" size={16} color={sobreMedio.text} />
        </Pulsable>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  caja: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    // Opaco: lo fijado se lee sobre cualquier imagen, también una clara.
    backgroundColor: 'rgba(0,0,0,0.78)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: sobreMedio.glassBorder,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    marginBottom: spacing.xs,
  },
  chincheta: { marginTop: 2 },
  textos: { flexShrink: 1, gap: 1 },
  soltar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
    marginTop: -2,
  },
});
