import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { BottomSheet } from '@/components/BottomSheet';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import {
  type EstadoDeCalidad,
  type OpcionDeCalidad,
  type PreferenciaDeCalidad,
} from '@/live/calidadDeVideo';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La calidad de la imagen que RECIBE quien mira.
 *
 * SOLO SE ABRE SI HAY ALGO QUE ELEGIR: las opciones salen de las capas que el
 * proveedor dice que existen para la pista que se esta viendo
 * (`live/calidadDeVideo.ts`). Sin Simulcast en la plantilla la lista llega
 * vacia y la pantalla ni siquiera pinta el boton que abre esta hoja.
 *
 * LO QUE SE ENSEÑA ES LA MEDIDA REAL de cada capa, no «HD»: la aplicacion no
 * sabe prometer una resolucion que quien emite quiza no esta publicando.
 */

const NOMBRE: Record<PreferenciaDeCalidad, TranslationKey> = {
  automatica: 'live.qualityAuto',
  ahorro: 'live.qualitySaver',
  alta: 'live.qualityHigh',
};

const DETALLE: Record<PreferenciaDeCalidad, TranslationKey> = {
  automatica: 'live.qualityAutoBody',
  ahorro: 'live.qualitySaverBody',
  alta: 'live.qualityHighBody',
};

type Props = {
  visible: boolean;
  alCerrar: () => void;
  estado: EstadoDeCalidad;
  alElegir: (preferencia: PreferenciaDeCalidad) => void;
};

export function HojaDeCalidad({ visible, alCerrar, estado, alElegir }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  const fila = (opcion: OpcionDeCalidad) => {
    const elegida = estado.elegida === opcion.preferencia;
    const medida = opcion.ancho > 0 && opcion.alto > 0 ? ` · ${opcion.ancho}×${opcion.alto}` : '';
    return (
      <Pulsable
        key={opcion.preferencia}
        onPress={() => alElegir(opcion.preferencia)}
        disabled={estado.aplicando}
        opacidad={estado.aplicando ? 0.45 : 1}
        accessibilityRole="radio"
        accessibilityState={{ selected: elegida, disabled: estado.aplicando }}
        style={[estilos.fila, { borderColor: elegida ? colors.text : colors.border }]}
      >
        <View style={estilos.textos}>
          <Text variant="body" weight="700">
            {t(NOMBRE[opcion.preferencia])}
            {medida}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {t(DETALLE[opcion.preferencia])}
          </Text>
        </View>
        {elegida ? <Feather name="check" size={18} color={colors.text} /> : null}
      </Pulsable>
    );
  };

  return (
    <BottomSheet visible={visible} onClose={alCerrar}>
      <Text variant="titleMedium" weight="800" accessibilityRole="header">
        {t('live.qualityTitle')}
      </Text>

      <View accessibilityRole="radiogroup" style={estilos.lista}>
        {estado.opciones.map(fila)}
      </View>

      {estado.aplicando ? (
        <View style={estilos.linea} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={colors.text} />
          <Text variant="secondary" color={colors.textMuted}>
            {t('live.qualityApplying')}
          </Text>
        </View>
      ) : estado.fallo ? (
        <View style={estilos.linea} accessibilityLiveRegion="polite">
          <Feather name="alert-triangle" size={16} color={colors.danger} />
          <Text variant="secondary" color={colors.danger} style={estilos.crece}>
            {t('live.qualityFailed')}
          </Text>
        </View>
      ) : null}

      <Text variant="caption" color={colors.textMuted}>
        {t('live.qualityHint')}
      </Text>
    </BottomSheet>
  );
}

const estilos = StyleSheet.create({
  lista: { gap: spacing.sm, marginTop: spacing.sm },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 56,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  textos: { flex: 1, gap: 2 },
  linea: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  crece: { flex: 1 },
});
