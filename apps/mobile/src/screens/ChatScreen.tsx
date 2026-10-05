import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Aparecer } from '@/components/Aparecer';
import { BotonDeEnviar } from '@/components/BotonDeEnviar';
import { BotonDeNotaDeVoz } from '@/components/BotonDeNotaDeVoz';
import { Pulsable } from '@/components/Pulsable';
import { CabeceraDeChat } from '@/components/CabeceraDeChat';
import { BottomSheet } from '@/components/BottomSheet';
import { BurbujaDeNotaDeVoz } from '@/components/BurbujaDeNotaDeVoz';
import { ImageViewer } from '@/components/ImageViewer';
import { ListRow } from '@/components/ListRow';
import { Input } from '@/components/Input';
import { RespuestaAHistoria } from '@/components/RespuestaAHistoria';
import { SesionEnElChat } from '@/components/SesionEnElChat';
import { StateView } from '@/components/StateView';
import { useGrabadoraDeVoz } from '@/hooks/useGrabadoraDeVoz';
import { useResponderSesion } from '@/hooks/useResponderSesion';
import { useTranslation } from '@/i18n/useTranslation';
import { afterSheetClose } from '@/lib/afterSheetClose';
import { dejarDeVerConversacion, marcarConversacionALaVista } from '@/lib/loQueSeVe';
import { claveDeConversacion } from '@/lib/rutaDelPush';
import { retirarAvisosDe } from '@/lib/toast';
import { refrescarMensajes } from '@/services/contadores';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { confirm, notify } from '@/lib/confirm';
import {
  descartarEnvio,
  fusionar,
  instanteMasAntiguo,
  instanteMasReciente,
  nuevoIdTemporal,
  reconciliarEnvio,
} from '@/lib/mensajesEnVivo';
import {
  comoSolicitud,
  estadosVigentes,
  loQueSigueHaciendoFalta,
  sesionesSinTarjeta,
  type LoSabidoDeUnaSesion,
} from '@/lib/sesionesDelChat';
import { formatTime, toMessageFromRow } from '@/mappers/messageMapper';
import { registrarSalidaPropia } from '@/navigation/capasAbiertas';
import { BookingRepository, type Sesion } from '@/repositories/BookingRepository';
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

/**
 * Si el adjunto ya tiene un enlace del SERVIDOR, y no la ruta local con la que
 * se pinta la burbuja mientras sube.
 *
 * Es lo que decide si se puede abrir fuera de la aplicación: una ruta del
 * teléfono no se puede entregar a otra aplicación —en Android lanza—, y un
 * enlace firmado sí.
 */
