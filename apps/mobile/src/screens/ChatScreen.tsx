import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { AppHeader } from '@/components/AppHeader';
import { BotonDeNotaDeVoz } from '@/components/BotonDeNotaDeVoz';
import { BottomSheet } from '@/components/BottomSheet';
import { BurbujaDeNotaDeVoz } from '@/components/BurbujaDeNotaDeVoz';
import { ImageViewer } from '@/components/ImageViewer';
import { ListRow } from '@/components/ListRow';
import { Input } from '@/components/Input';
import { RespuestaAHistoria } from '@/components/RespuestaAHistoria';
import { useGrabadoraDeVoz } from '@/hooks/useGrabadoraDeVoz';
import { useTranslation } from '@/i18n/useTranslation';
import { afterSheetClose } from '@/lib/afterSheetClose';
import { confirm, notify } from '@/lib/confirm';
import {
  descartarEnvio,
  fusionar,
  instanteMasAntiguo,
  instanteMasReciente,
  nuevoIdTemporal,
  reconciliarEnvio,
} from '@/lib/mensajesEnVivo';
import { toMessageFromRow } from '@/mappers/messageMapper';
import {
  MessageRepository,
  MENSAJES_POR_PAGINA,
  type FuncionesDelChat,
} from '@/repositories/MessageRepository';
import { ApiError } from '@/services/api';
import {
  elegirArchivo,
  elegirFotosOVideos,
  hacerFoto,
  MAX_ADJUNTOS,
  subirAdjunto,
  type AdjuntoElegido,
  type AdjuntoSubido,
} from '@/services/messageMedia';
import { PermisoDenegadoError } from '@/services/storage';
import { subscribeToConversation } from '@/services/realtime';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Message, MessageAttachment } from '@/types';

/** Un envío que se puede repetir tal cual si falla. */
type EnvioPendiente = { texto: string; archivos: AdjuntoElegido[] };

/**
 * La lápida de un mensaje borrado: sin relleno, con el borde a la vista y en
 * cursiva. Ver el comentario del `renderItem`.
 */
const ESTILO_ELIMINADO = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 6,
  backgroundColor: 'transparent' as const,
};

/**
 * Cuánto silencio hace falta para que un mensaje vuelva a llevar su hora.
 *
 * Dentro de una ráfaga —lo normal al escribir— repetir «14:32» en cada burbuja
 * no informa de nada y llena la conversación de ruido. Pasados cinco minutos, en
 * cambio, saber cuándo se dijo algo vuelve a importar.
 */
const MINUTOS_DE_RAFAGA = 5;

