import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { sobreMedio } from '@/components/CapaDeContraste';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { duracionLegible, tamanoLegible, type Grabacion } from '@/live/grabacion';
import { LiveRepository } from '@/repositories/LiveRepository';
import { radius, spacing } from '@/theme/tokens';

type Props = {
  emisionId: string;
  /** Si abrir el enlace falla, se cuenta por la banda de avisos de la sala. */
  alFallar: (texto: string) => void;
};

/**
 * Descargar la grabación del directo, para quien lo emitió (prototipo).
 *
 * SOLO APARECE SI HAY ALGO QUE DECIR. Si el servidor no tiene la función, no
 * se pinta nada. Si la tiene pero aún no ha llegado ninguna grabación, se dice
 * —el proveedor la prepara unos minutos después de terminar— y se deja volver
 * a comprobar: no se promete una descarga que, con la grabación apagada en el
 * panel del proveedor, no va a llegar.
 *
 * El enlace se abre FUERA (el navegador del teléfono lo descarga o lo
 * reproduce): es un fichero grande y el sistema ya sabe qué hacer con él.
 */
export function DescargaDeGrabacion({ emisionId, alFallar }: Props) {
  const { t } = useTranslation();
  const [grabacion, setGrabacion] = useState<Grabacion | null>(null);
  const [comprobando, setComprobando] = useState(false);

  const comprobar = useCallback(async () => {
    setComprobando(true);
    try {
      setGrabacion(await LiveRepository.grabacion(emisionId));
    } finally {
      setComprobando(false);
    }
  }, [emisionId]);

  useEffect(() => {
    void comprobar();
  }, [comprobar]);

  if (!grabacion || grabacion.estado === 'sin_funcion') return null;

  if (grabacion.estado === 'pendiente') {
    return (
      <View style={estilos.caja}>
        <Text variant="caption" color={sobreMedio.textMuted} style={estilos.centrado}>
          {t('live.recordingPending')}
        </Text>
        <Pulsable
          onPress={() => void comprobar()}
          disabled={comprobando}
          hitSlop={8}
          accessibilityRole="button"
          style={estilos.secundario}
        >
          {comprobando ? (
            <ActivityIndicator size="small" color={sobreMedio.text} />
          ) : (
            <Text variant="caption" weight="800" color={sobreMedio.text}>
              {t('live.recordingCheckAgain')}
            </Text>
          )}
        </Pulsable>
      </View>
    );
  }

  const detalle = [duracionLegible(grabacion.duracionS), tamanoLegible(grabacion.tamanoBytes)]
    .filter(Boolean)
    .join(' · ');
  const url = grabacion.url;

  return (
    <View style={estilos.caja}>
      <Pulsable
        onPress={() => {
          if (url) Linking.openURL(url).catch(() => alFallar(t('live.recordingOpenFailed')));
        }}
        accessibilityRole="button"
        accessibilityLabel={t('live.recordingDownload')}
        style={estilos.boton}
      >
        <Feather name="download" size={16} color={sobreMedio.text} />
        <Text variant="body" weight="800" color={sobreMedio.text}>
          {t('live.recordingDownload')}
        </Text>
      </Pulsable>
      <Text variant="caption" color={sobreMedio.textMuted} style={estilos.centrado}>
        {detalle ? `${detalle} · ` : ''}
        {t('live.recordingExpires')}
      </Text>
    </View>
  );
}

const estilos = StyleSheet.create({
  caja: { alignSelf: 'stretch', alignItems: 'center', gap: spacing.xs, marginTop: spacing.sm },
  centrado: { textAlign: 'center' },
  boton: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: 46,
    borderWidth: 1,
    borderColor: sobreMedio.text,
    borderRadius: radius.pill,
  },
  secundario: { minHeight: 32, justifyContent: 'center', paddingHorizontal: spacing.md },
});
