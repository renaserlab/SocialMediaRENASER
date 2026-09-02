import React, { useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { useTranslation } from '@/i18n/useTranslation';
import type { FaseDeNotaDeVoz } from '@/hooks/useGrabadoraDeVoz';
import { formatearDuracion } from '@/lib/notaDeVoz';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * El redactor de una nota de voz: pulsar, hablar, escuchar y enviar.
 *
 * =============================================================================
 * POR QUÉ YA NO ES «MANTENER PULSADO»
 * =============================================================================
 * Antes esto era un `Gesture.LongPress` que grababa mientras el dedo estuviera
 * encima y ENVIABA AL SOLTAR. Se ha quitado entero, y no por gusto:
 *
 *  - EL ENVÍO NO PUEDE DEPENDER DE UN EVENTO DE GESTO. El envío colgaba de
 *    `onFinalize`, que se dispara también cuando el gesto FALLA o lo CANCELA el
 *    sistema — y el diálogo de permiso del micrófono lo cancela siempre la
 *    primera vez. Con la grabadora todavía arrancando, ese `soltar` no hacía
 *    nada y la nota no se enviaba nunca. Está contado con detalle en la cabecera
 *    de `hooks/useGrabadoraDeVoz.ts`.
 *  - NO SE PODÍA ESCUCHAR ANTES DE MANDAR. Al levantar el dedo la nota ya
 *    volaba: ni oírla, ni rehacerla.
 *  - Y NO SE VEÍA QUÉ HACER. Un micrófono que sólo responde a un gesto sin
 *    pistas es una función que existe únicamente para quien ya la conocía.
 *
 * Ahora cada paso es un botón con su nombre: micrófono → Detener → (escuchar)
 * → Enviar. Se ve qué hacer sin que nadie lo explique, y arrepentirse es
 * siempre un toque en una papelera visible.
 *
 * ESTE COMPONENTE NO DECIDE NADA. Recibe la fase de la máquina de estados y
 * pinta lo que toca; quien manda es `useGrabadoraDeVoz`. Es lo que permite que
 * un fallo de envío no borre la grabación: el estado no vive aquí.
 */

type Props = {
  fase: FaseDeNotaDeVoz;
  /** Segundos: los que lleva grabando, o los que dura la nota terminada. */
  segundos: number;
  /** De 0 a 1 sobre el máximo: la barra que avisa de que se acaba el tiempo. */
  avance: number;
  /** De 0 a 1 mientras se sube. */
  progreso: number;
  /** El fichero grabado, para poder escucharlo antes de mandarlo. */
  uri: string | null;
  empezar: () => void;
  detener: () => void;
  cancelar: () => void;
  eliminar: () => void;
  enviar: () => void;
  /** Sin la migración 0044 esto no se pinta siquiera. Ver `ChatScreen`. */
  deshabilitado?: boolean;
};

export function BotonDeNotaDeVoz({
  fase,
  segundos,
  avance,
  progreso,
  uri,
  empezar,
  detener,
  cancelar,
  eliminar,
  enviar,
  deshabilitado = false,
}: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  /** Si la previa está sonando. Sólo entonces existe un reproductor. */
  const [sonando, setSonando] = useState(false);

  // Cambiar de nota —o mandarla— apaga el reproductor: dejarlo montado sobre un
  // fichero que ya no está en pantalla es un reproductor nativo de más.
  useEffect(() => {
    if (fase !== 'lista' && fase !== 'fallida') setSonando(false);
  }, [fase]);

  const enPrevia = fase === 'lista' || fase === 'fallida';
  const preparando = fase === 'permiso' || fase === 'guardando';

  return (
    <>
      {/*
        LA BARRA DE ESTADO, encima del redactor y ocupando su ancho.

        Sin un indicador claro, una grabación en curso es indistinguible de un
        botón atascado. Y en la previa es donde se escucha, se tira y se lee por
        qué no salió: todo lo que hay que decidir, en el mismo sitio.
      */}
      {fase === 'grabando' ? (
        <View style={[styles.aviso, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.punto, { backgroundColor: colors.danger }]} />
          <Text style={[styles.reloj, { color: colors.text }]}>
            {formatearDuracion(segundos)}
          </Text>
          <Text numberOfLines={1} style={[styles.pista, { color: colors.textMuted }]}>
            {t('chat.recording')}
          </Text>

          <Pressable
            onPress={cancelar}
            accessibilityRole="button"
            accessibilityLabel={t('chat.discardRecording')}
            hitSlop={10}
            style={styles.accion}
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

      {enPrevia ? (
        <View style={[styles.aviso, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {sonando && uri ? (
            <NotaSonando uri={uri} duracion={segundos} color={colors.text} alTerminar={() => setSonando(false)} />
          ) : (
            <Pressable
              onPress={() => setSonando(true)}
              disabled={!uri}
              accessibilityRole="button"
              accessibilityLabel={t('chat.playRecording')}
              hitSlop={8}
              style={[styles.play, { borderColor: colors.text }]}
            >
              <Feather name="play" size={14} color={colors.text} />
            </Pressable>
          )}

          <Text style={[styles.reloj, { color: colors.text }]}>
            {formatearDuracion(segundos)}
          </Text>

          <Text
            numberOfLines={1}
            style={[
              styles.pista,
              { color: fase === 'fallida' ? colors.danger : colors.textMuted },
            ]}
          >
            {fase === 'fallida' ? t('chat.recordingFailed') : t('chat.recordingReady')}
          </Text>

          <Pressable
            onPress={eliminar}
            accessibilityRole="button"
            accessibilityLabel={t('chat.deleteRecording')}
            hitSlop={10}
            style={styles.accion}
          >
            <Feather name="trash-2" size={18} color={colors.danger} />
          </Pressable>
        </View>
      ) : null}

      {fase === 'enviando' ? (
        <View style={[styles.aviso, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text numberOfLines={1} style={[styles.pista, { color: colors.textMuted }]}>
            {t('chat.recordingSending')}
          </Text>
          <View style={[styles.barra, { backgroundColor: colors.border }]}>
            <View
              style={[
                styles.barraAvance,
                {
                  backgroundColor: colors.primary,
                  width: `${Math.round(Math.min(1, progreso) * 100)}%`,
                },
              ]}
            />
          </View>
        </View>
      ) : null}

      {/*
        EL BOTÓN DE LA FILA, que cambia de trabajo según la fase. Es siempre el
        siguiente paso y sólo uno: grabar → detener → enviar. Dos botones a la
        vez obligarían a elegir entre cosas que desde fuera son «mandar».
      */}
      {fase === 'grabando' ? (
        <Pressable
          onPress={detener}
          accessibilityRole="button"
          accessibilityLabel={t('chat.stopRecording')}
          style={[styles.boton, { backgroundColor: colors.danger }]}
        >
          <Feather name="square" size={18} color={colors.onPrimary} />
        </Pressable>
      ) : enPrevia ? (
        <Pressable
          onPress={enviar}
          accessibilityRole="button"
          accessibilityLabel={
            fase === 'fallida' ? t('common.retry') : t('chat.sendRecording')
          }
          style={[styles.boton, { backgroundColor: colors.primary }]}
        >
          <Feather
            name={fase === 'fallida' ? 'refresh-cw' : 'send'}
            size={20}
            color={colors.onPrimary}
          />
        </Pressable>
      ) : preparando || fase === 'enviando' ? (
        <View style={styles.boton}>
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
      ) : (
        <Pressable
          onPress={empezar}
          disabled={deshabilitado}
          accessibilityRole="button"
          accessibilityLabel={t('chat.recordVoice')}
          accessibilityHint={t('chat.recordVoiceHint')}
          style={styles.boton}
        >
          <Feather name="mic" size={22} color={deshabilitado ? colors.border : colors.text} />
        </Pressable>
      )}
    </>
  );
}

/**
 * El único sitio de la previa donde vive un reproductor, y sólo mientras suena.
 *
 * Misma regla que `BurbujaDeNotaDeVoz` y por el mismo motivo: un reproductor
 * nativo reserva memoria por delante aunque no esté reproduciendo, así que no
 * se monta ninguno hasta que alguien pulsa play. La limpieza va en la fase de
 * LAYOUT porque `expo-audio` libera el objeto nativo en la suya, declarada
 * antes: un `pause()` en un efecto pasivo caería sobre un objeto ya muerto.
 */
function NotaSonando({
  uri,
  duracion,
  color,
  alTerminar,
}: {
  uri: string;
  duracion: number;
  color: string;
  alTerminar: () => void;
}) {
  const reproductor = useAudioPlayer({ uri });
  const estado = useAudioPlayerStatus(reproductor);
  const { t } = useTranslation();

  useLayoutEffect(() => {
    return () => {
      try {
        reproductor.muted = true;
        reproductor.pause();
      } catch {
        /* Ya se liberó. Parar dos veces no es un error. */
      }
    };
  }, [reproductor]);

  useEffect(() => {
    reproductor.play();
  }, [reproductor]);

  useEffect(() => {
    if (estado?.didJustFinish) alTerminar();
  }, [estado?.didJustFinish, alTerminar]);

  const total = estado?.duration || duracion;
  const actual = estado?.currentTime ?? 0;

  return (
    <Pressable
      onPress={alTerminar}
      accessibilityRole="button"
      accessibilityLabel={t('chat.pauseRecording')}
      hitSlop={8}
      style={[styles.play, { borderColor: color }]}
    >
      <Feather name="pause" size={14} color={color} />
      {total > 0 ? (
        <View
          style={[
            styles.playAvance,
            { backgroundColor: color, width: `${Math.round(Math.min(1, actual / total) * 100)}%` },
          ]}
        />
      ) : null}
    </Pressable>
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
  accion: { minWidth: 28, alignItems: 'center' },
  play: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  playAvance: { position: 'absolute', bottom: 0, left: 0, height: 2, opacity: 0.8 },
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
