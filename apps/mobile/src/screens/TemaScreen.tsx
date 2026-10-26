import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { BotonDeEnviar } from '@/components/BotonDeEnviar';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { BurbujaDeTema } from '@/components/chat/BurbujaDeTema';
import { HojaDeStickers } from '@/components/chat/HojaDeStickers';
import { VisorDeAdjunto, type AccionDeVisor } from '@/components/chat/VisorDeAdjunto';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useMargenInferior } from '@/components/teclado';
import { useFuncionesDelChat } from '@/hooks/useFuncionesDelChat';
import { useInfoDeConversacion } from '@/hooks/useInfoDeConversacion';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { afterSheetClose } from '@/lib/afterSheetClose';
import { confirm, notify } from '@/lib/confirm';
import { claveDelFalloDeGrupo, nombreDelAutor } from '@/lib/gruposDeChat';
import { dejarDeVerConversacion, marcarConversacionALaVista } from '@/lib/loQueSeVe';
import { alReaccionar, miReaccion, type ReaccionDeMensaje } from '@/lib/reaccionesDeChat';
import { claveDeConversacion } from '@/lib/rutaDelPush';
import { pedirSalto } from '@/lib/saltoDeChat';
import { REACCIONES_RAPIDAS } from '@/lib/stickers';
import {
  MAX_NOMBRE_DE_TEMA,
  claveDelFalloDeTemas,
  fusionarMensajesDeTema,
  instanteMasAntiguoDeTema,
  juzgarNombreDeTema,
  limpiarNombre,
  refrescarLoReciente,
  type TemaDeGrupo,
} from '@/lib/temasDeGrupo';
import { retirarAvisosDe, toast } from '@/lib/toast';
import { unaALaVez } from '@/lib/unaALaVez';
import { MessageRepository } from '@/repositories/MessageRepository';
import { TemasRepository, type MensajeDeTema } from '@/repositories/TemasRepository';
import { ApiError } from '@/services/api';
import { refrescarMensajes } from '@/services/contadores';
import { guardarEnLaGaleria } from '@/services/guardarAdjunto';
import { avisosDeTemas, subscribeToConversation } from '@/services/realtime';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

/** Lo que mide de ancho una foto, como en el chat: 250, o menos si no cabe. */
const ANCHO_DE_MEDIO = 250;
const RELLENO_H = spacing.md + 2;
/** Cuánto se espera a que pare una ráfaga de avisos antes de volver a preguntar. */
const RESPIRO_DE_AVISOS_MS = 600;

type Estado = 'cargando' | 'listo' | 'error' | 'no_existe';

/**
 * UN TEMA por dentro. Se lee como un chat: burbujas en orden, con el mismo
 * aspecto, y debajo de cada una de dónde viene.
 *
 * QUÉ HAY DENTRO. Referencias a mensajes de General —el MISMO mensaje, con sus
 * reacciones de verdad— y lo que la administración escribió solo aquí. Debajo
 * de una referencia, «Ver en General» lleva al mensaje en su sitio.
 *
 * QUIÉN ESCRIBE. Solo la administración (D11), y lo que escribe NO sale en
 * General: se guarda en el chat propio del tema. Por eso escribir es mandar un
 * mensaje a ese chat, como siempre, y escucharlo es suscribirse a él. Los
 * miembros ven, en el sitio del campo, una barra con candado que lo dice.
 *
 * LO QUE CAMBIA SIN MENSAJE NUEVO —agregar o quitar una referencia, borrar,
 * renombrar— llega por la difusión `chat-temas:{grupo}`: quien lo hace avisa y
 * aquí se vuelve a preguntar. El aviso no lleva nada; la verdad es la API.
 *
 * AL ABRIRLO SE DA POR VISTO (`seen`): el numerito del tema en la lista vuelve
 * a cero, y lo escrito aquí queda leído.
 */
