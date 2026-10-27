import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { OndaDeVoz } from '@/components/OndaDeVoz';
import { Pulsable } from '@/components/Pulsable';
import { useTranslation } from '@/i18n/useTranslation';
import type { FaseDeNotaDeVoz } from '@/hooks/useGrabadoraDeVoz';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import { haptics } from '@/lib/haptics';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
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
  /**
   * El nivel del micrófono (0–1) mientras se graba, o `null` si la plataforma
   * no lo mide. Con `null` no se pinta una onda inventada.
   */
  nivel?: number | null;
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
  nivel = null,
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

  /*
    EMPEZAR Y PARAR SE NOTAN EN LA MANO, Y SE DICEN EN VOZ ALTA.

    Quien graba suele estar mirando a otra parte —o hablando al telefono como
    si fuera una llamada—: una vibracion al abrirse el microfono y otra al
    cerrarse le dicen lo que no esta viendo. Y quien usa lector de pantalla no
    puede depender del punto rojo: se le anuncia que empieza y que termina.
  */
  const faseAnterior = useRef(fase);
  useEffect(() => {
    const antes = faseAnterior.current;
    faseAnterior.current = fase;
    if (antes === fase) return;
    if (fase === 'grabando') {
      haptics.medium();
      AccessibilityInfo.announceForAccessibility(t('chat.recording'));
    } else if (antes === 'grabando') {
      haptics.light();
      if (fase === 'lista') AccessibilityInfo.announceForAccessibility(t('chat.recordingReady'));
    } else if (fase === 'fallida') {
      AccessibilityInfo.announceForAccessibility(t('chat.recordingFailed'));
    }
  }, [fase, t]);

  const enPrevia = fase === 'lista' || fase === 'fallida';
  const preparando = fase === 'permiso' || fase === 'guardando';

  return (
    <>
      {/*
        LA BARRA DE ESTADO, DENTRO del redactor: ocupa el sitio del campo de
        texto mientras hay una nota en marcha.

        Sin un indicador claro, una grabación en curso es indistinguible de un
        botón atascado. Y en la previa es donde se escucha, se tira y se lee por
        qué no salió: todo lo que hay que decidir, en el mismo sitio.

        ANTES FLOTABA ENCIMA DEL REDACTOR, fuera de su recuadro y sobre los
        mensajes, con la papelera al final. Reportado el 06/10/2026: «cuando un
        audio está grabado debe haber un icono de borrar el audio antes de
        enviarlo». Lo había, pero donde no se buscaba. Ahora va en la fila, y
        la PAPELERA ES LO PRIMERO, a la izquierda: tirar a un lado, enviar al
        otro, como en cualquier chat.
      */}
      {fase === 'grabando' ? (
        <View
          style={[
            styles.aviso,
            styles.avisoGrabando,
            // El borde en el color de «grabando»: la barra entera cambia, no
            // solo un punto de nueve pixeles.
            { backgroundColor: colors.surface, borderColor: colors.danger },
          ]}
        >
          <Pulsable
            onPress={cancelar}
            accessibilityRole="button"
            accessibilityLabel={t('chat.discardRecording')}
            hitSlop={10}
            escala={ESCALA_AL_PULSAR.icono}
            style={[styles.accion, styles.circulo, { borderColor: colors.border }]}
          >
            <Feather name="trash-2" size={16} color={colors.danger} />
          </Pulsable>
          <PuntoQueLate color={colors.danger} />
          <Text style={[styles.grabando, { color: colors.danger }]}>
            {t('chat.recording')}
          </Text>
          <Text
            style={[styles.reloj, { color: colors.text }]}
            // El reloj cambia cinco veces por segundo: sin esto el lector de
            // pantalla lo leeria sin parar.
            accessibilityLiveRegion="none"
          >
            {formatearDuracion(segundos)}
          </Text>
          {/*
            La voz, mientras se habla. Con medicion real es la señal del
            microfono; sin ella son tres puntos que no pretenden serlo.
          */}
          <OndaDeVoz nivel={nivel} latido={segundos} color={colors.text} />

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
          <Pulsable
            onPress={eliminar}
            accessibilityRole="button"
            accessibilityLabel={t('chat.deleteRecording')}
            hitSlop={10}
            escala={ESCALA_AL_PULSAR.icono}
            style={[styles.accion, styles.circulo, { borderColor: colors.border }]}
          >
            <Feather name="trash-2" size={16} color={colors.danger} />
          </Pulsable>
          {sonando && uri ? (
            <NotaSonando uri={uri} duracion={segundos} color={colors.text} alTerminar={() => setSonando(false)} />
          ) : (
            <Pulsable
              onPress={() => setSonando(true)}
              disabled={!uri}
              accessibilityRole="button"
              accessibilityLabel={t('chat.playRecording')}
              hitSlop={8}
              escala={ESCALA_AL_PULSAR.icono}
              style={[styles.play, { borderColor: colors.text, backgroundColor: colors.text }]}
            >
              <Feather name="play" size={14} color={colors.background} />
            </Pulsable>
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
        </View>
      ) : null}

      {preparando ? <View style={styles.hueco} /> : null}

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
        <Pulsable
          onPress={detener}
          accessibilityRole="button"
          accessibilityLabel={t('chat.stopRecording')}
          escala={ESCALA_AL_PULSAR.icono}
          style={[styles.boton, { backgroundColor: colors.danger }]}
        >
          {/*
            Un aro que se abre y se desvanece alrededor del boton: junto con
            la barra de arriba, no deja dudas de que el microfono esta abierto
            y de DONDE se para. El cuadrado va en blanco fijo —no en un color
            de tema— porque el fondo es siempre el rojo de «grabando».
          */}
          <AroQueLate color={colors.danger} />
          <Feather name="square" size={18} color="#FFFFFF" />
        </Pulsable>
      ) : enPrevia ? (
        <Pulsable
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
        </Pulsable>
      ) : preparando || fase === 'enviando' ? (
        <View style={styles.boton}>
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
      ) : (
        <Pulsable
          onPress={empezar}
          disabled={deshabilitado}
          accessibilityRole="button"
          accessibilityLabel={t('chat.recordVoice')}
          accessibilityHint={t('chat.recordVoiceHint')}
          style={styles.boton}
        >
          <Feather name="mic" size={22} color={deshabilitado ? colors.border : colors.text} />
        </Pulsable>
      )}
    </>
  );
}

