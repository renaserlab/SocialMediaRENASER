import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { useMargenInferior } from '@/components/teclado';
import { TextoConEnlaces } from '@/components/TextoConEnlaces';
import { Aparecer } from '@/components/Aparecer';
import { BotonDeEnviar } from '@/components/BotonDeEnviar';
import { BotonDeNotaDeVoz } from '@/components/BotonDeNotaDeVoz';
import { Pulsable } from '@/components/Pulsable';
import { CabeceraDeChat } from '@/components/CabeceraDeChat';
import { BottomSheet } from '@/components/BottomSheet';
import { BurbujaDeNotaDeVoz } from '@/components/BurbujaDeNotaDeVoz';
import { Avatar } from '@/components/Avatar';
import { DetallesDeMensaje } from '@/components/chat/DetallesDeMensaje';
import { HojaDeFondoDeChat } from '@/components/chat/HojaDeFondoDeChat';
import { IndicadorDeEscritura } from '@/components/chat/IndicadorDeEscritura';
import { MarcaDeEntrega } from '@/components/chat/MarcaDeEntrega';
import { ArchivoDeChat } from '@/components/chat/ArchivoDeChat';
import { DeslizarParaResponder } from '@/components/chat/DeslizarParaResponder';
import { HojaDeStickers } from '@/components/chat/HojaDeStickers';
import { HojaDeTemas } from '@/components/chat/HojaDeTemas';
import { MedioDeChat } from '@/components/chat/MedioDeChat';
import { VisorDeAdjunto, type AccionDeVisor } from '@/components/chat/VisorDeAdjunto';
import { ListRow } from '@/components/ListRow';
import { Input } from '@/components/Input';
import { RespuestaAHistoria } from '@/components/RespuestaAHistoria';
import { SesionEnElChat } from '@/components/SesionEnElChat';
import { StateView } from '@/components/StateView';
import { useGrabadoraDeVoz } from '@/hooks/useGrabadoraDeVoz';
import { useEscribiendo } from '@/hooks/useEscribiendo';
import { useInfoDeConversacion } from '@/hooks/useInfoDeConversacion';
import { useDisponibilidadDeTemas } from '@/hooks/useDisponibilidadDeTemas';
import { useLecturasDelChat } from '@/hooks/useLecturasDelChat';
import { useResponderSesion } from '@/hooks/useResponderSesion';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { colorDeAutor, miembroDe, nombreDelAutor } from '@/lib/gruposDeChat';
import {
  MAX_CONSULTA_DE_REACCIONES,
  alReaccionar,
  aplicarReacciones,
  miReaccion,
  textoDeCita,
  type CitaDeMensaje,
  type ReaccionDeMensaje,
} from '@/lib/reaccionesDeChat';
import { REACCIONES_RAPIDAS, esSticker } from '@/lib/stickers';
import { sePuedeResponder } from '@/lib/deslizarParaResponder';
import { medioQueEs, soloLlevaMedios, vaSinMarco } from '@/lib/mediosDeChat';
import { guardarEnLaGaleria } from '@/services/guardarAdjunto';
import { profileImageUrl } from '@/services/storage';
import {
  MENSAJES_POR_PAGINA_AL_BUSCAR,
  PAGINAS_PARA_IR_A_UN_MENSAJE,
  RESALTE_MS,
  tomarSalto,
} from '@/lib/saltoDeChat';
import { alCambiarElSilencioDeUnChat } from '@/hooks/useAvisosEnVivo';
import { afterSheetClose } from '@/lib/afterSheetClose';
import { fraseDeEscritura, suenaElTono } from '@/lib/escribiendo';
import { colorDeFondo, fondoDe, veloSobreLaFoto } from '@/lib/fondoDeChat';
import {
  COLOR_DE_LEIDO,
  estadoDeEntrega,
  llevaFranjaDeHora,
  tieneDetalles,
} from '@/lib/lecturaDeMensajes';
import { dejarDeVerConversacion, marcarConversacionALaVista } from '@/lib/loQueSeVe';
import { claveDeConversacion } from '@/lib/rutaDelPush';
import { retirarAvisosDe, toast } from '@/lib/toast';
import {
  alSaberDeUnMensaje,
  marcarConversacionLeida,
  refrescarMensajes,
} from '@/services/contadores';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { unaALaVez } from '@/lib/unaALaVez';
import { estaPegadoAlFinal, queHacerConLoUltimo } from '@/lib/chatAlFinal';
import { suenaLoQueLlega } from '@/lib/tonosDelChat';
import { sonarTono } from '@/services/notifications';
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
import { GroupRepository } from '@/repositories/GroupRepository';
import {
  MessageRepository,
  MENSAJES_POR_PAGINA,
  SIN_FUNCIONES,
  type FuncionesDelChat,
} from '@/repositories/MessageRepository';
import { ApiError } from '@/services/api';
import { useFondoDeChatStore } from '@/store/useFondoDeChatStore';
import {
  elegirArchivo,
  elegirFotoRecortada,
  elegirFotosOVideos,
  hacerFoto,
  MAX_ADJUNTOS,
  subirAdjunto,
  type AdjuntoElegido,
  type AdjuntoSubido,
} from '@/services/messageMedia';
import { PermisoDenegadoError } from '@/services/storage';
import { avisosDeReacciones, subscribeToConversation } from '@/services/realtime';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Message, MessageAttachment } from '@/types';

/** Un envío que se puede repetir tal cual si falla. */
type EnvioPendiente = {
  texto: string;
  archivos: AdjuntoElegido[];
  /** El mensaje al que se responde, y su cita para pintarla ya en la burbuja. */
  respondeA?: string;
  cita?: CitaDeMensaje;
};

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

/**
 * El elemento de la lista que pinta «está escribiendo». No es un mensaje: solo
 * ocupa el último sitio mientras alguien escribe, para que la burbuja empuje
 * los mensajes en vez de taparlos.
 */
const ELEMENTO_DE_ESCRITURA: Message = { id: 'escribiendo', text: '', sender: 'them', createdAt: '' };

/** El relleno de una burbuja. Lo necesita también la foto que la llena. */
const RELLENO_V = spacing.sm + 2;
const RELLENO_H = spacing.md + 2;
/** Lo que queda de burbuja alrededor de una foto que va con texto. */
const MARCO_FINO = 3;
/** Lo que mide de ancho una foto o un video en el chat. */
const ANCHO_DE_MEDIO = 250;

/**
 * Si el adjunto ya tiene un enlace del SERVIDOR, y no la ruta local con la que
 * se pinta la burbuja mientras sube.
 *
 * Es lo que decide si ya se puede abrir, guardar o descargar: mientras sube
 * solo existe en este teléfono.
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
  // EN UN GRUPO «suyo» puede ser de varias personas: dos mensajes ajenos
  // seguidos solo van juntos si son de la misma. En un chat de dos el autor
  // ajeno es siempre el mismo y esto no cambia nada. Los propios no se
  // miran: la burbuja que se está enviando todavía no trae autor.
  if (
    actual.sender === 'them' &&
    anterior.autorId &&
    actual.autorId &&
    anterior.autorId !== actual.autorId
  ) {
    return false;
  }
  if (anterior.eliminado || actual.eliminado) return false;
  // La tarjeta de una sesión no es una burbuja: nada se pega a ella.
  if (anterior.sesion || actual.sesion) return false;
  if (!anterior.createdAtIso || !actual.createdAtIso) return false;
  const a = new Date(anterior.createdAtIso).getTime();
  const b = new Date(actual.createdAtIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return b - a < MINUTOS_DE_RAFAGA * 60 * 1000;
}

/**
 * Cada cuánto pregunta el chat por mensajes nuevos MIENTRAS SU CANAL DE TIEMPO
 * REAL ESTÁ CAÍDO. Con el canal enganchado no se pregunta: llegan solos.
 */
const SONDEO_SIN_TIEMPO_REAL_MS = 4_000;
/**
 * Cuánto después de bajar al final se repasa, ya sin recorrido. Más que lo que
 * dura el desplazamiento animado, para no cortarlo a medias.
 */
const REPASO_DE_LA_BAJADA_MS = 400;