export function TemaScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const margenInferior = useMargenInferior();
  const { width: anchoDePantalla } = useWindowDimensions();
  const params = useLocalSearchParams<{ id: string; tema?: string; name?: string }>();
  const grupoId = typeof params.id === 'string' ? params.id : '';
  const temaId = typeof params.tema === 'string' ? params.tema : '';
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUserId = useAppStore((state) => state.user?.id ?? null);
  const activo = supabaseEnabled && !!grupoId && !!temaId;

  // El grupo: los nombres y las fotos de quien escribió, y quién administra.
  const { info } = useInfoDeConversacion(grupoId, currentUserId, activo);
  const funciones = useFuncionesDelChat(activo);

  const [tema, setTema] = useState<TemaDeGrupo | null>(null);
  const [administraLosTemas, setAdministraLosTemas] = useState(false);
  const [mensajes, setMensajes] = useState<MensajeDeTema[]>([]);
  const [estado, setEstado] = useState<Estado>(activo ? 'cargando' : 'error');
  const [hayMasAtras, setHayMasAtras] = useState(false);
  const [cargandoAtras, setCargandoAtras] = useState(false);
  const [borrador, setBorrador] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [accionesDe, setAccionesDe] = useState<MensajeDeTema | null>(null);
  const [reaccionandoA, setReaccionandoA] = useState<MensajeDeTema | null>(null);
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [renombrando, setRenombrando] = useState(false);
  const [fotoAmpliada, setFotoAmpliada] = useState<MessageAttachment | null>(null);
  /** La única nota de voz con reproductor montado (ver `ChatScreen`). */
  const [audioSonando, setAudioSonando] = useState<string | null>(null);

  const puedoAdministrar = administraLosTemas || info?.puedoAdministrar === true;
  const nombreDelTema = tema?.nombre || (typeof params.name === 'string' ? params.name : '');
  const chatId = tema?.chatId ?? null;

  /*
    Lo pintado, accesible desde los avisos sin volver a crearlos: una
    suscripción que se rehace pierde lo que entra mientras tanto.
  */
  const mensajesRef = useRef<MensajeDeTema[]>([]);
  const aplicar = useCallback((lista: MensajeDeTema[]) => {
    mensajesRef.current = lista;
    setMensajes(lista);
  }, []);
  const montada = useRef(true);
  useEffect(
    () => () => {
      montada.current = false;
    },
    [],
  );
  /** Si esta pantalla es la que se está mirando: solo entonces se da por visto. */
  const aLaVista = useRef(true);
  const cargadoUnaVez = useRef(false);
  const canal = useRef<{ avisar: () => void; cerrar: () => void } | null>(null);

  /** «Ya lo vi». Si falla, el numerito se queda: no es motivo para avisar a nadie. */
  const marcarVisto = useCallback(() => {
    if (!aLaVista.current || AppState.currentState !== 'active') return;
    TemasRepository.visto(grupoId, temaId).catch(() => {});
  }, [grupoId, temaId]);

  /*
    LO MÁS RECIENTE, Y EL TEMA CON ELLO. Las dos preguntas a la vez: el tema
    trae su nombre, su chat y sus cuentas; la página, los mensajes. En el
    tramo que cubre la página manda ella sola —lo quitado se va—, y lo bajado
    de antes se conserva (`refrescarLoReciente`).

    Nunca dos a la vez (`unaALaVez`): los avisos llegan en ráfagas.
  */
  const recargar = useMemo(
    () =>
      unaALaVez(async () => {
        if (!activo) return;
        try {
          const [lista, pagina] = await Promise.all([
            TemasRepository.listar(grupoId),
            TemasRepository.mensajes(grupoId, temaId, currentUserId),
          ]);
          if (!montada.current) return;
          const encontrado = lista.disponible ? lista.temas.find((x) => x.id === temaId) ?? null : null;
          if (!encontrado) {
            setEstado('no_existe');
            return;
          }
          setTema(encontrado);
          setAdministraLosTemas(lista.puedoAdministrar);
          aplicar(refrescarLoReciente(mensajesRef.current, pagina.mensajes, pagina.hayMas));
          if (!cargadoUnaVez.current) setHayMasAtras(pagina.hayMas);
          else if (!pagina.hayMas) setHayMasAtras(false);
          cargadoUnaVez.current = true;
          setEstado('listo');
          marcarVisto();
        } catch (error) {
          if (!montada.current) return;
          if (error instanceof ApiError && error.status === 404) {
            setEstado('no_existe');
            return;
          }
          // Un refresco que falla no borra lo que se lee.
          if (!cargadoUnaVez.current) setEstado('error');
        }
      }),
    [activo, grupoId, temaId, currentUserId, aplicar, marcarVisto],
  );

  useEffect(() => {
    void recargar();
  }, [recargar]);

  /** Vuelve a preguntar dentro de un momento: una ráfaga de avisos es una sola pregunta. */
  const programar = useRef<() => void>(() => {});
  useEffect(() => {
    let pendiente: ReturnType<typeof setTimeout> | null = null;
    programar.current = () => {
      if (pendiente) return;
      pendiente = setTimeout(() => {
        pendiente = null;
        void recargar();
      }, RESPIRO_DE_AVISOS_MS);
    };
    return () => {
      if (pendiente) clearTimeout(pendiente);
      programar.current = () => {};
    };
  }, [recargar]);

  /*
    LO ESCRITO EN EL TEMA llega por su chat; lo demás (referencias, borrados,
    renombrar), por la difusión del grupo. Y al engancharse el canal, o al
    volver la aplicación, se pregunta lo que pudo pasar mientras tanto.
  */
  useEffect(() => {
    if (!activo || !chatId) return undefined;
    return subscribeToConversation(
      chatId,
      () => programar.current(),
      (enganchado) => {
        if (enganchado) programar.current();
      },
    );
  }, [activo, chatId]);

  useEffect(() => {
    if (!activo) return undefined;
    const abierto = avisosDeTemas(grupoId, () => programar.current());
    canal.current = abierto;
    return () => {
      canal.current = null;
      abierto.cerrar();
    };
  }, [activo, grupoId]);

  useEffect(() => {
    const suscripcion = AppState.addEventListener('change', (estadoDeLaApp) => {
      if (estadoDeLaApp === 'active' && aLaVista.current) programar.current();
    });
    return () => suscripcion.remove();
  }, []);

  /*
    A LA VISTA. Lo que llegue del chat de este tema no se avisa con un
    flotante: ya se está leyendo. Al salir, la bandeja se pone al día —abrir
    el tema dejó cosas vistas— y al volver se pregunta lo que cambió.
  */
  useFocusEffect(
    useCallback(() => {
      if (!chatId) return undefined;
      marcarConversacionALaVista(chatId);
      retirarAvisosDe((clave) => clave === claveDeConversacion(chatId));
      return () => dejarDeVerConversacion(chatId);
    }, [chatId]),
  );
  const yaTuvoElFoco = useRef(false);
  useFocusEffect(
    useCallback(() => {
      aLaVista.current = true;
      if (yaTuvoElFoco.current) void recargar();
      yaTuvoElFoco.current = true;
      return () => {
        aLaVista.current = false;
        void refrescarMensajes();
      };
    }, [recargar]),
  );

  /** La página anterior, al llegar arriba del todo. */
  const cargarAtras = useCallback(async () => {
    if (cargandoAtras || !hayMasAtras) return;
    const before = instanteMasAntiguoDeTema(mensajesRef.current);
    if (!before) return;
    setCargandoAtras(true);
    try {
      const pagina = await TemasRepository.mensajes(grupoId, temaId, currentUserId, { before });
      if (!montada.current) return;
      aplicar(fusionarMensajesDeTema(mensajesRef.current, pagina.mensajes));
      // Sin nada nuevo se deja de preguntar: cada rebote pediría lo mismo.
      setHayMasAtras(pagina.hayMas && pagina.mensajes.length > 0);
    } catch {
      // Lo ya cargado se queda; se puede volver a intentar subiendo otra vez.
    } finally {
      if (montada.current) setCargandoAtras(false);
    }
  }, [cargandoAtras, hayMasAtras, grupoId, temaId, currentUserId, aplicar]);

  const alDesplazar = (evento: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (evento.nativeEvent.contentOffset.y <= 24) void cargarAtras();
  };

  // -------------------------------------------------------------------------
  // Hacer cosas
  // -------------------------------------------------------------------------

  const textoDelFallo = useCallback(
    (error: unknown): string => {
      const codigo = error instanceof ApiError ? error.code : null;
      return t((claveDelFalloDeTemas(codigo) ?? claveDelFalloDeGrupo(codigo)) as TranslationKey);
    },
    [t],
  );

  /** Tras un cambio: la lista y los demás temas abiertos, que pregunten. */
  const avisarALosDemas = () => canal.current?.avisar();

  const volver = () => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/chat/lista/[id]' as never, params: { id: grupoId } });
  };

  /**
   * Escribir en el tema: SOLO TEXTO en esta versión, y solo la administración.
   * Va al chat del tema, así que no sale en General ni en su tiempo real.
   */
  const enviar = async () => {
    const texto = borrador.trim();
    if (!texto || enviando || !chatId) return;
    setEnviando(true);
    try {
      const enviado = await MessageRepository.sendMessage(chatId, texto, currentUserId);
      const nuevo: MensajeDeTema = {
        ...enviado,
        propio: true,
        conversacionId: chatId,
        anadidoPor: null,
        anadidoEnIso: null,
        ordenIso: enviado.createdAtIso ?? new Date().toISOString(),
      };
      aplicar(fusionarMensajesDeTema(mensajesRef.current, [nuevo]));
      setTema((actual) => (actual ? { ...actual, propios: actual.propios + 1 } : actual));
      setBorrador('');
      avisarALosDemas();
    } catch (error) {
      notify(t('chat.sendFailed'), textoDelFallo(error));
    } finally {
      if (montada.current) setEnviando(false);
    }
  };

  const poner = (mensaje: MensajeDeTema, reacciones: ReaccionDeMensaje[]) =>
    aplicar(mensajesRef.current.map((m) => (m.id === mensaje.id ? { ...m, reacciones } : m)));

  /**
   * Reaccionar (D16), con las rutas de siempre y la conversación DE VERDAD del
   * mensaje: General si es una referencia. En el acto, y corregido con lo que
   * diga el servidor; si falla, vuelve a como estaba.
   */
  const reaccionar = async (mensaje: MensajeDeTema, emoji: string | null) => {
    if (mensaje.eliminado) return;
    const antes = mensaje.reacciones ?? [];
    poner(mensaje, alReaccionar(antes, emoji));
    try {
      poner(mensaje, await MessageRepository.reaccionar(mensaje.conversacionId, mensaje.id, emoji));
      avisarALosDemas();
    } catch {
      poner(mensaje, antes);
      notify(t('chat.reactFailedTitle'), t('common.tryAgainSoon'));
    }
  };

  /** Al mensaje en su sitio, en General: el chat lo busca y lo resalta. */
  const verEnGeneral = (mensaje: MensajeDeTema) => {
    pedirSalto(grupoId, mensaje.id);
    router.push({
      pathname: '/chat/[id]',
      params: info?.titulo ? { id: grupoId, name: info.titulo } : { id: grupoId },
    });
  };

  /** Lo escrito en el tema lo borra quien lo escribió o quien administra (D4). */
  const puedeBorrar = (mensaje: MensajeDeTema) =>
    mensaje.propio && !mensaje.eliminado && (mensaje.sender === 'me' || puedoAdministrar);

  /**
   * Si mantener presionado abre algo. Un menú que se abre para enseñar que no
   * hay nada que hacer es peor que no abrirse.
   */
  const tieneAcciones = (mensaje: MensajeDeTema) =>
    !mensaje.eliminado && (funciones.reacciones || !mensaje.propio || puedeBorrar(mensaje));

  /** Cierra la hoja y espera: nada se abre encima de una que se va (iOS). */
  const cerrarAcciones = async (): Promise<MensajeDeTema | null> => {
    const mensaje = accionesDe;
    setAccionesDe(null);
    await afterSheetClose();
    return mensaje;
  };

  const verEnGeneralDesdeLaHoja = async () => {
    const mensaje = await cerrarAcciones();
    if (mensaje) verEnGeneral(mensaje);
  };

  const quitarDelTema = async () => {
    const mensaje = await cerrarAcciones();
    if (!mensaje) return;
    try {
      await TemasRepository.quitar(grupoId, temaId, mensaje.id);
      aplicar(mensajesRef.current.filter((m) => m.id !== mensaje.id));
      setTema((actual) =>
        actual ? { ...actual, referencias: Math.max(0, actual.referencias - 1) } : actual,
      );
      avisarALosDemas();
      toast(t('groupTopics.removed'), 'check');
    } catch (error) {
      notify(t('chatMenu.failedTitle'), textoDelFallo(error));
    }
  };

  const eliminarMensaje = async () => {
    const mensaje = await cerrarAcciones();
    if (!mensaje || !puedeBorrar(mensaje)) return;
    const seguro = await confirm({
      title: t('chat.deleteTitle'),
      message: t('groupTopics.deleteOwnHint'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!seguro) return;
    try {
      // Con la conversación de verdad del mensaje: la del chat del tema.
      await MessageRepository.deleteMessage(mensaje.conversacionId, mensaje.id);
      aplicar(mensajesRef.current.filter((m) => m.id !== mensaje.id));
      setTema((actual) => (actual ? { ...actual, propios: Math.max(0, actual.propios - 1) } : actual));
      avisarALosDemas();
      toast(t('groupTopics.messageDeleted'), 'check');
    } catch (error) {
      notify(t('common.deleteFailed'), textoDelFallo(error));
    }
  };

  /** Cierra el menú del tema y espera, por lo mismo que las acciones. */
  const trasElMenu = async () => {
    setMenuAbierto(false);
    await afterSheetClose();
  };

  /**
   * Eliminar el tema (D15). Se dice ANTES qué pasa con lo de dentro: lo traído
   * de General sigue allí; lo escrito solo aquí se borra.
   */
  const eliminarTema = async () => {
    await trasElMenu();
    if (!tema) return;
    const propios = tema.propios;
    const seguro = await confirm({
      title: t('groupTopics.deleteTitle'),
      message:
        propios === 0
          ? t('groupTopics.deleteBody')
          : propios === 1
            ? t('groupTopics.deleteBodyOne')
            : t('groupTopics.deleteBodyMany', { n: propios }),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!seguro) return;
    try {
      await TemasRepository.eliminar(grupoId, temaId);
      avisarALosDemas();
      toast(t('groupTopics.deleted'), 'check');
      volver();
    } catch (error) {
      notify(t('chatMenu.failedTitle'), textoDelFallo(error));
    }
  };

  // -------------------------------------------------------------------------
  // Pintar
  // -------------------------------------------------------------------------

  const anchoDeMedio = Math.min(ANCHO_DE_MEDIO, Math.floor(anchoDePantalla * 0.8) - 2 * RELLENO_H - 2);

  const subtitulo = tema
    ? t('groupTopics.subtitle', {
        n: tema.referencias,
        escritos:
          tema.propios === 1 ? t('groupTopics.writtenOne') : t('groupTopics.writtenMany', { n: tema.propios }),
      })
    : '';

  const mensajeDelVisor = fotoAmpliada
    ? mensajes.find((m) => m.attachments?.some((a) => a.id === fotoAmpliada.id))
    : undefined;
  const accionesDelVisor: AccionDeVisor[] = [];
  if (fotoAmpliada?.url?.startsWith('http') && (fotoAmpliada.kind === 'image' || fotoAmpliada.kind === 'video')) {
    const adjunto = fotoAmpliada;
    accionesDelVisor.push({
      icono: 'download',
      etiqueta: t('chat.saveMedia'),
      alPulsar: () => {
        if (!adjunto.url) return;
        void guardarEnLaGaleria(adjunto.url, adjunto.fileName, adjunto.kind as 'image' | 'video').then(
          (resultado) => {
            if (resultado === 'guardado') notify(t('chat.savedTitle'), t('chat.savedBody'));
            else if (resultado === 'sin_permiso') notify(t('chat.saveDeniedTitle'), t('chat.saveDeniedBody'));
            else if (resultado === 'fallo') notify(t('chat.saveFailedTitle'), t('common.tryAgainSoon'));
          },
        );
      },
    });
  }

  const cabecera = (
    <AppHeader
      onBack={volver}
      rightIcon={puedoAdministrar && tema ? 'more-vertical' : undefined}
      onRightPress={puedoAdministrar && tema ? () => setMenuAbierto(true) : undefined}
      rightLabel={t('groupTopics.topicMenuOpen')}
      center={
        <View style={styles.cabecera}>
          <View style={[styles.icono, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <Feather name={tema?.icono ?? 'folder'} size={16} color={colors.text} />
          </View>
          <View style={styles.cabeceraTextos}>
            <Text numberOfLines={1} weight="700" color={colors.text} style={styles.cabeceraTitulo}>
              {nombreDelTema}
            </Text>
            {subtitulo ? (
              <Text numberOfLines={1} color={colors.textMuted} style={styles.cabeceraSubtitulo}>
                {subtitulo}
              </Text>
            ) : null}
          </View>
        </View>
      }
    />
  );

  if (estado === 'no_existe') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView
          state="empty"
          icon="folder"
          title={t('groupTopics.goneTitle')}
          description={t('groupTopics.goneBody')}
          actionLabel={t('common.back')}
          onAction={volver}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {cabecera}
      <SinTecladoDelante>
        <View style={[styles.zona, { borderTopColor: colors.border }]}>
          <FlashList
            data={mensajes}
            extraData={`${audioSonando ?? ''}|${puedoAdministrar}|${funciones.reacciones}|${info?.miembros.length ?? 0}`}
            keyExtractor={(item: MensajeDeTema) => item.id}
            contentContainerStyle={styles.lista}
            showsVerticalScrollIndicator={false}
            // ANCLADA ABAJO, como el chat: se abre por lo último, y lo que
            // llega arrastra la lista solo si ya se estaba abajo.
            maintainVisibleContentPosition={{
              startRenderingFromBottom: true,
              autoscrollToBottomThreshold: 0.2,
            }}
            onScroll={alDesplazar}
            scrollEventThrottle={100}
            ListHeaderComponent={
              cargandoAtras ? (
                <View style={styles.cargandoAtras}>
                  <ActivityIndicator size="small" color={colors.textMuted} />
                </View>
              ) : null
            }
            ListEmptyComponent={
              estado === 'cargando' ? (
                <StateView state="loading" />
              ) : estado === 'error' ? (
                <StateView
                  state="error"
                  title={t('groupTopics.loadTopicError')}
                  description={t('common.checkConnection')}
                  // Sin servidor no hay a quién volver a preguntar: sin botón.
                  onRetry={
                    activo
                      ? () => {
                          setEstado('cargando');
                          void recargar();
                        }
                      : undefined
                  }
                />
              ) : (
                <StateView
                  state="empty"
                  icon="folder"
                  title={t('groupTopics.emptyTitle')}
                  description={t(puedoAdministrar ? 'groupTopics.emptyAdmin' : 'groupTopics.emptyMember')}
                />
              )
            }
            renderItem={({ item, index }: { item: MensajeDeTema; index: number }) => (
              <BurbujaDeTema
                mensaje={item}
                anterior={mensajes[index - 1]}
                info={info}
                currentUserId={currentUserId}
                anchoDeMedio={anchoDeMedio}
                audioSonando={audioSonando}
                alSonar={setAudioSonando}
                alParar={() => setAudioSonando(null)}
                alVerAdjunto={setFotoAmpliada}
                alMantener={tieneAcciones(item) ? setAccionesDe : undefined}
                alReaccionar={funciones.reacciones ? (m, emoji) => void reaccionar(m, emoji) : undefined}
                alVerEnGeneral={verEnGeneral}
              />
            )}
          />
        </View>

        {/*
          QUIÉN ESCRIBE AQUÍ. La administración tiene el campo, con el aviso de
          que lo suyo no sale en General; los miembros, una barra con candado
          que lo explica en vez de un campo que respondería 403.
        */}
        {puedoAdministrar && tema ? (
          <>
            <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
              <Feather name="edit-3" size={13} color={colors.textMuted} />
              <Text color={colors.textMuted} style={styles.avisoTexto}>
                {t('groupTopics.adminComposerHint')}
              </Text>
            </View>
            <View
              style={[
                styles.barra,
                {
                  borderTopColor: colors.border,
                  backgroundColor: colors.background,
                  paddingBottom: spacing.lg + margenInferior,
                },
              ]}
            >
              <Input
                value={borrador}
                onChangeText={setBorrador}
                onSubmitEditing={() => void enviar()}
                placeholder={t('groupTopics.placeholder', { nombre: nombreDelTema })}
                placeholderTextColor={colors.textMuted}
                returnKeyType="send"
                containerStyle={styles.campo}
                forma="pastilla"
                style={{ minHeight: 40 }}
              />
              <View style={styles.enviar}>
                <BotonDeEnviar
                  onPress={() => void enviar()}
                  listo={!!borrador.trim()}
                  enviando={enviando}
                  accessibilityLabel={t('chat.sendMessage')}
                />
              </View>
            </View>
          </>
        ) : tema ? (
          <View
            style={[
              styles.lectura,
              {
                borderTopColor: colors.border,
                backgroundColor: colors.background,
                paddingBottom: spacing.lg + margenInferior,
              },
            ]}
          >
            <Feather name="lock" size={16} color={colors.textMuted} />
            <Text color={colors.textMuted} style={styles.lecturaTexto}>
              {t('groupTopics.memberBar')}
            </Text>
          </View>
        ) : null}
      </SinTecladoDelante>

      {/* Las acciones de un mensaje del tema. */}
      <BottomSheet visible={!!accionesDe} onClose={() => setAccionesDe(null)}>
        {funciones.reacciones && accionesDe ? (
          <View style={styles.reaccionesRapidas}>
            {REACCIONES_RAPIDAS.map((emoji) => {
              const puesta = miReaccion(accionesDe.reacciones) === emoji;
              return (
                <Pressable
                  key={emoji}
                  onPress={() => {
                    const mensaje = accionesDe;
                    setAccionesDe(null);
                    void reaccionar(mensaje, puesta ? null : emoji);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.reactWith', { emoji })}
                  style={[styles.reaccionRapida, puesta && { backgroundColor: colors.surfaceAlt }]}
                >
                  <Text style={styles.reaccionRapidaTexto}>{emoji}</Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => {
                // Otra hoja no se abre encima de una que se está cerrando.
                void cerrarAcciones().then((mensaje) => setReaccionandoA(mensaje));
              }}
              accessibilityRole="button"
              accessibilityLabel={t('chat.reactMore')}
              style={styles.reaccionRapida}
            >
              <Feather name="plus" size={22} color={colors.text} />
            </Pressable>
          </View>
        ) : null}
        {accionesDe && !accionesDe.propio ? (
          <>
            <ListRow
              title={t('groupTopics.seeInGeneral')}
              leftIcon="corner-up-right"
              onPress={() => void verEnGeneralDesdeLaHoja()}
            />
            {puedoAdministrar ? (
              <ListRow
                title={t('groupTopics.removeFromTopic')}
                subtitle={t('groupTopics.removeFromTopicHint')}
                leftIcon="x"
                onPress={() => void quitarDelTema()}
              />
            ) : null}
          </>
        ) : null}
        {accionesDe && puedeBorrar(accionesDe) ? (
          <ListRow
            title={t('common.delete')}
            subtitle={t('groupTopics.deleteOwnHint')}
            leftIcon="trash-2"
            destructive
            onPress={() => void eliminarMensaje()}
          />
        ) : null}
        {accionesDe && accionesDe.propio && !puedeBorrar(accionesDe) ? (
          <Text color={colors.textMuted} style={styles.nota}>
            {t('groupTopics.ownNote')}
          </Text>
        ) : null}
      </BottomSheet>

      {/* El menú del tema: solo para quien administra. */}
      <BottomSheet visible={menuAbierto} onClose={() => setMenuAbierto(false)}>
        <ListRow
          title={t('groupTopics.rename')}
          leftIcon="edit-2"
          onPress={() => {
            void trasElMenu().then(() => setRenombrando(true));
          }}
        />
        <ListRow
          title={t('groupTopics.delete')}
          leftIcon="trash-2"
          destructive
          onPress={() => void eliminarTema()}
        />
      </BottomSheet>

      <HojaRenombrar
        visible={renombrando}
        tema={tema}
        grupoId={grupoId}
        textoDelFallo={textoDelFallo}
        onClose={() => setRenombrando(false)}
        alGuardar={(cambiado) => {
          setTema(cambiado);
          setRenombrando(false);
          avisarALosDemas();
          void afterSheetClose().then(() => toast(t('groupTopics.renamed'), 'check'));
        }}
      />

      <HojaDeStickers
        visible={!!reaccionandoA}
        titulo={t('chat.reactTitle')}
        onClose={() => setReaccionandoA(null)}
        alElegir={(emoji) => {
          const mensaje = reaccionandoA;
          setReaccionandoA(null);
          if (mensaje) void reaccionar(mensaje, emoji);
        }}
      />

      <VisorDeAdjunto
        adjunto={fotoAmpliada?.url ? fotoAmpliada : null}
        autor={
          !mensajeDelVisor
            ? nombreDelTema
            : mensajeDelVisor.sender === 'me'
              ? t('chatViews.you')
              : nombreDelAutor(info, mensajeDelVisor.autorId, mensajeDelVisor.autorNombre) || nombreDelTema
        }
        fecha={
          mensajeDelVisor?.createdAtIso
            ? new Date(mensajeDelVisor.createdAtIso).toLocaleString(undefined, {
                day: 'numeric',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
              })
            : undefined
        }
        acciones={accionesDelVisor}
        onClose={() => setFotoAmpliada(null)}
      />
    </View>
  );
}

/** «Renombrar»: el nombre nuevo, con los errores dentro de la hoja (iOS). */
function HojaRenombrar({
  visible,
  tema,
  grupoId,
  textoDelFallo,
  onClose,
  alGuardar,
}: {
  visible: boolean;
  tema: TemaDeGrupo | null;
  grupoId: string;
  textoDelFallo: (error: unknown) => string;
  onClose: () => void;
  alGuardar: (tema: TemaDeGrupo) => void;
}) {
  const { t } = useTranslation();
  const [nombre, setNombre] = useState('');
  const [fallo, setFallo] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setNombre(tema?.nombre ?? '');
    setFallo(null);
  }, [visible, tema?.nombre]);

  const guardar = async () => {
    if (!tema || guardando) return;
    const limpio = limpiarNombre(nombre);
    if (limpio === tema.nombre) {
      onClose();
      return;
    }
    const juicio = juzgarNombreDeTema(nombre);
    if (juicio !== 'vale') {
      setFallo(t(juicio === 'vacio' ? 'groupTopics.errorNameEmpty' : 'groupTopics.errorNameLong'));
      return;
    }
    setGuardando(true);
    setFallo(null);
    try {
      const cambiado = await TemasRepository.cambiar(grupoId, tema.id, { nombre: limpio });
      alGuardar(cambiado ?? { ...tema, nombre: limpio });
    } catch (error) {
      setFallo(textoDelFallo(error));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.hoja}>
        <Text weight="800" style={styles.hojaTitulo}>
          {t('groupTopics.renameTitle')}
        </Text>
        <Input
          label={t('groupTopics.nameLabel')}
          value={nombre}
          onChangeText={(texto) => {
            setNombre(texto);
            setFallo(null);
          }}
          maxLength={MAX_NOMBRE_DE_TEMA}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void guardar()}
        />
        <InlineError message={fallo} />
        <Button label={t('common.save')} onPress={() => void guardar()} loading={guardando} disabled={guardando} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0, flexShrink: 1 },
  icono: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cabeceraTextos: { minWidth: 0, flexShrink: 1 },
  cabeceraTitulo: { fontSize: 15 },
  cabeceraSubtitulo: { fontSize: 11 },
  zona: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth },
  // FlashList solo admite relleno en el contenedor.
  lista: { padding: spacing.lg },
  cargandoAtras: { paddingVertical: spacing.md, alignItems: 'center' },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  avisoTexto: { flex: 1, fontSize: 12, lineHeight: 17 },
  barra: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: 1,
    padding: spacing.md,
  },
  campo: { flex: 1 },
  enviar: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  lectura: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: 14,
  },
  lecturaTexto: { flex: 1, fontSize: 13, lineHeight: 18 },
  reaccionesRapidas: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reaccionRapida: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reaccionRapidaTexto: { fontSize: 26, lineHeight: 32 },
  nota: { fontSize: 13, lineHeight: 18, marginHorizontal: spacing.lg, marginTop: spacing.xs },
  hoja: { gap: spacing.md, paddingBottom: spacing.sm },
  hojaTitulo: { fontSize: 20, lineHeight: 24 },
});