function pesoLegible(bytes?: number | null): string {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** El día de un mensaje, o `null` si todavía no ha llegado al servidor. */
function diaDe(mensaje?: Message): string | null {
  if (!mensaje?.createdAtIso) return null;
  const fecha = new Date(mensaje.createdAtIso);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toDateString();
}

/**
 * Si dos mensajes seguidos van en la misma ráfaga: mismo autor y poco tiempo.
 *
 * Es lo único que decide el agrupado visual. Se mira contra el mensaje ANTERIOR
 * de la lista, no contra un estado acumulado, para que reordenar o insertar por
 * Realtime no deje el agrupado desincronizado con lo que se ve.
 */
function mismaRafaga(actual: Message, anterior?: Message): boolean {
  if (!anterior || anterior.sender !== actual.sender) return false;
  if (anterior.eliminado || actual.eliminado) return false;
  if (!anterior.createdAtIso || !actual.createdAtIso) return false;
  const a = new Date(anterior.createdAtIso).getTime();
  const b = new Date(actual.createdAtIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return b - a < MINUTOS_DE_RAFAGA * 60 * 1000;
}

export function ChatScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUserId = useAppStore((state) => state.user?.id);

  // Modo demo (sin Supabase): usa el store local.
  const conversations = useAppStore((state) => state.conversations);
  const sendMessageDemo = useAppStore((state) => state.sendMessage);

  // Solo lo que hay en el store. Antes, un id 'darren' se inventaba aqui una
  // conversacion con un mentor y su saludo escrito a mano. No se veia en
  // produccion —hace falta Supabase apagado—, pero era el mismo dato falso que
  // llevo a borrar `/short/[id]` y la rama demo de `ProfileScreen`: un chat que
  // parece de alguien y no lo es.
  const demoConversation = useMemo(
    () => conversations.find((item) => item.id === params.id),
    [conversations, params.id],
  );

  const [remoteMessages, setRemoteMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [elegidos, setElegidos] = useState<AdjuntoElegido[]>([]);
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [fotoAmpliada, setFotoAmpliada] = useState<MessageAttachment | null>(null);
  // Historial: si queda algo más arriba y si se está trayendo ahora mismo.
  const [hayMasHistorial, setHayMasHistorial] = useState(true);
  const [cargandoHistorial, setCargandoHistorial] = useState(false);
  // El mensaje cuyo menú de acciones está abierto.
  const [accionesDe, setAccionesDe] = useState<Message | null>(null);

  /*
    LA UNICA NOTA DE VOZ QUE PUEDE TENER REPRODUCTOR MONTADO.

    Es el identificador del adjunto que está sonando, o `null`. Vive AQUI, en la
    pantalla, y no en cada burbuja, porque una burbuja no puede decidir no
    montarse a sí misma: la guarda tiene que estar fuera. Es el mismo patrón que
    `videoAbierto ===` en `ProfileSection`, y existe por la misma razón cara —un
    reproductor nativo por celda agotaba la memoria de Android y cerraba la
    aplicación, ver `components/cuadriculaSinReproductores.test.mts`—. Un chat es
    todavía peor que una cuadrícula: el historial pagina, así que la lista crece
    sin techo mientras alguien sube por la conversación.
  */
  const [audioSonando, setAudioSonando] = useState<string | null>(null);

  /*
    Que funciones ofrece el servidor. NUNCA UN BOTON MUERTO.

    Mientras la migración 0044 no esté aplicada, `notasDeVoz` es `false` y el
    micrófono NO se pinta. La alternativa —pintarlo y fallar al soltarlo— sería
    dejar que alguien hable treinta segundos para después perderlo todo con un
    503. Un fallo de red también responde `false`, por lo mismo.
  */
  const [funciones, setFunciones] = useState<FuncionesDelChat>({
    notasDeVoz: false,
    respuestasAHistorias: false,
  });

  /*
    Lo último que se intentó enviar, para poder repetirlo.

    Vive en una referencia y no en el estado porque cambiarlo no tiene que
    repintar nada: solo se lee cuando alguien pulsa «reintentar».
  */
  const ultimoEnvio = useRef<EnvioPendiente | null>(null);

  /*
    Lo que ya se ha pintado, accesible desde los callbacks de Realtime.

    Sin esto, la suscripción se tendría que volver a montar cada vez que cambia
    la lista para no leer una versión antigua; y volver a montarla significa
    cerrar el canal y abrir otro, perdiendo los mensajes que lleguen en medio.
  */
  const mensajesRef = useRef<Message[]>([]);
  mensajesRef.current = remoteMessages;

  const aplicar = useCallback((siguiente: Message[]) => {
    mensajesRef.current = siguiente;
    setRemoteMessages(siguiente);
  }, []);

  // Carga inicial + suscripción Realtime a los mensajes de la conversación.
  useEffect(() => {
    if (!supabaseEnabled || !params.id) return;
    let montado = true;
    const conversationId = params.id;

    MessageRepository.listMessages(conversationId, currentUserId)
      .then((msgs) => {
        if (!montado) return;
        aplicar(msgs);
        // Si vino una página entera, es que probablemente hay más arriba.
        setHayMasHistorial(msgs.length >= MENSAJES_POR_PAGINA);
      })
      // Sin esto un fallo de carga dejaba el chat vacio, como si no hubiera
      // mensajes, en vez de avisar de que no se pudieron cargar.
      .catch(() => {
        if (montado) setLoadError(t('chat.loadFailed'));
      });
    MessageRepository.markRead(conversationId).catch(() => {});

    const unsubscribe = subscribeToConversation(conversationId, (row) => {
      if (!montado) return;
      /*
        La fila de Realtime se pinta AL INSTANTE, aunque venga incompleta: es lo
        que hace que un chat se sienta vivo. `fusionar` se encarga de que no
        salga dos veces, que es el fallo clásico aquí —el mensaje propio llega
        por la respuesta del POST y también por esta suscripción, mientras en
        pantalla ya hay una burbuja optimista—.
      */
      aplicar(fusionar(mensajesRef.current, [toMessageFromRow(row, currentUserId)]));

      /*
        Y después se completa. La fila cruda de `messages` no sabe nada de los
        archivos que cuelgan de ella —ni de la historia a la que respondía—, así
        que se piden las novedades desde el último mensaje conocido: UNA petición
        para toda la ráfaga, no una por mensaje.
      */
      const desde = instanteMasReciente(
        // Sin contar la fila recién llegada: el instante tiene que ser ANTERIOR
        // a ella para que la petición la incluya.
        mensajesRef.current.filter((m) => m.id !== row.id),
      );
      /*
        Sin nada anterior de donde colgar el corte —el primer mensaje de una
        conversación recién abierta— se pide la primera página entera. Es una
        petición más grande, pero pasa una vez por conversación y es la
        diferencia entre que la primera foto que alguien manda se vea o quede en
        un hueco vacío hasta reabrir el chat.
      */
      const completar = desde
        ? MessageRepository.listMessagesSince(conversationId, desde, currentUserId)
        : MessageRepository.listMessages(conversationId, currentUserId);
      completar
        .then((nuevos) => {
          if (montado && nuevos.length) {
            aplicar(fusionar(mensajesRef.current, nuevos));
          }
        })
        .catch(() => {
          // La burbuja de texto ya está puesta; sin esto solo faltaría el
          // adjunto, y volverá con el siguiente mensaje o al reabrir.
        });
      MessageRepository.markRead(conversationId).catch(() => {});
    });

    return () => {
      montado = false;
      unsubscribe();
    };
  }, [supabaseEnabled, params.id, currentUserId, aplicar]);

  /*
    Qué se puede hacer en esta instalación. Una sola pregunta al abrir el chat.

    En modo demo no se pregunta: no hay servidor al que preguntar, y las notas de
    voz necesitan uno para subirlas.
  */
  useEffect(() => {
    if (!supabaseEnabled) return;
    let montado = true;
    MessageRepository.funciones()
      .then((disponibles) => {
        if (montado) setFunciones(disponibles);
      })
      .catch(() => {
        // `funciones()` ya devuelve todo en `false` ante un fallo. Esto es por
        // si alguna vez dejara de hacerlo: sin micrófono se sigue escribiendo.
      });
    return () => {
      montado = false;
    };
  }, [supabaseEnabled]);

  /** Trae la página anterior del historial al llegar arriba del todo. */
  const cargarMasHistorial = useCallback(() => {
    if (!supabaseEnabled || !params.id) return;
    if (cargandoHistorial || !hayMasHistorial) return;
    const before = instanteMasAntiguo(mensajesRef.current);
    if (!before) return;

    setCargandoHistorial(true);
    MessageRepository.listMessages(params.id, currentUserId, { before })
      .then((viejos) => {
        // Nada más arriba: se deja de preguntar. Sin esto, cada rebote de la
        // lista lanzaría otra petición para recibir siempre lo mismo.
        if (viejos.length === 0) setHayMasHistorial(false);
        else aplicar(fusionar(mensajesRef.current, viejos));
      })
      .catch(() => {
        // Un fallo al subir por el historial no borra lo que ya se lee.
      })
      .finally(() => setCargandoHistorial(false));
  }, [supabaseEnabled, params.id, currentUserId, cargandoHistorial, hayMasHistorial, aplicar]);

  const headerName = params.name ?? demoConversation?.name ?? t('chat.conversation');
  const messages = supabaseEnabled ? remoteMessages : demoConversation?.messages ?? [];

  // -------------------------------------------------------------------------
  // Elegir archivos
  // -------------------------------------------------------------------------

  const anadir = useCallback((nuevos: AdjuntoElegido[]) => {
    if (nuevos.length === 0) return;
    setElegidos((previos) => {
      const total = [...previos, ...nuevos];
      if (total.length > MAX_ADJUNTOS) {
        notify(
          'Demasiados archivos',
          `Se pueden mandar hasta ${MAX_ADJUNTOS} en un mismo mensaje.`,
        );
        return total.slice(0, MAX_ADJUNTOS);
      }
      return total;
    });
  }, []);

  /**
   * Envuelve al selector para que un permiso denegado se explique.
   *
   * `PermisoDenegadoError` existe justo para esto: sin distinguirlo de «la
   * persona canceló», el botón se quedaba mudo para siempre. En iOS el sistema
   * solo pregunta una vez, así que quien lo rechazó en su día no tiene forma de
   * saber por qué no pasa nada.
   */
  const elegirCon = useCallback(
    async (accion: () => Promise<AdjuntoElegido[] | AdjuntoElegido | null>) => {
      setMenuAbierto(false);
      try {
        const resultado = await accion();
        if (!resultado) return;
        anadir(Array.isArray(resultado) ? resultado : [resultado]);
      } catch (error) {
        notify(
          t('common.couldNotOpen'),
          error instanceof PermisoDenegadoError ? error.message : t('chat.pickerFailed'),
        );
      }
    },
    [anadir],
  );

  const quitarElegido = useCallback((indice: number) => {
    setElegidos((previos) => previos.filter((_, i) => i !== indice));
  }, []);

  // -------------------------------------------------------------------------
  // Enviar
  // -------------------------------------------------------------------------

  /**
   * Sube los archivos y guarda el mensaje.
   *
   * Se separa de `submit` para que «reintentar» pueda repetir exactamente lo
   * mismo sin volver a pedir los archivos: los que ya se eligieron siguen
   * estando en el teléfono.
   */
  const enviar = useCallback(
    async (envio: EnvioPendiente, idTemporal: string) => {
      if (!params.id) return;
      const conversationId = params.id;

      const marcarProgreso = (ratio: number) => {
        aplicar(
          mensajesRef.current.map((m) =>
            m.id === idTemporal ? { ...m, progreso: ratio } : m,
          ),
        );
      };

      try {
        const subidos: AdjuntoSubido[] = [];
        for (let i = 0; i < envio.archivos.length; i += 1) {
          const archivo = envio.archivos[i];
          if (!archivo) continue;
          subidos.push(
            await subirAdjunto(conversationId, archivo, ({ ratio }) => {
              // El avance de TODO el envío, no el de un archivo suelto: con tres
              // fotos, una barra que vuelve a cero tres veces parece un error.
              marcarProgreso((i + ratio) / envio.archivos.length);
            }),
          );
        }

        const guardado = await MessageRepository.sendMessage(
          conversationId,
          envio.texto,
          currentUserId,
          subidos,
        );
        aplicar(reconciliarEnvio(mensajesRef.current, idTemporal, guardado));
        ultimoEnvio.current = null;
      } catch (error) {
        /*
          La burbuja se QUEDA, marcada como fallida y con su botón de reintentar.
          Antes desaparecía sin decir nada y quien escribía creía que su mensaje
          se había enviado; borrarla y avisar sigue perdiendo el texto y los
          archivos elegidos, que es lo que más cuesta rehacer.
        */
        aplicar(
          mensajesRef.current.map((m) =>
            m.id === idTemporal
              ? { ...m, estado: 'error' as const, progreso: undefined }
              : m,
          ),
        );
        ultimoEnvio.current = envio;

        const codigo = error instanceof ApiError ? error.code : undefined;
        const esFaltaDeMigracion =
          codigo === 'chat_attachments_not_available' ||
          codigo === 'voice_notes_not_available';
        notify(
          esFaltaDeMigracion ? t('chat.attachmentsOffTitle') : t('chat.sendFailed'),
          esFaltaDeMigracion
            ? /*
                Se distinguen los dos porque no son lo mismo para quien mira: sin
                la 0033 no se puede mandar NADA adjunto; sin la 0044 se pueden
                mandar fotos y solo faltan las notas de voz. Decir «no se pueden
                enviar archivos» cuando sí se pueden manda a buscar un problema
                que no existe.
              */
              codigo === 'voice_notes_not_available'
              ? t('chat.voiceNotesOffBody')
              : t('chat.attachmentsOffBody')
            : error instanceof Error
              ? error.message
              : t('common.checkConnection'),
        );
      } finally {
        setEnviando(false);
      }
    },
    [params.id, currentUserId, aplicar],
  );

  /**
   * Pinta la burbuja optimista y arranca el envío.
   *
   * Lo usan los dos caminos que mandan algo —el botón de enviar y el micrófono—
   * para que la nota de voz reciba exactamente el mismo trato que el resto: la
   * misma burbuja provisional, la misma barra de subida, la misma
   * reconciliación y el mismo reintento si falla.
   */
  const mandar = useCallback(
    async (envio: EnvioPendiente) => {
      if (enviando) return;
      setEnviando(true);

      const idTemporal = nuevoIdTemporal();
      aplicar(
        fusionar(mensajesRef.current, [
          {
            id: idTemporal,
            text: envio.texto,
            sender: 'me' as const,
            createdAt: '',
            estado: 'enviando' as const,
            progreso: envio.archivos.length ? 0 : undefined,
            // Vista previa local mientras sube: la ruta local vale como `url`,
            // así la burbuja enseña la foto —o deja oír la nota— desde el primer
            // instante.
            attachments: envio.archivos.map((archivo, i) => ({
              id: `${idTemporal}-${i}`,
              storagePath: '',
              kind: archivo.kind,
              fileName: archivo.name,
              bytes: archivo.bytes,
              width: archivo.width,
              height: archivo.height,
              // La duración tiene que viajar YA: sin ella la burbuja de una nota
              // de voz recién grabada saldría marcando 0:00 hasta que el
              // servidor la devolviera.
              durationS: archivo.durationS,
              url: archivo.uri,
            })),
          },
        ]),
      );
      await enviar(envio, idTemporal);
    },
    [enviando, aplicar, enviar],
  );

  const submit = async () => {
    const body = text.trim();
    if (!body && elegidos.length === 0) return;
    if (enviando) return;

    if (!supabaseEnabled) {
      if (demoConversation && body) sendMessageDemo(demoConversation.id, body);
      setText('');
      return;
    }

    const envio: EnvioPendiente = { texto: body, archivos: elegidos };
    setText('');
    setElegidos([]);
    await mandar(envio);
  };

  const reintentar = useCallback(
    async (mensaje: Message) => {
      const envio = ultimoEnvio.current;
      if (!envio || enviando) return;
      setEnviando(true);
      aplicar(
        mensajesRef.current.map((m) =>
          m.id === mensaje.id
            ? { ...m, estado: 'enviando' as const, progreso: envio.archivos.length ? 0 : undefined }
            : m,
        ),
      );
      await enviar(envio, mensaje.id);
    },
    [enviando, enviar, aplicar],
  );

  const descartar = useCallback(
    (mensaje: Message) => {
      aplicar(descartarEnvio(mensajesRef.current, mensaje.id));
      ultimoEnvio.current = null;
    },
    [aplicar],
  );

  // -------------------------------------------------------------------------
  // Nota de voz
  // -------------------------------------------------------------------------

  /**
   * Una nota terminada se manda SOLA, sin pasar por la tira de adjuntos.
   *
   * Es lo que espera cualquiera que venga de otro chat: se suelta y sale. Dejar
   * la nota esperando en la previa obligaría a un segundo toque para algo que ya
   * se ha decidido al levantar el dedo, y confundiría el gesto de cancelar
   * —deslizar— con el de quitar un adjunto.
   */
  const grabadora = useGrabadoraDeVoz({
    alTerminar: (nota) => {
      void mandar({ texto: '', archivos: [nota] });
    },
    alAvisar: (aviso) => {
      /*
        UN PERMISO DENEGADO SE EXPLICA Y SE OFRECE LA SALIDA. Cuando el sistema
        ya no va a volver a preguntar —en iOS basta con haber dicho que no una
        vez— pedirlo otra vez no hace absolutamente nada, así que se lleva a la
        persona a los ajustes con un botón. Sin esto, el micrófono es un botón
        que no responde y nadie sabe por qué.
      */
      if (!aviso.accion) {
        notify(aviso.titulo, aviso.cuerpo);
        return;
      }
      void confirm({
        title: aviso.titulo,
        message: aviso.cuerpo,
        confirmLabel: aviso.accion.texto,
        cancelLabel: t('common.cancel'),
      }).then((ok) => {
        if (ok) aviso.accion?.alPulsar();
      });
    },
  });

  // -------------------------------------------------------------------------
  // Menú de acciones y borrado
  // -------------------------------------------------------------------------

  /**
   * Borra un mensaje PROPIO, para todo el mundo.
   *
   * PREGUNTA ANTES, porque no se puede deshacer: lo que se borra desaparece
   * también del teléfono de la otra persona, y ahí ya lo ha podido leer.
   *
   * QUIÉN PUEDE lo decide el servidor. Aquí ni se ofrece sobre un mensaje ajeno
   * —`sender !== 'me'`— ni sobre uno que todavía no ha llegado (no tiene id de
   * verdad que borrar), pero eso es comodidad, no permiso.
   *
   * LO QUE SE VE DESPUÉS es una lápida: la burbuja se queda diciendo «Mensaje
   * eliminado». No se quita de la lista, porque un hueco haría que la
   * conversación mintiera sobre lo que hubo.
   */
  const eliminarMensaje = useCallback(
    async (mensaje: Message) => {
      if (!params.id || mensaje.sender !== 'me' || mensaje.estado || mensaje.eliminado) {
        return;
      }
      const ok = await confirm({
        title: t('chat.deleteTitle'),
        message: t('chat.deleteBody'),
        confirmLabel: t('common.delete'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await MessageRepository.deleteMessage(params.id, mensaje.id);
        /*
          Se marca en el acto en vez de recargar el historial: el servidor ya ha
          confirmado, y volver a pedir la página entera para cambiar una burbuja
          es un viaje que se nota. Si algo se descuadrara, la siguiente carga
          —o el siguiente mensaje que entre— trae la verdad del servidor.

          El contexto de historia también se va: el servidor deja de mandarlo en
          un mensaje borrado, y una lápida no enseña a qué respondía.
        */
        aplicar(
          mensajesRef.current.map((m) =>
            m.id === mensaje.id
              ? { ...m, eliminado: true, text: '', attachments: [], storyContext: undefined }
              : m,
          ),
        );
      } catch (fallo) {
        notify(
          t('common.deleteFailed'),
          fallo instanceof ApiError && fallo.code === 'message_not_yours'
            ? t('chat.deleteNotYours')
            : t('common.tryAgainSoon'),
        );
      }
    },
    [params.id, aplicar],
  );

  /**
   * Abre el menú de acciones de una burbuja, con pulsación larga.
   *
   * Solo sobre lo PROPIO y ya entregado, que es sobre lo único que hay algo que
   * hacer. Un menú que se abre para enseñar que no hay opciones es peor que no
   * abrirse.
   */
  const abrirAcciones = useCallback((mensaje: Message) => {
    if (mensaje.sender !== 'me' || mensaje.estado || mensaje.eliminado) return;
    setAccionesDe(mensaje);
  }, []);

  /**
   * Borrar DESDE la hoja. El `afterSheetClose` no es opcional.
   *
   * Los `BottomSheet` son `Modal` de React Native y en iOS no se puede presentar
   * nada encima de un Modal que sigue en pantalla; cerrarlo tarda su animación.
   * Lanzar el diálogo de confirmación antes de que termine falla EN SILENCIO: no
   * hay error, simplemente no aparece nada y el botón parece roto. Es el mismo
   * fallo que ya se pagó con el selector de fotos y la subida de historias.
   */
  const eliminarDesdeElMenu = useCallback(async () => {
    const mensaje = accionesDe;
    setAccionesDe(null);
    if (!mensaje) return;
    await afterSheetClose();
    await eliminarMensaje(mensaje);
  }, [accionesDe, eliminarMensaje]);

  // -------------------------------------------------------------------------
  // Pintar
  // -------------------------------------------------------------------------

  const pintarAdjunto = (adjunto: MessageAttachment, mio: boolean) => {
    const colorTexto = mio ? colors.onPrimary : colors.text;

    /*
      LA NOTA DE VOZ NO MONTA REPRODUCTOR AQUI. Recibe si es la que está sonando
      y un par de avisos; quien decide es la pantalla (`audioSonando`). Ver el
      comentario de ese estado: la guarda tiene que vivir fuera de la burbuja.
    */
    if (adjunto.kind === 'audio') {
      return (
        <BurbujaDeNotaDeVoz
          key={adjunto.id}
          adjunto={adjunto}
          mio={mio}
          activo={audioSonando === adjunto.id}
          alPulsar={() => setAudioSonando(adjunto.id)}
          alTerminar={() => setAudioSonando(null)}
        />
      );
    }

    if (adjunto.kind === 'document') {
      return (
        <View key={adjunto.id} style={[styles.documento, { borderColor: colors.border }]}>
          <Feather name="file-text" size={20} color={colorTexto} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: colorTexto, fontSize: 13, fontWeight: '600' }}>
              {adjunto.fileName ?? 'Archivo'}
            </Text>
            {adjunto.bytes ? (
              <Text style={{ color: colorTexto, fontSize: 10, opacity: 0.7 }}>
                {pesoLegible(adjunto.bytes)}
              </Text>
            ) : null}
          </View>
        </View>
      );
    }

    // La proporción real del archivo, cuando se sabe: sin ella la burbuja da un
    // salto al cargar la imagen y mueve todo lo que hay debajo.
    const proporcion =
      adjunto.width && adjunto.height ? adjunto.width / adjunto.height : 1;

    return (
      <Pressable
        key={adjunto.id}
        onPress={() => (adjunto.url ? setFotoAmpliada(adjunto) : undefined)}
        accessibilityRole="button"
        accessibilityLabel={adjunto.kind === 'video' ? t('chat.viewVideo') : t('chat.viewPhoto')}
        style={[styles.medio, { aspectRatio: Math.min(Math.max(proporcion, 0.6), 1.9) }]}
      >
        {adjunto.url ? (
          <Image source={{ uri: adjunto.url }} style={styles.medioImagen} />
        ) : (
          <View style={[styles.medioImagen, { backgroundColor: colors.border }]} />
        )}
        {adjunto.kind === 'video' ? (
          <View style={styles.play}>
            <Feather name="play" size={22} color="#FFF" />
          </View>
        ) : null}
      </Pressable>
    );
  };

  const hayQueEnviar = text.trim().length > 0 || elegidos.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={headerName} rightIcon="video" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      {loadError ? (
        <Text style={{ color: colors.danger, textAlign: 'center', padding: spacing.sm, fontSize: 12 }}>
          {loadError}
        </Text>
      ) : null}
      <SinTecladoDelante>
        <FlashList
          data={messages}
          keyExtractor={(item: Message) => item.id}
          contentContainerStyle={styles.messages}
          showsVerticalScrollIndicator={false}
          // El historial se pide al llegar ARRIBA, que en una lista de chat es
          // el final de la lista invertida... y esta no lo está, así que se usa
          // el desplazamiento: `onStartReached` no existe en esta versión.
          onScroll={(evento) => {
            if (evento.nativeEvent.contentOffset.y <= 24) cargarMasHistorial();
          }}
          scrollEventThrottle={200}
          ListHeaderComponent={
            cargandoHistorial ? (
              <View style={styles.cargandoHistorial}>
                <ActivityIndicator size="small" color={colors.textMuted} />
              </View>
            ) : null
          }
          renderItem={({ item, index }: { item: Message; index: number }) => {
            const mine = item.sender === 'me';
            const fallido = item.estado === 'error';
            const anterior = messages[index - 1];

            /*
              LA SEPARACION POR DIAS. Se calcula contra el mensaje anterior de la
              lista y no con un contador aparte, para que insertar por Realtime o
              paginar hacia atrás no deje las cabeceras descolocadas.
            */
            const dia = diaDe(item);
            const cambioDeDia = !!dia && dia !== diaDe(anterior);
            const agrupado = mismaRafaga(item, anterior) && !cambioDeDia;

            /*
              LA HORA, DISCRETA. Dentro de una ráfaga no se repite: «14:32» en
              cinco burbujas seguidas no informa de nada.

              PERO SI EL MENSAJE NO LLEVA TEXTO, SE PINTA SIEMPRE. La franja de
              la hora es lo que queda para mantener pulsado en un mensaje que
              solo tiene una foto; sin ella, esas burbujas se quedarían sin
              ninguna zona con la que abrir el menú de acciones.
            */
            const mostrarHora = !agrupado || !item.text || !!item.estado;

            const cabecera = cambioDeDia ? (
              <View style={styles.dia}>
                <Text style={[styles.diaTexto, { color: colors.textMuted, backgroundColor: colors.surfaceAlt }]}>
                  {new Date(item.createdAtIso as string).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'long',
                  })}
                </Text>
              </View>
            ) : null;

            /*
              LA LÁPIDA: la burbuja de un mensaje que su autor borró.

              Se pinta distinta de una burbuja normal —sin relleno, con el borde
              a la vista, en cursiva y con un icono— porque NO es un mensaje: es
              la marca de que hubo uno. Con el mismo aspecto que los demás se
              leería como si alguien hubiera escrito literalmente «Mensaje
              eliminado», que es la confusión clásica de este patrón.

              Y no lleva ni texto, ni adjuntos, ni contexto de historia, porque
              el servidor no los manda: borrar para todos borra de verdad.
            */
            if (item.eliminado) {
              return (
                <View>
                  {cabecera}
                  <View style={mine ? styles.filaMia : styles.filaSuya}>
                    <View
                      style={[
                        styles.bubble,
                        mine ? styles.mine : styles.theirs,
                        ESTILO_ELIMINADO,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Feather name="slash" size={12} color={colors.textMuted} />
                      <Text
                        style={{
                          color: colors.textMuted,
                          fontSize: 13,
                          fontStyle: 'italic',
                        }}
                      >
                        {t('chat.deletedMessage')}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            }

            return (
              <View>
                {cabecera}
                <View style={mine ? styles.filaMia : styles.filaSuya}>
                  <View
                    style={[
                      styles.bubble,
                      mine ? styles.mine : styles.theirs,
                      // Dentro de una ráfaga las burbujas se acercan y pierden
                      // la esquina que apunta al lado: se leen como un bloque.
                      agrupado && (mine ? styles.mineSeguida : styles.theirsSeguida),
                      agrupado && styles.pegada,
                      {
                        backgroundColor: mine ? colors.primary : colors.surface,
                        borderColor: fallido ? colors.danger : colors.border,
                        opacity: item.estado === 'enviando' ? 0.75 : 1,
                      },
                    ]}
                  >
                    {/*
                      A QUE HISTORIA RESPONDIA, encima de todo lo demás: es el
                      contexto que hace que se entienda lo que viene debajo.

                      Va como HERMANO del texto y de los adjuntos, nunca
                      envolviéndolos, por lo mismo que se explica más abajo con
                      el `Pressable`: anidar zonas pulsables genera HTML inválido
                      en web.
                    */}
                    {item.storyContext ? (
                      <RespuestaAHistoria contexto={item.storyContext} mio={mine} />
                    ) : null}

                    {item.attachments?.length ? (
                      <View style={styles.adjuntos}>
                        {item.attachments.map((adjunto) => pintarAdjunto(adjunto, mine))}
                      </View>
                    ) : null}

                    {/*
                      PULSACIÓN LARGA PARA EL MENÚ DE ACCIONES, y solo sobre lo
                      propio.

                      Es el gesto que ya espera cualquiera que venga de otro
                      chat. No hay botón visible: uno por burbuja ensuciaría la
                      conversación entera para algo que casi nunca se usa.

                      POR QUÉ ENVUELVE EL TEXTO Y LA HORA, Y NO LA BURBUJA
                      ENTERA. Porque en web cada `Pressable` es un `<button>`, y
                      los adjuntos YA son `Pressable` (se tocan para ver la foto,
                      para oír la nota). Un Pressable rodeando a otro genera HTML
                      inválido y rompe la hidratación — es una trampa que este
                      proyecto ya pagó. Aquí van como HERMANOS: los adjuntos
                      arriba, esto debajo.

                      `onLongPress` sin `onPress`: tocar la burbuja sigue sin
                      hacer nada, como antes.
                    */}
                    <Pressable
                      onLongPress={
                        mine && !item.estado ? () => abrirAcciones(item) : undefined
                      }
                      delayLongPress={400}
                      accessibilityRole={mine && !item.estado ? 'button' : undefined}
                      accessibilityLabel={
                        mine && !item.estado ? t('chat.holdForActions') : undefined
                      }
                    >
                      {item.text ? (
                        <Text style={{ color: mine ? colors.onPrimary : colors.text, fontSize: 15, lineHeight: 21 }}>
                          {item.text}
                        </Text>
                      ) : null}

                      {item.progreso !== undefined ? (
                        <View style={[styles.barra, { backgroundColor: colors.border }]}>
                          <View
                            style={[
                              styles.barraAvance,
                              {
                                backgroundColor: mine ? colors.onPrimary : colors.primary,
                                width: `${Math.round(item.progreso * 100)}%`,
                              },
                            ]}
                          />
                        </View>
                      ) : null}

                      {mostrarHora ? (
                        <Text
                          style={{
                            color: mine ? colors.onPrimary : colors.textMuted,
                            fontSize: 9,
                            marginTop: 5,
                            opacity: 0.7,
                            textAlign: mine ? 'right' : 'left',
                          }}
                        >
                          {item.estado === 'enviando'
                            ? t('chat.sending')
                            : fallido
                              ? t('chat.notSent')
                              : item.createdAt}
                        </Text>
                      ) : null}
                    </Pressable>
                  </View>

                  {fallido ? (
                    <View style={styles.accionesFallo}>
                      <Pressable
                        onPress={() => reintentar(item)}
                        accessibilityRole="button"
                        accessibilityLabel={t('chat.retrySend')}
                        style={styles.accionFallo}
                      >
                        <Feather name="refresh-cw" size={13} color={colors.primary} />
                        <Text style={{ color: colors.primary, fontSize: 11 }}>
                          {t('common.retry')}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => descartar(item)}
                        accessibilityRole="button"
                        accessibilityLabel={t('chat.discardMessage')}
                        style={styles.accionFallo}
                      >
                        <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                          {t('common.discard')}
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              </View>
            );
          }}
        />

        {/* Lo elegido y todavía sin enviar. Ver lo que se va a mandar antes de
            mandarlo es lo que evita el «he enviado la foto que no era». */}
        {elegidos.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.previa, { borderTopColor: colors.border }]}
            contentContainerStyle={styles.previaContenido}
          >
            {elegidos.map((archivo, indice) => (
              <View
                key={`${archivo.uri}-${indice}`}
                style={[styles.previaItem, { borderColor: colors.border, backgroundColor: colors.surface }]}
              >
                {archivo.kind === 'document' || archivo.kind === 'audio' ? (
                  <View style={styles.previaDocumento}>
                    <Feather
                      name={archivo.kind === 'audio' ? 'mic' : 'file-text'}
                      size={20}
                      color={colors.text}
                    />
                    <Text numberOfLines={2} style={{ color: colors.text, fontSize: 9, textAlign: 'center' }}>
                      {archivo.name ?? 'Archivo'}
                    </Text>
                  </View>
                ) : (
                  <Image source={{ uri: archivo.uri }} style={styles.previaImagen} />
                )}
                {archivo.kind === 'video' ? (
                  <View style={styles.previaPlay}>
                    <Feather name="play" size={14} color="#FFF" />
                  </View>
                ) : null}
                <Pressable
                  onPress={() => quitarElegido(indice)}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.removeAttachment', {
                    nombre: archivo.name ?? t('chat.theFile'),
                  })}
                  style={[styles.previaQuitar, { backgroundColor: colors.background }]}
                >
                  <Feather name="x" size={12} color={colors.text} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}

        <View
          style={[
            styles.inputBar,
            {
              borderTopColor: colors.border,
              backgroundColor: colors.background,
              // Evita que el campo quede bajo la barra de gestos / home indicator.
              paddingBottom: spacing.lg + insets.bottom,
            },
          ]}
        >
          <Pressable
            accessibilityLabel="Adjuntar archivo"
            accessibilityRole="button"
            onPress={() => setMenuAbierto(true)}
            disabled={!supabaseEnabled || grabadora.grabando}
            style={styles.addButton}
          >
            <Feather
              name="plus"
              size={24}
              color={supabaseEnabled && !grabadora.grabando ? colors.text : colors.border}
            />
          </Pressable>

          {/*
            MIENTRAS SE GRABA, EL CAMPO DE TEXTO SE APARTA. Dejarlo daría dos
            modos a la vez —hablando y escribiendo— y el aviso de grabación no
            tendría dónde ponerse sin tapar lo que se escribe.
          */}
          {grabadora.grabando ? (
            <View style={styles.inputContainer} />
          ) : (
            <Input
              value={text}
              onChangeText={setText}
              onSubmitEditing={submit}
              placeholder={t('profile.message')}
              placeholderTextColor={colors.textMuted}
              returnKeyType="send"
              containerStyle={styles.inputContainer}
              style={{ minHeight: 40 }}
            />
          )}

          {/*
            EL MICROFONO SOLO EXISTE SI EL SERVIDOR PUEDE GUARDAR LA NOTA.

            Mientras la 0044 no esté aplicada, `funciones.notasDeVoz` es `false`
            y aquí no se pinta nada: NUNCA UN BOTON MUERTO. Y cuando hay algo
            escrito o adjuntado, el micrófono deja su sitio al avión de papel —
            los dos a la vez obligarían a elegir entre dos botones que hacen lo
            mismo desde el punto de vista de quien mira: mandar.
          */}
          {funciones.notasDeVoz && !hayQueEnviar && supabaseEnabled ? (
            <BotonDeNotaDeVoz
              grabando={grabadora.grabando}
              segundos={grabadora.segundos}
              avance={grabadora.avance}
              empezar={() => void grabadora.empezar()}
              soltar={() => void grabadora.soltar()}
              cancelar={() => void grabadora.cancelar()}
              deshabilitado={enviando}
            />
          ) : (
            <Pressable
              onPress={submit}
              disabled={!hayQueEnviar || enviando}
              style={styles.sendButton}
              accessibilityLabel={t('chat.sendMessage')}
              accessibilityRole="button"
            >
              {enviando ? (
                <ActivityIndicator size="small" color={colors.text} />
              ) : (
                <Feather
                  name="send"
                  size={20}
                  color={hayQueEnviar ? colors.text : colors.border}
                />
              )}
            </Pressable>
          )}
        </View>
      </SinTecladoDelante>

      <BottomSheet visible={menuAbierto} onClose={() => setMenuAbierto(false)}>
        <ListRow
          title={t('chat.photosAndVideos')}
          leftIcon="image"
          onPress={() => void elegirCon(() => elegirFotosOVideos(MAX_ADJUNTOS - elegidos.length))}
        />
        <ListRow
          title={t('chat.camera')}
          leftIcon="camera"
          onPress={() => void elegirCon(hacerFoto)}
        />
        <ListRow
          title={t('chat.file')}
          leftIcon="paperclip"
          onPress={() => void elegirCon(elegirArchivo)}
        />
      </BottomSheet>

      {/* El menú de acciones de una burbuja. */}
      <BottomSheet visible={!!accionesDe} onClose={() => setAccionesDe(null)}>
        <ListRow
          title={t('common.delete')}
          leftIcon="trash-2"
          destructive
          onPress={() => void eliminarDesdeElMenu()}
        />
      </BottomSheet>

      {fotoAmpliada?.url ? (
        <ImageViewer
          uri={fotoAmpliada.url}
          caption={fotoAmpliada.fileName ?? undefined}
          onClose={() => setFotoAmpliada(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // FlashList solo admite padding en contentContainerStyle (nada de gap/flexGrow).
  messages: { padding: spacing.lg },
  cargandoHistorial: { paddingVertical: spacing.md, alignItems: 'center' },
  dia: { alignItems: 'center', marginVertical: spacing.md },
  diaTexto: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    overflow: 'hidden',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  filaMia: { alignItems: 'flex-end' },
  filaSuya: { alignItems: 'flex-start' },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, marginBottom: spacing.md },
  mine: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
  // Dentro de una ráfaga se recupera la esquina redonda y se juntan: el bloque
  // se lee como una sola intervención en vez de como mensajes sueltos.
  mineSeguida: { borderTopRightRadius: 6 },
  theirsSeguida: { borderTopLeftRadius: 6 },
  pegada: { marginBottom: 3 },
  adjuntos: { gap: spacing.sm, marginBottom: spacing.sm },
  medio: {
    width: 220,
    borderRadius: radius.md,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  medioImagen: { width: '100%', height: '100%' },
  play: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  documento: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    width: 220,
  },
  barra: { height: 3, borderRadius: 2, marginTop: spacing.sm, overflow: 'hidden' },
  barraAvance: { height: 3, borderRadius: 2 },
  accionesFallo: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  accionFallo: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  previa: { maxHeight: 96, borderTopWidth: 1 },
  previaContenido: { gap: spacing.sm, padding: spacing.sm },
  previaItem: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previaImagen: { width: '100%', height: '100%' },
  previaDocumento: { alignItems: 'center', justifyContent: 'center', gap: 4, padding: 4 },
  previaPlay: {
    position: 'absolute',
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previaQuitar: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `position: relative` para que el aviso de grabación, que va posicionado
  // sobre esta barra, se ancle aquí y no a la pantalla entera.
  inputBar: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: 1,
    padding: spacing.md,
    paddingBottom: spacing.lg,
  },
  inputContainer: { flex: 1 },
  addButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