export function ChatScreen() {
  const { colors, mode } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  // El de la barra de gestos; con el teclado abierto, cero: ya está encima.
  const margenInferior = useMargenInferior();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUserId = useAppStore((state) => state.user?.id);

  /*
    QUÉ ES ESTA CONVERSACIÓN: de dos personas o un grupo.

    `undefined` mientras se pregunta y `null` si no se pudo saber, que se
    trata como siempre: un chat de dos. En un grupo cambian tres cosas y
    nada más: la cabecera enseña el nombre del grupo, cada mensaje ajeno
    dice de quién es, y dos personas distintas no comparten ráfaga.
  */
  const { info: infoDeConversacion, refrescar: refrescarInfo } = useInfoDeConversacion(
    params.id,
    currentUserId,
    supabaseEnabled && !!params.id,
  );
  const esGrupo = infoDeConversacion?.esGrupo === true;
  /*
    TEMAS Y COMUNIDADES (26/10/2026). Una comunidad cuelga de un grupo
    (`padre`); el chat de un tema no se lee aquí, sino en su tema. Quien
    administra un grupo borra también mensajes ajenos (D4) y, en uno de
    primer nivel con temas en el servidor, los agrega a un tema.
  */
  const padre = infoDeConversacion?.padre ?? null;
  const temaDelChat = infoDeConversacion?.tema ?? null;
  const puedoBorrarAjenos = esGrupo && infoDeConversacion?.puedoAdministrar === true;
  const disponibilidadDeTemas = useDisponibilidadDeTemas(supabaseEnabled && esGrupo);
  const esGrupoDePrimerNivel = esGrupo && !padre && !temaDelChat;
  const puedoAgregarATemas =
    puedoBorrarAjenos && esGrupoDePrimerNivel && disponibilidadDeTemas.temas;
  /** El mensaje de General que se está agregando a un tema (`HojaDeTemas`). */
  const [temasPara, setTemasPara] = useState<Message | null>(null);
  /*
    EL CHAT DE UN TEMA SE LEE EN SU TEMA. Se llega aquí por un aviso, que
    abre la conversación suelta: se sustituye por el tema, con sus
    referencias y su barra de quién escribe.
  */
  useEffect(() => {
    if (!temaDelChat) return;
    router.replace({
      pathname: '/chat/tema/[id]' as never,
      params: { id: temaDelChat.grupoId, tema: temaDelChat.temaId, name: temaDelChat.nombre },
    });
  }, [temaDelChat?.grupoId, temaDelChat?.temaId]);
  /** El mensaje al que se llegó desde «Contenido», mientras dura el resalte. */
  const [resaltado, setResaltado] = useState<string | null>(null);
  /** El mensaje al que hay que ir, recogido de `saltoDeChat`. */
  const [mensajeBuscado, setMensajeBuscado] = useState<string | null>(null);

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
  const [stickersAbiertos, setStickersAbiertos] = useState(false);
  /** El mensaje al que se está respondiendo, mientras se escribe la respuesta. */
  const [respondiendoA, setRespondiendoA] = useState<Message | null>(null);
  /** El mensaje al que se va a reaccionar desde el panel de «más». */
  const [reaccionandoA, setReaccionandoA] = useState<Message | null>(null);
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
  const [funciones, setFunciones] = useState<FuncionesDelChat>(SIN_FUNCIONES);

  /*
    EL MENÚ DEL CHAT (los tres puntos) y lo que se abre desde él.

    `silencioPuesto` es lo que se acaba de pulsar, que manda sobre lo último
    leído hasta que el servidor lo confirme: la campana no puede tardar una
    vuelta de red en cambiar.
  */
  const [opcionesAbiertas, setOpcionesAbiertas] = useState(false);
  const [fondoAbierto, setFondoAbierto] = useState(false);
  /** El mensaje propio del que se están viendo los detalles (quién lo leyó). */
  const [detallesDe, setDetallesDe] = useState<Message | null>(null);
  const [silencioPuesto, setSilencioPuesto] = useState<boolean | null>(null);
  const [haciendoOpcion, setHaciendoOpcion] = useState(false);

  // El fondo que esta persona eligió PARA ESTE CHAT en este teléfono. Cada
  // conversación tiene el suyo; lo guardado se lee una vez.
  const fondoDelChat = useFondoDeChatStore((estado) => fondoDe(estado.fondos, params.id ?? ''));
  const leerFondoDelChat = useFondoDeChatStore((estado) => estado.leer);
  useEffect(() => {
    void leerFondoDelChat();
  }, [leerFondoDelChat]);

  /*
    LA CONFIRMACIÓN DE LECTURA Y «ESTÁ ESCRIBIENDO» (12/10/2026), como en
    WhatsApp. Las marcas de lectura salen del servidor y solo si las conoce;
    «está escribiendo» es difusión entre los teléfonos que tienen el chat
    abierto y no depende del servidor. A los avisos de escritura solo se les
    hace caso si vienen de alguien de esta conversación.
  */
  const lecturas = useLecturasDelChat(
    params.id,
    supabaseEnabled && !!params.id && funciones.lecturas,
  );
  const miembrosConocidos = useMemo(
    () => (infoDeConversacion ? infoDeConversacion.miembros.map((miembro) => miembro.id) : null),
    [infoDeConversacion],
  );
  const escritura = useEscribiendo({
    conversationId: params.id,
    yo: currentUserId,
    conocidos: miembrosConocidos,
    activo: supabaseEnabled && !!params.id,
  });
  // Un texto y no la lista: la lista es un objeto nuevo en cada dibujo.
  const claveDeEscritura = escritura.quienes.join('|');

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

  /*
    Si esta pantalla es la que se está mirando. Empieza en `true`: una pantalla
    que se monta es una a la que se está entrando.

    Hace falta para dos cosas que antes se hacían sin mirar: marcar como leído
    lo que llega —una conversación enterrada bajo otra pantalla, o con la
    aplicación en segundo plano, marcaba como leído lo que nadie había visto— y
    no preguntar al servidor desde un chat que no está delante.
  */
  const aLaVista = useRef(true);
  /** «Ponte al día», para el efecto del foco. `null` sin conversación cargando. */
  const ponerseAlDia = useRef<(() => void) | null>(null);

  // Carga inicial + suscripción Realtime a los mensajes de la conversación.
  useEffect(() => {
    if (!supabaseEnabled || !params.id) return;
    let montado = true;
    const conversationId = params.id;
    /** La primera página llegó: hay desde dónde pedir «lo que ha entrado después». */
    let cargada = false;

    /** Que los demás vuelvan a preguntar quién leyó: solo si el servidor ya lo anotó. */
    const avisarSiSeAnoto = (anotado: boolean) => {
      if (anotado) lecturas.avisarQueLei();
    };

    /** Leído solo si de verdad se está mirando. */
    const leerSiSeVe = () => {
      if (aLaVista.current && AppState.currentState === 'active') {
        void marcarConversacionLeida(conversationId).then(avisarSiSeAnoto);
      }
    };

    // Cada carga —la primera y cada reintento— empieza limpia: «cargando» a la
    // vista y sin el error del intento anterior.
    setCargandoMensajes(true);
    setLoadError(null);

    const cargaInicial = MessageRepository.listMessages(conversationId, currentUserId)
      .then((msgs) => {
        if (!montado) return;
        aplicar(msgs);
        cargada = true;
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
    void marcarConversacionLeida(conversationId).then(avisarSiSeAnoto);

    /*
      PONERSE AL DÍA: pedir lo que haya entrado desde lo último que se tiene.

      LO REPORTADO (05/10/2026). «A pesar de que me aparezca en la bandeja que
      tengo mensajes, estos no llegaban hasta que volvía a entrar al chat», y
      «los mensajes no llegan instantáneamente». La pantalla cargaba UNA vez,
      al montarse, y después dependía por entero de su canal de tiempo real.
      Ese canal no repone lo que se pierde: mientras se engancha, y cada vez
      que se cae —la red cambia, el teléfono duerme, la aplicación pasa a
      segundo plano— y vuelve, lo que entró en medio no llega nunca. Y con el
      chat delante no hay otro camino, porque el aviso flotante y el push se
      callan a propósito. El mensaje estaba en el servidor, la bandeja lo
      contaba y aquí no aparecía hasta desmontar la pantalla.

      AHORA LO PIDEN TODAS LAS SEÑALES QUE SABEN ALGO, y todas hacen lo mismo:

        - el canal, cada vez que se engancha o se reengancha;
        - la aplicación, al volver del segundo plano;
        - la pantalla, al recuperar el foco;
        - el push de un mensaje de esta conversación (`alSaberDeUnMensaje`);
        - y, mientras el canal esté caído y el chat delante, un reloj corto.

      Es una petición pequeña —«después de tal instante»— y nunca dos a la vez
      (`unaALaVez`). Con el canal sano no hay reloj: no se sondea por sondear.
    */
    const ponerAlDia = unaALaVez(async () => {
      await cargaInicial;
      // Sin primera página no hay desde dónde: la pantalla ofrece «Reintentar».
      if (!montado || !cargada) return;
      const desde = instanteMasReciente(mensajesRef.current);
      const recibidos = await (desde
        ? MessageRepository.listMessagesSince(conversationId, desde, currentUserId)
        : MessageRepository.listMessages(conversationId, currentUserId));
      if (!montado) return;
      // El corte tiene la precisión del teléfono y la base guarda más: puede
      // volver el último que ya se tenía. Solo cuenta lo que no estaba.
      const conocidos = new Set(mensajesRef.current.map((m) => m.id));
      if (!recibidos.some((m) => !conocidos.has(m.id))) return;
      aplicar(fusionar(mensajesRef.current, recibidos));
      leerSiSeVe();
    });

    /** Si el canal de tiempo real de esta conversación está enganchado ahora. */
    let canalEnganchado = false;

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
      leerSiSeVe();
    }, (enganchado) => {
      canalEnganchado = enganchado;
      // La primera vez cubre el hueco entre la carga y el enganche; las demás,
      // lo que entró con el canal caído.
      if (enganchado) void ponerAlDia();
    });

    const sondeo = setInterval(() => {
      if (!canalEnganchado && aLaVista.current && AppState.currentState === 'active') {
        void ponerAlDia();
      }
    }, SONDEO_SIN_TIEMPO_REAL_MS);

    const alVolver = AppState.addEventListener('change', (estado) => {
      if (estado !== 'active') return;
      void ponerAlDia();
      // Lo que el canal pintó con la aplicación en segundo plano no se marcó.
      leerSiSeVe();
    });

    const dejarDeOir = alSaberDeUnMensaje((conversacion) => {
      if (conversacion === conversationId) void ponerAlDia();
    });

    ponerseAlDia.current = () => {
      void ponerAlDia();
      leerSiSeVe();
    };

    return () => {
      montado = false;
      ponerseAlDia.current = null;
      clearInterval(sondeo);
      alVolver.remove();
      dejarDeOir();
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
  const mensajesYTarjetas = useMemo<Message[]>(
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
  /*
    Y, MIENTRAS ALGUIEN ESCRIBE, LA BURBUJA DE «ESTÁ ESCRIBIENDO», TAMBIÉN COMO
    ELEMENTO (12/10/2026). Antes flotaba encima de la lista para no mover nada,
    y por eso tapaba la hora y las marcas del último mensaje. Ahora es el
    último elemento: ocupa su sitio y empuja los mensajes hacia arriba, como en
    WhatsApp. Por ser un elemento —y no un pie— la lista baja sola hasta ella
    si se estaba abajo, y no mueve a quien subió a leer el historial.

    En reposo no existe: la lista vuelve a ser los mensajes y las tarjetas.
  */
  const elementos = useMemo<Message[]>(
    () => (claveDeEscritura ? [...mensajesYTarjetas, ELEMENTO_DE_ESCRITURA] : mensajesYTarjetas),
    [mensajesYTarjetas, claveDeEscritura],
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
    // Con `infoDeConversacion` y `resaltado`: la lista solo repinta sus
    // celdas cuando cambia esto, y los dos cambian lo que pinta una burbuja.
    // Y con las marcas de lectura: cambian la marca de las burbujas propias.
    () => ({
      estadosDeSesion,
      sesionOcupada,
      infoDeConversacion,
      resaltado,
      marcas: lecturas.marcas,
      // Y con quién escribe: cambia la frase de la burbuja del final.
      claveDeEscritura,
    }),
    [estadosDeSesion, sesionOcupada, infoDeConversacion, resaltado, lecturas.marcas, claveDeEscritura],
  );

  // -------------------------------------------------------------------------
  // Seguir el final de la conversación
  // -------------------------------------------------------------------------

  /*
    LO ÚLTIMO SE VE SIN DESLIZAR. Reportado el 06/10/2026, en teléfono: al
    abrir un chat a veces había que bajar a mano; y con el teclado abierto, el
    mensaje recién enviado —o el que llegaba— quedaba por debajo del redactor.
    «El usuario tiene que deslizar para ver el mensaje que publicó, de lo
    contrario va a pensar que no se escribió nada».

    La lista ya seguía el final, pero solo si se estaba CASI abajo, y lo medía
    contra el alto que tiene a la vista. El teclado deja ese alto en la mitad:
    lo último pasa a estar «lejos» y dejaba de seguir nada. Aquí se recuerda si
    se estaba abajo ANTES de que el alto cambiara, y la regla la decide
    `lib/chatAlFinal`: lo propio baja siempre; lo ajeno, si se estaba abajo; a
    quien subió a leer el historial se le avisa con un botón.
  */
  const lista = useRef<FlashListRef<Message>>(null);
  /** Se está viendo lo último. Empieza en `true`: un chat se abre por el final. */
  const pegadoAlFinal = useRef(true);
  /** El alto a la vista en la última medida, para notar que el teclado lo cambia. */
  const altoDeLaLista = useRef(0);
  const altoAlDesplazar = useRef(0);
  /** Pinta el botón de «ir a lo último». */
  const [lejosDelFinal, setLejosDelFinal] = useState(false);
  /** Ha llegado algo mientras se leía el historial. */
  const [hayNuevosAbajo, setHayNuevosAbajo] = useState(false);
  const bajadaPendiente = useRef<number | null>(null);
  const repasoDeLaBajada = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bajarAlFinal = useCallback((animado: boolean) => {
    pegadoAlFinal.current = true;
    setLejosDelFinal(false);
    setHayNuevosAbajo(false);
    if (bajadaPendiente.current !== null) cancelAnimationFrame(bajadaPendiente.current);
    // Un fotograma de margen: la lista tiene que haber medido lo recién llegado.
    bajadaPendiente.current = requestAnimationFrame(() => {
      bajadaPendiente.current = null;
      void lista.current?.scrollToEnd({ animated: animado });
    });
    // Una burbuja puede crecer después de pintarse (una foto, la tarjeta de
    // una sesión): un repaso sin recorrido la alcanza.
    if (repasoDeLaBajada.current) clearTimeout(repasoDeLaBajada.current);
    repasoDeLaBajada.current = setTimeout(() => {
      repasoDeLaBajada.current = null;
      if (pegadoAlFinal.current) void lista.current?.scrollToEnd({ animated: false });
    }, REPASO_DE_LA_BAJADA_MS);
  }, []);

  useEffect(
    () => () => {
      if (bajadaPendiente.current !== null) cancelAnimationFrame(bajadaPendiente.current);
      if (repasoDeLaBajada.current) clearTimeout(repasoDeLaBajada.current);
    },
    [],
  );

  /*
    EL ALTO A LA VISTA CAMBIA SIN QUE NADIE DESPLACE: se abre o se cierra el
    teclado, aparece la tira de adjuntos elegidos. Si se estaba abajo, se
    sigue abajo.
  */
  const alMedirLaLista = useCallback(
    (evento: LayoutChangeEvent) => {
      const alto = evento.nativeEvent.layout.height;
      const antes = altoDeLaLista.current;
      altoDeLaLista.current = alto;
      if (antes > 0 && Math.abs(alto - antes) > 1 && pegadoAlFinal.current) bajarAlFinal(false);
    },
    [bajarAlFinal],
  );

  /** El contenido crece después de pintarse y se estaba abajo: se sigue. */
  const alCrecerElContenido = useCallback(() => {
    if (!pegadoAlFinal.current) return;
    // Ya hay una bajada en camino: ella llega al final nuevo.
    if (bajadaPendiente.current !== null || repasoDeLaBajada.current !== null) return;
    bajadaPendiente.current = requestAnimationFrame(() => {
      bajadaPendiente.current = null;
      void lista.current?.scrollToEnd({ animated: false });
    });
  }, []);

  // De los mensajes y las tarjetas, no de `elementos`: que alguien escriba no
  // es que haya llegado algo (ni suena «recibido» ni marca «hay nuevos»).
  const ultimoElemento =
    mensajesYTarjetas.length > 0 ? mensajesYTarjetas[mensajesYTarjetas.length - 1] : undefined;
  const idDeLoUltimo = ultimoElemento?.id ?? null;
  const loUltimoEsMio = ultimoElemento?.sender === 'me';
  const ultimoVisto = useRef<string | null>(null);
  useEffect(() => {
    const queHacer = queHacerConLoUltimo({
      antes: ultimoVisto.current,
      ahora: idDeLoUltimo,
      mio: loUltimoEsMio,
      pegado: pegadoAlFinal.current,
    });
    // El tono de «recibido»: solo lo ajeno, solo si es una novedad y solo si
    // se está mirando. Con el chat detrás, ya suena el push.
    if (
      suenaLoQueLlega({
        antes: ultimoVisto.current,
        ahora: idDeLoUltimo,
        mio: loUltimoEsMio,
        seEstaMirando: aLaVista.current && AppState.currentState === 'active',
      })
    ) {
      void sonarTono('recibido');
    }
    ultimoVisto.current = idDeLoUltimo;
    if (queHacer === 'bajar') bajarAlFinal(true);
    else if (queHacer === 'bajar-sin-animar') bajarAlFinal(false);
    else if (queHacer === 'avisar') setHayNuevosAbajo(true);
  }, [idDeLoUltimo, loUltimoEsMio, bajarAlFinal]);

  // -------------------------------------------------------------------------
  // Ir a un mensaje concreto (desde «Contenido»)
  // -------------------------------------------------------------------------

  /*
    El encargo llega por `saltoDeChat`, no por un parámetro: a esta pantalla
    se VUELVE desde «Contenido», y al volver atrás no se pueden cambiar sus
    parámetros. Se recoge al tener el foco, que cubre también el caso de
    que hubiera que abrirla de nuevo. Al volver al chat por cualquier otro
    camino se refresca además quién está en la conversación.
  */
  const yaTuvoElFoco = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const pedido = tomarSalto(typeof params.id === 'string' ? params.id : null);
      if (pedido) setMensajeBuscado(pedido);
      // La primera vez ya pregunta el propio `useInfoDeConversacion`.
      if (yaTuvoElFoco.current) refrescarInfo();
      yaTuvoElFoco.current = true;
    }, [params.id, refrescarInfo]),
  );

  const sigueMontado = useRef(true);
  useEffect(
    () => () => {
      sigueMontado.current = false;
    },
    [],
  );

  /*
    EL CHAT SOLO TIENE CARGADO LO ÚLTIMO. Si el mensaje está más arriba se
    sube por el historial —el mismo camino que hace el dedo, y por eso la
    conversación sigue siendo continua hasta hoy— hasta dar con él.

    CON TOPE: diez páginas de cien. Un mensaje más antiguo que los últimos
    mil no se abre desde aquí, y se dice; cargar el historial entero de un
    grupo para enseñar un mensaje dejaría el teléfono a tirones.
  */
  const enBusca = useRef<string | null>(null);
  useEffect(() => {
    if (!supabaseEnabled || !params.id || !mensajeBuscado || cargandoMensajes) return;
    if (enBusca.current === mensajeBuscado) return;
    enBusca.current = mensajeBuscado;
    const conversationId = params.id;
    const buscado = mensajeBuscado;

    const buscar = async (): Promise<boolean> => {
      for (let pagina = 0; pagina <= PAGINAS_PARA_IR_A_UN_MENSAJE; pagina += 1) {
        const indice = mensajesRef.current.findIndex((m) => m.id === buscado);
        if (indice >= 0) {
          // Deja de seguir el final: si no, la lista volvería abajo sola.
          pegadoAlFinal.current = false;
          setLejosDelFinal(true);
          setResaltado(buscado);
          const ir = () =>
            void lista.current?.scrollToIndex({ index: indice, animated: false, viewPosition: 0.3 });
          // Dos veces: la primera sale con alturas estimadas si las celdas de
          // arriba aún no se han medido; la segunda cae en el sitio.
          setTimeout(ir, 120);
          setTimeout(ir, 500);
          setTimeout(() => {
            if (sigueMontado.current) setResaltado(null);
          }, RESALTE_MS);
          return true;
        }
        const before = instanteMasAntiguo(mensajesRef.current);
        if (!before || pagina === PAGINAS_PARA_IR_A_UN_MENSAJE) return false;
        const viejos = await MessageRepository.listMessages(conversationId, currentUserId, {
          before,
          limit: MENSAJES_POR_PAGINA_AL_BUSCAR,
        });
        if (!sigueMontado.current) return true;
        const conocidos = new Set(mensajesRef.current.map((m) => m.id));
        // Nada nuevo más arriba: se acabó el historial.
        if (!viejos.some((m) => !conocidos.has(m.id))) {
          setHayMasHistorial(false);
          return false;
        }
        aplicar(fusionar(mensajesRef.current, viejos));
      }
      return false;
    };

    buscar()
      .then((encontrado) => {
        if (!encontrado && sigueMontado.current) {
          notify(t('chat.jumpNotFoundTitle'), t('chat.jumpNotFoundBody'));
        }
      })
      .catch(() => {
        // Sin red no se llega al mensaje; el chat queda como estaba.
      })
      .finally(() => {
        if (sigueMontado.current) setMensajeBuscado(null);
      });
  }, [supabaseEnabled, params.id, mensajeBuscado, cargandoMensajes, currentUserId, aplicar, t]);

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
          null,
          envio.respondeA ?? null,
        );
        aplicar(reconciliarEnvio(mensajesRef.current, idTemporal, guardado));
        ultimoEnvioDe.current.delete(idTemporal);
        // El tono de «enviado» suena cuando el servidor lo ha guardado, no al
        // tocar el botón: si el envío falla, no hay nada que celebrar.
        void sonarTono('enviado');
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
            // La cita se ve desde el primer instante, no al confirmar.
            respuestaA: envio.cita,
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

  /** La cita de un mensaje que se va a responder, armada con lo que ya se sabe de él. */
  const citaDe = (mensaje: Message): CitaDeMensaje => ({
    id: mensaje.id,
    autorId: mensaje.autorId ?? (mensaje.sender === 'me' ? currentUserId ?? '' : ''),
    autor:
      mensaje.sender === 'me'
        ? t('chatViews.you')
        : nombreDelAutor(infoDeConversacion, mensaje.autorId, mensaje.autorNombre) || headerName,
    extracto: mensaje.text.replace(/\s+/g, ' ').trim().slice(0, 140),
    tipo: mensaje.attachments?.[0]?.kind ?? null,
    eliminado: false,
  });

  const submit = async () => {
    const body = text.trim();
    if (!body && elegidos.length === 0) return;
    if (enviando) return;

    if (!supabaseEnabled) {
      if (demoConversation && body) sendMessageDemo(demoConversation.id, body);
      setText('');
      return;
    }

    const envio: EnvioPendiente = {
      texto: body,
      archivos: elegidos,
      respondeA: respondiendoA?.id,
      cita: respondiendoA ? citaDe(respondiendoA) : undefined,
    };
    setText('');
    // Enviado: para los demás, ya no se está escribiendo.
    escritura.alParar();
    setElegidos([]);
    setRespondiendoA(null);
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
  const estaSilenciada = silencioPuesto ?? infoDeConversacion?.silenciada ?? false;
  useEffect(() => {
    setSilencioPuesto(null);
  }, [infoDeConversacion?.silenciada]);

  /*
    QUIÉN ESTÁ ESCRIBIENDO, dicho con palabras. El nombre sale de los miembros
    que ya se conocen, nunca del aviso. En un chat de dos no hace falta.
  */
  const cuantosEscriben = escritura.quienes.length;
  const fraseDeQuienEscribe = (() => {
    const frase = fraseDeEscritura(
      escritura.quienes.map((id) => nombreDelAutor(infoDeConversacion, id)),
      esGrupo,
    );
    if (!frase) return null;
    if (frase.clave === 'solo') return t('chat.typingSolo');
    if (frase.clave === 'uno') return t('chat.typingOne', { nombre: frase.nombre });
    if (frase.clave === 'dos') {
      return t('chat.typingTwo', { primero: frase.primero, segundo: frase.segundo });
    }
    return t('chat.typingMany', { n: frase.cuantos });
  })();

  /*
    EL TONO DE «ESTÁ ESCRIBIENDO». Una vez, cuando alguien empieza y antes no
    escribía nadie; no en cada aviso, no con el chat detrás y no si la
    conversación está silenciada. Cuándo toca lo decide `suenaElTono`.
  */
  const escribianAntes = useRef(0);
  const ultimoTonoDeEscritura = useRef<number | undefined>(undefined);
  useEffect(() => {
    const momento = Date.now();
    if (
      suenaElTono({
        antes: escribianAntes.current,
        ahora: cuantosEscriben,
        seEstaMirando: aLaVista.current && AppState.currentState === 'active',
        silenciada: estaSilenciada,
        momento,
        ultimoTono: ultimoTonoDeEscritura.current,
      })
    ) {
      ultimoTonoDeEscritura.current = momento;
      void sonarTono('escribiendo');
    }
    escribianAntes.current = cuantosEscriben;
  }, [cuantosEscriben, estaSilenciada]);

  /** Cierra el menú y espera: nada se abre encima de una hoja que se va. */
  const trasElMenu = async () => {
    setOpcionesAbiertas(false);
    await afterSheetClose();
  };

  const nombreDelChat = (esGrupo && infoDeConversacion?.titulo) || headerName;

  const abrirContenido = async () => {
    if (!params.id) return;
    await trasElMenu();
    // En un grupo, lo compartido está en su ficha, junto a los miembros.
    router.push(
      esGrupo
        ? { pathname: '/chat/grupo/[id]' as never, params: { id: params.id } }
        : { pathname: '/chat/contenido/[id]' as never, params: { id: params.id, name: nombreDelChat } },
    );
  };

  const abrirBusqueda = async () => {
    if (!params.id) return;
    await trasElMenu();
    router.push({
      pathname: '/chat/buscar/[id]' as never,
      params: { id: params.id, name: nombreDelChat },
    });
  };

  const abrirFondo = async () => {
    await trasElMenu();
    setFondoAbierto(true);
  };

  /** La lista del grupo: General, sus temas y sus comunidades. */
  const abrirListaDelGrupo = async () => {
    if (!params.id) return;
    await trasElMenu();
    router.push({
      pathname: '/chat/lista/[id]' as never,
      params: { id: params.id, name: nombreDelChat },
    });
  };

  const alternarSilencio = async () => {
    if (!params.id || haciendoOpcion) return;
    const quiere = !estaSilenciada;
    await trasElMenu();
    setHaciendoOpcion(true);
    setSilencioPuesto(quiere);
    try {
      await MessageRepository.silenciar(params.id, quiere);
      toast(t(quiere ? 'chatMenu.muted' : 'chatMenu.unmuted'), quiere ? 'bell-off' : 'bell');
      refrescarInfo();
      alCambiarElSilencioDeUnChat();
    } catch {
      setSilencioPuesto(null);
      notify(t('chatMenu.failedTitle'), t('common.tryAgainSoon'));
    } finally {
      setHaciendoOpcion(false);
    }
  };

  /**
   * Vaciar el chat PARA QUIEN LO PIDE. Se pregunta antes, porque no tiene
   * vuelta atrás para esa persona, y se dice lo que no hace: no le borra
   * nada a nadie más.
   */
  const vaciarElChat = async () => {
    if (!params.id || haciendoOpcion) return;
    await trasElMenu();
    const seguro = await confirm({
      title: t('chatMenu.clearTitle'),
      message: t(esGrupo ? 'chatMenu.clearBodyGroup' : 'chatMenu.clearBody'),
      confirmLabel: t('chatMenu.clear'),
      destructive: true,
    });
    if (!seguro) return;
    setHaciendoOpcion(true);
    try {
      await MessageRepository.vaciar(params.id);
      // Lo que había en pantalla ya no se le enseña; se vuelve a pedir el
      // historial, que ahora empieza donde lo vació.
      setRespondiendoA(null);
      setRemoteMessages([]);
      setIntentoDeCarga((n) => n + 1);
      toast(t('chatMenu.cleared'), 'check');
    } catch {
      notify(t('chatMenu.failedTitle'), t('common.tryAgainSoon'));
    } finally {
      setHaciendoOpcion(false);
    }
  };

  const salirDelGrupo = async () => {
    if (!params.id || !currentUserId || haciendoOpcion) return;
    await trasElMenu();
    // De una comunidad se sale sin salir del grupo: se dice así.
    const seguro = await confirm({
      title: t(padre ? 'groupCommunities.leaveTitle' : 'groups.leaveTitle'),
      message: t(padre ? 'groupCommunities.leaveBody' : 'groups.leaveBody'),
      confirmLabel: t(padre ? 'groupCommunities.leave' : 'groups.leave'),
      destructive: true,
    });
    if (!seguro) return;
    setHaciendoOpcion(true);
    try {
      await GroupRepository.quitar(params.id, currentUserId);
      // Ya no se pertenece: a este chat no se puede volver. De una comunidad
      // se vuelve a la lista de su grupo, donde se sigue estando.
      if (padre) {
        router.dismissTo({ pathname: '/chat/lista/[id]' as never, params: { id: padre.id } });
        return;
      }
      router.replace('/messages' as never);
    } catch {
      notify(t('chatMenu.failedTitle'), t('common.tryAgainSoon'));
    } finally {
      setHaciendoOpcion(false);
    }
  };

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
  const vistaAntes = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!conversacionALaVista) return undefined;
      aLaVista.current = true;
      marcarConversacionALaVista(conversacionALaVista);
      retirarAvisosDe((clave) => clave === claveDeConversacion(conversacionALaVista));
      // AL VOLVER a esta pantalla —la primera vez ya carga el montaje—: lo que
      // entró mientras había otra encima se pide ahora, y se da por leído.
      if (vistaAntes.current) ponerseAlDia.current?.();
      vistaAntes.current = true;
      return () => {
        aLaVista.current = false;
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
      // Lo ajeno, solo quien administra el grupo (D4); el servidor lo comprueba.
      const ajeno = mensaje.sender !== 'me';
      if (!params.id || (ajeno && !puedoBorrarAjenos) || mensaje.estado || mensaje.eliminado) {
        return;
      }
      const ok = await confirm({
        title: t('chat.deleteTitle'),
        message: t(ajeno ? 'groupTopics.adminDeleteBody' : 'chat.deleteBody'),
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
    [params.id, aplicar, puedoBorrarAjenos],
  );

  /**
   * Abre el menú de acciones de una burbuja, con pulsación larga.
   *
   * Solo sobre lo PROPIO y ya entregado, que es sobre lo único que hay algo que
   * hacer. Un menú que se abre para enseñar que no hay opciones es peor que no
   * abrirse.
   */
  const abrirAcciones = useCallback(
    (mensaje: Message) => {
      if (mensaje.estado || mensaje.eliminado) return;
      // Sobre lo propio siempre hay algo (borrar). Sobre lo ajeno solo hay
      // reaccionar y responder —y, para quien administra el grupo, borrar y
      // agregar a un tema—: sin nada de eso la hoja se abriría vacía.
      if (mensaje.sender !== 'me' && !funciones.reacciones && !puedoBorrarAjenos) return;
      setAccionesDe(mensaje);
    },
    [funciones.reacciones, puedoBorrarAjenos],
  );

  /** «Agregar a un tema»: cierra esta hoja y, cuando ya no está, abre la de temas (iOS). */
  const agregarATemaDesdeElMenu = useCallback(async () => {
    const mensaje = accionesDe;
    setAccionesDe(null);
    if (!mensaje) return;
    await afterSheetClose();
    setTemasPara(mensaje);
  }, [accionesDe]);

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

  // -------------------------------------------------------------------------
  // Reaccionar
  // -------------------------------------------------------------------------

  const avisosDeReaccion = useRef<{ avisar: () => void; cerrar: () => void } | null>(null);

  /** Pregunta por las reacciones de lo que hay cargado: los últimos cien mensajes. */
  const refrescarReacciones = useCallback(() => {
    if (!supabaseEnabled || !params.id) return;
    const ids = mensajesRef.current
      .filter((m) => !m.estado && !m.eliminado)
      .slice(-MAX_CONSULTA_DE_REACCIONES)
      .map((m) => m.id);
    if (ids.length === 0) return;
    MessageRepository.reaccionesDe(params.id, ids)
      .then((porMensaje) => {
        const siguiente = aplicarReacciones(mensajesRef.current, ids, porMensaje);
        // La misma lista significa «nada cambió»: no se repinta el chat.
        if (siguiente !== mensajesRef.current) aplicar(siguiente);
      })
      .catch(() => {
        // Sin respuesta se queda lo que había; el siguiente aviso lo repite.
      });
  }, [supabaseEnabled, params.id, aplicar]);

  /*
    UNA REACCIÓN CAMBIA UN MENSAJE QUE YA ESTÁ EN PANTALLA, y el canal de
    mensajes no avisa de eso. Quien reacciona manda un aviso sin contenido y
    los demás preguntan a la API. Como mucho una consulta cada segundo largo.
    Solo si el servidor conoce las reacciones: sin eso no hay nada que oír.
  */
  useEffect(() => {
    if (!supabaseEnabled || !params.id || !funciones.reacciones) return;
    let pendiente: ReturnType<typeof setTimeout> | null = null;
    const canal = avisosDeReacciones(params.id, () => {
      if (pendiente) return;
      pendiente = setTimeout(() => {
        pendiente = null;
        refrescarReacciones();
      }, 1200);
    });
    avisosDeReaccion.current = canal;
    return () => {
      if (pendiente) clearTimeout(pendiente);
      avisosDeReaccion.current = null;
      canal.cerrar();
    };
  }, [supabaseEnabled, params.id, funciones.reacciones, refrescarReacciones]);

  /**
   * Pone la reacción (o la quita, con `null`).
   *
   * Se pinta EN EL ACTO y después se corrige con lo que diga el servidor, que
   * es quien sabe cuántos han reaccionado. Si falla, se vuelve a como estaba
   * y se dice: una reacción que se queda puesta sin haberse guardado miente.
   */
  const reaccionar = useCallback(
    async (mensaje: Message, emoji: string | null) => {
      if (!params.id || mensaje.estado || mensaje.eliminado) return;
      const conversationId = params.id;
      const antes = mensaje.reacciones ?? [];
      const poner = (reacciones: ReaccionDeMensaje[]) =>
        aplicar(
          mensajesRef.current.map((m) => (m.id === mensaje.id ? { ...m, reacciones } : m)),
        );
      poner(alReaccionar(antes, emoji));
      try {
        poner(await MessageRepository.reaccionar(conversationId, mensaje.id, emoji));
        avisosDeReaccion.current?.avisar();
      } catch {
        poner(antes);
        notify(t('chat.reactFailedTitle'), t('common.tryAgainSoon'));
      }
    },
    [params.id, aplicar, t],
  );

  /** El texto de una cita: su extracto, o qué era si no tenía texto. */
  const textoDeLaCita = (cita: CitaDeMensaje): string => {
    const lo = textoDeCita(cita);
    return 'texto' in lo ? lo.texto : t(lo.clave as TranslationKey);
  };

  /** Guarda en la galería del teléfono la foto o el vídeo que se está viendo. */
  const guardarAdjunto = useCallback(
    async (adjunto: MessageAttachment) => {
      if (!adjunto.url || (adjunto.kind !== 'image' && adjunto.kind !== 'video')) return;
      const resultado = await guardarEnLaGaleria(adjunto.url, adjunto.fileName, adjunto.kind);
      if (resultado === 'guardado') notify(t('chat.savedTitle'), t('chat.savedBody'));
      else if (resultado === 'sin_permiso') {
        notify(t('chat.saveDeniedTitle'), t('chat.saveDeniedBody'));
      } else if (resultado === 'fallo') {
        notify(t('chat.saveFailedTitle'), t('common.tryAgainSoon'));
      }
    },
    [t],
  );

  /**
   * Cómo va una foto o un video dentro de su mensaje.
   *
   * `sin_marco`: van solos, sin burbuja. `al_ras`: dentro de una burbuja con
   * texto, con un marco fino. `normal`: mezclados con archivos o notas de
   * voz, como una pieza más.
   */
  type ContextoDeAdjunto = {
    mensaje: Message;
    /** Si mantenerlo presionado abre el menú del mensaje. */
    conAcciones: boolean;
    forma: 'normal' | 'al_ras' | 'sin_marco';
    /** Lo que se pinta encima de la imagen: de quién es, la hora. */
    encima?: React.ReactNode;
  };

  /*
    LO QUE MIDE DE ANCHO UNA FOTO O UN ARCHIVO. Una burbuja ocupa como máximo
    el 80 % de la pantalla: en un teléfono angosto, los 250 puntos de siempre
    no caben dentro y se salían por el borde. Se recorta a lo que haya.
  */
  const { width: anchoDePantalla } = useWindowDimensions();
  const anchoDeMedio = Math.min(
    ANCHO_DE_MEDIO,
    Math.floor(anchoDePantalla * 0.8) - 2 * RELLENO_H - 2,
  );

  const pintarAdjunto = (
    adjunto: MessageAttachment,
    mio: boolean,
    contexto: ContextoDeAdjunto,
  ) => {
    /*
      MANTENER PRESIONADO SOBRE EL ADJUNTO ABRE EL MENÚ DEL MENSAJE. Antes
      solo respondía la franja de la hora, debajo. Una foto sin marco ya no
      tiene franja: sin esto no habría dónde borrar, reaccionar ni responder.
    */
    const alMantener = contexto.conAcciones
      ? () => abrirAcciones(contexto.mensaje)
      : undefined;

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
        UN ARCHIVO SE DESCARGA, DENTRO DE LA APLICACIÓN (12/10/2026). Antes
        tocarlo abría su dirección en el navegador: la persona acababa fuera
        de Z, en una pestaña de Chrome. Ahora lleva su botón de descargar y
        se guarda en el teléfono. Ver `ArchivoDeChat`.

        Si en realidad es una foto o un video mandado como archivo, tocarlo
        lo abre en el visor, como cualquier otra foto del chat. Solo cuando
        ya está en el servidor: mientras sube no hay nada que abrir.
      */
      const medio = estaEnElServidor(adjunto)
        ? medioQueEs(adjunto.mimeType, adjunto.fileName)
        : null;
      return (
        <ArchivoDeChat
          key={adjunto.id}
          adjunto={adjunto}
          mio={mio}
          alVer={medio ? () => setFotoAmpliada({ ...adjunto, kind: medio }) : undefined}
          alMantener={alMantener}
          style={{ width: anchoDeMedio }}
        />
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
          // EL VÍDEO SE REPRODUCE DENTRO (10/10/2026), en el mismo visor que
          // las fotos. Antes se abría fuera, en el navegador. Mientras se
          // está subiendo todavía no tiene dirección que reproducir.
          if (adjunto.kind === 'video' && !estaEnElServidor(adjunto)) return;
          if (adjunto.url) setFotoAmpliada(adjunto);
        }}
        onLongPress={alMantener}
        delayLongPress={400}
        accessibilityRole="button"
        accessibilityLabel={adjunto.kind === 'video' ? t('chat.viewVideo') : t('chat.viewPhoto')}
        accessibilityHint={alMantener ? t('chat.holdForActions') : undefined}
        style={[
          styles.medio,
          contexto.forma === 'sin_marco' && styles.medioSinMarco,
          contexto.forma === 'al_ras' && styles.medioAlRas,
          contexto.forma === 'al_ras' ? { minWidth: anchoDeMedio } : { width: anchoDeMedio },
          { aspectRatio: Math.min(Math.max(proporcion, 0.6), 1.9) },
        ]}
      >
        {/*
          LA PIEZA QUE SABE DE DÓNDE SACAR LA IMAGEN SIN ESPERAR: lo que ya
          está en el teléfono, lo guardado en el disco, o la portada de un
          video. Antes iba aquí un `Image` con la dirección firmada, que
          volvía a bajar la foto en cada apertura y, con un video, pintaba
          un cuadro negro. Ver `MedioDeChat`.
        */}
        <MedioDeChat adjunto={adjunto} style={StyleSheet.absoluteFill}>
          {contexto.encima}
        </MedioDeChat>
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

  /*
    Arriba del todo se pide más historial; y en cada desplazamiento se anota si
    se sigue viendo el final. Un evento que llega con OTRO alto a la vista no
    lo ha hecho un dedo —es el teclado— y no cuenta como haber subido.
  */
  const alDesplazar = (evento: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = evento.nativeEvent;
    if (contentOffset.y <= 24) cargarMasHistorial();

    const altoAntes = altoAlDesplazar.current;
    altoAlDesplazar.current = layoutMeasurement.height;
    if (altoAntes > 0 && Math.abs(layoutMeasurement.height - altoAntes) > 1) {
      if (pegadoAlFinal.current) bajarAlFinal(false);
      return;
    }

    const abajo = estaPegadoAlFinal({
      desplazado: contentOffset.y,
      alto: layoutMeasurement.height,
      contenido: contentSize.height,
    });
    pegadoAlFinal.current = abajo;
    setLejosDelFinal(!abajo);
    if (abajo) setHayNuevosAbajo(false);
  };

  /*
    DE QUIÉN ES LO QUE SE ESTÁ VIENDO AMPLIADO, y cuándo se mandó. Lo dice el
    mensaje del que cuelga el adjunto. Antes el visor enseñaba la foto y nada
    más: en un grupo no se sabía de quién era.
  */
  const mensajeDelVisor = fotoAmpliada
    ? messages.find((m) => m.attachments?.some((a) => a.id === fotoAmpliada.id))
    : undefined;
  const autorDelVisor = !mensajeDelVisor
    ? headerName
    : mensajeDelVisor.sender === 'me'
      ? t('chatViews.you')
      : nombreDelAutor(infoDeConversacion, mensajeDelVisor.autorId, mensajeDelVisor.autorNombre) ||
        headerName;
  const fechaDelVisor = mensajeDelVisor?.createdAtIso
    ? new Date(mensajeDelVisor.createdAtIso).toLocaleString(undefined, {
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      })
    : undefined;
  const accionesDelVisor: AccionDeVisor[] = [];
  if (fotoAmpliada && estaEnElServidor(fotoAmpliada)) {
    accionesDelVisor.push({
      icono: 'download',
      etiqueta: t('chat.saveMedia'),
      alPulsar: () => void guardarAdjunto(fotoAmpliada),
    });
  }
  if (mensajeDelVisor && mensajeDelVisor.sender === 'me' && !mensajeDelVisor.estado) {
    accionesDelVisor.push({
      icono: 'trash-2',
      etiqueta: t('common.delete'),
      peligro: true,
      alPulsar: () => {
        setFotoAmpliada(null);
        void eliminarMensaje(mensajeDelVisor);
      },
    });
  }

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
        // «La otra persona» solo se busca cuando ya se sabe que NO es un grupo:
        // en un grupo saldría el nombre de quien escribió primero.
        resolverEnElServidor={
          supabaseEnabled && !!params.id && infoDeConversacion !== undefined && !esGrupo
        }
        grupo={
          esGrupo && infoDeConversacion
            ? {
                titulo: infoDeConversacion.titulo || headerName,
                miembros: infoDeConversacion.miembros.length,
                avatarUrl: profileImageUrl(infoDeConversacion.avatarPath) ?? undefined,
                // A quien administra, la cabecera le dice que hay alguien
                // esperando: tocarla lleva a la ficha, donde se responde.
                pendientes: infoDeConversacion.pendientes,
              }
            : undefined
        }
        alAbrirGrupo={
          esGrupo && params.id
            ? () =>
                router.push({
                  pathname: '/chat/grupo/[id]' as never,
                  params: { id: params.id },
                })
            : undefined
        }
        onBack={() => void salirDelChat()}
        // Lo del menú se le pide al servidor: sin él (modo de muestra) no
        // hay nada que abrir, y los tres puntos no se pintan.
        alAbrirMenu={supabaseEnabled && params.id ? () => setOpcionesAbiertas(true) : undefined}
        silenciada={estaSilenciada}
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
        <View
          style={[
            styles.zonaDeMensajes,
            { backgroundColor: colorDeFondo(fondoDelChat, mode === 'dark', colors.background) },
          ]}
          onLayout={alMedirLaLista}
        >
        {/*
          EL FONDO QUE ELIGIÓ ESTA PERSONA. Una foto va detrás de la lista y
          bajo un velo: puede ser cualquier cosa, y lo que no puede es dejar
          sin leer la hora de un mensaje. No recibe toques.
        */}
        {fondoDelChat.tipo === 'foto' ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Image
              source={{ uri: fondoDelChat.uri }}
              resizeMode="cover"
              style={StyleSheet.absoluteFill}
            />
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: veloSobreLaFoto(mode === 'dark') },
              ]}
            />
          </View>
        ) : null}
        <FlashList
          ref={lista}
          data={elementos}
          extraData={extraDeSesiones}
          onContentSizeChange={alCrecerElContenido}
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
          onScroll={alDesplazar}
          scrollEventThrottle={100}
          ListHeaderComponent={
            cargandoHistorial ? (
              <View style={styles.cargandoHistorial}>
                <ActivityIndicator size="small" color={colors.textMuted} />
              </View>
            ) : null
          }
          renderItem={({ item, index }: { item: Message; index: number }) => {
            // La burbuja de «está escribiendo»: no es un mensaje.
            if (item.id === ELEMENTO_DE_ESCRITURA.id) {
              return fraseDeQuienEscribe ? (
                <IndicadorDeEscritura frase={fraseDeQuienEscribe} />
              ) : null;
            }
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
            /*
              Y LO PROPIO LA LLEVA SIEMPRE: en esa franja va la marca, y cada
              mensaje que uno manda —texto, foto, emoji, archivo— enseña la
              suya.
            */
            const mostrarHora = llevaFranjaDeHora({
              agrupado,
              tieneTexto: !!item.text,
              tieneEstado: !!item.estado,
              esMio: mine,
            });
            // Una marca, dos, o dos en celeste: saliendo, enviado o leído.
            const entrega = estadoDeEntrega(item, lecturas.marcas);
            /*
              STICKER: un mensaje que es solo uno, dos o tres emoji, sin
              adjuntos. Se pinta grande y sin burbuja. Vale igual para el que
              se elige en el panel que para el que se escribe con el teclado.
            */
            /*
              MANTENER PULSADO abre las acciones. Sobre lo propio siempre
              (borrar); sobre lo ajeno solo si se puede reaccionar o
              responder: sin eso la hoja saldría vacía.
            */
            const conAcciones = !item.estado && (mine || funciones.reacciones || puedoBorrarAjenos);
            const comoSticker =
              !item.eliminado &&
              !item.attachments?.length &&
              !item.storyContext &&
              !item.sesion &&
              esSticker(item.text);
            /*
              SIN MARCO (12/10/2026, pedido con captura): una foto o un
              video que van solos se pintan sin burbuja. La propia era
              negra y le hacía a la foto un marco grueso que la afeaba.
              La hora va encima de la imagen, como en cualquier chat.

              AL RAS: con texto, con una cita o respondiendo a una
              historia la burbuja se queda —eso necesita un fondo sobre
              el que leerse— y la foto la llena con un marco fino.
            */
            const sinMarco = vaSinMarco({
              texto: item.text,
              eliminado: item.eliminado,
              conCita: !!item.respuestaA,
              conHistoria: !!item.storyContext,
              adjuntos: item.attachments,
            });
            const alRas =
              !sinMarco && !item.eliminado && soloLlevaMedios(item.attachments);
            /** Sin burbuja detrás: un sticker, o una foto sola. */
            const sinFondo = comoSticker || sinMarco;
            /** El nombre de quien escribe, en un grupo, en el primero de su ráfaga. */
            const conAutor = esGrupo && !mine && !agrupado;
            /** Si los adjuntos son lo primero que hay dentro de la burbuja. */
            const adjuntosArriba = !conAutor && !item.respuestaA && !item.storyContext;

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
                {/*
                  DESLIZAR PARA RESPONDER (12/10/2026). Tirar del mensaje
                  hacia cualquiera de los dos lados lo deja citado en la
                  barra de escribir: lo mismo que «Responder» en el menú,
                  sin el menú. Solo donde el menú lo ofrecería: ver
                  `sePuedeResponder`.
                */}
                <DeslizarParaResponder
                  clave={item.id}
                  activo={sePuedeResponder(
                    { estado: item.estado, eliminado: item.eliminado },
                    funciones.reacciones,
                  )}
                  alResponder={() => setRespondiendoA(item)}
                  style={[
                    mine ? styles.filaMia : styles.filaSuya,
                    esGrupo && !mine && styles.filaDeGrupo,
                    // El mensaje al que se llegó desde «Contenido», un momento.
                    item.id === resaltado && { backgroundColor: colors.border },
                  ]}
                >
                  {/*
                    EN UN GRUPO, LA FOTO DE QUIEN ESCRIBE (10/10/2026). Va al
                    lado del primer mensaje de cada ráfaga; en los siguientes
                    queda su hueco, para que las burbujas no bailen. Visto en
                    teléfono: con solo el nombre en gris no se distinguía
                    quién mandaba cada cosa.
                  */}
                  {esGrupo && !mine ? (
                    agrupado ? (
                      <View style={styles.huecoDeAvatar} />
                    ) : (
                      <Avatar
                        size={28}
                        image={
                          profileImageUrl(miembroDe(infoDeConversacion, item.autorId)?.avatarPath) ??
                          null
                        }
                        name={nombreDelAutor(infoDeConversacion, item.autorId, item.autorNombre)}
                      />
                    )
                  ) : null}
                  <View
                    style={[
                      styles.bubble,
                      mine ? styles.mine : styles.theirs,
                      // Dentro de una ráfaga las burbujas se acercan y pierden
                      // la esquina que apunta al lado: se leen como un bloque.
                      agrupado && (mine ? styles.mineSeguida : styles.theirsSeguida),
                      agrupado && styles.pegada,
                      sinMarco && styles.bubbleSinMarco,
                      {
                        // La ajena se despega del fondo con un gris suave en
                        // vez de un borde: en claro, blanco sobre blanco con
                        // una línea parecía una casilla de formulario.
                        backgroundColor: sinFondo
                          ? 'transparent'
                          : mine
                            ? colors.primary
                            : colors.surfaceAlt,
                        borderColor: fallido
                          ? colors.danger
                          : sinFondo
                            ? 'transparent'
                            : mine
                              ? colors.primary
                              : colors.border,
                        opacity: item.estado === 'enviando' ? 0.75 : 1,
                      },
                    ]}
                  >
                    {/*
                      DE QUIÉN ES, solo en un grupo y solo en el primer
                      mensaje de cada ráfaga ajena: repetir el nombre en
                      cinco burbujas seguidas de la misma persona no dice
                      nada.
                    */}
                    {conAutor && !sinMarco ? (
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.autorDeGrupo,
                          // Cada persona, su color: se la reconoce antes de leerla.
                          { color: colorDeAutor(item.autorId, mode === 'dark') },
                        ]}
                      >
                        {nombreDelAutor(infoDeConversacion, item.autorId, item.autorNombre) ||
                          t('groups.someone')}
                      </Text>
                    ) : null}
                    {/*
                      A QUÉ MENSAJE RESPONDE (10/10/2026). Tocarla lleva al
                      original, con el mismo camino que «ver en el chat».
                      Hermana de lo demás, nunca envolviéndolo.
                    */}
                    {item.respuestaA ? (
                      <Pressable
                        onPress={() => setMensajeBuscado(item.respuestaA?.id ?? null)}
                        accessibilityRole="button"
                        accessibilityLabel={t('chat.replyGoTo')}
                        style={[
                          styles.cita,
                          { borderLeftColor: colorDeAutor(item.respuestaA.autorId, mode === 'dark') },
                        ]}
                      >
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.citaAutor,
                            { color: mine && !comoSticker ? colors.onPrimary : colors.text },
                          ]}
                        >
                          {item.respuestaA.autorId === currentUserId
                            ? t('chatViews.you')
                            : item.respuestaA.autor || t('groups.someone')}
                        </Text>
                        <Text
                          numberOfLines={2}
                          style={[
                            styles.citaTexto,
                            { color: mine && !comoSticker ? colors.onPrimary : colors.textMuted },
                          ]}
                        >
                          {textoDeLaCita(item.respuestaA)}
                        </Text>
                      </Pressable>
                    ) : null}
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
                      <View
                        style={[
                          styles.adjuntos,
                          sinMarco && styles.adjuntosSinMarco,
                          alRas && styles.adjuntosAlRas,
                          alRas && adjuntosArriba && styles.adjuntosArriba,
                        ]}
                      >
                        {item.attachments.map((adjunto, indice, todos) =>
                          pintarAdjunto(adjunto, mine, {
                            mensaje: item,
                            conAcciones,
                            forma: sinMarco ? 'sin_marco' : alRas ? 'al_ras' : 'normal',
                            /*
                              SIN BURBUJA, LO QUE IBA DENTRO DE ELLA VA ENCIMA
                              DE LA IMAGEN, sobre un fondo oscuro para que se
                              lea con cualquier foto: de quién es, arriba de
                              la primera; la hora y el estado, abajo de la
                              última.
                            */
                            encima: sinMarco ? (
                              <>
                                {indice === 0 && conAutor ? (
                                  <View style={[styles.sobreMedio, styles.autorSobreMedio]}>
                                    <Text numberOfLines={1} style={styles.textoSobreMedio}>
                                      {nombreDelAutor(
                                        infoDeConversacion,
                                        item.autorId,
                                        item.autorNombre,
                                      ) || t('groups.someone')}
                                    </Text>
                                  </View>
                                ) : null}
                                {indice === todos.length - 1 && mostrarHora ? (
                                  <View style={[styles.sobreMedio, styles.horaSobreMedio]}>
                                    <Text style={styles.textoSobreMedio}>
                                      {item.estado === 'enviando'
                                        ? t('chat.sending')
                                        : fallido
                                          ? t('chat.notSent')
                                          : item.createdAt}
                                    </Text>
                                    {mine ? (
                                      // Sobre la foto la franja es oscura en los dos temas.
                                      <MarcaDeEntrega
                                        estado={entrega}
                                        color="#FFF"
                                        colorDeLeido={COLOR_DE_LEIDO.sobreOscuro}
                                      />
                                    ) : null}
                                  </View>
                                ) : null}
                              </>
                            ) : null,
                          }),
                        )}
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
                        conAcciones ? () => abrirAcciones(item) : undefined
                      }
                      delayLongPress={400}
                      // Una foto sin marco no tiene nada aquí debajo: el
                      // menú se abre manteniendo presionada la propia foto.
                      accessibilityRole={conAcciones && !sinMarco ? 'button' : undefined}
                      accessibilityLabel={
                        conAcciones && !sinMarco ? t('chat.holdForActions') : undefined
                      }
                    >
                      {/*
                        Los enlaces se pueden tocar (07/10/2026): el de una
                        reunión pegado aquí se abre con un toque. Sin
                        enlaces se pinta exactamente lo de antes.
                      */}
                      {item.text && comoSticker ? (
                        <Text style={styles.sticker}>{item.text}</Text>
                      ) : item.text ? (
                        <TextoConEnlaces
                          texto={item.text}
                          colorDelTexto={mine ? colors.onPrimary : colors.text}
                          style={{ color: mine ? colors.onPrimary : colors.text, fontSize: 15, lineHeight: 22 }}
                        />
                      ) : null}

                      {item.progreso !== undefined ? (
                        <View style={[styles.barra, { backgroundColor: colors.border }]}>
                          <View
                            style={[
                              styles.barraAvance,
                              {
                                // Sin burbuja, la barra va sobre el fondo del chat.
                                backgroundColor:
                                  mine && !sinMarco ? colors.onPrimary : colors.primary,
                                width: `${Math.round(item.progreso * 100)}%`,
                              },
                            ]}
                          />
                        </View>
                      ) : null}

                      {mostrarHora && !sinMarco ? (
                        /*
                          LA HORA Y EL ESTADO, legibles. Eran 9 puntos al 70 %:
                          sobre la burbuja negra no se leía. Y el estado del
                          envío se dice con un icono además de con el texto:
                          una marca mientras sale, dos cuando el servidor lo
                          confirma, dos en celeste cuando lo leyeron, y un
                          aviso si no salió. Ver `lib/lecturaDeMensajes`.
                        */
                        <View style={[styles.pieDeBurbuja, mine && styles.pieDeBurbujaMia]}>
                          <Text
                            style={{
                              // Sin burbuja detrás, la hora va sobre el fondo del chat.
                              color: mine && !comoSticker ? colors.onPrimary : colors.textMuted,
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
                            <MarcaDeEntrega
                              estado={entrega}
                              color={comoSticker ? colors.textMuted : colors.onPrimary}
                              // La burbuja propia es del color principal: oscura en
                              // el tema claro y clara en el oscuro. Un sticker no
                              // lleva burbuja y va sobre el fondo del tema, al revés.
                              colorDeLeido={
                                (mode === 'dark') === comoSticker
                                  ? COLOR_DE_LEIDO.sobreOscuro
                                  : COLOR_DE_LEIDO.sobreClaro
                              }
                              style={styles.iconoDeEstado}
                            />
                          ) : null}
                        </View>
                      ) : null}
                    </Pressable>
                    {/*
                      LAS REACCIONES. Tocar una pone la propia o la quita.
                      Fuera del `Pressable` de arriba: un botón dentro de
                      otro genera HTML inválido en la web.
                    */}
                    {item.reacciones?.length ? (
                      <View style={styles.reacciones}>
                        {item.reacciones.map((reaccion) => (
                          <Pressable
                            key={reaccion.emoji}
                            onPress={() =>
                              void reaccionar(item, reaccion.mia ? null : reaccion.emoji)
                            }
                            accessibilityRole="button"
                            accessibilityLabel={t('chat.reactionOf', {
                              emoji: reaccion.emoji,
                              n: reaccion.cuantos,
                            })}
                            style={[
                              styles.reaccion,
                              {
                                backgroundColor: colors.background,
                                borderColor: reaccion.mia ? colors.text : colors.border,
                              },
                            ]}
                          >
                            <Text style={[styles.reaccionTexto, { color: colors.text }]}>
                              {reaccion.cuantos > 1
                                ? `${reaccion.emoji} ${reaccion.cuantos}`
                                : reaccion.emoji}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
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
                </DeslizarParaResponder>
              </Aparecer>
            );
          }}
        />
        {/*
          IR A LO ÚLTIMO. Solo cuando se ha subido a leer: abajo no hay a dónde
          ir. El punto dice que, mientras tanto, ha llegado algo.
        */}
        {lejosDelFinal ? (
          <Pulsable
            onPress={() => bajarAlFinal(true)}
            accessibilityRole="button"
            accessibilityLabel={t('chat.goToLatest')}
            escala={ESCALA_AL_PULSAR.icono}
            style={[styles.irAlFinal, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Feather name="chevron-down" size={22} color={colors.text} />
            {hayNuevosAbajo ? (
              <View
                style={[styles.irAlFinalPunto, { backgroundColor: colors.primary, borderColor: colors.surface }]}
              />
            ) : null}
          </Pulsable>
        ) : null}
        </View>

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
                  // La misma pieza que la burbuja: de un video enseña un
                  // fotograma en vez de un cuadro negro.
                  <MedioDeChat
                    compacto
                    style={styles.previaImagen}
                    adjunto={{
                      id: archivo.uri,
                      storagePath: '',
                      kind: archivo.kind,
                      url: archivo.uri,
                      durationS: archivo.durationS,
                    }}
                  />
                )}
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

        {/*
          A QUÉ SE ESTÁ RESPONDIENDO, mientras se escribe. Con su X: quien se
          arrepiente manda un mensaje normal.
        */}
        {respondiendoA ? (
          <View
            style={[
              styles.respondiendo,
              { borderTopColor: colors.border, backgroundColor: colors.surfaceAlt },
            ]}
          >
            <View style={styles.respondiendoTexto}>
              <Text numberOfLines={1} style={[styles.citaAutor, { color: colors.text }]}>
                {respondiendoA.sender === 'me'
                  ? t('chat.replyingToYou')
                  : t('chat.replyingTo', { nombre: citaDe(respondiendoA).autor })}
              </Text>
              <Text numberOfLines={1} style={[styles.citaTexto, { color: colors.textMuted }]}>
                {textoDeLaCita(citaDe(respondiendoA))}
              </Text>
            </View>
            <Pressable
              onPress={() => setRespondiendoA(null)}
              accessibilityRole="button"
              accessibilityLabel={t('chat.replyCancel')}
              hitSlop={10}
              style={styles.respondiendoQuitar}
            >
              <Feather name="x" size={18} color={colors.text} />
            </Pressable>
          </View>
        ) : null}

        <View
          style={[
            styles.inputBar,
            {
              borderTopColor: colors.border,
              backgroundColor: colors.background,
              // Evita que el campo quede bajo la barra de gestos / home indicator.
              paddingBottom: spacing.lg + margenInferior,
            },
          ]}
        >
          {/*
            MIENTRAS HAY UNA NOTA DE VOZ EN MARCHA, LA FILA ES DE LA GRABADORA.
            El `+` y el campo de texto se apartan y su sitio lo ocupa la barra
            de la nota (`BotonDeNotaDeVoz`), con la papelera a la izquierda y
            el envío a la derecha. Dejarlos daría dos modos a la vez —hablando
            y escribiendo—, y la barra tendría que flotar sobre los mensajes,
            que es donde estaba y donde no se encontraba la papelera.
          */}
          {grabadora.ocupada ? null : (
            /*
              El `+` es un botón: lleva su círculo y se hunde al tocarlo.
              Suelto sobre el fondo parecía un signo, no algo que se pulsa.
            */
            <Pulsable
              accessibilityLabel={t('chat.attach')}
              accessibilityRole="button"
              onPress={() => setMenuAbierto(true)}
              disabled={!supabaseEnabled}
              escala={ESCALA_AL_PULSAR.icono}
              opacidad={supabaseEnabled ? 1 : 0.4}
              style={[styles.addButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
            >
              <Feather name="plus" size={22} color={colors.text} />
            </Pulsable>
          )}

          {grabadora.ocupada || !supabaseEnabled ? null : (
            <Pulsable
              accessibilityLabel={t('stickers.open')}
              accessibilityRole="button"
              onPress={() => setStickersAbiertos(true)}
              escala={ESCALA_AL_PULSAR.icono}
              style={[styles.addButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
            >
              <Feather name="smile" size={22} color={colors.text} />
            </Pulsable>
          )}

          {grabadora.ocupada ? null : (
            <Input
              value={text}
              onChangeText={(texto) => {
                setText(texto);
                // Mientras se teclea se avisa a quien tenga el chat abierto.
                escritura.alEscribir(texto);
              }}
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

      {/*
        EL MENÚ DEL CHAT. Cada fila hace algo: «Silenciar» y «Vaciar chat»
        solo salen si el servidor las tiene, y «Salir del grupo», solo en un
        grupo que no se administra (quien lo lleva no puede dejarlo solo).
      */}
      <BottomSheet visible={opcionesAbiertas} onClose={() => setOpcionesAbiertas(false)}>
        <ListRow
          title={t(esGrupo ? 'chatMenu.groupInfo' : 'chatMenu.content')}
          leftIcon={esGrupo ? 'users' : 'grid'}
          onPress={() => void abrirContenido()}
        />
        <ListRow
          title={t('chatMenu.search')}
          leftIcon="search"
          onPress={() => void abrirBusqueda()}
        />
        {funciones.preferencias ? (
          <ListRow
            title={t(estaSilenciada ? 'chatMenu.unmute' : 'chatMenu.mute')}
            leftIcon={estaSilenciada ? 'bell' : 'bell-off'}
            onPress={() => void alternarSilencio()}
          />
        ) : null}
        <ListRow
          title={t('chatBackground.title')}
          leftIcon="image"
          onPress={() => void abrirFondo()}
        />
        {funciones.preferencias ? (
          <ListRow
            title={t('chatMenu.clear')}
            leftIcon="trash-2"
            destructive
            onPress={() => void vaciarElChat()}
          />
        ) : null}
        {/*
          LA LISTA DEL GRUPO, para quien lo administra: es por donde se crea
          la primera comunidad, cuando todavía no hay nada que haga que la
          bandeja abra la lista.
        */}
        {puedoBorrarAjenos &&
        esGrupoDePrimerNivel &&
        (disponibilidadDeTemas.temas || disponibilidadDeTemas.comunidades) ? (
          <ListRow
            title={t('groupTopics.manage')}
            leftIcon="layers"
            onPress={() => void abrirListaDelGrupo()}
          />
        ) : null}
        {esGrupo && infoDeConversacion && !infoDeConversacion.puedoAdministrar ? (
          <ListRow
            title={t(padre ? 'groupCommunities.leave' : 'groups.leave')}
            leftIcon="log-out"
            destructive
            onPress={() => void salirDelGrupo()}
          />
        ) : null}
      </BottomSheet>

      <HojaDeFondoDeChat
        conversacionId={params.id ?? ''}
        visible={fondoAbierto}
        onClose={() => setFondoAbierto(false)}
      />

      <BottomSheet visible={menuAbierto} onClose={() => setMenuAbierto(false)}>
        <ListRow
          title={t('chat.photosAndVideos')}
          leftIcon="image"
          onPress={() => void elegirCon(() => elegirFotosOVideos(MAX_ADJUNTOS - elegidos.length))}
        />
        {/* Aparte de la fila de arriba: el recortador del teléfono trabaja
            con una sola foto, y aquella deja elegir varias. */}
        <ListRow
          title={t('chat.cropPhoto')}
          subtitle={t('chat.cropPhotoHint')}
          leftIcon="crop"
          onPress={() => void elegirCon(elegirFotoRecortada)}
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
        {funciones.reacciones ? (
          <>
            <View style={styles.reaccionesRapidas}>
              {REACCIONES_RAPIDAS.map((emoji) => {
                const puesta = miReaccion(accionesDe?.reacciones) === emoji;
                return (
                  <Pressable
                    key={emoji}
                    onPress={() => {
                      const mensaje = accionesDe;
                      setAccionesDe(null);
                      if (mensaje) void reaccionar(mensaje, puesta ? null : emoji);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.reactWith', { emoji })}
                    style={[
                      styles.reaccionRapida,
                      puesta && { backgroundColor: colors.surfaceAlt },
                    ]}
                  >
                    <Text style={styles.reaccionRapidaTexto}>{emoji}</Text>
                  </Pressable>
                );
              })}
              <Pressable
                onPress={() => {
                  const mensaje = accionesDe;
                  setAccionesDe(null);
                  // Otra hoja no se abre encima de una que se está cerrando.
                  void afterSheetClose().then(() => setReaccionandoA(mensaje));
                }}
                accessibilityRole="button"
                accessibilityLabel={t('chat.reactMore')}
                style={styles.reaccionRapida}
              >
                <Feather name="plus" size={22} color={colors.text} />
              </Pressable>
            </View>
            <ListRow
              title={t('chat.reply')}
              leftIcon="corner-up-left"
              onPress={() => {
                setRespondiendoA(accionesDe);
                setAccionesDe(null);
              }}
            />
          </>
        ) : null}
        {/* Quién lo leyó y quién no. Solo de lo propio, ya enviado, y solo si
            el servidor lo sabe decir. */}
        {accionesDe &&
        funciones.lecturas &&
        tieneDetalles({ ...accionesDe, esSesion: accionesDe.id.startsWith('sesion:') }) ? (
          <ListRow
            title={t('chat.messageDetails')}
            leftIcon="info"
            onPress={() => {
              setDetallesDe(accionesDe);
              setAccionesDe(null);
            }}
          />
        ) : null}
        {/* Solo quien administra, en un grupo de primer nivel con temas. */}
        {accionesDe && puedoAgregarATemas && !accionesDe.sesion ? (
          <ListRow
            title={t('groupTopics.addToTopic')}
            leftIcon="folder-plus"
            onPress={() => void agregarATemaDesdeElMenu()}
          />
        ) : null}
        {accionesDe?.sender === 'me' || (accionesDe && puedoBorrarAjenos) ? (
          <ListRow
            title={t('common.delete')}
            leftIcon="trash-2"
            destructive
            onPress={() => void eliminarDesdeElMenu()}
          />
        ) : null}
      </BottomSheet>

      <HojaDeTemas
        grupoId={params.id ?? ''}
        mensajeId={temasPara?.id ?? null}
        onClose={() => setTemasPara(null)}
      />

      <DetallesDeMensaje
        conversacionId={params.id ?? ''}
        mensaje={detallesDe}
        esGrupo={esGrupo}
        onClose={() => setDetallesDe(null)}
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

      <HojaDeStickers
        visible={stickersAbiertos}
        onClose={() => setStickersAbiertos(false)}
        alElegir={(sticker) => {
          setStickersAbiertos(false);
          void mandar({
            texto: sticker,
            archivos: [],
            respondeA: respondiendoA?.id,
            cita: respondiendoA ? citaDe(respondiendoA) : undefined,
          });
          setRespondiendoA(null);
        }}
      />
      <VisorDeAdjunto
        adjunto={fotoAmpliada?.url ? fotoAmpliada : null}
        autor={autorDelVisor}
        fecha={fechaDelVisor}
        acciones={accionesDelVisor}
        pie={
          funciones.reacciones && mensajeDelVisor && !mensajeDelVisor.estado ? (
            <View style={styles.pieDelVisor}>
              <Pressable
                onPress={() => {
                  setRespondiendoA(mensajeDelVisor);
                  setFotoAmpliada(null);
                }}
                accessibilityRole="button"
                accessibilityLabel={t('chat.reply')}
                style={styles.responderEnElVisor}
              >
                <Feather name="corner-up-left" size={18} color="#FFFFFF" />
                <Text style={styles.responderEnElVisorTexto}>{t('chat.reply')}</Text>
              </Pressable>
              {REACCIONES_RAPIDAS.slice(0, 3).map((emoji) => {
                const puesta = miReaccion(mensajeDelVisor.reacciones) === emoji;
                return (
                  <Pressable
                    key={emoji}
                    onPress={() => void reaccionar(mensajeDelVisor, puesta ? null : emoji)}
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.reactWith', { emoji })}
                    style={[styles.reaccionEnElVisor, puesta && styles.reaccionEnElVisorPuesta]}
                  >
                    <Text style={styles.reaccionRapidaTexto}>{emoji}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : undefined
        }
        onClose={() => setFotoAmpliada(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  autorDeGrupo: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  filaDeGrupo: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  huecoDeAvatar: { width: 28 },
  sticker: { fontSize: 44, lineHeight: 56 },
  cita: {
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 6,
    backgroundColor: 'rgba(127,127,127,0.22)',
  },
  citaAutor: { fontSize: 12, fontWeight: '700' },
  citaTexto: { fontSize: 13, lineHeight: 18 },
  reacciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  reaccion: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2 },
  reaccionTexto: { fontSize: 13 },
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
  respondiendo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  respondiendoTexto: { flex: 1, minWidth: 0 },
  respondiendoQuitar: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  pieDelVisor: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  responderEnElVisor: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  responderEnElVisorTexto: { color: '#FFFFFF', fontSize: 15 },
  reaccionEnElVisor: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reaccionEnElVisorPuesta: { backgroundColor: 'rgba(255,255,255,0.22)' },
  // FlashList solo admite padding en contentContainerStyle (nada de gap/flexGrow).
  messages: { padding: spacing.lg },
  // La lista y, encima, el botón de «ir a lo último».
  zonaDeMensajes: { flex: 1 },
  irAlFinal: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  irAlFinalPunto: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
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
    paddingVertical: RELLENO_V,
    paddingHorizontal: RELLENO_H,
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
  // Una foto o un video solos: ni relleno ni borde que les hagan marco.
  bubbleSinMarco: { paddingVertical: 0, paddingHorizontal: 0, borderWidth: 0 },
  adjuntos: { gap: spacing.sm, marginBottom: spacing.sm },
  adjuntosSinMarco: { gap: 4, marginBottom: 0 },
  // Dentro de una burbuja con texto la foto llega hasta casi el borde: se
  // come el relleno de la burbuja menos un marco fino (`MARCO_FINO`).
  adjuntosAlRas: { marginHorizontal: -(RELLENO_H - MARCO_FINO) },
  adjuntosArriba: { marginTop: -(RELLENO_V - MARCO_FINO) },
  // El ancho lo pone la pantalla: ver `anchoDeMedio`.
  medio: { borderRadius: radius.md, overflow: 'hidden' },
  medioSinMarco: { borderRadius: 18 },
  // Se estira a lo que mida la burbuja —que puede ensancharla el texto—, y
  // nunca menos que una foto suelta.
  medioAlRas: { alignSelf: 'stretch', borderRadius: 16 },
  // Lo que va encima de una foto sin marco: sobre oscuro, se lee con todas.
  sobreMedio: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  horaSobreMedio: { right: 8, bottom: 8 },
  autorSobreMedio: { left: 8, top: 8, maxWidth: '80%' },
  textoSobreMedio: { color: '#FFF', fontSize: 11, lineHeight: 14, fontWeight: '600' },
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
