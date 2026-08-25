import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
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

import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/Text';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import { confirm } from '@/lib/confirm';
import { describeError } from '@/lib/describeError';
import { haptics } from '@/lib/haptics';
import { esperaRestanteMs, puedeEnviarMensaje, registrarEnvio } from '@/lib/ritmoDeChat';
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

/**
 * La pantalla de una emision en vivo.
 *
 * LO QUE NO HACE, Y ES LO IMPORTANTE: no pinta un reproductor. La respuesta del
 * servidor trae `playback_available` y hoy es SIEMPRE `false`, porque no hay
 * proveedor de directo contratado (bloqueo de negocio, como la pasarela de
 * pago). Asi que la pantalla lo dice con todas las letras —todavia no hay
 * video, el chat si funciona— en vez de dejar girando un indicador de carga
 * contra una URL que nadie va a servir. Un spinner eterno miente igual que un
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

/** Como se lee cada reaccion en voz alta. */
const NOMBRE_DE_REACCION: Record<TipoDeReaccion, string> = {
  corazon: 'corazón',
  aplauso: 'aplauso',
  fuego: 'fuego',
  asombro: 'asombro',
  risa: 'risa',
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
  if (error instanceof ApiError) {
    if (error.code === 'live_chat_rate_limited' || error.code === 'live_reactions_rate_limited') {
      return 'Vas demasiado rápido. Espera unos segundos.';
    }
    if (error.code === 'live_chat_closed') return 'El chat de esta emisión está cerrado.';
    if (error.code === 'live_reactions_closed') return 'Esta emisión ya no admite reacciones.';
    if (error.code === 'live_not_available') {
      // El 503 del backend cuando la migracion del dominio no esta aplicada. No
      // es culpa de quien mira, y conviene que no parezca que la app se rompio.
      return 'Los directos todavía no están disponibles. Vuelve a intentarlo más tarde.';
    }
    if (error.code === 'live_provider_not_configured') {
      return 'Todavía no hay proveedor de vídeo para los directos.';
    }
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
 * El hueco del video, que hoy nunca es un video.
 *
 * Tiene un estado por cada situacion real y ninguno es un indicador de carga:
 * o hay algo que contar, o se cuenta por que no lo hay.
 */
function PanelDeVideo({ emision }: { emision: Emision }) {
  if (emision.estado === 'scheduled') {
    return (
      <AvisoDeVideo
        icono="clock"
        titulo="Todavía no ha empezado"
        detalle={
          emision.programadaParaIso
            ? `Está anunciada para el ${fechaYHora(emision.programadaParaIso)}. Puedes dejar tu mensaje cuando abra el chat.`
            : 'Quien emite aún no la ha iniciado.'
        }
      />
    );
  }

  if (emision.estado === 'cancelled') {
    return (
      <AvisoDeVideo
        icono="slash"
        titulo="La emisión se canceló"
        detalle="Quien la anunció decidió no hacerla. El chat queda cerrado."
      />
    );
  }

  if (emision.estado === 'ended') {
    return (
      <AvisoDeVideo
        icono="check-circle"
        titulo="La emisión terminó"
        detalle={
          emision.terminoEnIso
            ? `Acabó a las ${hora(emision.terminoEnIso)}. Puedes leer lo que se dijo, pero el chat ya está cerrado.`
            : 'Puedes leer lo que se dijo, pero el chat ya está cerrado.'
        }
      />
    );
  }

  /*
    Emision EN DIRECTO y sin video, que es el caso de hoy y por tiempo
    indefinido. Se dice tal cual: no hay imagen, pero lo que si funciona —el
    chat y las reacciones— esta justo debajo y se puede usar ya.
  */
  if (!emision.reproduccionDisponible) {
    return (
      <AvisoDeVideo
        icono="video-off"
        titulo="El vídeo todavía no está disponible"
        detalle="Nos falta el proveedor de directo, así que no hay imagen que enseñar. El chat y las reacciones sí funcionan: esta sala está viva."
      />
    );
  }

  /*
    El servidor dice que hay video. No puede pasar hoy —`playback_available`
    llega siempre en false— y no se pinta un reproductor a ciegas: la URL de
    reproduccion la dara `POST /sessions/{id}/credential`, con la forma que fije
    el proveedor que se contrate, y no se puede escribir contra un contrato que
    todavia no existe. Antes que inventarselo, se dice lo que hay.
  */
  return (
    <AvisoDeVideo
      icono="alert-circle"
      titulo="Esta versión aún no reproduce el vídeo"
      detalle="La emisión ya trae imagen, pero la app necesita una actualización para conectarse al proveedor. El chat funciona igual."
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
      setErrorDeCarga('No sabemos qué emisión abrir.');
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
        if (vigente) setErrorDeCarga(mensajeDeError(error, 'No pudimos abrir la emisión.'));
      });

    cargarMensajes().catch(() => {
      // Sin esto un fallo de carga dejaba el chat vacio, como si nadie hubiera
      // escrito nunca, en vez de avisar de que no se pudo leer.
      if (vigente) setAviso('No se pudieron cargar los mensajes.');
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
      setAviso(mensajeDeError(error, 'No se pudo enviar el mensaje.'));
    } finally {
      setEnviando(false);
    }
  }, [texto, enviando, emisionId]);

  /* -------------------------------------------------------- Moderacion ---- */

  const terminar = useCallback(async () => {
    const seguro = await confirm({
      title: '¿Terminar la emisión?',
      message: 'Se cerrará el chat y nadie podrá volver a entrar. No se puede deshacer.',
      confirmLabel: 'Terminar',
      destructive: true,
    });
    if (!seguro) return;
    try {
      const datos = await LiveRepository.terminar(emisionId);
      setEmision(datos);
      // Se apunta tambien aqui: el UPDATE de Realtime va a llegar con este
      // mismo estado, y sin esto lo leeria como un cambio y volveria a pedir
      // una ficha que ya tenemos.
      estadoAnterior.current = datos.estado;
    } catch (error) {
      setAviso(mensajeDeError(error, 'No se pudo terminar la emisión.'));
    }
  }, [emisionId]);

  const empezar = useCallback(async () => {
    try {
      const datos = await LiveRepository.empezar(emisionId);
      setEmision(datos);
      estadoAnterior.current = datos.estado;
    } catch (error) {
      setAviso(mensajeDeError(error, 'No se pudo empezar la emisión.'));
    }
  }, [emisionId]);

  const ocultar = useCallback(
    async (mensaje: MensajeDeEmision) => {
      const seguro = await confirm({
        title: '¿Ocultar este mensaje?',
        message: mensaje.cuerpo,
        confirmLabel: 'Ocultar',
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
        setAviso(mensajeDeError(error, 'No se pudo ocultar el mensaje.'));
      }
    },
    [],
  );

  /* ------------------------------------------------------------ Pintado --- */

  const salir = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (errorDeCarga) {
    return (
      <View style={estilos.fondo}>
        <SafeAreaView style={estilos.centro}>
          <Feather name="alert-triangle" size={34} color={media.text} />
          <Text variant="titleMedium" weight="800" color={media.text} style={estilos.centrado}>
            No pudimos abrir la emisión
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
              Volver
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
            Abriendo la sala…
          </Text>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={estilos.fondo}>
      <SafeAreaView style={estilos.seguro}>
        <KeyboardAvoidingView
          style={estilos.columna}
          behavior={Platform.select({ ios: 'padding', android: undefined })}
        >
          {/* Cabecera */}
          <View style={estilos.cabecera}>
            <Pressable
              onPress={salir}
              accessibilityLabel="Salir de la emisión"
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
          <PanelDeVideo emision={emision} />

          {puedeGestionar && (emision.estado === 'live' || emision.estado === 'scheduled') ? (
            <View style={estilos.filaDeGestion}>
              {emision.estado === 'scheduled' ? (
                <Pressable
                  onPress={empezar}
                  accessibilityRole="button"
                  style={[estilos.botonDeTexto, { borderColor: media.border }]}
                >
                  <Text variant="secondary" weight="700" color={media.text}>
                    Empezar ahora
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={terminar}
                  accessibilityRole="button"
                  style={[estilos.botonDeTexto, { borderColor: media.danger }]}
                >
                  <Text variant="secondary" weight="700" color={media.danger}>
                    Terminar emisión
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
                  {chatAbierto
                    ? 'Nadie ha escrito todavía. Puedes empezar tú.'
                    : 'No hay mensajes en esta sala.'}
                </Text>
              ) : (
                visibles.map((mensaje) => (
                  <Pressable
                    key={mensaje.id}
                    onLongPress={puedeGestionar ? () => void ocultar(mensaje) : undefined}
                    delayLongPress={400}
                    accessibilityRole={puedeGestionar ? 'button' : 'text'}
                    accessibilityHint={
                      puedeGestionar ? 'Mantén pulsado para ocultar este mensaje' : undefined
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
                  accessibilityLabel={`Reaccionar con ${NOMBRE_DE_REACCION[tipo]}`}
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
                placeholder="Escribe un mensaje…"
                placeholderTextColor={media.textMuted}
                accessibilityLabel="Mensaje para el chat"
                style={[estilos.campo, { borderColor: media.border, color: media.text }]}
              />
              <Pressable
                onPress={() => void enviar()}
                disabled={!texto.trim() || enviando}
                accessibilityLabel="Enviar mensaje"
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
              {emision.estado === 'scheduled'
                ? 'El chat se abre cuando empiece la emisión.'
                : 'El chat de esta emisión está cerrado.'}
            </Text>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

/** El estado de la sala, dicho sin adornos. */
function Insignia({ estado }: { estado: EstadoDeEmision }) {
  if (estado === 'live') {
    return (
      <View style={[estilos.insignia, { backgroundColor: media.danger }]}>
        <View style={[estilos.punto, { backgroundColor: media.text }]} />
        <Text variant="caption" weight="900" color={media.text}>
          EN VIVO
        </Text>
      </View>
    );
  }
  const texto =
    estado === 'scheduled' ? 'PROGRAMADA' : estado === 'ended' ? 'TERMINÓ' : 'CANCELADA';
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
