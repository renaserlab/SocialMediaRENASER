import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Text';
import { PuntuacionEnEstrellas } from '@/components/valoraciones/PuntuacionEnEstrellas';
import {
  PUNTUACIONES,
  anchoDeBarra,
  anuncioDelResumen,
  etiquetaDeDistribucion,
  hayMedia,
  textoDeMedia,
  textoDelTotal,
  type ResumenDeValoraciones,
} from '@/lib/valoracionesDeCurso';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type Props = { resumen: ResumenDeValoraciones };

/**
 * Media, total y distribucion.
 *
 * LA REGLA QUE NO SE PUEDE ROMPER: cuando no hay ninguna valoracion aqui pone
 * «Sin valoraciones», nunca «0.0». El servidor manda `average: null` justo
 * para poder decir eso (`catalog/valoraciones.py`), y un 0,0 debajo del titulo
 * de un curso no significa «todavia nadie lo ha valorado»: significa que lo
 * han valorado y esta mal. Es la diferencia entre callarse y difamar.
 *
 * Sin valoraciones tampoco se pintan las cinco barras a cero: cinco lineas
 * vacias parecen un fallo de carga y no aportan nada que la frase no diga ya.
 */
export function ResumenDeLasValoraciones({ resumen }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const conMedia = hayMedia(resumen);

  return (
    <View style={[styles.caja, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {/*
        La media y el total se anuncian JUNTOS y una sola vez: leidos por
        separado se oye «4.3» suelto, que no dice de cuanto ni de cuantos.
      */}
      <View style={styles.cabecera} accessible accessibilityLabel={anuncioDelResumen(resumen, t)}>
        <Text
          variant={conMedia ? 'display' : 'titleMedium'}
          style={conMedia ? undefined : styles.sinMedia}
        >
          {textoDeMedia(resumen, t)}
        </Text>
        {conMedia ? (
          <View style={styles.junto}>
            {/* Sin texto: el numero grande de al lado ya lo dice. */}
            <PuntuacionEnEstrellas
              valor={Math.round(resumen.media as number)}
              tamano={16}
              conTexto={false}
            />
            <Text variant="secondary" color={colors.textMuted}>
              {textoDelTotal(resumen.total, t)}
            </Text>
          </View>
        ) : null}
      </View>

      {conMedia ? (
        <View style={styles.distribucion}>
          {PUNTUACIONES.map((n) => {
            const cuantas = resumen.distribucion[String(n) as '1' | '2' | '3' | '4' | '5'];
            return (
              <View
                key={n}
                style={styles.filaDeBarra}
                accessible
                accessibilityLabel={etiquetaDeDistribucion(n, cuantas, t)}
              >
                <Text variant="caption" color={colors.textMuted} style={styles.nota}>
                  {n}
                </Text>
                <View style={[styles.carril, { backgroundColor: colors.backgroundAlt }]}>
                  <View
                    style={[
                      styles.barra,
                      { backgroundColor: colors.text, width: anchoDeBarra(cuantas, resumen.total) },
                    ]}
                  />
                </View>
                {/* El numero, ademas de la barra: una barra corta no se cuenta. */}
                <Text variant="caption" color={colors.textMuted} style={styles.cuantas}>
                  {cuantas}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  caja: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  sinMedia: { fontSize: 16 },
  junto: { gap: spacing.xs },
  distribucion: { gap: spacing.xs },
  filaDeBarra: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nota: { width: 12, textAlign: 'right' },
  carril: { flex: 1, height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  barra: { height: 6, borderRadius: radius.pill },
  cuantas: { minWidth: 24, textAlign: 'right' },
});
