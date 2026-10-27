import React from 'react';
import { StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { sobreMedio } from '@/components/CapaDeContraste';
import { Pulsable } from '@/components/Pulsable';
import { useTranslation } from '@/i18n/useTranslation';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { spacing } from '@/theme/tokens';

/**
 * La salida de Crear, para los pasos que no la traian.
 *
 * POR QUE HACE FALTA AHORA. En Crear ya no esta la barra de secciones —su sitio
 * lo ocupa la de los tipos de publicacion—, y arrastrar de lado cambia de tipo,
 * no de seccion. La camara y el carrete tienen su `X`; el aviso de permiso, el
 * selector de archivos de la web y el modo Vivo no la tenian, porque hasta ahora
 * se salia por la barra. Sin esto, en un iPhone —que no tiene boton de atras—
 * esos pasos no tendrian por donde salir.
 *
 * Va en el mismo sitio y con la misma forma que la `X` de la camara, para que
 * no cambie de lugar al pasar de un tipo de publicacion a otro.
 */
export function SalirDeCrear({ alSalir }: { alSalir: () => void }) {
  const { t } = useTranslation();
  return (
    <Pulsable
      onPress={alSalir}
      hitSlop={12}
      escala={ESCALA_AL_PULSAR.icono}
      style={styles.boton}
      accessibilityRole="button"
      accessibilityLabel={t('common.close')}
    >
      <Feather name="x" size={24} color={sobreMedio.text} />
    </Pulsable>
  );
}

const styles = StyleSheet.create({
  boton: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: sobreMedio.overlay,
  },
});
