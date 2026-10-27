import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Input } from '@/components/Input';
import { Pulsable } from '@/components/Pulsable';
import { useTranslation } from '@/i18n/useTranslation';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = Omit<React.ComponentProps<typeof Input>, 'secureTextEntry' | 'accesorio'>;

/**
 * Un campo de contraseña con su ojo DENTRO.
 *
 * Antes el ojo era un botón aparte, colocado encima del campo con una posición
 * a mano (`top: 36`): bastaba un mensaje de error de dos líneas o una etiqueta
 * más larga para que se descuadrara, y el texto escrito pasaba por debajo de
 * él. Ahora es el accesorio del campo y la caja le reserva su sitio.
 *
 * Empieza oculta. El ojo dice lo que HARÁ («Mostrar contraseña»), no lo que
 * hay, que es como lo lee un lector de pantalla.
 */
export function CampoDeContrasena({ icono = 'lock', ...props }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [oculta, setOculta] = useState(true);

  return (
    <Input
      autoCapitalize="none"
      autoCorrect={false}
      icono={icono}
      {...props}
      secureTextEntry={oculta}
      accesorio={
        <Pulsable
          onPress={() => setOculta((v) => !v)}
          escala={ESCALA_AL_PULSAR.icono}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={oculta ? t('auth.showPassword') : t('auth.hidePassword')}
          style={styles.ojo}
        >
          <Feather name={oculta ? 'eye' : 'eye-off'} size={18} color={colors.textMuted} />
        </Pulsable>
      }
    />
  );
}

const styles = StyleSheet.create({
  ojo: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    // El icono queda alineado con el borde interior de la caja; la zona que
    // se pulsa es más ancha que lo que se ve.
    marginRight: -spacing.sm,
  },
});
