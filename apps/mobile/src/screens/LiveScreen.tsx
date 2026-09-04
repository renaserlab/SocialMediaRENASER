import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/Text';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import { useSesionDeDirecto } from '@/hooks/useSesionDeDirecto';
import { confirm } from '@/lib/confirm';
import { describeError } from '@/lib/describeError';
import { haptics } from '@/lib/haptics';
import { abrirAjustes } from '@/lib/permisos';
import { esperaRestanteMs, puedeEnviarMensaje, registrarEnvio } from '@/lib/ritmoDeChat';
import {
  cartelDelEstado,
  pideAccionDeLaPersona,
  type EstadoDeDirecto,
  type VistaDeDirecto,
} from '@/live/maquinaDeDirecto';
import {
  LiveRepository,
  REACCIONES,
  reaccionesVacias,
  type ConteoDeReacciones,
  type Emision,
  type EstadoDeEmision,
  type MensajeDeEmision,
  type TipoDeReaccion,
} from '@/repositories/LiveRepository';
import { ApiError } from '@/services/api';
import {
  canalDeReacciones,
  hayTiempoReal,
  suscribirseAlChat,
  suscribirseAlEstado,
  type CanalDeReacciones,
  type FilaDeMensaje,
} from '@/services/directoEnVivo';
import { useAppStore } from '@/store/useAppStore';
import { palette, radius, spacing } from '@/theme/tokens';
import { traduceEnElIdiomaActual, type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * La pantalla de una emision en vivo.
 *
 * LO QUE NO HACE, Y ES LO IMPORTANTE: no pinta un reproductor, porque todavia
 * no hay SDK de video instalado. Lo que SI hay desde ahora es todo lo que
 * rodea al video, y esta escrito de forma que enchufar el SDK sea un cambio
 * pequeño y en un solo sitio:
 *
 *   - `live/salaDeVideo.ts` fija el contrato de la sala y trae una
 *     implementacion FALSA que rechaza `unirse` con «no hay proveedor». El dia
 *     que se apruebe el paquete se escribe la segunda implementacion y se
 *     registra con una linea.
 *   - `live/maquinaDeDirecto.ts` decide, sin React delante, cual de los catorce
 *     estados se pinta —conectando, reconectando, permiso denegado, proveedor
 *     no configurado, error recuperable, error definitivo…— y cuando se puede
 *     reintentar. Se prueba con `node --test`.
 *   - `hooks/useSesionDeDirecto.ts` es el cable entre las dos cosas y React.
 *
 * Esta pantalla, por tanto, ya no adivina nada sobre el video: pinta
 * `vista.estado`. Con la bandera apagada ese estado es
 * `proveedor_no_configurado` y se dice con todas las letras —todavia no hay
 * video, el chat si funciona— en vez de dejar girando un indicador de carga
 * contra una sala que nadie va a servir. Un spinner eterno miente igual que un
 * video de ejemplo, solo que mas despacio.
 *
 * Lo que si es real y funciona hoy: la sala, el chat en tiempo real y las
 * reacciones. Ver `services/directoEnVivo.ts` para el porque de que cada cosa
 * viaje por un camino distinto.
 */

// Superficie a pantalla completa sobre contexto de media: siempre oscura.
const media = palette('dark');

/**
 * El simbolo de cada reaccion.
 *
 * Son emoji y no iconos de Feather porque el juego de iconos no tiene aplauso,
 * ni fuego, ni risa: habria que representarlos con otra cosa que no significa
 * lo mismo, y una reaccion que no se reconoce de un vistazo no sirve de nada.
 * Cada clave es exactamente uno de los valores que acepta el servidor.
 */
const SIMBOLO_DE_REACCION: Record<TipoDeReaccion, string> = {
  corazon: '❤️',
  aplauso: '👏',
  fuego: '🔥',
  asombro: '😮',
  risa: '😂',
};

/** Como se lee cada reaccion en voz alta. Claves, no textos. */
const NOMBRE_DE_REACCION: Record<TipoDeReaccion, TranslationKey> = {
  corazon: 'live.reactionHeart',
  aplauso: 'live.reactionClap',
  fuego: 'live.reactionFire',
  asombro: 'live.reactionWow',
  risa: 'live.reactionLaugh',
};

/**
 * Cuantas burbujas de reaccion pueden estar volando a la vez.
 *
 * En un directo animado llegan decenas por segundo, y otras tantas vistas
 * animadas simultaneas tiran los fotogramas al suelo. Pasado el tope se
 * descartan las mas viejas: nadie cuenta las burbujas, y una emision a
 * trompicones si se nota.
 */
const MAXIMO_DE_BURBUJAS = 24;

/** Lo que tarda una burbuja en subir y desaparecer. */
const DURACION_DE_BURBUJA_MS = 1_400;

/** Cuanto sube, en puntos. */
const ALTURA_DE_BURBUJA = 190;

/**
 * Espera antes de volver a pedir la lista de mensajes.
 *
 * La fila que llega por Realtime trae `user_id` pero no el nombre, asi que la
 * primera vez que escribe alguien desconocido hay que preguntarle al servidor.
 * El pequeño retraso agrupa la rafaga inicial de una sala que se llena en una
 * sola peticion en vez de una por persona.
 */
const ESPERA_ANTES_DE_RECARGAR_MS = 250;

/** Quien escribio un mensaje, para poder pintar las filas de Realtime. */
type Autor = { nombre: string; avatarUrl?: string };

type Burbuja = { clave: number; tipo: TipoDeReaccion; carril: number };

/**
 * Traduce un fallo del servidor a algo que se pueda leer.
 *
 * Los 409 del directo son los unicos errores que una persona va a ver a
 * menudo, y «409 live_chat_rate_limited» no le dice a nadie que lo que tiene
 * que hacer es esperar tres segundos.
 */
function mensajeDeError(error: unknown, respaldo: string): string {
  // No es un componente: el idioma se lee de `traduceEnElIdiomaActual`.
  const t = traduceEnElIdiomaActual;
  if (error instanceof ApiError) {
    if (error.code === 'live_chat_rate_limited' || error.code === 'live_reactions_rate_limited') {
      return t('live.tooFast');
    }
    if (error.code === 'live_chat_closed') return t('live.chatClosed');
    if (error.code === 'live_reactions_closed') return t('live.reactionsClosed');
    if (error.code === 'live_not_available') {
      // El 503 del backend cuando la migracion del dominio no esta aplicada. No
      // es culpa de quien mira, y conviene que no parezca que la app se rompio.
      return t('live.notAvailable');
    }
    if (
      error.code === 'live_provider_not_configured' ||
      error.code === 'live_provider_missing'
    ) {
      return t('live.noProvider');
    }
    if (error.code === 'live_not_joinable') return t('live.notJoinable');
    if (error.code === 'live_credential_rate_limited') return t('live.rateLimited');
  }
  return describeError(error, respaldo);
}

function hora(iso: string | null): string {
  if (!iso) return '';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  return fecha.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fechaYHora(iso: string | null): string {
  if (!iso) return '';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  return fecha.toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ------------------------------------------------------------- El video ---- */

/**
 * El hueco del video, que hoy sigue sin ser un video.
 *
 * YA NO DECIDE NADA. Antes esta funcion tenia su propia escalera de `if` sobre
 * el estado de la emision y sobre `reproduccionDisponible`, y esa escalera era
 * imposible de comprobar sin abrir la aplicacion. Ahora el estado lo decide
 * `live/maquinaDeDirecto.ts` —catorce estados, probados uno a uno— y aqui solo
 * se pinta el cartel que le corresponde.
 *
 * Lo unico que se añade a lo que dice la maquina son los DATOS que ella no
 * puede conocer sin importar medio proyecto: la fecha a la que esta programada
 * y la hora a la que termino. El cartel generico sigue estando debajo por si no
 * hay fecha.
 */
function PanelDeVideo({ emision, estado }: { emision: Emision; estado: EstadoDeDirecto }) {
  const { t } = useTranslation();
  const cartel = cartelDelEstado(estado, emision.puedeGestionar);

  let detalle = t(cartel.cuerpo as TranslationKey);
  if (estado === 'programado' && emision.programadaParaIso) {
    detalle = t('live.scheduledFor', { fecha: fechaYHora(emision.programadaParaIso) });
  } else if (estado === 'terminado' && emision.terminoEnIso) {
    detalle = t('live.endedAt', { hora: hora(emision.terminoEnIso) });
  }

  return (
    <AvisoDeVideo
      icono={cartel.icono as keyof typeof Feather.glyphMap}
      titulo={t(cartel.titulo as TranslationKey)}
      detalle={detalle}
    />
  );
}

function AvisoDeVideo({
  icono,
  titulo,
  detalle,
}: {
  icono: keyof typeof Feather.glyphMap;
  titulo: string;
  detalle: string;
}) {
  return (
    <View style={[estilos.panelDeVideo, { borderColor: media.border }]}>
      <Feather name={icono} size={30} color={media.text} />
      <Text variant="titleMedium" weight="800" color={media.text} style={estilos.centrado}>
        {titulo}
      </Text>
      <Text variant="secondary" color={media.textMuted} style={estilos.centrado}>
        {detalle}
      </Text>
    </View>
  );
}

/**
 * Los controles de quien emite: microfono, camara, girar y empezar.
 *
 * SOLO SE PINTAN SI EL SERVIDOR AUTORIZO A PUBLICAR (`can_publish` de la
 * credencial). No basta con `can_manage`: gestionar una emision —terminarla,
 * moderar el chat— y emitir video son dos permisos distintos, y quien decide el
 * segundo es el proveedor, no la pantalla. Hoy `can_publish` no llega nunca en
 * true, asi que esta fila no aparece: un boton de microfono sobre una sala que
 * no existe es exactamente el tipo de maqueta que este modulo no hace.
 *
 * `ocupado` deshabilita los cuatro a la vez. Es el freno de la doble pulsacion,
 * y lo lleva la maquina: aqui solo se obedece.
 */
function ControlesDeAnfitrion({
  vista,
  enDirecto,
  alAlternarCamara,
  alAlternarMicrofono,
  alCambiarCamara,
  alEmpezar,
}: {
  vista: VistaDeDirecto;
  enDirecto: boolean;
  alAlternarCamara: () => void;
  alAlternarMicrofono: () => void;
  alCambiarCamara: () => void;
  alEmpezar: () => void;
}) {
  const { t } = useTranslation();
  if (!vista.puedePublicar) return null;

  return (
    <View style={estilos.filaDeControles}>
      <BotonDeControl
        icono={vista.microfono ? 'mic' : 'mic-off'}
        etiqueta={vista.microfono ? t('live.micOff') : t('live.micOn')}
        activo={vista.microfono}
        desactivado={vista.ocupado}
        alPulsar={alAlternarMicrofono}
      />
      <BotonDeControl
        icono={vista.camara ? 'video' : 'video-off'}
        etiqueta={vista.camara ? t('live.cameraOff') : t('live.cameraOn')}
        activo={vista.camara}
        desactivado={vista.ocupado}
        alPulsar={alAlternarCamara}
      />
      <BotonDeControl
        icono="refresh-cw"
        etiqueta={t('live.flipCamera')}
        activo={false}
        desactivado={vista.ocupado || !vista.camara}
        alPulsar={alCambiarCamara}
      />
      {enDirecto ? null : (
        <Pressable
          onPress={alEmpezar}
          disabled={vista.ocupado}
          accessibilityRole="button"
          accessibilityState={{ disabled: vista.ocupado }}
          style={[
            estilos.botonDeTexto,
            { borderColor: media.border, opacity: vista.ocupado ? 0.45 : 1 },
          ]}
        >
          <Text variant="secondary" weight="700" color={media.text}>
            {t('live.goLive')}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function BotonDeControl({
  icono,
  etiqueta,
  activo,
  desactivado,
  alPulsar,
}: {
  icono: keyof typeof Feather.glyphMap;
  etiqueta: string;
  activo: boolean;
  desactivado: boolean;
  alPulsar: () => void;
}) {
  return (
    <Pressable
      onPress={alPulsar}
      disabled={desactivado}
      accessibilityRole="button"
      accessibilityLabel={etiqueta}
      accessibilityState={{ disabled: desactivado, selected: activo }}
      style={[
        estilos.botonRedondo,
        { borderColor: media.border, borderWidth: 1, opacity: desactivado ? 0.45 : 1 },
      ]}
    >
      <Feather name={icono} size={18} color={media.text} />
    </Pressable>
  );
}

/* ---------------------------------------------------------- Reacciones ----- */

/**
 * Una reaccion que sube y se apaga.
 *
 * Se monta y se borra sola: la pantalla solo la mete en la lista. El aviso de
 * que ya termino va por `setTimeout` y no por la animacion, porque lo unico
 * que hace falta es saber CUANDO quitarla del arbol, y para eso el reloj de
 * JavaScript basta y no arrastra ninguna sutileza de hilos.
 */
function BurbujaDeReaccion({
  tipo,
  carril,
  reduceMotion,
  alTerminar,
}: {
  tipo: TipoDeReaccion;
  carril: number;
  reduceMotion: boolean;
  alTerminar: () => void;
}) {
  const avance = useSharedValue(0);
  const duracion = reduceMotion ? 500 : DURACION_DE_BURBUJA_MS;
  // Con "reducir movimiento" activo la reaccion aparece y se apaga sin viajar:
  // sigue confirmando el toque, que es para lo que esta.
  const subida = reduceMotion ? 0 : ALTURA_DE_BURBUJA;

  useEffect(() => {
    avance.value = withTiming(1, { duration: duracion });
    const corte = setTimeout(alTerminar, duracion);
    return () => clearTimeout(corte);
    // Solo al montar: cada burbuja vive una vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const estilo = useAnimatedStyle(() => ({
    opacity: 1 - avance.value,
    transform: [
      { translateY: -avance.value * subida },
      { scale: 0.85 + avance.value * 0.35 },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[estilos.burbuja, { left: `${carril * 70}%` }, estilo]}
    >
      <Text style={estilos.simboloGrande}>{SIMBOLO_DE_REACCION[tipo]}</Text>
    </Animated.View>
  );
}

/* ------------------------------------------------------------ Pantalla ----- */

export function LiveScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const parametros = useLocalSearchParams<{ id: string }>();
  const emisionId = typeof parametros.id === 'string' ? parametros.id : '';
  const reduceMotion = useReduceMotion();
  const usuario = useAppStore((estado) => estado.user);

  const [emision, setEmision] = useState<Emision | null>(null);
  const [errorDeCarga, setErrorDeCarga] = useState<string | null>(null);
  const [mensajes, setMensajes] = useState<MensajeDeEmision[]>([]);
  const [texto, setTexto] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [totales, setTotales] = useState<ConteoDeReacciones>(reaccionesVacias);
  const [burbujas, setBurbujas] = useState<Burbuja[]>([]);

  /*
    Quien escribio cada mensaje. La fila que entrega Realtime trae `user_id` y
    nada mas —el nombre y el avatar viven en otra tabla—, asi que este mapa es
    lo que permite pintar un mensaje nuevo sin volver a preguntar.
  */
  const autores = useRef(new Map<string, Autor>());
  const envios = useRef<number[]>([]);
  const recarga = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reacciones = useRef<CanalDeReacciones | null>(null);
  const contadorDeBurbujas = useRef(0);
  const estadoAnterior = useRef<EstadoDeEmision | null>(null);
  const listaRef = useRef<ScrollView | null>(null);

  const puedeGestionar = emision?.puedeGestionar ?? false;
  const chatAbierto = emision?.estado === 'live';

  const visibles = useMemo(() => mensajes.filter((mensaje) => !mensaje.oculto), [mensajes]);

  /* ------------------------------------------------------------ Cargas ---- */

  const cargarMensajes = useCallback(async () => {
    const lista = await LiveRepository.listarMensajes(emisionId);
    lista.forEach((mensaje) => {
      autores.current.set(mensaje.usuarioId, {
        nombre: mensaje.usuarioNombre,
        avatarUrl: mensaje.usuarioAvatarUrl,
      });
    });
    setMensajes(lista);
  }, [emisionId]);

  const programarRecarga = useCallback(() => {
    if (recarga.current) return;
    recarga.current = setTimeout(() => {
      recarga.current = null;
      cargarMensajes().catch(() => {
        // Un fallo aqui solo significa que ese mensaje tarda un poco mas en
        // aparecer; el siguiente evento vuelve a intentarlo.
      });
    }, ESPERA_ANTES_DE_RECARGAR_MS);
  }, [cargarMensajes]);

  const refrescarFicha = useCallback(() => {
    LiveRepository.obtener(emisionId)
      .then((datos) => {
        setEmision(datos);
        setTotales(datos.reacciones);
      })
      .catch(() => {
        // Lo que ya se sabe de la emision sigue siendo valido: no se borra la
        // pantalla por no haber podido refrescarla.
      });
  }, [emisionId]);

  /* ------------------------------------------------- Mensajes en directo -- */

  const alLlegarFila = useCallback(
    (fila: FilaDeMensaje) => {
      const autor = autores.current.get(fila.user_id);
      if (!autor) {
        /*
          No sabemos quien ha escrito. Antes que pintar el mensaje con un
          nombre inventado o con un hueco, se pide la lista al servidor —que si
          trae los nombres— y entra completo un cuarto de segundo despues. Solo
          pasa la primera vez que habla cada persona.
        */
        programarRecarga();
        return;
      }

      const mensaje: MensajeDeEmision = {
        id: fila.id,
        emisionId: fila.session_id,
        usuarioId: fila.user_id,
        usuarioNombre: autor.nombre,
        usuarioAvatarUrl: autor.avatarUrl,
        cuerpo: fila.body,
        creadoEnIso: fila.created_at,
        oculto: Boolean(fila.hidden),
      };

      setMensajes((previos) => {
        const posicion = previos.findIndex((otro) => otro.id === mensaje.id);
        // Si ya estaba es un UPDATE, y en este chat eso significa que alguien lo
        // ha escondido: se sustituye para que desaparezca en todas las
        // pantallas, no solo en la de quien modera.
        if (posicion >= 0) {
          const copia = previos.slice();
          copia[posicion] = mensaje;
          return copia;
        }
        return [...previos, mensaje];
      });
    },
    [programarRecarga],
  );

  useEffect(() => {
    if (!emisionId) {
      setErrorDeCarga(t('live.unknownBroadcast'));
      return;
    }
    let vigente = true;

    LiveRepository.obtener(emisionId)
      .then((datos) => {
        if (!vigente) return;
        setEmision(datos);
        setTotales(datos.reacciones);
        estadoAnterior.current = datos.estado;
      })
      .catch((error) => {
        if (vigente) setErrorDeCarga(mensajeDeError(error, t('live.openFailed')));
      });

    cargarMensajes().catch(() => {
      // Sin esto un fallo de carga dejaba el chat vacio, como si nadie hubiera
      // escrito nunca, en vez de avisar de que no se pudo leer.
      if (vigente) setAviso(t('chat.loadFailed'));
    });

    const dejarChat = suscribirseAlChat(emisionId, alLlegarFila);
    const dejarEstado = suscribirseAlEstado(emisionId, (fila) => {
      const anterior = estadoAnterior.current;
      estadoAnterior.current = fila.status;
      setEmision((previa) =>
        previa
          ? {
              ...previa,
              estado: fila.status,
              empezoEnIso: fila.started_at,
              terminoEnIso: fila.ended_at,
              picoDeEspectadores: fila.viewer_peak ?? previa.picoDeEspectadores,
            }
          : previa,
      );
      /*
        Solo se vuelve a pedir la ficha cuando cambia el ESTADO. Esta misma
        tabla se actualiza con cada resumen de reacciones, y pedir la emision
        entera en cada rafaga costaria mas de lo que ahorra el tiempo real.
      */
      if (anterior && anterior !== fila.status) refrescarFicha();
    });

    return () => {
      vigente = false;
      dejarChat();
      dejarEstado();
      if (recarga.current) {
        clearTimeout(recarga.current);
        recarga.current = null;
      }
    };
  }, [emisionId, alLlegarFila, cargarMensajes, refrescarFicha]);

  /*
    El propio nombre, para que los mensajes de uno aparezcan al instante en vez
    de esperar a la recarga que dispara un autor desconocido.
  */
  useEffect(() => {
    if (usuario?.id) {
      autores.current.set(usuario.id, { nombre: usuario.fullName });
    }
  }, [usuario?.id, usuario?.fullName]);

  /* ---------------------------------------------------------- Burbujas ---- */

  const quitarBurbuja = useCallback((clave: number) => {
    setBurbujas((previas) => previas.filter((burbuja) => burbuja.clave !== clave));
  }, []);

  const soltarBurbuja = useCallback((tipo: TipoDeReaccion) => {
    contadorDeBurbujas.current += 1;
    const clave = contadorDeBurbujas.current;
    // Carril al azar: en vertical y todas en la misma columna, una rafaga se ve
    // como un solo simbolo parpadeando.
    const carril = Math.random();
    setBurbujas((previas) => {
      const sitio = previas.length >= MAXIMO_DE_BURBUJAS ? previas.slice(1) : previas;
      return [...sitio, { clave, tipo, carril }];
    });
  }, []);

  /* -------------------------------------------------- Canal de reacciones -- */

  useEffect(() => {
    // Fuera de directo el servidor cierra las reacciones (409
    // `live_reactions_closed`): no se abre un canal para que nadie lo use.
    if (!emisionId || emision?.estado !== 'live') return;

    const canal = canalDeReacciones(emisionId);
    reacciones.current = canal;
    const dejarDeEscuchar = canal.alRecibir((tipo) => {
      soltarBurbuja(tipo);
      setTotales((previos) => ({ ...previos, [tipo]: previos[tipo] + 1 }));
    });

    return () => {
      dejarDeEscuchar();
      canal.cerrar();
      reacciones.current = null;
    };
  }, [emisionId, emision?.estado, soltarBurbuja]);

  const reaccionar = useCallback(
    (tipo: TipoDeReaccion) => {
      /*
        LA ANIMACION NO ESPERA AL SERVIDOR. Va primero, en el mismo gesto: es lo
        que hace que el boton se sienta conectado. Lo que viaja despues —el
        Broadcast a quien mira, el resumen al backend— puede tardar o fallar sin
        que se note aqui.
      */
      soltarBurbuja(tipo);
      haptics.light();
      setTotales((previos) => ({ ...previos, [tipo]: previos[tipo] + 1 }));
      reacciones.current?.enviar(tipo);
    },
    [soltarBurbuja],
  );

  /* ------------------------------------------------------------- Enviar --- */

  const enviar = useCallback(async () => {
    const cuerpo = texto.trim();
    if (!cuerpo || enviando) return;

    const ahora = Date.now();
    if (!puedeEnviarMensaje(envios.current, ahora)) {
      const segundos = Math.max(1, Math.ceil(esperaRestanteMs(envios.current, ahora) / 1000));
      // El freno de verdad esta en el servidor; este solo evita perder el texto
      // contra un 409 que llega cuando el campo ya se ha vaciado.
      setAviso(`Vas demasiado rápido. Espera ${segundos} s.`);
      return;
    }
    envios.current = registrarEnvio(envios.current, ahora);

    setTexto('');
    setAviso(null);
    setEnviando(true);
    try {
      const guardado = await LiveRepository.enviarMensaje(emisionId, cuerpo);
      /*
        EL POST SOLO ESCRIBE: el mensaje entra por la suscripcion, igual que el
        de cualquier otra persona. La excepcion es no tener tiempo real (modo
        demo, sin Supabase configurado), donde nadie lo va a entregar y sin esto
        el chat se quedaria mudo con lo que uno mismo escribe.
      */
      if (!hayTiempoReal) {
        autores.current.set(guardado.usuarioId, {
          nombre: guardado.usuarioNombre,
          avatarUrl: guardado.usuarioAvatarUrl,
        });
        setMensajes((previos) =>
          previos.some((otro) => otro.id === guardado.id) ? previos : [...previos, guardado],
        );
      }
    } catch (error) {
      // Lo escrito vuelve al campo: perder el texto por un limite de ritmo es
      // la forma mas rapida de que alguien deje de escribir.
      setTexto(cuerpo);
      setAviso(mensajeDeError(error, t('live.sendFailed')));
    } finally {
      setEnviando(false);
    }
  }, [texto, enviando, emisionId]);

  /* -------------------------------------------------------- Moderacion ---- */

  /**
   * Empezar y terminar, tal y como los ve la maquina.
   *
   * La CONFIRMACION y el freno de la doble pulsacion ya no estan aqui: los pone
   * `live/maquinaDeDirecto.ts`, que es donde se pueden probar. Antes, dos
   * toques rapidos en «Terminar emision» abrian dos dialogos y el segundo
   * mandaba un `POST /end` sobre una emision ya cerrada.
   *
   * El error se cuenta AQUI y no se vuelve a lanzar: este sitio sabe traducir
   * un `ApiError` del directo a algo legible («vas demasiado rapido», «el chat
   * esta cerrado») y la maquina, que no puede importar el diccionario, solo
   * tiene un texto generico de respaldo. Dejarlo subir pintaria el generico
   * encima del bueno.
   */
  const alCambiarLaFicha = useCallback(
    async (accion: 'empezar' | 'terminar') => {
      try {
        const datos =
          accion === 'empezar'
            ? await LiveRepository.empezar(emisionId)
            : await LiveRepository.terminar(emisionId);
        setEmision(datos);
        // Se apunta tambien aqui: el UPDATE de Realtime va a llegar con este
        // mismo estado, y sin esto lo leeria como un cambio y volveria a pedir
        // una ficha que ya tenemos.
        estadoAnterior.current = datos.estado;
      } catch (error) {
        setAviso(
          mensajeDeError(error, accion === 'empezar' ? t('live.startFailed') : t('live.endFailed')),
        );
      }
    },
    [emisionId, t],
  );

  const { vista, sesion } = useSesionDeDirecto({
    emisionId,
    estadoDeSesion: emision?.estado ?? null,
    esAnfitrion: puedeGestionar,
    alCambiarLaFicha,
    avisar: setAviso,
  });

  const terminar = useCallback(() => void sesion.terminar(), [sesion]);
  const empezar = useCallback(() => void sesion.empezar(), [sesion]);

  const ocultar = useCallback(
    async (mensaje: MensajeDeEmision) => {
      const seguro = await confirm({
        title: t('live.hideConfirmTitle'),
        message: mensaje.cuerpo,
        confirmLabel: t('live.hide'),
        destructive: true,
      });
      if (!seguro) return;
      try {
        const oculto = await LiveRepository.ocultarMensaje(mensaje.id);
        // Tambien llegara por Realtime; se aplica ya para que quien modera vea
        // el efecto en el mismo momento en que lo pide.
        setMensajes((previos) =>
          previos.map((otro) => (otro.id === oculto.id ? { ...otro, oculto: true } : otro)),
        );
      } catch (error) {
        setAviso(mensajeDeError(error, t('live.hideFailed')));
      }
    },
    [],
  );

  /* ------------------------------------------------------------ Pintado --- */

  /**
   * Salir de la sala.
   *
   * Siendo ANFITRION de una emision en directo pregunta antes: salir de la
   * pantalla no termina la emision —para eso esta «Terminar emision»— y quien
   * se marcha sin saberlo deja a la gente dentro de una sala sin nadie. Quien
   * solo mira se va sin preguntas: un dialogo por cerrar un video es ruido.
   * Quien decide cual de los dos casos es esta en la maquina.
   */
  const salir = useCallback(() => {
    void sesion.intentarSalir().then((puede) => {
      if (!puede) return;
      if (router.canGoBack()) router.back();
      else router.replace('/');
    });
  }, [sesion, router]);

  if (errorDeCarga) {
    return (
      <View style={estilos.fondo}>
        <SafeAreaView style={estilos.centro}>
          <Feather name="alert-triangle" size={34} color={media.text} />
          <Text variant="titleMedium" weight="800" color={media.text} style={estilos.centrado}>
            {t('live.openFailedTitle')}
          </Text>
          <Text variant="secondary" color={media.textMuted} style={estilos.centrado}>
            {errorDeCarga}
          </Text>
          <Pressable
            onPress={salir}
            accessibilityRole="button"
            style={[estilos.botonDeTexto, { borderColor: media.border }]}
          >
            <Text variant="body" weight="700" color={media.text}>
              {t('common.back')}
            </Text>
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  if (!emision) {
    return (
      <View style={estilos.fondo}>
        <SafeAreaView style={estilos.centro}>
          {/* Acotado: `apiRequest` corta a los 20 s y cae en el estado de error
              de arriba, asi que esto no puede quedarse girando para siempre. */}
          <ActivityIndicator color={media.text} />
          <Text variant="secondary" color={media.textMuted}>
            {t('live.opening')}
          </Text>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={estilos.fondo}>
      <SafeAreaView style={estilos.seguro}>
        <SinTecladoDelante style={estilos.columna}>
          {/* Cabecera */}
          <View style={estilos.cabecera}>
            <Pressable
              onPress={salir}
              accessibilityLabel={t('live.leave')}
              accessibilityRole="button"
              style={estilos.botonRedondo}
            >
              <Feather name="arrow-left" size={24} color={media.text} />
            </Pressable>

            <View style={estilos.tituloDeSala}>
              <Text variant="body" weight="800" color={media.text} numberOfLines={1}>
                {emision.titulo}
              </Text>
              <Text variant="caption" color={media.textMuted} numberOfLines={1}>
                {emision.anfitrionNombre}
                {emision.picoDeEspectadores > 0
                  ? ` · ${emision.picoDeEspectadores} en el pico`
                  : ''}
              </Text>
            </View>

            <Insignia estado={emision.estado} />
          </View>

          {/* Video (o la verdad sobre por que no lo hay) */}
          <PanelDeVideo emision={emision} estado={vista.estado} />

          {/*
            La salida del estado, cuando la hay. Un cartel que solo explica el
            problema deja a quien lo lee sin nada que hacer: el permiso denegado
            lleva a los ajustes del telefono —unico sitio donde se arregla— y el
            error definitivo ofrece volver a intentarlo, que es lo que ya no
            ocurre solo. El error RECUPERABLE no pinta boton a proposito: se
            esta reintentando en este momento, y un boton ahi solo consigue
            reintentos encimados.
          */}
          {pideAccionDeLaPersona(vista.estado) ? (
            <View style={estilos.filaDeGestion}>
              <Pressable
                onPress={abrirAjustes}
                accessibilityRole="button"
                style={[estilos.botonDeTexto, { borderColor: media.border }]}
              >
                <Text variant="secondary" weight="700" color={media.text}>
                  {t('live.openSettings')}
                </Text>
              </Pressable>
            </View>
          ) : vista.estado === 'error_definitivo' ? (
            <View style={estilos.filaDeGestion}>
              <Pressable
                onPress={() => sesion.reintentar()}
                accessibilityRole="button"
                style={[estilos.botonDeTexto, { borderColor: media.border }]}
              >
                <Text variant="secondary" weight="700" color={media.text}>
                  {t('live.retry')}
                </Text>
              </Pressable>
            </View>
          ) : null}

          <ControlesDeAnfitrion
            vista={vista}
            enDirecto={emision.estado === 'live'}
            alAlternarCamara={() => void sesion.alternarCamara()}
            alAlternarMicrofono={() => void sesion.alternarMicrofono()}
            alCambiarCamara={() => void sesion.cambiarCamara()}
            alEmpezar={empezar}
          />

          {puedeGestionar && (emision.estado === 'live' || emision.estado === 'scheduled') ? (
            <View style={estilos.filaDeGestion}>
              {emision.estado === 'scheduled' ? (
                <Pressable
                  onPress={empezar}
                  disabled={vista.ocupado}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: vista.ocupado }}
                  style={[
                    estilos.botonDeTexto,
                    { borderColor: media.border, opacity: vista.ocupado ? 0.45 : 1 },
                  ]}
                >
                  <Text variant="secondary" weight="700" color={media.text}>
                    {t('create.startNow')}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={terminar}
                  disabled={vista.ocupado}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: vista.ocupado }}
                  style={[
                    estilos.botonDeTexto,
                    { borderColor: media.danger, opacity: vista.ocupado ? 0.45 : 1 },
                  ]}
                >
                  <Text variant="secondary" weight="700" color={media.danger}>
                    {t('live.endBroadcast')}
                  </Text>
                </Pressable>
              )}
            </View>
          ) : null}

          {/* Chat */}
          <View style={estilos.zonaDeChat}>
            <ScrollView
              ref={listaRef}
              contentContainerStyle={estilos.mensajes}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() => listaRef.current?.scrollToEnd({ animated: true })}
            >
              {visibles.length === 0 ? (
                <Text variant="secondary" color={media.textMuted} style={estilos.centrado}>
                  {chatAbierto ? t('live.chatEmptyOpen') : t('live.chatEmptyClosed')}
                </Text>
              ) : (
                visibles.map((mensaje) => (
                  <Pressable
                    key={mensaje.id}
                    onLongPress={puedeGestionar ? () => void ocultar(mensaje) : undefined}
                    delayLongPress={400}
                    accessibilityRole={puedeGestionar ? 'button' : 'text'}
                    accessibilityHint={
                      puedeGestionar ? t('live.holdToHide') : undefined
                    }
                    style={estilos.mensaje}
                  >
                    <Avatar size={26} image={mensaje.usuarioAvatarUrl} name={mensaje.usuarioNombre} />
                    <View style={estilos.cuerpoDeMensaje}>
                      <Text variant="caption" weight="800" color={media.textMuted}>
                        {mensaje.usuarioNombre}
                        {mensaje.creadoEnIso ? ` · ${hora(mensaje.creadoEnIso)}` : ''}
                      </Text>
                      <Text variant="secondary" color={media.text}>
                        {mensaje.cuerpo}
                      </Text>
                    </View>
                  </Pressable>
                ))
              )}
            </ScrollView>

            {/* Las burbujas vuelan por encima del chat, sin robarle el dedo. */}
            <View pointerEvents="none" style={estilos.pistaDeBurbujas}>
              {burbujas.map((burbuja) => (
                <BurbujaDeReaccion
                  key={burbuja.clave}
                  tipo={burbuja.tipo}
                  carril={burbuja.carril}
                  reduceMotion={reduceMotion}
                  alTerminar={() => quitarBurbuja(burbuja.clave)}
                />
              ))}
            </View>
          </View>

          {aviso ? (
            <Text variant="caption" weight="700" color={media.danger} style={estilos.aviso}>
              {aviso}
            </Text>
          ) : null}

          {/* Reacciones */}
          {chatAbierto ? (
            <View style={estilos.filaDeReacciones}>
              {REACCIONES.map((tipo) => (
                <Pressable
                  key={tipo}
                  onPress={() => reaccionar(tipo)}
                  accessibilityRole="button"
                  accessibilityLabel={t('live.reactWith', {
                    reaccion: t(NOMBRE_DE_REACCION[tipo]),
                  })}
                  style={[estilos.botonDeReaccion, { borderColor: media.border }]}
                >
                  <Text style={estilos.simbolo}>{SIMBOLO_DE_REACCION[tipo]}</Text>
                  {totales[tipo] > 0 ? (
                    <Text variant="caption" weight="700" color={media.textMuted}>
                      {totales[tipo]}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* Escribir */}
          {chatAbierto ? (
            <View style={estilos.filaDeEscritura}>
              <TextInput
                value={texto}
                onChangeText={setTexto}
                onSubmitEditing={() => void enviar()}
                returnKeyType="send"
                placeholder={t('live.messagePlaceholder')}
                placeholderTextColor={media.textMuted}
                accessibilityLabel={t('live.messageLabel')}
                style={[estilos.campo, { borderColor: media.border, color: media.text }]}
              />
              <Pressable
                onPress={() => void enviar()}
                disabled={!texto.trim() || enviando}
                accessibilityLabel={t('chat.sendMessage')}
                accessibilityRole="button"
                style={[estilos.botonRedondo, { borderColor: media.border, borderWidth: 1 }]}
              >
                <Feather
                  name="send"
                  size={18}
                  color={texto.trim() && !enviando ? media.text : media.disabled}
                />
              </Pressable>
            </View>
          ) : (
            <Text variant="caption" color={media.textMuted} style={estilos.chatCerrado}>
              {emision.estado === 'scheduled' ? t('live.chatOpensLater') : t('live.chatClosed')}
            </Text>
          )}
        </SinTecladoDelante>
      </SafeAreaView>
    </View>
  );
}

/** El estado de la sala, dicho sin adornos. */
function Insignia({ estado }: { estado: EstadoDeEmision }) {
  const { t } = useTranslation();
  if (estado === 'live') {
    return (
      <View style={[estilos.insignia, { backgroundColor: media.danger }]}>
        <View style={[estilos.punto, { backgroundColor: media.text }]} />
        <Text variant="caption" weight="900" color={media.text}>
          {t('live.badgeLive')}
        </Text>
      </View>
    );
  }
  const texto =
    estado === 'scheduled'
      ? t('live.badgeScheduled')
      : estado === 'ended'
        ? t('live.badgeEnded')
        : t('live.badgeCancelled');
  return (
    <View style={[estilos.insignia, { borderColor: media.border, borderWidth: 1 }]}>
      <Text variant="caption" weight="900" color={media.textMuted}>
        {texto}
      </Text>
    </View>
  );
}

const estilos = StyleSheet.create({
  fondo: { flex: 1, backgroundColor: media.background },
  seguro: { flex: 1 },
  columna: { flex: 1, paddingHorizontal: spacing.lg },
  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  centrado: { textAlign: 'center' },
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  tituloDeSala: { flex: 1 },
  botonRedondo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insignia: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  punto: { width: 6, height: 6, borderRadius: 3 },
  panelDeVideo: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  filaDeGestion: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: spacing.sm },
  filaDeControles: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  botonDeTexto: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  zonaDeChat: { flex: 1, marginTop: spacing.md },
  mensajes: { gap: spacing.md, paddingVertical: spacing.md },
  mensaje: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  cuerpoDeMensaje: { flex: 1, gap: 2 },
  pistaDeBurbujas: {
    ...StyleSheet.absoluteFillObject,
    // Deja libre la mitad de arriba: las burbujas nacen abajo, junto a los
    // botones que las lanzan.
    justifyContent: 'flex-end',
  },
  burbuja: { position: 'absolute', bottom: 0 },
  simbolo: { fontSize: 20 },
  simboloGrande: { fontSize: 30 },
  aviso: { textAlign: 'center', paddingBottom: spacing.xs },
  filaDeReacciones: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.xs,
    paddingBottom: spacing.sm,
  },
  botonDeReaccion: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.pill,
    minHeight: 44,
  },
  filaDeEscritura: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  campo: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    fontSize: 14,
  },
  chatCerrado: { textAlign: 'center', paddingVertical: spacing.lg },
});