function estaEnElServidor(adjunto: MessageAttachment): boolean {
  return !!adjunto.url && adjunto.url.startsWith('http');
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
  // La tarjeta de una sesión no es una burbuja: nada se pega a ella.
  if (anterior.sesion || actual.sesion) return false;
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
  /*
    La PRIMERA carga de la conversación, mientras dura.

    Sin esto, abrir un chat enseñaba una pantalla en blanco que era
    indistinguible de una conversación sin mensajes: quien tenía cobertura mala
    veía «nada» durante segundos y no sabía si esperar o si se habían perdido
    sus mensajes. Empieza en `true` cuando hay algo que pedir, para que el
    primer fotograma ya sea el de «cargando» y no el de «vacío».
  */
  const [cargandoMensajes, setCargandoMensajes] = useState(
    supabaseEnabled && !!params.id,
  );
  /* Sube en uno con cada «Reintentar»: es lo que vuelve a lanzar la carga. */
  const [intentoDeCarga, setIntentoDeCarga] = useState(0);
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
    Lo último que se intentó enviar DESDE CADA BURBUJA, para poder repetirlo.

    ES UN MAPA POR IDENTIFICADOR DE BURBUJA Y NO UN SOLO HUECO. Antes era una
    única referencia (`ultimoEnvio`), y con dos envíos fallidos en pantalla el
    segundo pisaba al primero: pulsar «reintentar» en la PRIMERA burbuja mandaba
    el contenido de la SEGUNDA con el identificador de la primera, y al salir
    bien se vaciaba el hueco, así que la segunda ya no se podía reintentar. Cada
    burbuja fallida guarda ahora lo suyo, y solo lo suelta cuando se envía o se
    descarta.

    Vive en una referencia y no en el estado porque cambiarlo no tiene que
    repintar nada: solo se lee cuando alguien pulsa «reintentar».
  */
  const ultimoEnvioDe = useRef(new Map<string, EnvioPendiente>());

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

    // Cada carga —la primera y cada reintento— empieza limpia: «cargando» a la
    // vista y sin el error del intento anterior.
    setCargandoMensajes(true);
    setLoadError(null);

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
      })
      .finally(() => {
        if (montado) setCargandoMensajes(false);
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
    // `intentoDeCarga` no se lee dentro: está para que «Reintentar» vuelva a
    // lanzar la carga entera —y la suscripción con ella— tras un fallo.
  }, [supabaseEnabled, params.id, currentUserId, aplicar, intentoDeCarga]);

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
  // Sesiones 1:1 dentro de la conversación
  // -------------------------------------------------------------------------

  /*
    Lo que se sabe de una sesión ANTES de que llegue el mensaje que lo
    registra: lo que respondió el servidor al pulsar un botón. Con ello la
    tarjeta deja de ofrecer «Aceptar» en el acto, sin esperar a Realtime.
  */
  const [sabidas, setSabidas] = useState<LoSabidoDeUnaSesion[]>([]);
  /*
    Las sesiones que viven en esta conversación, según la agenda. Sirven para
    dos cosas: poner al día una tarjeta vieja, y poder responder una sesión
    cuya tarjeta no está a la vista (ver `sesionesSinTarjeta`).
  */
  const [sesionesDelChat, setSesionesDelChat] = useState<Sesion[]>([]);
  const conversacionDeSesiones = supabaseEnabled ? params.id : undefined;
  // La conversación que hay AHORA en pantalla: una respuesta que llega tarde,
  // de la conversación anterior, no puede pintarse en esta.
  const conversacionEnPantalla = useRef(conversacionDeSesiones);
  conversacionEnPantalla.current = conversacionDeSesiones;
  const leerSesiones = useCallback(() => {
    const deCual = conversacionDeSesiones;
    if (!deCual) return;
    BookingRepository.deLaConversacion(deCual)
      .then((sesiones) => {
        if (conversacionEnPantalla.current === deCual) setSesionesDelChat(sesiones);
      })
      .catch(() => {
        // Sin esto solo falta el atajo: la agenda sigue teniendo los botones.
      });
  }, [conversacionDeSesiones]);
  useEffect(() => {
    setSesionesDelChat([]);
    leerSesiones();
  }, [leerSesiones]);

  /*
    Y se vuelven a leer cuando llega un mensaje de la otra persona: puede ser
    que acabe de pedir una sesión, o de responder a una. Con un respiro, para
    que una ráfaga de mensajes sea una sola pregunta.
  */
  const ultimoAjeno = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const mensaje = messages[i];
      if (mensaje && mensaje.sender === 'them') return mensaje.id;
    }
    return null;
  }, [messages]);
  /*
    Lo último ajeno que había AL TERMINAR la carga inicial. `undefined` hasta
    entonces: lo que trae esa carga no es una novedad —las sesiones ya se han
    pedido— y lo que llegue después, sí. Aunque sea el primer mensaje que esa
    persona escribe en la conversación.
  */
  const ajenoYaVisto = useRef<string | null | undefined>(undefined);
  const respiroDeSesiones = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Mientras dura la carga inicial no hay novedad que mirar. (Es la salida
    // de este efecto, no de la pantalla: el redactor sigue pintándose.)
    const cargado = !cargandoMensajes;
    if (!cargado) return;
    if (ajenoYaVisto.current === undefined) {
      ajenoYaVisto.current = ultimoAjeno;
      return;
    }
    if (ajenoYaVisto.current === ultimoAjeno) return;
    ajenoYaVisto.current = ultimoAjeno;
    if (respiroDeSesiones.current) clearTimeout(respiroDeSesiones.current);
    respiroDeSesiones.current = setTimeout(() => {
      respiroDeSesiones.current = null;
      leerSesiones();
    }, 800);
  }, [ultimoAjeno, cargandoMensajes, leerSesiones]);
  /*
    Y AL VOLVER A ESTA PANTALLA. Aceptar en la agenda y volver al chat tiene
    que encontrar la tarjeta al día: sin esto seguía ofreciendo «Aceptar», que
    es justo el fallo reportado, por otro camino. (El registro de esa respuesta
    es un mensaje propio, así que la relectura de arriba no lo ve.)
  */
  const enfocadaAntes = useRef(false);
  useFocusEffect(
    useCallback(() => {
      // La primera vez ya las pide el montaje.
      if (enfocadaAntes.current) leerSesiones();
      enfocadaAntes.current = true;
    }, [leerSesiones]),
  );
  // El respiro no sobrevive a la pantalla.
  useEffect(
    () => () => {
      if (respiroDeSesiones.current) clearTimeout(respiroDeSesiones.current);
    },
    [],
  );

  /*
    Cómo está HOY cada sesión de la que habla esta conversación. La tarjeta de
    la solicitud pinta esto, no lo que traía su mensaje cuando se cargó: una
    respuesta posterior lo deja viejo. Ver `lib/sesionesDelChat.ts`.
  */
  const estadosDeSesion = useMemo(
    () =>
      estadosVigentes(messages, [
        ...sesionesDelChat.map((sesion) => ({
          sesionId: sesion.id,
          estado: sesion.estado,
          actualizadaIso: sesion.actualizadaIso,
        })),
        ...sabidas,
      ]),
    [messages, sesionesDelChat, sabidas],
  );
  /** Las vivas cuya tarjeta no está en pantalla: se pintan al final. */
  const sesionesAlFinal = useMemo(
    () => sesionesSinTarjeta(sesionesDelChat, messages, estadosDeSesion),
    [sesionesDelChat, messages, estadosDeSesion],
  );
  /*
    Lo que pinta la lista: los mensajes y, al final, esas tarjetas COMO
    ELEMENTOS, no como un pie. La lista solo se desplaza sola hasta abajo
    cuando cambian sus elementos: en un pie, la tarjeta —que llega un instante
    después del mensaje— se quedaba por debajo del borde y había que
    desplazar para encontrar los botones.
  */
  const elementos = useMemo<Message[]>(
    () =>
      sesionesAlFinal.length === 0
        ? messages
        : [
            ...messages,
            ...sesionesAlFinal.map((sesion) => ({
              id: `sesion:${sesion.id}`,
              text: '',
              sender: sesion.miRol === 'requester' ? ('me' as const) : ('them' as const),
              createdAt: formatTime(sesion.creadaIso),
              sesion: comoSolicitud(sesion),
            })),
          ],
    [messages, sesionesAlFinal],
  );

  // En cuanto un mensaje trae esa versión, deja de hacer falta recordarla.
  useEffect(() => {
    setSabidas((previas) => {
      if (previas.length === 0) return previas;
      const quedan = loQueSigueHaciendoFalta(messages, previas);
      return quedan.length === previas.length ? previas : quedan;
    });
  }, [messages]);

  const { ocupada: sesionOcupada, responder: responderSesion } = useResponderSesion({
    alCambiar: (sesion) => {
      setSabidas((previas) => [
        ...previas.filter((dato) => dato.sesionId !== sesion.id),
        { sesionId: sesion.id, estado: sesion.estado, actualizadaIso: sesion.actualizadaIso },
      ]);
      setSesionesDelChat((previas) => previas.map((s) => (s.id === sesion.id ? sesion : s)));
    },
    /*
      El servidor dijo «eso ya no se puede»: la sesión cambió por otro lado —se
      respondió desde la agenda, o respondió la otra persona— y lo que hay en
      pantalla es viejo. Se le pregunta a la agenda cómo están, que es quien lo
      sabe aunque el mensaje que lo registra no haya llegado.
    */
    alDesfasar: leerSesiones,
  });
  // Lo que la lista tiene que mirar, además de los mensajes, para repintar.
  const extraDeSesiones = useMemo(
    () => ({ estadosDeSesion, sesionOcupada }),
    [estadosDeSesion, sesionOcupada],
  );

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
        ultimoEnvioDe.current.delete(idTemporal);
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
        // Bajo el identificador de SU burbuja: es lo que permite reintentar
        // esta sin tocar otra que también haya fallado.
        ultimoEnvioDe.current.set(idTemporal, envio);

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
      // Lo que se intentó mandar desde ESTA burbuja, no lo último que falló.
      const envio = ultimoEnvioDe.current.get(mensaje.id);
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
      ultimoEnvioDe.current.delete(mensaje.id);
    },
    [aplicar],
  );

  // -------------------------------------------------------------------------
  // Nota de voz
  // -------------------------------------------------------------------------

  /**
   * Sube UNA nota de voz y crea su mensaje. Devuelve si el servidor lo confirmó.
   *
   * NO PASA POR `mandar`, y la diferencia es lo que evita que el mensaje entre
   * dos veces. `mandar` deja la burbuja fallida en la conversación con su propio
   * «reintentar», y una nota de voz ya tiene el suyo en la barra del redactor
   * —que además conserva el audio—. Dos botones de reintentar sobre el mismo
   * envío son dos subidas y dos mensajes.
   *
   * Así que aquí la burbuja optimista se pone igual —se ve al instante, con su
   * barra de subida— pero SI FALLA SE RETIRA: el único sitio donde queda algo
   * pendiente es la barra de voz, con la grabación intacta. Y si sale bien,
   * `reconciliarEnvio` sustituye la provisional por la del servidor, así que el
   * mensaje queda EXACTAMENTE UNA VEZ aunque Realtime entregue la fila antes de
   * que responda el POST (de eso se encarga `fusionar`, ver `mensajesEnVivo`).
   */
  const enviarNotaDeVoz = useCallback(
    async (nota: AdjuntoElegido, avisarProgreso: (ratio: number) => void) => {
      const conversationId = params.id;
      if (!conversationId) return false;

      const idTemporal = nuevoIdTemporal();
      aplicar(
        fusionar(mensajesRef.current, [
          {
            id: idTemporal,
            text: '',
            sender: 'me' as const,
            createdAt: '',
            estado: 'enviando' as const,
            progreso: 0,
            attachments: [
              {
                id: `${idTemporal}-0`,
                storagePath: '',
                kind: 'audio' as const,
                fileName: nota.name,
                bytes: nota.bytes,
                width: null,
                height: null,
                // La duración tiene que viajar YA: sin ella la burbuja de una
                // nota recién grabada saldría marcando 0:00.
                durationS: nota.durationS,
                url: nota.uri,
              },
            ],
          },
        ]),
      );

      try {
        const subido = await subirAdjunto(conversationId, nota, ({ ratio }) => {
          avisarProgreso(ratio);
          aplicar(
            mensajesRef.current.map((m) =>
              m.id === idTemporal ? { ...m, progreso: ratio } : m,
            ),
          );
        });
        const guardado = await MessageRepository.sendMessage(
          conversationId,
          '',
          currentUserId,
          [subido],
        );
        aplicar(reconciliarEnvio(mensajesRef.current, idTemporal, guardado));
        return true;
      } catch (error) {
        aplicar(descartarEnvio(mensajesRef.current, idTemporal));
        const codigo = error instanceof ApiError ? error.code : undefined;
        notify(
          codigo === 'voice_notes_not_available'
            ? t('chat.attachmentsOffTitle')
            : t('chat.sendFailed'),
          codigo === 'voice_notes_not_available'
            ? t('chat.voiceNotesOffBody')
            : error instanceof Error
              ? error.message
              : t('common.checkConnection'),
        );
        return false;
      }
    },
    [params.id, currentUserId, aplicar, t],
  );

  const grabadora = useGrabadoraDeVoz({
    alEnviar: enviarNotaDeVoz,
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
  // Salir con una nota de voz a medias
  // -------------------------------------------------------------------------

  /*
    Hay una nota que se perdería al salir: grabándose, en la previa o fallida.

    «Enviando» NO cuenta: la subida sigue aunque la pantalla se cierre y el
    mensaje llega igual. Las dos fases de paso («permiso», «guardando») tampoco:
    duran un instante y todavía no hay nada que perder.
  */
  const notaEnJuego =
    grabadora.fase === 'grabando' ||
    grabadora.fase === 'lista' ||
    grabadora.fase === 'fallida';
  const grabadoraActual = useRef(grabadora);
  grabadoraActual.current = grabadora;

  /**
   * Volver atrás, PREGUNTANDO ANTES si hay una nota de voz que se perdería.
   *
   * Antes, pulsar atrás con una nota grabada la tiraba sin decir nada: lo que
   * cuesta rehacer es haberla dicho. Si la persona confirma, la nota se
   * descarta POR SU CAMINO —`cancelar` cierra el micrófono, `eliminar` suelta
   * la previa, y los dos borran el fichero— y solo entonces se navega.
   */
  const salirDelChat = async () => {
    if (notaEnJuego) {
      const ok = await confirm({
        title: t('chat.voiceLeaveTitle'),
        message: t('chat.voiceLeaveBody'),
        confirmLabel: t('chat.voiceLeaveConfirm'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      // La grabadora de AHORA, no la del render en que se pulsó atrás: mientras
      // el diálogo está abierto la fase puede haber cambiado (el tope de
      // duración para la grabación sola y la deja en la previa).
      const actual = grabadoraActual.current;
      if (actual.fase === 'grabando') await actual.cancelar();
      else actual.eliminar();
    }
    return router.canGoBack() ? router.back() : router.replace('/');
  };

  /*
    EL ATRÁS FÍSICO DE ANDROID TAMBIÉN PREGUNTA. La tecla del teléfono no pasa
    por el botón de la cabecera: la atiende `navigation/atras.ts`, que ve una
    ruta anterior y vuelve sin más. Es el mismo registro que usa el asistente de
    cursos para no perder lo escrito (`registrarSalidaPropia`).

    SOLO MIENTRAS HAY UNA NOTA EN JUEGO, y solo con el foco: sin nota, el Atrás
    sigue su camino normal y esta pantalla no se queda ningún evento.

    Por referencia: `salirDelChat` cambia en cada render.
  */
  /*
    ESTA CONVERSACIÓN ESTÁ A LA VISTA mientras la pantalla tiene el foco.

    Es lo que evita el aviso redundante: si llega un mensaje de la conversación
    que la persona tiene delante, aparece en la conversación y NO sale un aviso
    flotante ni suena el teléfono para decirle lo que ya está leyendo. Al salir
    se quita la marca y se retira cualquier aviso de esta conversación que
    estuviera esperando; los contadores se ponen al día, porque entrar aquí ha
    marcado sus mensajes como leídos.
  */
  const conversacionALaVista = typeof params.id === 'string' ? params.id : null;
  useFocusEffect(
    useCallback(() => {
      if (!conversacionALaVista) return undefined;
      marcarConversacionALaVista(conversacionALaVista);
      retirarAvisosDe((clave) => clave === claveDeConversacion(conversacionALaVista));
      return () => {
        dejarDeVerConversacion(conversacionALaVista);
        void refrescarMensajes();
      };
    }, [conversacionALaVista]),
  );

  const ultimaSalida = useRef<() => void>(() => {});
  ultimaSalida.current = () => void salirDelChat();
  useFocusEffect(
    useCallback(() => {
      if (!notaEnJuego) return undefined;
      return registrarSalidaPropia(() => ultimaSalida.current());
    }, [notaEnJuego]),
  );

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

  /**
   * Abre un adjunto con lo que el teléfono tenga para él: un documento en su
   * lector, un vídeo en su reproductor.
   *
   * Es el mismo `Linking.openURL` sobre un enlace firmado que ya usan las
   * pantallas de evidencias y documentos. Si el sistema no sabe abrirlo, se
   * dice: un toque que no hace nada se lee como un botón roto.
   */
  const abrirFuera = (adjunto: MessageAttachment) => {
    if (!adjunto.url || !estaEnElServidor(adjunto)) return;
    Linking.openURL(adjunto.url).catch(() => {
      notify(t('common.couldNotOpen'), t('common.tryAgainSoon'));
    });
  };

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
      /*
        UN DOCUMENTO SE ABRE. Antes era una ficha con el nombre y el peso que no
        respondía a nada: se podía mandar un PDF pero no leerlo. Se abre fuera,
        con lo que el teléfono tenga para ese tipo de archivo — igual que las
        evidencias y los documentos de las demás pantallas.

        Solo cuando ya hay enlace del servidor: mientras sube, lo que hay es una
        ruta local que no se puede entregar a otra aplicación, y un botón que no
        hace nada es peor que una ficha quieta.
      */
      const sePuedeAbrir = estaEnElServidor(adjunto);
      return (
        <Pressable
          key={adjunto.id}
          onPress={() => abrirFuera(adjunto)}
          disabled={!sePuedeAbrir}
          accessibilityRole={sePuedeAbrir ? 'button' : undefined}
          accessibilityLabel={
            sePuedeAbrir
              ? t('chat.openFile', { nombre: adjunto.fileName ?? '' }).trim()
              : undefined
          }
          style={[styles.documento, { borderColor: colors.border }]}
        >
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
        </Pressable>
      );
    }

    // La proporción real del archivo, cuando se sabe: sin ella la burbuja da un
    // salto al cargar la imagen y mueve todo lo que hay debajo.
    const proporcion =
      adjunto.width && adjunto.height ? adjunto.width / adjunto.height : 1;

    return (
      <Pressable
        key={adjunto.id}
        onPress={() => {
          /*
            UN VÍDEO NO VA AL VISOR DE IMÁGENES. `ImageViewer` pinta una imagen:
            con la URL de un vídeo enseñaba una pantalla negra con «pellizca
            para ampliar». La aplicación no tiene un visor de vídeo a pantalla
            completa, así que se abre fuera, como los documentos.
          */
          if (adjunto.kind === 'video') abrirFuera(adjunto);
          else if (adjunto.url) setFotoAmpliada(adjunto);
        }}
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

  /*
    Mientras hay una nota de voz en marcha NUNCA hay «algo que enviar» por la
    vía del texto: si no, empezar a grabar con un adjunto ya elegido cambiaría
    el micrófono por el avión de papel y la barra de voz se quedaría sin su
    botón, con la grabación viva y sin forma de mandarla ni de tirarla.
  */
  const hayQueEnviar =
    !grabadora.ocupada && (text.trim().length > 0 || elegidos.length > 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/*
        LA CÁMARA DE VIDEOLLAMADA YA NO ESTÁ. Era `rightIcon="video"` sin
        `onRightPress`: un icono que no abría nada porque no hay videollamadas
        en esta aplicación. En su lugar la cabecera enseña con QUIÉN se habla y
        lleva a su perfil. (La cámara del selector de adjuntos —la del botón
        «+», que sí hace una foto y la manda— sigue exactamente donde estaba.)
      */}
      <CabeceraDeChat
        conversationId={params.id}
        currentUserId={currentUserId}
        nombreDeRespaldo={headerName}
        avatarDeRespaldo={demoConversation?.avatarUrl}
        idDeRespaldo={demoConversation?.otherId}
        resolverEnElServidor={supabaseEnabled && !!params.id}
        onBack={() => void salirDelChat()}
      />
      {/*
        La franja roja solo cuando YA hay algo pintado (una burbuja propia, un
        mensaje que entró por Realtime) y la carga del historial falló. Con la
        lista vacía el error lo cuenta el estado de abajo, que además ofrece
        reintentar: las dos cosas a la vez serían el mismo aviso dos veces.
      */}
      {loadError && messages.length > 0 ? (
        <Text style={{ color: colors.danger, textAlign: 'center', padding: spacing.sm, fontSize: 12 }}>
          {loadError}
        </Text>
      ) : null}
      <SinTecladoDelante>
        <FlashList
          data={elementos}
          extraData={extraDeSesiones}
          keyExtractor={(item: Message) => item.id}
          contentContainerStyle={styles.messages}
          showsVerticalScrollIndicator={false}
          /*
            ANCLADA ABAJO. Sin esto la conversación se abría por el mensaje más
            ANTIGUO de la página y había que bajar a mano hasta lo último, que
            es lo único que se viene a leer. `startRenderingFromBottom` hace que
            el primer pintado empiece por el final, y el umbral hace que un
            mensaje nuevo —propio o ajeno— arrastre la lista hasta él SOLO si ya
            se estaba abajo: quien ha subido a leer el historial no pierde el
            sitio. Es el modo de chat que trae FlashList 2; no hay lista
            invertida ni desplazamientos a mano.
          */
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.2,
          }}
          /*
            CARGANDO, ERROR O VACÍO: los tres estados de una lista sin mensajes,
            con el componente de estados de siempre. Solo existen con la lista
            vacía: en cuanto hay una burbuja, manda la conversación.

            El redactor sigue debajo en los tres casos. En una conversación
            recién creada «vacío» es justo desde donde se escribe el primer
            mensaje, y tras un error se puede reintentar sin salir del chat.
          */
          ListEmptyComponent={
            supabaseEnabled && cargandoMensajes ? (
              <StateView state="loading" />
            ) : supabaseEnabled && loadError ? (
              <StateView
                state="error"
                title={loadError}
                description={t('common.checkConnection')}
                onRetry={() => setIntentoDeCarga((intento) => intento + 1)}
              />
            ) : (
              <StateView
                state="empty"
                icon="message-circle"
                title={t('chat.emptyTitle')}
                description={t('chat.emptyBody')}
              />
            )
          }
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

            /*
              UNA SESIÓN 1:1. La solicitud es una tarjeta con los botones que le
              tocan a quien mira; cada respuesta, una línea que la deja
              registrada. El estado es el de HOY, no el que traía el mensaje.
              Sin menú de acciones: el registro de una sesión no se borra.
            */
            if (item.sesion) {
              const sesion = item.sesion;
              return (
                <View>
                  {cabecera}
                  <SesionEnElChat
                    sesion={sesion}
                    estado={estadosDeSesion.get(sesion.sesionId) ?? sesion.estado}
                    mio={mine}
                    nombre={headerName}
                    hora={item.createdAt}
                    ocupada={sesionOcupada === sesion.sesionId}
                    alElegir={(accion) => void responderSesion(sesion.sesionId, accion)}
                  />
                </View>
              );
            }

            return (
              /*
                EL MENSAJE QUE SE ACABA DE MANDAR ENTRA; EL HISTORIAL NO.

                Una burbuja nueva sube unos puntos hasta su sitio: se ve salir
                lo que se acaba de escribir. El historial está ya en pantalla
                al abrir —y vuelve al desplazar, porque la lista recicla— y
                animarlo sería ver aparecer mensajes de hace un mes.

                `clave` porque la lista RECICLA celdas: sin ella la entrada no
                se repetiría al reutilizar una celda para otro mensaje. Y cuando
                el servidor confirma y la burbuja deja de estar «enviando», no
                vuelve a animarse.
              */
              <Aparecer inmediato={item.estado !== 'enviando'} desde={12} clave={item.id}>
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
                        // La ajena se despega del fondo con un gris suave en
                        // vez de un borde: en claro, blanco sobre blanco con
                        // una línea parecía una casilla de formulario.
                        backgroundColor: mine ? colors.primary : colors.surfaceAlt,
                        borderColor: fallido
                          ? colors.danger
                          : mine
                            ? colors.primary
                            : colors.border,
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
                        <Text style={{ color: mine ? colors.onPrimary : colors.text, fontSize: 15, lineHeight: 22 }}>
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
                        /*
                          LA HORA Y EL ESTADO, legibles. Eran 9 puntos al 70 %:
                          sobre la burbuja negra no se leía. Y el estado del
                          envío se dice con un icono además de con el texto:
                          reloj mientras sale, una marca cuando el servidor lo
                          confirma, aviso si no salió.

                          UNA SOLA MARCA Y NO DOS. Significa «enviado», que es
                          lo que el servidor confirma. La aplicación no sabe si
                          se ha leído, y dos marcas lo darían a entender.
                        */
                        <View style={[styles.pieDeBurbuja, mine && styles.pieDeBurbujaMia]}>
                          <Text
                            style={{
                              color: mine ? colors.onPrimary : colors.textMuted,
                              fontSize: 11,
                              opacity: 0.8,
                            }}
                          >
                            {item.estado === 'enviando'
                              ? t('chat.sending')
                              : fallido
                                ? t('chat.notSent')
                                : item.createdAt}
                          </Text>
                          {mine ? (
                            <Feather
                              name={
                                item.estado === 'enviando'
                                  ? 'clock'
                                  : fallido
                                    ? 'alert-circle'
                                    : 'check'
                              }
                              size={11}
                              color={colors.onPrimary}
                              style={styles.iconoDeEstado}
                            />
                          ) : null}
                        </View>
                      ) : null}
                    </Pressable>
                  </View>

                  {fallido ? (
                    <View style={styles.accionesFallo}>
                      <Pulsable
                        onPress={() => reintentar(item)}
                        escala={ESCALA_AL_PULSAR.chip}
                        accessibilityRole="button"
                        accessibilityLabel={t('chat.retrySend')}
                        style={styles.accionFallo}
                      >
                        <Feather name="refresh-cw" size={13} color={colors.primary} />
                        <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>
                          {t('common.retry')}
                        </Text>
                      </Pulsable>
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
              </Aparecer>
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
          {/*
            El `+` es un botón: lleva su círculo y se hunde al tocarlo. Suelto
            sobre el fondo parecía un signo, no algo que se pulsa.
          */}
          <Pulsable
            accessibilityLabel={t('chat.attach')}
            accessibilityRole="button"
            onPress={() => setMenuAbierto(true)}
            disabled={!supabaseEnabled || grabadora.ocupada}
            escala={ESCALA_AL_PULSAR.icono}
            opacidad={supabaseEnabled && !grabadora.ocupada ? 1 : 0.4}
            style={[styles.addButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
          >
            <Feather name="plus" size={22} color={colors.text} />
          </Pulsable>

          {/*
            MIENTRAS HAY UNA NOTA DE VOZ EN MARCHA, EL CAMPO DE TEXTO SE APARTA.
            Dejarlo daría dos modos a la vez —hablando y escribiendo— y la barra
            de la grabadora no tendría dónde ponerse sin tapar lo que se escribe.
          */}
          {grabadora.ocupada ? (
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
              forma="pastilla"
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
              fase={grabadora.fase}
              segundos={grabadora.segundos}
              avance={grabadora.avance}
              progreso={grabadora.progreso}
              nivel={grabadora.nivel}
              uri={grabadora.nota?.uri ?? null}
              empezar={() => void grabadora.empezar()}
              detener={() => void grabadora.detener()}
              cancelar={() => void grabadora.cancelar()}
              eliminar={() => grabadora.eliminar()}
              enviar={() => void grabadora.enviar()}
              deshabilitado={enviando}
            />
          ) : (
            // El mismo botón redondo que en comentarios: crece cuando hay algo
            // que mandar y enseña la espera dentro, sin cambiar de tamaño.
            <View style={styles.sendButton}>
              <BotonDeEnviar
                onPress={submit}
                listo={hayQueEnviar}
                enviando={enviando}
                accessibilityLabel={t('chat.sendMessage')}
              />
            </View>
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
  // 80 % y no más: una burbuja que casi toca el borde contrario deja de
  // decir de quién es.
  bubble: {
    maxWidth: '80%',
    borderRadius: 20,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md + 2,
    borderWidth: 1,
    marginBottom: spacing.md,
  },
  pieDeBurbuja: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  pieDeBurbujaMia: { justifyContent: 'flex-end' },
  iconoDeEstado: { opacity: 0.8 },
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
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
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
