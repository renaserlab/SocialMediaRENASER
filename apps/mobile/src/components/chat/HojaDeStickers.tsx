import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/BottomSheet';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { PAQUETES_DE_STICKERS, type PaqueteDeStickers } from '@/lib/stickers';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const NOMBRE: Record<PaqueteDeStickers['clave'], TranslationKey> = {
  caras: 'stickers.faces',
  gestos: 'stickers.gestures',
  celebrar: 'stickers.celebrate',
  estudio: 'stickers.study',
};

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Se llama con el sticker elegido. Quien llama lo manda y cierra la hoja. */
  alElegir: (sticker: string) => void;
  /** El título de la hoja; por omisión, «Stickers». Reaccionar usa otro. */
  titulo?: string;
};

/**
 * El panel de stickers: cuatro paquetes y, en cada uno, sus stickers.
 *
 * Tocar uno lo elige de inmediato. No hay «confirmar»: un sticker se manda
 * como se manda un gesto, y un segundo toque para confirmarlo lo estropearía.
 */
export function HojaDeStickers({ visible, onClose, alElegir, titulo }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [abierto, setAbierto] = useState<PaqueteDeStickers['clave']>('caras');
  const paquete =
    PAQUETES_DE_STICKERS.find((p) => p.clave === abierto) ?? PAQUETES_DE_STICKERS[0];

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.cuerpo}>
        <Text weight="800" style={styles.titulo}>
          {titulo ?? t('stickers.title')}
        </Text>

        <View style={styles.pestanas} accessibilityRole="tablist">
          {PAQUETES_DE_STICKERS.map((p) => {
            const elegido = p.clave === abierto;
            return (
              <Pressable
                key={p.clave}
                onPress={() => setAbierto(p.clave)}
                accessibilityRole="tab"
                accessibilityState={{ selected: elegido }}
                accessibilityLabel={t(NOMBRE[p.clave])}
                style={[
                  styles.pestana,
                  {
                    borderColor: elegido ? colors.primary : colors.border,
                    backgroundColor: elegido ? colors.surfaceAlt : 'transparent',
                  },
                ]}
              >
                <Text style={styles.iconoDePestana}>{p.icono}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.rejilla}>
          {(paquete?.stickers ?? []).map((sticker) => (
            <Pressable
              key={sticker}
              onPress={() => alElegir(sticker)}
              accessibilityRole="button"
              accessibilityLabel={t('stickers.send', { sticker })}
              style={({ pressed }) => [
                styles.celda,
                pressed && { backgroundColor: colors.surfaceAlt },
              ]}
            >
              <Text style={styles.sticker}>{sticker}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  cuerpo: { padding: spacing.md, gap: spacing.md },
  titulo: { fontSize: 17 },
  pestanas: { flexDirection: 'row', gap: spacing.sm },
  pestana: {
    width: 48,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconoDePestana: { fontSize: 20 },
  rejilla: { flexDirection: 'row', flexWrap: 'wrap' },
  // Cuatro por fila: el dedo acierta sin apuntar.
  celda: {
    width: '25%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  sticker: { fontSize: 40, lineHeight: 50 },
});
