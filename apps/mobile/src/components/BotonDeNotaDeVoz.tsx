import React, { useCallback, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { useTranslation } from '@/i18n/useTranslation';
import { formatearDuracion, MS_PARA_EMPEZAR } from '@/lib/notaDeVoz';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * El micrófono del redactor: MANTENER PULSADO para grabar, soltar para enviar.
 *
 * POR QUE UN GESTO Y NO UN BOTON DE ENCENDER/APAGAR. Es el gesto que ya conoce
 * cualquiera que venga de otro chat, y sobre todo hace imposible el fallo que
 * más molesta de la alternativa: dejarse una grabación abierta sin darse cuenta.
 * Mientras el dedo está encima está grabando; al levantarlo, se acabó.
 *
 * UN TOQUE SIMPLE NO GRABA, y esto es un requisito, no un efecto secundario. El
 * gesto es `LongPress` con `minDuration` (ver `lib/notaDeVoz.ts`): rozar el
 * micrófono al ir a escribir no abre nada. Y si alguien lo toca sin mantener, se
 * le dice qué hacer en vez de dejarle pensando que el botón está roto.
 *
 * SE PUEDE CANCELAR ANTES DE ENVIAR, de dos maneras, porque arrepentirse a
 * mitad de una nota es lo más normal del mundo:
 *
 *  - Deslizando el dedo hacia la izquierda sin levantarlo, que es el gesto
 *    aprendido; al pasar del umbral el aviso cambia y avisa de que al soltar se
 *    tira.
 *  - Pulsando la papelera que aparece mientras se graba, para quien no conozca
 *    el gesto. Un gesto sin alternativa visible es una función que solo existe
 *    para quien ya la conocía.
 *
 * `maxDistance` MUY ALTO A PROPOSITO. Por defecto, `LongPress` se cancela en
 * cuanto el dedo se mueve unos píxeles — que es exactamente lo que hay que hacer
 * para cancelar deslizando. Sin esto, deslizar cortaba la grabación por la vía
 * del gesto abortado: la nota se enviaba igual y el deslizamiento no servía de
 * nada.
 */

/** Cuánto hay que deslizar a la izquierda para que soltar signifique cancelar. */
const DESLIZAR_PARA_CANCELAR = 70;

type Props = {
  grabando: boolean;
  /** Segundos que lleva grabando. */
  segundos: number;
  /** De 0 a 1 sobre el máximo: la barra que avisa de que se acaba el tiempo. */
  avance: number;
  empezar: () => void;
  soltar: () => void;
  cancelar: () => void;
  /** Sin la migración 0044 esto no se pinta siquiera. Ver `ChatScreen`. */
  deshabilitado?: boolean;
};

export function BotonDeNotaDeVoz({
  grabando,
  segundos,
  avance,
  empezar,
  soltar,
  cancelar,
  deshabilitado = false,
}: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  /*
    Cuánto se ha deslizado, en una REFERENCIA y no en el estado.

    Lo lee `alSoltar`, que corre en el mismo tic que el final del gesto. Con
    estado de React, el valor leído sería el del render anterior —o sea, antes
    del último deslizamiento— y soltar tras deslizar mandaría la nota igual.
  */
  const desplazamiento = useRef(0);
  const [vaACancelar, setVaACancelar] = React.useState(false);

  const mover = useCallback((x: number) => {
    desplazamiento.current = x;
    setVaACancelar(x < -DESLIZAR_PARA_CANCELAR);
  }, []);

  const alEmpezar = useCallback(() => {
    desplazamiento.current = 0;
    setVaACancelar(false);
    empezar();
  }, [empezar]);

  const alSoltar = useCallback(() => {
    const cancelaba = desplazamiento.current < -DESLIZAR_PARA_CANCELAR;
    desplazamiento.current = 0;
    setVaACancelar(false);
    if (cancelaba) cancelar();
    else soltar();
  }, [soltar, cancelar]);

  const mantener = Gesture.LongPress()
    .minDuration(MS_PARA_EMPEZAR)
    // Ver la nota de la cabecera: sin esto, deslizar para cancelar aborta el
    // gesto y la cancelación no llega nunca a ocurrir.
    .maxDistance(10_000)
    .shouldCancelWhenOutside(false)
    .enabled(!deshabilitado)
    .onStart(() => runOnJS(alEmpezar)())
    .onFinalize(() => runOnJS(alSoltar)());

  const arrastrar = Gesture.Pan()
    .enabled(!deshabilitado)
    .onUpdate((e) => runOnJS(mover)(e.translationX))
    .onFinalize(() => runOnJS(mover)(0));

  const gesto = Gesture.Simultaneous(mantener, arrastrar);

  return (
    <>
      {/*
        LO QUE SE VE MIENTRAS SE GRABA, y tiene que verse: sin un indicador
        claro, una grabación en curso es indistinguible de un botón atascado.
        Ocupa la fila entera del redactor para que no haya duda de en qué modo
        está la pantalla.
      */}
      {grabando ? (
        <View style={[styles.aviso, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.punto, { backgroundColor: colors.danger }]} />
          <Text style={[styles.reloj, { color: colors.text }]}>
            {formatearDuracion(segundos)}
          </Text>

          <Text
            numberOfLines={1}
            style={[
              styles.pista,
              { color: vaACancelar ? colors.danger : colors.textMuted },
            ]}
          >
            {vaACancelar ? t('chat.releaseToCancel') : t('chat.slideToCancel')}
          </Text>

          {/* Alternativa visible al gesto, para quien no lo conozca. */}
          <Pressable
            onPress={cancelar}
            accessibilityRole="button"
            accessibilityLabel={t('chat.cancelRecording')}
            hitSlop={10}
          >
            <Feather name="trash-2" size={18} color={colors.danger} />
          </Pressable>

          {/* Cuánto queda hasta el tope. Aparece cuando de verdad importa. */}
          {avance > 0.75 ? (
            <View style={[styles.barra, { backgroundColor: colors.border }]}>
              <View
                style={[
                  styles.barraAvance,
                  { backgroundColor: colors.danger, width: `${Math.round(avance * 100)}%` },
                ]}
              />
            </View>
          ) : null}
        </View>
      ) : null}

      <GestureDetector gesture={gesto}>
        <View
          accessibilityRole="button"
          accessibilityLabel={t('chat.holdToRecord')}
          accessibilityHint={t('chat.holdToRecordHint')}
          style={[
            styles.boton,
            grabando && {
              backgroundColor: vaACancelar ? colors.danger : colors.primary,
              transform: [{ scale: 1.15 }],
            },
          ]}
        >
          <Feather
            name={vaACancelar ? 'trash-2' : 'mic'}
            size={22}
            color={
              deshabilitado
                ? colors.border
                : grabando
                  ? colors.onPrimary
                  : colors.text
            }
          />
        </View>
      </GestureDetector>
    </>
  );
}

const styles = StyleSheet.create({
  boton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aviso: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: '100%',
    marginBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  punto: { width: 9, height: 9, borderRadius: 5 },
  reloj: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  pista: { flex: 1, fontSize: 11 },
  barra: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: 3,
    height: 2,
    borderRadius: 1,
    overflow: 'hidden',
  },
  barraAvance: { height: 2 },
});
