import React from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import {
  mismoEfecto,
  type CapacidadDeEfectos,
  type EfectoDeVideo,
  type EstadoDeEfectos,
  type MotivoSinEfectos,
} from '@/live/efectosDeVideo';
import { FONDOS_VIRTUALES } from '@/live/fondosVirtuales';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La hoja de efectos de quien emite: ninguno, desenfoque, o uno de los fondos
 * que trae la aplicacion.
 *
 * NO HAY VISTA PREVIA APARTE, Y ES A PROPOSITO. La hoja ocupa la parte de
 * abajo y la propia camara sigue viendose encima: lo que se ve ahi ES la pista
 * que sale, con el efecto ya aplicado por el SDK. Una miniatura «de como
 * quedaria» seria una segunda imagen que puede no coincidir con lo que reciben
 * los demas.
 *
 * LA HOJA NO DECIDE NADA. Pinta `estado` y llama a `alElegir`; las reglas —una
 * operacion a la vez, vuelta a «ninguno» si falla, limite de tiempo— estan en
 * `live/efectosDeVideo.ts`.
 *
 * «Ninguno» SE PUEDE PULSAR SIEMPRE, tambien mientras se esta aplicando otra
 * cosa: es la salida si el telefono no puede con el efecto.
 */

/** Por que no hay efectos, dicho a la persona. */
const EXPLICACION: Record<MotivoSinEfectos, TranslationKey> = {
  sin_proveedor: 'live.effectsUnavailableProvider',
  no_publica: 'live.effectsUnavailableViewer',
  sin_modulo: 'live.effectsUnavailableUpdate',
  sistema_antiguo: 'live.effectsUnavailableSystem',
};

type Props = {
  visible: boolean;
  alCerrar: () => void;
  capacidad: CapacidadDeEfectos;
  estado: EstadoDeEfectos;
  alElegir: (efecto: EfectoDeVideo) => void;
};

export function HojaDeEfectos({ visible, alCerrar, capacidad, estado, alElegir }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  const opcion = (
    efecto: EfectoDeVideo,
    etiqueta: string,
    contenido: React.ReactNode,
    siempre = false,
  ) => {
    const puesto = mismoEfecto(estado.efecto, efecto);
    const apagada = estado.aplicando && !siempre;
    return (
      <Pulsable
        key={efecto.tipo === 'fondo' ? efecto.fondoId : efecto.tipo}
        onPress={() => alElegir(efecto)}
        disabled={apagada}
        opacidad={apagada ? 0.45 : 1}
        accessibilityRole="button"
        accessibilityLabel={etiqueta}
        accessibilityState={{ selected: puesto, disabled: apagada }}
        style={estilos.opcion}
      >
        <View
          style={[
            estilos.muestra,
            { borderColor: puesto ? colors.text : colors.border, borderWidth: puesto ? 2 : 1 },
          ]}
        >
          {contenido}
        </View>
        <Text
          variant="caption"
          weight={puesto ? '800' : '600'}
          color={puesto ? colors.text : colors.textMuted}
          numberOfLines={2}
          style={estilos.centrado}
        >
          {etiqueta}
        </Text>
      </Pulsable>
    );
  };

  return (
    <BottomSheet visible={visible} onClose={alCerrar}>
      <Text variant="titleMedium" weight="800" accessibilityRole="header">
        {t('live.effectsTitle')}
      </Text>

      {capacidad.admitidos ? (
        <>
          <Text variant="secondary" color={colors.textMuted}>
            {t('live.effectsBody')}
          </Text>

          <View style={estilos.rejilla}>
            {opcion(
              { tipo: 'ninguno' },
              t('live.effectNone'),
              <Feather name="slash" size={22} color={colors.text} />,
              true,
            )}
            {opcion(
              { tipo: 'desenfoque' },
              t('live.effectBlur'),
              <Feather name="droplet" size={22} color={colors.text} />,
            )}
            {FONDOS_VIRTUALES.filter((fondo) => capacidad.fondos.includes(fondo.id)).map((fondo) =>
              opcion(
                { tipo: 'fondo', fondoId: fondo.id },
                t(fondo.nombre),
                <Image source={fondo.imagen} style={estilos.miniatura} resizeMode="cover" />,
              ),
            )}
          </View>

          {estado.aplicando ? (
            <View style={estilos.linea} accessibilityLiveRegion="polite">
              <ActivityIndicator size="small" color={colors.text} />
              <Text variant="secondary" color={colors.textMuted}>
                {t('live.effectApplying')}
              </Text>
            </View>
          ) : estado.error ? (
            <View style={estilos.linea} accessibilityLiveRegion="polite">
              <Feather name="alert-triangle" size={16} color={colors.danger} />
              <Text variant="secondary" color={colors.danger} style={estilos.crece}>
                {estado.error === 'se_apago' ? t('live.effectTurnedOff') : t('live.effectFailed')}
              </Text>
            </View>
          ) : null}

          <Text variant="caption" color={colors.textMuted}>
            {t('live.effectsHint')}
          </Text>
        </>
      ) : (
        <Text variant="secondary" color={colors.textMuted}>
          {t(EXPLICACION[capacidad.motivo ?? 'sin_proveedor'])}
        </Text>
      )}
    </BottomSheet>
  );
}

const estilos = StyleSheet.create({
  rejilla: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm },
  // 72 de ancho: cabe el nombre en dos lineas y el area tactil pasa de 44.
  opcion: { width: 72, alignItems: 'center', gap: spacing.xs },
  muestra: {
    width: 64,
    height: 88,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  miniatura: { width: '100%', height: '100%' },
  centrado: { textAlign: 'center' },
  linea: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  crece: { flex: 1 },
});