/**
 * El punto rojo que LATE mientras el micrófono está abierto.
 *
 * Quieto no se distinguía de un adorno: la barra de grabación era un punto, un
 * reloj y una palabra, y hasta que el reloj saltaba de segundo no había nada
 * que dijera «esto está grabando AHORA». El latido es esa señal, la misma que
 * usa cualquier grabadora.
 *
 * Con «reducir movimiento» activado en el sistema se queda fijo, igual que
 * `Skeleton`: el punto y el reloj siguen diciendo lo mismo sin parpadear.
 *
 * Es `Animated` de React Native con el hilo nativo, no un temporizador: el
 * latido no depende de que el hilo de JavaScript esté libre, y ese hilo está
 * ocupado justo ahora leyendo el reloj del grabador.
 */
function PuntoQueLate({ color }: { color: string }) {
  const sinMovimiento = useReduceMotion();
  const latido = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (sinMovimiento) {
      latido.setValue(1);
      return undefined;
    }
    const bucle = Animated.loop(
      Animated.sequence([
        Animated.timing(latido, { toValue: 0.25, duration: 600, useNativeDriver: true }),
        Animated.timing(latido, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    bucle.start();
    return () => bucle.stop();
  }, [latido, sinMovimiento]);

  return (
    <Animated.View style={[styles.punto, { backgroundColor: color, opacity: latido }]} />
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
/**
 * El aro del boton de detener. Crece y se apaga en bucle mientras se graba.
 *
 * Con «reducir movimiento» se queda como un aro quieto alrededor del boton: la
 * señal sigue ahi —junto con el texto «Grabando» y el reloj—, sin el pulso.
 */
function AroQueLate({ color }: { color: string }) {
  const sinMovimiento = useReduceMotion();
  const pulso = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (sinMovimiento) {
      pulso.setValue(0.35);
      return undefined;
    }
    const bucle = Animated.loop(
      Animated.timing(pulso, { toValue: 1, duration: 1300, useNativeDriver: true }),
    );
    bucle.start();
    return () => bucle.stop();
  }, [pulso, sinMovimiento]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.aro,
        {
          borderColor: color,
          opacity: pulso.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }),
          transform: [
            { scale: pulso.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) },
          ],
        },
      ]}
    />
  );
}

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
    <Pulsable
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
    </Pulsable>
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
  // EN LA FILA del redactor, no flotando sobre los mensajes: ocupa lo que
  // ocupaba el campo de texto. `overflow` por la barra de avance, que va
  // pegada al borde redondeado.
  aviso: {
    flex: 1,
    minHeight: 44,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  // Mas alta y con mas aire que las otras barras: es la que tiene que verse.
  avisoGrabando: { paddingVertical: spacing.sm + 2, borderWidth: 1.5 },
  grabando: { fontSize: 12, fontWeight: '800' },
  hueco: { flex: 1 },
  circulo: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: 'center',
  },
  aro: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 22,
    borderWidth: 2,
  },
  punto: { width: 10, height: 10, borderRadius: 5 },
  reloj: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
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
