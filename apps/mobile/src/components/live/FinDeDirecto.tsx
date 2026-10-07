import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { sobreMedio } from '@/components/CapaDeContraste';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import type { Emision } from '@/repositories/LiveRepository';
import { radius, spacing } from '@/theme/tokens';

/**
 * LO QUE VE QUIEN MIRA CUANDO EL DIRECTO TERMINA.
 *
 * EL FALLO (teléfono, 06/10/2026): al terminar la emisión, quien miraba se
 * quedaba delante de una pantalla negra con los comentarios, sin que nada le
 * dijera qué había pasado ni qué hacer. La sala no se había roto: sencillamente
 * ya no había imagen, y eso en un teléfono se lee como «se ha colgado».
 *
 * Ahora se dice —quién emitía y que ha terminado— y se ofrece la salida, que es
 * volver a Inicio, donde hay más que ver.
 *
 * SE VUELVE SOLO, PERO SOLO SI TERMINÓ DELANTE DE UNO. Quien estaba mirando
 * cuando se cortó no ha pedido quedarse en una sala vacía: tras unos segundos
 * se le lleva a Inicio, con la cuenta atrás a la vista y la opción de quedarse
 * a leer el chat. Quien ABRE una emisión que ya había terminado ha venido a
 * verla: a esa persona no se la mueve.
 *
 * Quien emitía ve el mismo cartel sin cuenta atrás: acaba de terminar él.
 *
 * «Seguir» NO se repite aquí: está en la cabecera, justo encima, con el mismo
 * nombre al lado. Dos botones para lo mismo, cada uno con su estado, acababan
 * diciendo cosas distintas tras pulsar uno.
 */

/** Segundos antes de volver a Inicio. Lo justo para leer el cartel. */
export const SEGUNDOS_PARA_VOLVER = 8;

type Props = {
  emision: Emision;
  /** Terminó mientras esta persona miraba: se la devuelve a Inicio. */
  volverSolo: boolean;
  alIrAInicio: () => void;
};

export function FinDeDirecto({ emision, volverSolo, alIrAInicio }: Props) {
  const { t } = useTranslation();
  const [seQueda, setSeQueda] = useState(false);
  const [restan, setRestan] = useState(SEGUNDOS_PARA_VOLVER);
  const contando = volverSolo && !seQueda;

  useEffect(() => {
    if (!contando) return;
    if (restan <= 0) {
      alIrAInicio();
      return;
    }
    const reloj = setTimeout(() => setRestan((n) => n - 1), 1000);
    return () => clearTimeout(reloj);
  }, [contando, restan, alIrAInicio]);

  return (
    <View style={estilos.cartel} accessibilityLiveRegion="polite">
      <Avatar size={64} image={emision.anfitrionAvatarUrl} name={emision.anfitrionNombre} />
      <Text variant="titleMedium" weight="800" color={sobreMedio.text} style={estilos.centrado}>
        {t('live.endedViewerTitle')}
      </Text>
      <Text variant="secondary" color={sobreMedio.textMuted} style={estilos.centrado}>
        {t('live.endedViewerBody', { nombre: emision.anfitrionNombre })}
      </Text>

      <Pulsable
        onPress={alIrAInicio}
        accessibilityRole="button"
        accessibilityLabel={t('live.goHome')}
        style={estilos.principal}
      >
        <Text variant="body" weight="800" color={sobreMedio.background}>
          {t('live.goHome')}
        </Text>
      </Pulsable>

      {contando ? (
        <>
          <Text variant="caption" color={sobreMedio.textMuted} style={estilos.centrado}>
            {t('live.returningHome', { n: restan })}
          </Text>
          <Pulsable
            onPress={() => setSeQueda(true)}
            hitSlop={10}
            accessibilityRole="button"
            style={estilos.secundario}
          >
            <Text variant="caption" weight="800" color={sobreMedio.text}>
              {t('live.stayInChat')}
            </Text>
          </Pulsable>
        </>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  cartel: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: sobreMedio.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  centrado: { textAlign: 'center' },
  principal: {
    alignSelf: 'stretch',
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: sobreMedio.text,
    marginTop: spacing.sm,
  },
  secundario: { minHeight: 32, justifyContent: 'center', paddingHorizontal: spacing.md },
});
