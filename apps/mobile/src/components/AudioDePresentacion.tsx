import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { useBackgroundAudio } from '@/hooks/useBackgroundAudio';
import { confirm } from '@/lib/confirm';
import { describeError } from '@/lib/describeError';
import { abrirAjustes } from '@/lib/permisos';
import { toast } from '@/lib/toast';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { signMediaUrls, uploadPostMedia } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Tope del audio de presentacion.
 *
 * Un minuto. No es un limite tecnico sino de producto: quien visita un perfil
 * concede unos segundos, y un audio de cinco minutos no lo escucha nadie. Ese
 * minuto pesa poco (unos cientos de kilobytes), asi que tampoco castiga a
 * quien lo oye con datos moviles.
 */
export const MAX_INTRO_MS = 60_000;

function reloj(segundos: number): string {
  const s = Number.isFinite(segundos) ? Math.max(0, Math.floor(segundos)) : 0;
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

type Props = {
  /** Ruta en Storage del audio del perfil que se esta viendo. */
  rutaDelAudio: string | null | undefined;
  duracionS: number | null | undefined;
  /** `true` en el perfil propio: ademas de escuchar, se puede grabar. */
  esPropio: boolean;
  /** Nombre de quien presenta, para el texto. */
  nombre?: string;
};

/**
 * Audio de presentacion del perfil: grabar, reemplazar, escuchar y borrar.
 *
 * POR QUE IMPORTA. Es de las piezas mas cercanas a donde va Z. Una biografia
 * de dos lineas no dice si alguien sabe de carpinteria ni si da confianza para
 * pedirle una sesion; oirle treinta segundos, si. Por eso va ARRIBA, antes de
 * la descripcion, y no escondido entre las secciones.
 *
 * Lo que se guarda es la RUTA del archivo en el almacen, nunca el audio en la
 * base de datos ni una URL firmada (caducan). La firma se pide al reproducir.
 */
export function AudioDePresentacion({ rutaDelAudio, duracionS, esPropio, nombre }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const setUser = useAppStore((state) => state.setUser);
  useBackgroundAudio();

  /* ------------------------------------------------------------ escuchar - */
  const [urlFirmada, setUrlFirmada] = useState<string | null>(null);
  const [firmando, setFirmando] = useState(false);

  /*
    La URL se pide al TOCAR, no al abrir el perfil. Firmar cada audio de cada
    perfil que se visita seria una peticion por visita para algo que casi nadie
    reproduce; asi solo se paga cuando alguien decide escuchar.
  */
  const asegurarUrl = useCallback(async (): Promise<string | null> => {
    if (!rutaDelAudio) return null;
    if (urlFirmada) return urlFirmada;
    setFirmando(true);
    try {
      const mapa = await signMediaUrls([rutaDelAudio]);
      const url = mapa[rutaDelAudio] ?? null;
      setUrlFirmada(url);
      return url;
    } finally {
      setFirmando(false);
    }
  }, [rutaDelAudio, urlFirmada]);

  // Al cambiar de perfil (o al reemplazar el audio) la firma anterior ya no
  // sirve: apunta a otro archivo.
  useEffect(() => {
    setUrlFirmada(null);
  }, [rutaDelAudio]);

  const reproductor = useAudioPlayer(urlFirmada ? { uri: urlFirmada } : null);
  const estado = useAudioPlayerStatus(reproductor);
  const sonando = estado?.playing ?? false;

  const alternarReproduccion = useCallback(async () => {
    if (sonando) {
      reproductor.pause();
      return;
    }
    const url = await asegurarUrl();
    if (!url) {
      toast(t('intro.prepareFailed'));
      return;
    }
    /*
      Al terminar, el reproductor se queda al final. Sin rebobinar, el segundo
      toque no suena y parece que se haya roto.
    */
    if ((estado?.currentTime ?? 0) >= (estado?.duration ?? 0) - 0.2) {
      reproductor.seekTo(0);
    }
    reproductor.play();
  }, [sonando, reproductor, asegurarUrl, estado]);

  /* -------------------------------------------------------------- grabar - */
  const grabadora = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const estadoGrabadora = useAudioRecorderState(grabadora, 250);
  const grabando = estadoGrabadora?.isRecording ?? false;
  const msGrabados = estadoGrabadora?.durationMillis ?? 0;

  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  /*
    Cerrojo del guardado.

    Va en una referencia y no en el estado por el mismo motivo que en
    `usePublicacion`: se consulta y se escribe dentro del mismo manejador, y con
    estado la segunda llamada leeria el valor viejo y pasaria igual.

    Hace falta de verdad: el corte automatico al llegar al minuto se dispara
    desde un efecto que se reejecuta cada 250 ms (`useAudioRecorderState`), y
    `grabando` no pasa a `false` hasta el sondeo siguiente. Sin cerrojo, el
    mismo audio se subia dos veces y el perfil se guardaba dos veces.
  */
  const guardandoRef = useRef(false);

  const empezar = useCallback(async () => {
    setAviso(null);
    /*
      El microfono se pide AQUI, al tocar «Grabar», y no al abrir el perfil:
      un permiso pedido sin contexto se rechaza, y en iOS el rechazo no tiene
      vuelta atras dentro de la aplicacion.
    */
    const permiso = await requestRecordingPermissionsAsync();
    if (!permiso.granted) {
      setAviso(
        permiso.canAskAgain === false
          ? t('intro.micBlocked')
          : t('intro.micNeeded'),
      );
      return;
    }
    try {
      await grabadora.prepareToRecordAsync();
      grabadora.record();
    } catch (e) {
      setAviso(describeError(e, t('intro.startFailed')));
    }
  }, [grabadora]);

  const parar = useCallback(async () => {
    if (guardandoRef.current) return;
    guardandoRef.current = true;
    try {
      const duracionMs = Math.min(msGrabados, MAX_INTRO_MS);
      await grabadora.stop();
      const uri = grabadora.uri;
      if (!uri) {
        setAviso(t('intro.emptyRecording'));
        return;
      }
      setGuardando(true);
      const subido = await uploadPostMedia({
        uri,
        kind: 'audio',
        mimeType: 'audio/m4a',
        name: 'presentacion.m4a',
        durationMs: duracionMs,
      });
      const perfil = await ProfileRepository.updateMyProfile({
        introAudioPath: subido.storagePath,
        introAudioDurationS: Math.max(1, Math.round(duracionMs / 1000)),
      });
      setUser(perfil);
      toast(t('intro.saved'));
    } catch (e) {
      setAviso(describeError(e, t('intro.saveFailed')));
    } finally {
      guardandoRef.current = false;
      setGuardando(false);
    }
  }, [grabadora, msGrabados, setUser]);

  /*
    Corte automatico al llegar al minuto. Sin el, la grabacion sigue y despues
    hay que rechazarla: se habria gastado el tiempo de la persona para nada.

    El cerrojo de `parar` es lo que evita que este efecto —que se reevalua cada
    250 ms— lo dispare varias veces mientras la grabacion se cierra.
  */
  useEffect(() => {
    if (grabando && msGrabados >= MAX_INTRO_MS) void parar();
  }, [grabando, msGrabados, parar]);

  /*
    Al salir del perfil, se calla.

    Las secciones del carrusel NO se desmontan (ver SwipeTabs): sin esto,
    escuchar una presentacion y deslizar a Inicio dejaba la voz sonando por
    debajo del video del muro, y encima seguia con la aplicacion en segundo
    plano —`useBackgroundAudio` lo permite para todo el proceso—.

    `useCallback` sin dependencias a proposito: solo hace falta la accion de
    salir, no reengancharla cada vez que cambia el estado del reproductor.
  */
  const reproductorRef = useRef(reproductor);
  reproductorRef.current = reproductor;
  useFocusEffect(
    useCallback(
      () => () => {
        try {
          reproductorRef.current?.pause();
        } catch {
          // El reproductor puede haberse liberado ya; no hay nada que parar.
        }
      },
      [],
    ),
  );

  const borrar = useCallback(async () => {
    const seguro = await confirm({
      title: t('intro.removeTitle'),
      message: t('intro.removeBody'),
      confirmLabel: t('intro.remove'),
      destructive: true,
    });
    if (!seguro) return;
    setGuardando(true);
    try {
      const perfil = await ProfileRepository.updateMyProfile({ introAudioPath: null });
      setUser(perfil);
      setUrlFirmada(null);
      toast(t('intro.removed'));
    } catch (e) {
      setAviso(describeError(e, t('intro.removeFailed')));
    } finally {
      setGuardando(false);
    }
  }, [setUser]);

  const duracion = useMemo(() => {
    if (grabando) return reloj(msGrabados / 1000);
    if (estado?.duration) return reloj(estado.duration);
    if (duracionS) return reloj(duracionS);
    return null;
  }, [grabando, msGrabados, estado?.duration, duracionS]);

  const tieneAudio = !!rutaDelAudio;

  // Perfil ajeno sin audio: no se pinta nada. Un hueco que dice «esta persona
  // no grabo nada» no aporta y ensucia la parte alta del perfil.
  if (!tieneAudio && !esPropio) return null;

  return (
    <View style={[styles.caja, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable
        onPress={() => {
          if (grabando) void parar();
          else if (tieneAudio) void alternarReproduccion();
          else void empezar();
        }}
        disabled={guardando || firmando}
        style={[styles.boton, { backgroundColor: grabando ? colors.danger : colors.text }]}
        accessibilityRole="button"
        accessibilityLabel={
          grabando
            ? t('intro.stopRecording')
            : tieneAudio
            ? sonando
              ? t('intro.pause')
              : t('intro.listen')
            : t('intro.record')
        }
      >
        {guardando || firmando ? (
          <ActivityIndicator color={colors.background} />
        ) : (
          <Feather
            name={grabando ? 'square' : tieneAudio ? (sonando ? 'pause' : 'play') : 'mic'}
            size={20}
            color={grabando ? colors.onPrimary : colors.background}
          />
        )}
      </Pressable>

      <View style={styles.centro}>
        <Text variant="secondary" weight="700" color={colors.text}>
          {grabando
            ? t('intro.recording')
            : tieneAudio
            ? esPropio
              ? t('intro.yours')
              : t('intro.ofNamed', {
                  nombre: nombre?.split(' ')[0] ?? t('profile.thisPerson'),
                })
            : t('intro.record')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {grabando
            ? t('intro.recordingTime', { tiempo: duracion ?? '', maximo: MAX_INTRO_MS / 1000 })
            : tieneAudio
            ? (duracion ?? t('intro.tapToListen'))
            : t('intro.hint')}
        </Text>
      </View>

      {/* Reemplazar y quitar solo tienen sentido en el perfil propio y con algo
          que reemplazar o quitar. */}
      {esPropio && tieneAudio && !grabando ? (
        <View style={styles.acciones}>
          <Pressable
            onPress={() => void empezar()}
            disabled={guardando}
            hitSlop={8}
            style={styles.accion}
            accessibilityRole="button"
            accessibilityLabel={t('intro.recordAnother')}
          >
            <Feather name="refresh-cw" size={17} color={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={() => void borrar()}
            disabled={guardando}
            hitSlop={8}
            style={styles.accion}
            accessibilityRole="button"
            accessibilityLabel={t('intro.removeA11y')}
          >
            <Feather name="trash-2" size={17} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : null}

      {aviso ? (
        <Pressable
          onPress={abrirAjustes}
          style={styles.aviso}
          accessibilityRole="button"
          accessibilityLabel={t('intro.openSettings')}
        >
          <Text variant="caption" weight="700" color={colors.danger}>
            {aviso}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  caja: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.md,
    flexWrap: 'wrap',
  },
  boton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centro: { flex: 1, gap: 2, minWidth: 140 },
  acciones: { flexDirection: 'row', gap: spacing.sm },
  accion: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  aviso: { width: '100%', paddingTop: spacing.sm },
});
