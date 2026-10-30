import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { BottomSheet } from '@/components/BottomSheet';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { etiquetaDeTemas, type TemaDeMensaje } from '@/lib/nombresDeAdjuntos';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  temas: readonly TemaDeMensaje[] | null | undefined;
  /** Con un tema: abrirlo. */
  alAbrirTema: (tema: TemaDeMensaje) => void;
  /** Con varios: la hoja con la lista. */
  alVerTemas: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * La etiqueta del tema, BAJO la burbuja y fuera de ella (audios y temas,
 * 30/10/2026). Dice a todos los miembros que ese mensaje de General ya está
 * guardado en un tema, y lleva a él.
 *
 * Una píldora gris con «#» y el nombre, o con capas y «En N temas». Lo que la
 * distingue es el icono y el texto, no un color. Sin temas no pinta nada: un
 * mensaje que no está en ninguno se ve como siempre.
 *
 * Va FUERA de la burbuja y como hermana suya: dentro sería un botón más en un
 * sitio donde ya hay otros (el play, la descarga), y en la web un botón dentro
 * de otro rompe la página.
 */
export function EtiquetaDeTemas({ temas, alAbrirTema, alVerTemas, style }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const etiqueta = etiquetaDeTemas(temas);
  if (etiqueta.tipo === 'ninguna') return null;

  const uno = etiqueta.tipo === 'uno';
  return (
    <Pressable
      onPress={() => (etiqueta.tipo === 'uno' ? alAbrirTema(etiqueta.tema) : alVerTemas())}
      accessibilityRole="button"
      accessibilityLabel={
        etiqueta.tipo === 'uno'
          ? t('topicChip.oneLabel', { nombre: etiqueta.tema.nombre })
          : t('topicChip.manyLabel', { n: etiqueta.cuantos })
      }
      // La píldora mide 28: el toque se agranda sin agrandar lo que se ve.
      hitSlop={8}
      style={({ pressed }) => [
        styles.pildora,
        { backgroundColor: colors.tarjetaRelleno, opacity: pressed ? 0.7 : 1 },
        style,
      ]}
    >
      <Feather name={uno ? 'hash' : 'layers'} size={12} color={colors.text} />
      <Text weight="600" numberOfLines={1} color={colors.text} style={styles.texto}>
        {etiqueta.tipo === 'uno' ? etiqueta.tema.nombre : t('topicChip.many', { n: etiqueta.cuantos })}
      </Text>
      <Feather name="chevron-right" size={12} color={colors.text} />
    </Pressable>
  );
}

/**
 * «En N temas»: la lista, para elegir a cuál ir. Se abre desde la etiqueta y
 * desde «Ver en qué temas está» del menú del mensaje.
 *
 * Elegir uno NO navega desde aquí: avisa a quien la abrió, que cierra la hoja
 * y abre el tema cuando la hoja ya no está (`afterSheetClose`), por la misma
 * trampa de iOS que el resto de hojas.
 */
export function HojaDeTemasDelMensaje({
  temas,
  onClose,
  alElegir,
}: {
  /** `null`: cerrada. */
  temas: readonly TemaDeMensaje[] | null;
  onClose: () => void;
  alElegir: (tema: TemaDeMensaje) => void;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  return (
    <BottomSheet visible={!!temas && temas.length > 0} onClose={onClose}>
      <View style={styles.hoja}>
        <Text weight="800" style={styles.titulo}>
          {t('topicChip.sheetTitle', { n: temas?.length ?? 0 })}
        </Text>
        <Text color={colors.textMuted} style={styles.ayuda}>
          {t('topicChip.sheetHelp')}
        </Text>
        <View>
          {(temas ?? []).map((tema) => (
            <Pressable
              key={tema.id}
              onPress={() => alElegir(tema)}
              accessibilityRole="button"
              accessibilityLabel={t('topicChip.goTo', { nombre: tema.nombre })}
              style={[styles.fila, { borderBottomColor: colors.border }]}
            >
              <View style={[styles.icono, { borderColor: colors.border }]}>
                <Feather name="hash" size={16} color={colors.text} />
              </View>
              <Text weight="600" numberOfLines={1} style={styles.nombre}>
                {tema.nombre}
              </Text>
              <Feather name="chevron-right" size={18} color={colors.textMuted} />
            </Pressable>
          ))}
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  pildora: {
    height: 28,
    maxWidth: 260,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
  },
  texto: { flexShrink: 1, fontSize: 12, lineHeight: 16 },
  hoja: { gap: spacing.sm, paddingBottom: spacing.sm },
  titulo: { fontSize: 20, lineHeight: 24 },
  ayuda: { fontSize: 13, lineHeight: 18 },
  fila: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icono: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nombre: { flex: 1, fontSize: 15 },
});
