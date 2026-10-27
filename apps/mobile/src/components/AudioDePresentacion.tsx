import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from 'expo-audio';
import { useFocusEffect } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { Text } from '@/components/Text';
import { permitirGrabar, useBackgroundAudio } from '@/hooks/useBackgroundAudio';
import {
  useReproduccionDiferida,
  useSilencioAlDesmontar,
} from '@/hooks/useReproductorUnico';
import { confirm } from '@/lib/confirm';
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

/**
 * Cada cuanto se lee el reloj del microfono mientras se graba.
 *
 * El sondeo es NUESTRO y solo existe en la fase «grabando». Antes esto era
 * `useAudioRecorderState`, que monta un `setInterval` contra el objeto nativo
 * se este grabando o no: cada perfil visitado dejaba un sondeo permanente
 * contra el microfono. Es la misma leccion que ya aprendio `useGrabadoraDeVoz`.
 */
const RELOJ_MS = 250;

/** En que punto esta la grabacion. */
type Fase = 'inactiva' | 'preparando' | 'grabando' | 'guardando';

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
  /**
   * Se pinta dentro de una hoja (`BottomSheet`, que es un `Modal`): desde el
   * 25/09/2026 el audio propio se graba en la bandeja «Editar perfil».
   *
   * Encima de un Modal abierto no se ve nada mas: en iOS el dialogo de
   * `confirm()` no sale y no resuelve nunca, y los `toast` quedan DEBAJO de la
   * hoja. Asi que, en una hoja, quitar se confirma aqui mismo y «guardada» o
   * «quitada» se dicen dentro de la tarjeta.
   */
  enHoja?: boolean;
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
export function AudioDePresentacion({
  rutaDelAudio,
  duracionS,
  esPropio,
  nombre,
  enHoja = false,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const setUser = useAppStore((state) => state.setUser);
  useBackgroundAudio();

  const [aviso, setAviso] = useState<string | null>(null);
  /** Lo que salio bien, dicho dentro de la tarjeta (solo en una hoja). */
  const [hecho, setHecho] = useState<string | null>(null);
  /** En una hoja, «quitar» pide una segunda pulsacion aqui mismo. */
  const [confirmandoQuitar, setConfirmandoQuitar] = useState(false);

  const avisarHecho = useCallback(
    (texto: string) => {
      if (enHoja) setHecho(texto);
      else toast(texto);
    },
    [enHoja],
  );

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

  /*
    AQUI ESTABA EL FALLO DE «LA PRIMERA VEZ NO SUENA».

    Mientras no hay firma, `useAudioPlayer` recibe `null` y crea un reproductor
    nativo SIN FUENTE. La antigua `alternarReproduccion` pedia la URL, la
    guardaba en el estado y llamaba a `reproductor.play()` acto seguido — pero
    ese `reproductor` es el del render actual, el de la fuente `null`: el objeto
    con la fuente buena no existe hasta el render siguiente. `play()` sobre uno
    sin fuente no suena y tampoco lanza, asi que no habia ni error que ver. Al
    segundo toque ya existia el bueno, y de ahi «a la segunda o a la tercera».

    La reproduccion se APUNTA y se dispara cuando la fuente y el reproductor
    estan los dos listos. `isLoaded` es la senal: antes de eso, aunque el objeto
    ya tenga URL, el motor todavia no ha abierto el archivo.
  */
  const listo = !!urlFirmada && (estado?.isLoaded ?? false);
  const { pendiente, pedir, cancelar } = useReproduccionDiferida(reproductor, listo, () =>
    toast(t('intro.prepareFailed')),
  );

  // Callar mientras el objeto nativo sigue vivo. Corre tambien al cambiar de
  // perfil, que es cuando el reproductor se sustituye por otro.
  useSilencioAlDesmontar(reproductor);

  const alternarReproduccion = useCallback(async () => {
    if (sonando) {
      reproductor.pause();
      return;
    }
    // Segundo toque mientras se espera la firma: se cancela, no se encola otra
    // reproduccion. Es lo que evita la carrera del doble toque.
    if (pendiente) {
      cancelar();
      return;
    }
    /*
      Al terminar, el reproductor se queda al final. Sin rebobinar, el segundo
      toque no suena y parece que se haya roto.
    */
    const total = estado?.duration ?? 0;
    if (total > 0 && (estado?.currentTime ?? 0) >= total - 0.2) {
      void reproductor.seekTo(0);
    }
    // La intencion se apunta ANTES de pedir la firma: si ya hay fuente suena en
    // el acto, y si no, en cuanto llegue.
    pedir();
    try {
      const url = await asegurarUrl();
      if (!url) {
        cancelar();
        toast(t('intro.prepareFailed'));
      }
    } catch (e) {
      // El motivo tecnico al registro; a quien mira, un texto traducido.
      console.warn('[intro] no se pudo firmar el audio', e);
      cancelar();
      toast(t('intro.prepareFailed'));
    }
  }, [sonando, pendiente, reproductor, estado, pedir, cancelar, asegurarUrl, t]);

  /* -------------------------------------------------------------- grabar - */
  const grabadora = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const [fase, setFase] = useState<Fase>('inactiva');
  const [msGrabados, setMsGrabados] = useState(0);
  const [borrando, setBorrando] = useState(false);
  const grabando = fase === 'grabando';
  const ocupado = fase === 'guardando' || borrando;

  /*
    Cerrojo del ciclo de vida de la grabadora.

    Va en una referencia y no en el estado por el mismo motivo que en
    `usePublicacion`: se consulta y se escribe dentro del mismo manejador, y con
    estado la segunda llamada leeria el valor viejo y pasaria igual.

    Es LA PIEZA que arregla «AudioRecorder has already been prepared». Dos
    toques seguidos en «Grabar» entraban los dos en `empezar()` —el estado de la
    grabadora se sondeaba cada 250 ms, asi que el segundo toque todavia veia
    «no se esta grabando»— y llamaban dos veces a `prepareToRecordAsync()` sobre
    la misma grabadora ya preparada. Eso es exactamente lo que lanza ese error.

    Tambien cierra la carrera entre el corte automatico al llegar al minuto y un
    toque manual en «parar»: sin el, el mismo audio se subia dos veces.
  */
  const enCurso = useRef(false);
  /** Si la grabadora tiene una preparacion viva que haya que deshacer. */
  const preparada = useRef(false);

  /*
    EL CONTADOR ES NUESTRO Y SOLO CORRE MIENTRAS SE GRABA. Ver `RELOJ_MS`.
  */
  useEffect(() => {
    if (fase !== 'grabando') return;
    const tic = setInterval(() => {
      try {
        // `durationMillis` Y NO `currentTime`. En `expo-audio` 1.1.1 el
        // `currentTime` de una grabadora solo es lo que lleva en iOS; en
        // Android el modulo nativo devuelve ahi la HORA a la que empezo
        // (`AudioModule.kt`: `recorder.startTime`). Multiplicada por mil pasaba
        // del minuto en el primer tic: la presentacion se cortaba sola a los
        // 250 ms y se guardaba diciendo que duraba 60 s.
        setMsGrabados(grabadora.getStatus().durationMillis ?? 0);
      } catch {
        // El objeto nativo ya no esta. Se deja el ultimo valor leido.
      }
    }, RELOJ_MS);
    return () => clearInterval(tic);
  }, [fase, grabadora]);

  /**
   * Deshace la preparacion de la grabadora.
   *
   * `stop()` es la unica via: no hay un «unprepare». Parar algo que ya estaba
   * parado no es un error, y la bandera se baja ANTES de esperar para que un
   * fallo aqui no deje a la grabadora marcada como preparada para siempre.
   */
  const soltarGrabadora = useCallback(async () => {
    if (!preparada.current) return;
    preparada.current = false;
    try {
      await grabadora.stop();
    } catch (e) {
      console.warn('[intro] la grabadora ya estaba parada', e);
    }
  }, [grabadora]);

  const empezar = useCallback(async () => {
    // Pulsaciones rapidas: la segunda no vuelve a preparar nada.
    if (enCurso.current) return;
    enCurso.current = true;
    setAviso(null);
    setHecho(null);
    setConfirmandoQuitar(false);
    setFase('preparando');
    try {
      /*
        El microfono se pide AQUI, al tocar «Grabar», y no al abrir el perfil:
        un permiso pedido sin contexto se rechaza, y en iOS el rechazo no tiene
        vuelta atras dentro de la aplicacion.
      */
      const permiso = await requestRecordingPermissionsAsync();
      if (!permiso.granted) {
        setAviso(permiso.canAskAgain === false ? t('intro.micBlocked') : t('intro.micNeeded'));
        setFase('inactiva');
        return;
      }

      // Grabar con el altavoz sonando se graba a si mismo.
      cancelar();
      try {
        reproductor.pause();
      } catch {
        // Ya liberado; no hay nada que parar.
      }

      // La sesion de audio ANTES de preparar: en iOS `prepareToRecordAsync`
      // falla si la categoria de la sesion no admite grabar.
      await permitirGrabar(true);
      // Si quedo preparada de un intento anterior —reemplazar, o un fallo a
      // medias— se deshace antes: prepararla dos veces es el error 10.8.
      await soltarGrabadora();

      await grabadora.prepareToRecordAsync();
      preparada.current = true;
      grabadora.record();
      setMsGrabados(0);
      setFase('grabando');
    } catch (e) {
      // El error nativo al registro; a quien mira, un texto traducido.
      console.warn('[intro] no se pudo empezar a grabar', e);
      preparada.current = false;
      await permitirGrabar(false);
      setAviso(t('intro.startFailed'));
      setFase('inactiva');
    } finally {
      enCurso.current = false;
    }
  }, [grabadora, reproductor, cancelar, soltarGrabadora, t]);

  const parar = useCallback(async () => {
    if (enCurso.current) return;
    enCurso.current = true;
    setFase('guardando');
    try {
      const duracionMs = Math.min(msGrabados, MAX_INTRO_MS);
      preparada.current = false;
      await grabadora.stop();
      const uri = grabadora.uri;
      // La sesion vuelve a modo reproduccion en cuanto se suelta el microfono,
      // pase lo que pase con el archivo.
      await permitirGrabar(false);
      if (!uri) {
        setAviso(t('intro.emptyRecording'));
        return;
      }
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
      avisarHecho(t('intro.saved'));
    } catch (e) {
      console.warn('[intro] no se pudo guardar la presentacion', e);
      setAviso(t('intro.saveFailed'));
    } finally {
      enCurso.current = false;
      setFase('inactiva');
    }
  }, [grabadora, msGrabados, setUser, avisarHecho, t]);

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
    AL DESMONTAR NO SE TOCA NADA NATIVO.

    `useAudioRecorder` se apoya en `useReleasingSharedObject`, cuya limpieza
    libera el objeto al desmontar, y esa limpieza corre ANTES que esta (se
    declaro antes). Preguntarle cualquier cosa a la grabadora aqui es lo que
    cerraba la aplicacion al salir de un chat; la leccion esta escrita en
    `hooks/grabadoraNoTocaLoLiberado.test.mts` y vale igual aqui.

    `release()` ya cierra el microfono. Lo unico que queda por deshacer es la
    SESION DE AUDIO, que es del proceso: si se queda en modo grabacion, en iOS
    todo el sonido de la aplicacion suena mas bajo hasta que se cierre.
  */
  const grabandoAhora = useRef(false);
  grabandoAhora.current = fase === 'grabando' || fase === 'preparando';
  useEffect(
    () => () => {
      if (grabandoAhora.current) void permitirGrabar(false);
    },
    [],
  );

  /*
    Al salir del perfil, se calla.

    Las secciones del carrusel NO se desmontan (ver SwipeTabs): sin esto,
    escuchar una presentacion y deslizar a Inicio dejaba la voz sonando por
    debajo del video del muro, y encima seguia con la aplicacion en segundo
    plano —`useBackgroundAudio` lo permite para todo el proceso—.

    `useCallback` sin dependencias a proposito: solo hace falta la accion de
    salir, no reengancharla cada vez que cambia el estado del reproductor.
  */
  const alSalir = useRef<() => void>(() => {});
  alSalir.current = () => {
    // Tambien se cancela una reproduccion pendiente: si no, la firma llegaria
    // con el perfil ya cerrado y el audio arrancaria solo.
    cancelar();
    try {
      reproductor.pause();
    } catch {
      // El reproductor puede haberse liberado ya; no hay nada que parar.
    }
  };
  useFocusEffect(
    useCallback(
      () => () => {
        alSalir.current();
      },
      [],
    ),
  );

  const quitar = useCallback(async () => {
    setConfirmandoQuitar(false);
    setHecho(null);
    setBorrando(true);
    try {
      const perfil = await ProfileRepository.updateMyProfile({ introAudioPath: null });
      setUser(perfil);
      cancelar();
      setUrlFirmada(null);
      avisarHecho(t('intro.removed'));
    } catch (e) {
      console.warn('[intro] no se pudo quitar la presentacion', e);
      setAviso(t('intro.removeFailed'));
    } finally {
      setBorrando(false);
    }
  }, [setUser, cancelar, avisarHecho, t]);

  const borrar = useCallback(async () => {
    // En una hoja, la pregunta va en la propia tarjeta (ver `enHoja`).
    if (enHoja) {
      setConfirmandoQuitar(true);
      return;
    }
    const seguro = await confirm({
      title: t('intro.removeTitle'),
      message: t('intro.removeBody'),
      confirmLabel: t('intro.remove'),
      destructive: true,
    });
    if (!seguro) return;
    await quitar();
  }, [enHoja, quitar, t]);

  const duracion = useMemo(() => {
    if (grabando) return reloj(msGrabados / 1000);
    if (estado?.duration) return reloj(estado.duration);
    if (duracionS) return reloj(duracionS);
    return null;
  }, [grabando, msGrabados, estado?.duration, duracionS]);

  const tieneAudio = !!rutaDelAudio;
  // La rueda cubre las tres esperas: firmar, esperar a que la fuente cargue y
  // preparar el microfono. Sin ella, la primera pulsacion no daba ninguna senal.
  const cargando = ocupado || firmando || pendiente || fase === 'preparando';

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
        disabled={ocupado}
        style={[styles.boton, { backgroundColor: grabando ? colors.danger : colors.text }]}
        accessibilityRole="button"
        accessibilityLabel={
          grabando
            ? t('intro.stopRecording')
            : tieneAudio
            ? sonando || pendiente
              ? t('intro.pause')
              : t('intro.listen')
            : t('intro.record')
        }
      >
        {cargando ? (
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
            : firmando || pendiente
            ? t('common.loading')
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
            disabled={cargando}
            hitSlop={8}
            style={styles.accion}
            accessibilityRole="button"
            accessibilityLabel={t('intro.recordAnother')}
          >
            <Feather name="refresh-cw" size={17} color={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={() => void borrar()}
            disabled={cargando}
            hitSlop={8}
            style={styles.accion}
            accessibilityRole="button"
            accessibilityLabel={t('intro.removeA11y')}
          >
            <Feather name="trash-2" size={17} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : null}

      {confirmandoQuitar ? (
        <View style={styles.confirmar}>
          <Text variant="caption" weight="700" color={colors.text} style={styles.confirmarTexto}>
            {t('intro.removeAsk')}
          </Text>
          <Pressable
            onPress={() => setConfirmandoQuitar(false)}
            disabled={borrando}
            hitSlop={6}
            style={[styles.confirmarBoton, { borderColor: colors.border }]}
            accessibilityRole="button"
          >
            <Text variant="caption" weight="700" color={colors.text}>
              {t('common.cancel')}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void quitar()}
            disabled={borrando}
            hitSlop={6}
            style={[styles.confirmarBoton, { borderColor: colors.danger }]}
            accessibilityRole="button"
          >
            <Text variant="caption" weight="700" color={colors.danger}>
              {t('intro.remove')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {hecho && !aviso ? (
        <Text variant="caption" color={colors.textMuted} style={styles.aviso}>
          {hecho}
        </Text>
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
  confirmar: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  confirmarTexto: { flex: 1 },
  confirmarBoton: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 32,
    justifyContent: 'center',
  },
});
