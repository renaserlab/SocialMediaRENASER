import React from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { BottomSheet } from '@/components/BottomSheet';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import type { AccionDeMensaje } from '@/live/destacado';
import type { MensajeDeEmision } from '@/repositories/LiveRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const TEXTO: Record<AccionDeMensaje, TranslationKey> = {
  fijar: 'live.pin',
  soltar: 'live.unpin',
  ocultar: 'live.hideMessage',
};

type Props = {
  /** El mensaje elegido; sin él la hoja está cerrada. */
  mensaje: MensajeDeEmision | null;
  /** Lo que se puede hacer con él, ya decidido (`accionesDeMensaje`). */
  acciones: readonly AccionDeMensaje[];
  ocupado: boolean;
  alElegir: (accion: AccionDeMensaje, mensaje: MensajeDeEmision) => void;
  alCerrar: () => void;
};

/**
 * Lo que quien modera puede hacer con un mensaje del chat.
 *
 * Antes mantener pulsado un mensaje solo servía para ocultarlo, y saltaba
 * directamente a la confirmación. Ahora hay dos cosas que hacer con él —fijarlo
 * u ocultarlo—, así que primero se elige.
 *
 * EL MENSAJE SE ENSEÑA ARRIBA: el chat sigue corriendo debajo de la hoja, y sin
 * verlo no se sabría sobre cuál se está decidiendo.
 *
 * QUÉ ACCIONES HAY no se decide aquí: llega resuelto desde las reglas
 * (`live/destacado.ts`). Esta hoja solo las pinta.
 */
export function AccionesDeMensaje({ mensaje, acciones, ocupado, alElegir, alCerrar }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  return (
    <BottomSheet visible={Boolean(mensaje)} onClose={alCerrar}>
      <View style={estilos.columna}>
      <Text variant="titleMedium" weight="800">
        {t('live.messageActions')}
      </Text>
      {mensaje ? (
        <View style={[estilos.cita, { borderColor: colors.border }]}>
          <Text variant="caption" weight="800" color={colors.textMuted} numberOfLines={1}>
            {mensaje.usuarioNombre}
          </Text>
          <Text variant="secondary" numberOfLines={3}>
            {mensaje.cuerpo}
          </Text>
        </View>
      ) : null}

      {mensaje
        ? acciones.map((accion) => {
            const peligro = accion === 'ocultar';
            const color = peligro ? colors.danger : colors.text;
            return (
              <Pulsable
                key={accion}
                onPress={() => alElegir(accion, mensaje)}
                disabled={ocupado}
                opacidad={ocupado ? 0.45 : 1}
                accessibilityRole="button"
                accessibilityState={{ disabled: ocupado }}
                style={[estilos.accion, { borderColor: colors.border }]}
              >
                {accion === 'ocultar' ? (
                  <Feather name="eye-off" size={18} color={color} />
                ) : (
                  <MaterialCommunityIcons
                    name={accion === 'fijar' ? 'pin' : 'pin-off'}
                    size={19}
                    color={color}
                  />
                )}
                <Text variant="body" weight="700" color={color}>
                  {t(TEXTO[accion])}
                </Text>
              </Pulsable>
            );
          })
        : null}
      </View>
    </BottomSheet>
  );
}

const estilos = StyleSheet.create({
  columna: { gap: spacing.md },
  cita: {
    gap: 2,
    borderLeftWidth: 3,
    paddingLeft: spacing.sm,
    paddingVertical: 2,
  },
  accion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
});
