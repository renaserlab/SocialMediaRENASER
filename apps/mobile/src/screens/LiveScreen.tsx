import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
  type TextStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { rellenoDeEnVivo, rellenoDePeligro, ScrimDeMedio } from '@/components/CapaDeContraste';
import { Pulsable } from '@/components/Pulsable';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Text } from '@/components/Text';
import { CabeceraDeDirecto } from '@/components/live/CabeceraDeDirecto';
import {
  ChatDeDirecto,
  altoDelChatPara,
  type ChatDeDirectoRef,
} from '@/components/live/ChatDeDirecto';
import { DescargaDeGrabacion } from '@/components/live/DescargaDeGrabacion';
import { EscenarioDeVideo } from '@/components/live/EscenarioDeVideo';
import {
  AvisoDeRotuloQuitado,
  CapaDelRotulo,
  DURACION_DEL_AVISO_DE_QUITADO_MS,
  type GeometriaDelRotulo,
} from '@/components/live/CapaDelRotulo';
import { HojaDeRotulo, type BorradorDeRotulo } from '@/components/live/HojaDeRotulo';
import { MensajeFijado } from '@/components/live/MensajeFijado';
import { FinDeDirecto } from '@/components/live/FinDeDirecto';
import { HojaDeCalidad } from '@/components/live/HojaDeCalidad';
import { HojaDeEfectos } from '@/components/live/HojaDeEfectos';
import { HojaDeInvitados } from '@/components/live/HojaDeInvitados';
import { InvitacionAlEscenario } from '@/components/live/InvitacionAlEscenario';
import { ReaccionesDeDirecto } from '@/components/live/ReaccionesDeDirecto';
import { useAudienciaDeDirecto } from '@/hooks/useAudienciaDeDirecto';
import { useDestacadoDeDirecto } from '@/hooks/useDestacadoDeDirecto';
import { useEscenarioDeDirecto } from '@/hooks/useEscenarioDeDirecto';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import { useSesionDeDirecto } from '@/hooks/useSesionDeDirecto';
import { describeError } from '@/lib/describeError';
import { compartirDirecto } from '@/lib/enlaces';
import { abrirAjustes } from '@/lib/permisos';
import { esperaRestanteMs, puedeEnviarMensaje, registrarEnvio } from '@/lib/ritmoDeChat';
import {
  cartelDelEstado,
  pideAccionDeLaPersona,
  type EstadoDeDirecto,
  type VistaDeDirecto,
} from '@/live/maquinaDeDirecto';
import { elegirPistasDeEscenario } from '@/live/escenario';
import {
  ESTILO_POR_OMISION,
  PRESENTACION_POR_OMISION,
  claveDelRotulo,
  limpiarRotulo,
  type Rotulo,
} from '@/live/destacado';
import { papeleraEn, zonaLibre, type Caja, type Medida } from '@/live/rotuloEnPantalla';
import { volverA } from '@/navigation/salirDelTramite';
import {
  LiveRepository,
  type Emision,
  type EstadoDeEmision,
  type MensajeDeEmision,
} from '@/repositories/LiveRepository';
import { ApiError } from '@/services/api';
import { hayTiempoReal, suscribirseAlEstado } from '@/services/directoEnVivo';
import { palette, radius, spacing } from '@/theme/tokens';
import { traduceEnElIdiomaActual, type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * La pantalla de una emision en vivo.
 *
 * COMO SE VE (desde el 04/10/2026). La imagen ocupa la pantalla entera y todo
 * lo demas va encima: una cabecera corta arriba, y abajo el chat, las
 * reacciones y el campo para escribir, sobre un degradado que solo oscurece esa
 * franja. Los controles de quien emite van en una columna a la derecha, donde
 * no tapan a nadie. Antes el video era un recuadro de 3:4 con el chat debajo,
 * y un directo se veia como un formulario con una foto.
 *
 * ESTA PANTALLA NO DECIDE CASI NADA, y cada cosa tiene su sitio:
 *
 *   - el estado del video —conectando, reconectando, sin permiso, sin
 *     proveedor…— lo decide `live/maquinaDeDirecto.ts`, y aqui se pinta su
 *     cartel. `hooks/useSesionDeDirecto.ts` es el cable;
 *   - el chat (`components/live/ChatDeDirecto.tsx`) y las reacciones
 *     (`components/live/ReaccionesDeDirecto.tsx`) llevan su propio estado: un
 *     mensaje o un corazon ya no repintan la imagen ni los controles;
 *   - los efectos de camara y la calidad de imagen son de la sala
 *     (`SalaDeVideo`), y sus hojas solo pintan lo que ella dice.
 *
 * Con la bandera apagada el estado es `proveedor_no_configurado` y se dice con
 * todas las letras —todavia no hay video, el chat si funciona— en vez de dejar
 * girando un indicador de carga contra una sala que nadie va a servir.
 */

// Superficie a pantalla completa sobre contexto de media: siempre oscura.
const media = palette('dark');

/** El velo de los botones que van encima de la imagen. */
const VELO = 'rgba(0,0,0,0.45)';

/** El tema va en claro: su letra, en oscuro. */
const TINTA_DEL_TEMA = '#111111';

/**
 * Cuantos comentarios se ven a la vez. El resto se alcanza deslizando.
 *
 * Eran ocho o nueve —un tercio de la pantalla— y tapaban la emision. Cuatro,
 * como en las aplicaciones de referencia: el chat acompana, no manda. Cuanto
 * mide eso lo dice el propio chat (`altoDelChatPara`).
 */
const COMENTARIOS_A_LA_VISTA = 4;

/**
 * En web el campo de texto enfocado lleva el anillo del navegador
 * (`outline: auto`). Se quita con `outlineStyle`; `outlineWidth: 0` no basta.
 */
const SIN_ANILLO_DEL_NAVEGADOR =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;

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

/** Estados en los que hay sala y tiene sentido ensenar imagen si la hay. */
const ESTADOS_CON_IMAGEN: readonly EstadoDeDirecto[] = [
  'en_directo',
  'conectado',
  'conexion_lenta',
  'reconectando',
];

/**
 * El cartel del estado, cuando NO hay imagen que ensenar.
 *
 * AQUI NO SE DECIDE NADA. El estado lo decide `live/maquinaDeDirecto.ts`
 * —catorce estados, probados uno a uno— y aqui solo se pinta el cartel que le
 * corresponde.
 *
 * Lo unico que se añade a lo que dice la maquina son los DATOS que ella no
 * puede conocer sin importar medio proyecto: la fecha a la que esta programada
 * y la hora a la que termino. El cartel generico sigue estando debajo por si no
 * hay fecha.
 */
function CartelDeVideo({ emision, estado }: { emision: Emision; estado: EstadoDeDirecto }) {
  const { t } = useTranslation();
  const cartel = cartelDelEstado(estado, emision.puedeGestionar);

  let detalle = t(cartel.cuerpo as TranslationKey);
  if (estado === 'programado' && emision.programadaParaIso) {
    detalle = t('live.scheduledFor', { fecha: fechaYHora(emision.programadaParaIso) });
  } else if (estado === 'terminado' && emision.terminoEnIso) {
    detalle = t('live.endedAt', { hora: hora(emision.terminoEnIso) });
  }

  return (
    <View style={[estilos.cartel, { borderColor: media.border }]}>
      <Feather name={cartel.icono as keyof typeof Feather.glyphMap} size={30} color={media.text} />
      <Text variant="titleMedium" weight="800" color={media.text} style={estilos.centrado}>
        {t(cartel.titulo as TranslationKey)}
      </Text>
      <Text variant="secondary" color={media.textMuted} style={estilos.centrado}>
        {detalle}
      </Text>
    </View>
  );
}

/**
 * Los controles de quien emite: microfono, camara, girar y efectos.
 *
 * SOLO SE PINTAN SI EL SERVIDOR AUTORIZO A PUBLICAR (`can_publish` de la
 * credencial). No basta con `can_manage`: gestionar una emision —terminarla,
 * moderar el chat— y emitir video son dos permisos distintos, y quien decide el
 * segundo es el servidor al firmar la credencial de 100ms, no la pantalla. Sin
 * proveedor configurado `can_publish` no llega en true y esta columna no
 * aparece: un boton de microfono sobre una sala sin video es una maqueta.
 *
 * VAN EN COLUMNA, A LA DERECHA: es donde no tapan la cara de quien emite ni el
 * chat. `ocupado` deshabilita los de la sala a la vez. Es el freno de la doble
 * pulsacion, y lo lleva la maquina: aqui solo se obedece.
 *
 * EL DE EFECTOS ESTA SIEMPRE, y atenuado si este telefono no los admite: al
 * pulsarlo, la hoja explica por que (falta actualizar la aplicacion, el
 * sistema es antiguo). Esconderlo dejaria a quien emite sin saber que la
 * opcion existe ni por que no la tiene.
 */
function ControlesDeAnfitrion({
  vista,
  hayEfectos,
  efectoPuesto,
  alAlternarCamara,
  alAlternarMicrofono,
  alCambiarCamara,
  alAbrirEfectos,
}: {
  vista: VistaDeDirecto;
  hayEfectos: boolean;
  efectoPuesto: boolean;
  alAlternarCamara: () => void;
  alAlternarMicrofono: () => void;
  alCambiarCamara: () => void;
  alAbrirEfectos: () => void;
}) {
  const { t } = useTranslation();
  if (!vista.puedePublicar) return null;

  return (
    <View style={estilos.columnaDeControles}>
      <BotonDeControl
        icono="aperture"
        etiqueta={t('live.effects')}
        activo={efectoPuesto}
        // Nunca se deshabilita: el efecto se tiene que poder quitar con la
        // sala ocupada, y la hoja es donde se explica por que no hay.
        desactivado={false}
        atenuado={!hayEfectos}
        alPulsar={alAbrirEfectos}
      />
      <BotonDeControl
        icono="refresh-cw"
        etiqueta={t('live.flipCamera')}
        activo={false}
        desactivado={vista.ocupado || !vista.camara}
        alPulsar={alCambiarCamara}
      />
      <BotonDeControl
        icono={vista.camara ? 'video' : 'video-off'}
        etiqueta={vista.camara ? t('live.cameraOff') : t('live.cameraOn')}
        activo={vista.camara}
        desactivado={vista.ocupado}
        alPulsar={alAlternarCamara}
      />
      <BotonDeControl
        icono={vista.microfono ? 'mic' : 'mic-off'}
        etiqueta={vista.microfono ? t('live.micOff') : t('live.micOn')}
        activo={vista.microfono}
        desactivado={vista.ocupado}
        alPulsar={alAlternarMicrofono}
      />
    </View>
  );
}

function BotonDeControl({
  icono,
  etiqueta,
  activo,
  desactivado,
  atenuado = false,
  alPulsar,
}: {
  icono: keyof typeof Feather.glyphMap;
  etiqueta: string;
  activo: boolean;
  desactivado: boolean;
  /** Se puede pulsar, pero se ve apagado: lo que ofrece no esta disponible. */
  atenuado?: boolean;
  alPulsar: () => void;
}) {
  return (
    <Pulsable
      onPress={alPulsar}
      disabled={desactivado}
      opacidad={desactivado || atenuado ? 0.45 : 1}
      accessibilityRole="button"
      accessibilityLabel={etiqueta}
      accessibilityState={{ disabled: desactivado, selected: activo }}
      style={[estilos.botonRedondo, estilos.sobreImagen]}
    >
      <Feather name={icono} size={18} color={media.text} />
    </Pulsable>
  );
}

/** Un boton de texto sobre la imagen. `peligro` para terminar la emision. */
function BotonDeTexto({
  texto,
  alPulsar,
  desactivado = false,
  peligro = false,
}: {
  texto: string;
  alPulsar: () => void;
  desactivado?: boolean;
  peligro?: boolean;
}) {
  return (
    <Pulsable
      onPress={alPulsar}
      disabled={desactivado}
      opacidad={desactivado ? 0.45 : 1}
      accessibilityRole="button"
      accessibilityState={{ disabled: desactivado }}
      style={[
        estilos.botonDeTexto,
        estilos.sobreImagen,
        { borderColor: peligro ? media.danger : media.border },
      ]}
    >
      <Text variant="secondary" weight="700" color={peligro ? media.danger : media.text}>
        {texto}
      </Text>
    </Pulsable>
  );
}

/**
 * Cortar la emision. Rojo, con su icono de parar y su palabra.
 *
 * Era un boton de texto con borde, igual que «Empezar ahora»: quien emitia no
 * lo distinguia de los demas. Terminar no se puede deshacer, asi que es el
 * unico boton relleno de la sala, y lleva icono Y palabra para que no haya que
 * adivinar que hace. La confirmacion sigue estando en la maquina.
 */
function BotonDeTerminar({
  texto,
  etiqueta,
  alPulsar,
  desactivado,
}: {
  texto: string;
  etiqueta: string;
  alPulsar: () => void;
  desactivado: boolean;
}) {
  return (
    <Pulsable
      onPress={alPulsar}
      disabled={desactivado}
      opacidad={desactivado ? 0.45 : 1}
      accessibilityRole="button"
      accessibilityLabel={etiqueta}
      accessibilityState={{ disabled: desactivado }}
      // La píldora es baja para no tapar la imagen; el dedo tiene más sitio.
      hitSlop={10}
      style={[estilos.insignia, estilos.terminar, { backgroundColor: rellenoDePeligro.fondo }]}
    >
      <View style={[estilos.punto, { backgroundColor: rellenoDePeligro.texto }]} />
      <Text variant="caption" weight="900" color={rellenoDePeligro.texto}>
        {texto}
      </Text>
    </Pulsable>
  );
}

/** De que va el directo: el titulo que le puso quien lo creo. */
function TemaDeDirecto({ titulo }: { titulo: string }) {
  const { t } = useTranslation();
  const texto = titulo.trim();
  if (!texto) return null;
  return (
    <View
      style={estilos.tema}
      accessible
      accessibilityRole="text"
      accessibilityLabel={t('live.topic', { titulo: texto })}
    >
      <Feather name="radio" size={13} color={TINTA_DEL_TEMA} />
      <Text
        variant="secondary"
        weight="800"
        color={TINTA_DEL_TEMA}
        numberOfLines={1}
        style={estilos.textoDelTema}
      >
        {texto}
      </Text>
    </View>
  );
}

/* -------------------------------------------------------------- Escribir --- */

/**
 * El campo para escribir en el chat.
 *
 * Lleva su propio estado: cada letra repinta este componente y nada mas. Antes
 * el texto era estado de la pantalla, y escribir repintaba el video.
 */
function EscribirEnElChat({
  emisionId,
  alAvisar,
  alGuardar,
}: {
  emisionId: string;
  alAvisar: (texto: string | null) => void;
  /** El mensaje ya esta en el servidor. */
  alGuardar: (mensaje: MensajeDeEmision) => void;
}) {
  const { t } = useTranslation();
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const envios = useRef<number[]>([]);

  const enviar = useCallback(async () => {
    const cuerpo = texto.trim();
    if (!cuerpo || enviando) return;

    const ahora = Date.now();
    if (!puedeEnviarMensaje(envios.current, ahora)) {
      const segundos = Math.max(1, Math.ceil(esperaRestanteMs(envios.current, ahora) / 1000));
      // El freno de verdad esta en el servidor; este solo evita perder el texto
      // contra un 409 que llega cuando el campo ya se ha vaciado.
      alAvisar(`Vas demasiado rápido. Espera ${segundos} s.`);
      return;
    }
    envios.current = registrarEnvio(envios.current, ahora);

    setTexto('');
    alAvisar(null);
    setEnviando(true);
    try {
      /*
        EL POST SOLO ESCRIBE: el mensaje entra por la suscripcion, igual que el
        de cualquier otra persona. Quien recibe `alGuardar` decide si hace falta
        pintarlo desde aqui (solo sin tiempo real).
      */
      alGuardar(await LiveRepository.enviarMensaje(emisionId, cuerpo));
    } catch (error) {
      // Lo escrito vuelve al campo: perder el texto por un limite de ritmo es
      // la forma mas rapida de que alguien deje de escribir.
      setTexto(cuerpo);
      alAvisar(mensajeDeError(error, t('live.sendFailed')));
    } finally {
      setEnviando(false);
    }
  }, [texto, enviando, emisionId, alAvisar, alGuardar, t]);

  const puede = Boolean(texto.trim()) && !enviando;

  return (
    <View style={estilos.filaDeEscritura}>
      <TextInput
        value={texto}
        onChangeText={setTexto}
        onSubmitEditing={() => void enviar()}
        returnKeyType="send"
        placeholder={t('live.messagePlaceholder')}
        placeholderTextColor={media.textMuted}
        accessibilityLabel={t('live.messageLabel')}
        style={[
          estilos.campo,
          { color: media.text, borderColor: media.border },
          SIN_ANILLO_DEL_NAVEGADOR,
        ]}
      />
      <Pulsable
        onPress={() => void enviar()}
        disabled={!puede}
        opacidad={puede ? 1 : 0.55}
        accessibilityLabel={t('chat.sendMessage')}
        accessibilityRole="button"
        accessibilityState={{ disabled: !puede }}
        style={[estilos.botonRedondo, estilos.sobreImagen]}
      >
        <Feather name="send" size={18} color={media.text} />
      </Pulsable>
    </View>
  );
}

/* ------------------------------------------------------------ Pantalla ----- */

export function LiveScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const parametros = useLocalSearchParams<{ id: string }>();
  const emisionId = typeof parametros.id === 'string' ? parametros.id : '';
  const reduceMotion = useReduceMotion();

  const [emision, setEmision] = useState<Emision | null>(null);
  const [errorDeCarga, setErrorDeCarga] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [hojaDeEfectos, setHojaDeEfectos] = useState(false);
  const [hojaDeCalidad, setHojaDeCalidad] = useState(false);
  const [hojaDeInvitados, setHojaDeInvitados] = useState(false);
  const [hojaDeRotulo, setHojaDeRotulo] = useState(false);
  /*
    El rótulo mientras se edita: lo que se ve al momento detrás de la hoja. La
    sala no lo ve hasta «Actualizar el texto»; cerrar sin actualizar lo tira.
  */
  const [borrador, setBorrador] = useState<BorradorDeRotulo | null>(null);
  /** Veces que se ha cambiado el movimiento en la hoja: cada una se ve entrar. */
  const [entradasDelBorrador, setEntradasDelBorrador] = useState(0);
  const claveAlAbrirLaHoja = useRef('');
  const ultimoBorrador = useRef<BorradorDeRotulo | null>(null);
  const [altoDeLaHoja, setAltoDeLaHoja] = useState(0);
  const [altoDelTeclado, setAltoDelTeclado] = useState(0);
  /** El host está arrastrando o pellizcando el texto: la cabecera se apaga. */
  const [moviendoRotulo, setMoviendoRotulo] = useState(false);
  /** El rótulo recién quitado, para «Deshacer». */
  const [rotuloQuitado, setRotuloQuitado] = useState<Rotulo | null>(null);
  /** Lo que miden la pantalla útil, la cabecera y el chat: de ahí sale la zona libre. */
  const [medidasDeLaSala, setMedidasDeLaSala] = useState<{
    lienzo: Caja | null;
    cabecera: Caja | null;
    fila: number | null;
    chat: number | null;
  }>({ lienzo: null, cabecera: null, fila: null, chat: null });
  const insets = useSafeAreaInsets();
  /** La emision termino CON ESTA PERSONA DELANTE, no antes de que entrara. */
  const [terminoMirando, setTerminoMirando] = useState(false);

  const estadoAnterior = useRef<EstadoDeEmision | null>(null);
  const chat = useRef<ChatDeDirectoRef | null>(null);

  const puedeGestionar = emision?.puedeGestionar ?? false;
  const chatAbierto = emision?.estado === 'live';

  /* ------------------------------------------------------------ Cargas ---- */

  const refrescarFicha = useCallback(() => {
    LiveRepository.obtener(emisionId)
      .then((datos) => {
        // La ficha nueva trae los totales del servidor: `ReaccionesDeDirecto`
        // los toma como la verdad y deja de lado lo que llevaba contado.
        setEmision(datos);
      })
      .catch(() => {
        // Lo que ya se sabe de la emision sigue siendo valido: no se borra la
        // pantalla por no haber podido refrescarla.
      });
  }, [emisionId]);

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
        estadoAnterior.current = datos.estado;
      })
      .catch((error) => {
        if (vigente) setErrorDeCarga(mensajeDeError(error, t('live.openFailed')));
      });

    const dejarEstado = suscribirseAlEstado(emisionId, (fila) => {
      const anterior = estadoAnterior.current;
      estadoAnterior.current = fila.status;
      if (anterior === 'live' && fila.status === 'ended') setTerminoMirando(true);
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
      dejarEstado();
    };
    // `t` no entra: cambiar de idioma no puede volver a abrir la emision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emisionId, refrescarFicha]);

  /* --------------------------------------------------------- El chat ------ */

  const alFallarElChat = useCallback((error: unknown, respaldo: string) => {
    setAviso(mensajeDeError(error, respaldo));
  }, []);

  const alGuardarMensaje = useCallback((guardado: MensajeDeEmision) => {
    /*
      Con tiempo real el mensaje entra por la suscripcion, como el de cualquier
      otra persona. La excepcion es no tenerlo (modo demo, sin Supabase
      configurado), donde nadie lo va a entregar y sin esto el chat se quedaria
      mudo con lo que uno mismo escribe.
    */
    if (!hayTiempoReal) chat.current?.anadirPropio(guardado);
  }, []);

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

  const { vista, sesion, pistas, VistaDePista, efectos, calidad } = useSesionDeDirecto({
    emisionId,
    estadoDeSesion: emision?.estado ?? null,
    esAnfitrion: puedeGestionar,
    alCambiarLaFicha,
    avisar: setAviso,
  });

  const terminar = useCallback(() => void sesion.terminar(), [sesion]);
  const empezar = useCallback(() => void sesion.empezar(), [sesion]);

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

  /**
   * Compartir la sala. El enlace lo construye `lib/enlaces` —el mismo sitio
   * que el de una publicacion— y lleva a ESTE directo. Sin direccion de la
   * web configurada sale el texto a secas, que es mejor que una URL rota.
   */
  const compartir = useCallback(() => {
    if (!emision) return;
    const { message } = compartirDirecto({
      emisionId: emision.id,
      anfitrion: emision.anfitrionNombre,
      traducir: t,
    });
    Share.share({ message }).catch(() => {
      // La persona cancelo, o el navegador no expone `navigator.share`.
    });
  }, [emision, t]);

  /** A Inicio, sin dejar la sala debajo: es a donde se va al terminar. */
  const irAInicio = useCallback(() => volverA(router, '/(tabs)/home'), [router]);

  const viendo = useAudienciaDeDirecto({
    emisionId,
    enDirecto: emision?.estado === 'live',
    anfitrionId: emision?.anfitrionId ?? null,
  });

  /*
    El escenario: a quien ha invitado quien emite a salir con su camara, y que
    me pasa a mi. Aqui no se decide nada —lo decide el servidor—; el hook
    pregunta, manda los gestos y le dice a la sesion cuando subir o bajar.
  */
  const alQuitarme = useCallback(() => setAviso(t('live.stageRemovedYou')), [t]);
  const escena = useEscenarioDeDirecto({
    emisionId,
    enDirecto: emision?.estado === 'live',
    gestiono: puedeGestionar,
    anfitrionId: emision?.anfitrionId ?? null,
    sesion,
    alFallar: setAviso,
    alQuitarme,
  });

  /*
    Lo destacado: el mensaje que quien emite ha fijado y el texto que ha puesto
    sobre la imagen. Igual que el escenario, aqui no se decide nada: el hook
    pregunta al servidor y manda los gestos.
  */
  const destacar = useDestacadoDeDirecto({
    emisionId,
    enDirecto: emision?.estado === 'live',
    alFallar: setAviso,
  });
  const { fijado, rotulo } = destacar.destacado;
  /** Quien puede fijar y poner rotulo. Lo dice el servidor, no la ficha. */
  const puedeDestacar = destacar.disponible && destacar.destacado.puedeGestionar;
  /** Y moverlo, girarlo y vestirlo: con la 0114 en el servidor. */
  const puedeMoverRotulo = puedeDestacar && destacar.destacado.rotuloEditable;

  /*
    EL RÓTULO SUELTO (02/11/2026). Se pinta en una capa propia por encima de la
    imagen y por debajo de los botones (`CapaDelRotulo`), dentro de la ZONA
    LIBRE: de la cabecera al chat, medida en este teléfono.
  */
  const medirParte = useCallback(
    <K extends 'lienzo' | 'cabecera' | 'fila' | 'chat'>(
      parte: K,
      valor: (typeof medidasDeLaSala)[K],
    ) => {
      setMedidasDeLaSala((antes) =>
        JSON.stringify(antes[parte]) === JSON.stringify(valor) ? antes : { ...antes, [parte]: valor },
      );
    },
    [],
  );
  const geometriaDelRotulo = useMemo<GeometriaDelRotulo | null>(() => {
    const { lienzo, cabecera, fila, chat } = medidasDeLaSala;
    if (!lienzo || !cabecera || fila === null || chat === null) return null;
    // La cabecera y el chat se miden en la columna; la capa del rótulo cuenta
    // desde su propia esquina. Hoy coinciden (la capa ocupa la columna
    // entera), pero así no depende de cómo se reparta el relleno.
    const enLaCapa: Caja = { ...cabecera, x: cabecera.x - lienzo.x, y: cabecera.y - lienzo.y };
    const medida: Medida = { ancho: lienzo.ancho, alto: lienzo.alto };
    return {
      lienzo: medida,
      zona: zonaLibre({ cabecera: enLaCapa, bordeDelChat: fila + chat - lienzo.y }),
      papelera: papeleraEn(medida, enLaCapa),
    };
  }, [medidasDeLaSala]);

  const abrirHojaDeRotulo = useCallback(() => {
    const puesto = destacar.destacado.rotulo;
    claveAlAbrirLaHoja.current = puesto ? claveDelRotulo(puesto) : 'nuevo';
    setEntradasDelBorrador(0);
    setBorrador({
      texto: puesto?.texto ?? '',
      estilo: puesto?.estilo ?? ESTILO_POR_OMISION,
      presentacion: puesto?.presentacion ?? { ...PRESENTACION_POR_OMISION },
    });
    setRotuloQuitado(null);
    setHojaDeRotulo(true);
  }, [destacar.destacado.rotulo]);

  // Cerrar sin actualizar descarta lo cambiado, como siempre.
  const cerrarHojaDeRotulo = useCallback(() => {
    setHojaDeRotulo(false);
    setBorrador(null);
  }, []);

  const cambiarBorrador = useCallback(
    (nuevo: BorradorDeRotulo, opciones?: { entra?: boolean }) => {
      setBorrador(nuevo);
      if (opciones?.entra) setEntradasDelBorrador((n) => n + 1);
    },
    [],
  );

  /** Quitarlo —papelera o «Quitar»— y ofrecer deshacerlo. */
  const quitarElRotulo = useCallback(async () => {
    const antes = destacar.destacado.rotulo;
    const hecho = await destacar.quitarRotulo();
    if (hecho && antes) setRotuloQuitado(antes);
    return hecho;
  }, [destacar]);

  const deshacerQuitado = useCallback(async () => {
    const vuelve = rotuloQuitado;
    if (!vuelve) return;
    const hecho = await destacar.ponerRotulo(
      vuelve.texto,
      vuelve.estilo,
      destacar.destacado.rotuloEditable ? vuelve.presentacion : null,
    );
    if (hecho) setRotuloQuitado(null);
  }, [destacar, rotuloQuitado]);

  // «Texto quitado · Deshacer» dura seis segundos.
  useEffect(() => {
    if (!rotuloQuitado) return;
    const id = setTimeout(() => setRotuloQuitado(null), DURACION_DEL_AVISO_DE_QUITADO_MS);
    return () => clearTimeout(id);
  }, [rotuloQuitado]);

  // Con la hoja abierta, el teclado la empuja hacia arriba: el texto que
  // tenga que subir para verse sube también eso.
  useEffect(() => {
    if (!hojaDeRotulo) {
      setAltoDelTeclado(0);
      return;
    }
    const alMostrar = Keyboard.addListener('keyboardDidShow', (evento) =>
      setAltoDelTeclado(evento.endCoordinates.height),
    );
    const alOcultar = Keyboard.addListener('keyboardDidHide', () => setAltoDelTeclado(0));
    return () => {
      alMostrar.remove();
      alOcultar.remove();
    };
  }, [hojaDeRotulo]);
  const fijarDesdeElChat = useMemo(
    () => ({
      disponible: puedeDestacar,
      fijadoId: fijado?.id ?? null,
      ocupado: destacar.ocupado,
      fijar: destacar.fijar,
      soltar: destacar.soltar,
      cambioPorFuera: destacar.cambioPorFuera,
    }),
    [
      puedeDestacar,
      fijado?.id,
      destacar.ocupado,
      destacar.fijar,
      destacar.soltar,
      destacar.cambioPorFuera,
    ],
  );

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

  /*
    Que imagenes ocupan la pantalla. Con una sola persona, lo de siempre: la
    propia para quien emite (su vista previa), la de quien emite para quien
    mira. Con invitados, todas, repartidas. Ninguna = no hay imagen y se pinta
    el cartel del estado. Lo decide `elegirPistasDeEscenario`, no esta pantalla.
  */
  const enEscena = ESTADOS_CON_IMAGEN.includes(vista.estado)
    ? elegirPistasDeEscenario(pistas.video, { emito: vista.puedePublicar })
    : [];
  const hayImagen = enEscena.length > 0 && Boolean(VistaDePista);
  const variasEnPantalla = enEscena.length > 1;

  const cartel = cartelDelEstado(vista.estado, emision.puedeGestionar);
  // Con imagen, el estado de la conexion se dice en una linea: la imagen se
  // congela, y sin decirlo parece que el telefono se ha colgado.
  const avisoDeConexion =
    hayImagen && (vista.estado === 'conexion_lenta' || vista.estado === 'reconectando')
      ? t(cartel.titulo as TranslationKey)
      : null;

  const altoDelChat = altoDelChatPara(COMENTARIOS_A_LA_VISTA);
  const enDirecto = emision.estado === 'live';
  const terminada = emision.estado === 'ended';

  /*
    Lo que enseña la capa del rótulo: lo publicado o, con la hoja abierta, el
    borrador. El borrador mantiene la clave con que se abrió —escribir no lo
    hace entrar en cada letra— y solo cambia al elegir otro movimiento.
  */
  const editandoRotulo = hojaDeRotulo && puedeDestacar && borrador !== null;
  // Al cerrar, la hoja se funde con lo último que tenía: sin esto desaparecería
  // de golpe en vez de fundirse.
  if (borrador) ultimoBorrador.current = borrador;
  const borradorDeLaHoja = borrador ?? ultimoBorrador.current;
  const textoDelBorrador = borrador ? limpiarRotulo(borrador.texto) : '';
  const rotuloEnPantalla: Rotulo | null = !destacar.disponible
    ? null
    : editandoRotulo && borrador
      ? textoDelBorrador
        ? {
            texto: textoDelBorrador,
            estilo: borrador.estilo,
            puestoEnIso: null,
            presentacion: borrador.presentacion,
          }
        : null
      : rotulo;
  const claveEnPantalla = editandoRotulo
    ? entradasDelBorrador === 0
      ? claveAlAbrirLaHoja.current
      : `${claveAlAbrirLaHoja.current}|${entradasDelBorrador}`
    : claveDelRotulo(rotulo);
  // Dónde empieza la hoja, en puntos de la pantalla útil (la hoja llega hasta
  // el borde de abajo del teléfono, y no pasa del 80 % de su alto).
  const lienzo = medidasDeLaSala.lienzo;
  const techoDeLaHoja =
    editandoRotulo && lienzo && altoDeLaHoja > 0
      ? lienzo.alto +
        insets.bottom -
        Math.min(altoDeLaHoja, 0.8 * (lienzo.alto + insets.top + insets.bottom)) -
        altoDelTeclado
      : null;

  return (
    <View style={estilos.fondo}>
      {/*
        La imagen, por detras de todo: a pantalla completa con una persona, o
        repartida arriba cuando quien emite ha subido a alguien.
      */}
      {hayImagen && VistaDePista ? (
        <EscenarioDeVideo
          pistas={enEscena}
          VistaDePista={VistaDePista}
          camaraFrontal={vista.camaraFrontal}
          // Mientras la persona no fije una calidad, la elige el proveedor.
          capaAutomatica={calidad.estado.elegida === 'automatica'}
        />
      ) : null}

      {/* Solo se oscurecen las dos franjas donde hay texto encima. */}
      {hayImagen ? <ScrimDeMedio borde="arriba" alto={150} /> : null}
      {/* Con varias personas el chat va DEBAJO de la rejilla, sobre el fondo
          oscuro de la sala: ahi no hay imagen que apagar. */}
      {hayImagen && !variasEnPantalla ? (
        <ScrimDeMedio borde="abajo" alto={altoDelChat + 260} />
      ) : null}

      <SafeAreaView style={estilos.seguro}>
        <SinTecladoDelante style={estilos.columna}>
          {/*
            Cabecera: quien emite, cuanta gente mira y el estado. El TITULO ya
            no va aqui: va abajo, junto al chat (`TemaDeDirecto`). Se mide: la
            zona libre del rotulo empieza debajo. Mientras se mueve el texto,
            se apaga (alli arriba aparece la papelera).
          */}
          <View
            style={moviendoRotulo ? estilos.cabeceraApagada : null}
            pointerEvents={moviendoRotulo ? 'none' : 'auto'}
            onLayout={(evento: LayoutChangeEvent) => {
              const { x, y, width, height } = evento.nativeEvent.layout;
              medirParte('cabecera', { x, y, ancho: width, alto: height });
            }}
          >
            <CabeceraDeDirecto
              emision={emision}
              viendo={viendo}
              sobreImagen={hayImagen}
              alSalir={salir}
              alFallar={setAviso}
              /*
                QUIEN EMITE NO TIENE DOS BOTONES ROJOS, TIENE UNO. Antes veía
                la insignia «EN VIVO» y, debajo, «Terminar»: dos píldoras
                iguales, una encima de la imagen que quiere enseñar. Ahora la
                insignia ES el botón: conserva el punto de «en directo» y dice
                lo que hace al tocarla. Quien mira sigue viendo «EN VIVO».
              */
              insignia={
                puedeGestionar && emision.estado === 'live' ? (
                  <BotonDeTerminar
                    texto={t('live.end')}
                    etiqueta={t('live.endBroadcast')}
                    alPulsar={terminar}
                    desactivado={vista.ocupado}
                  />
                ) : (
                  <Insignia estado={emision.estado} />
                )
              }
            />
          </View>

          {avisoDeConexion ? (
            <View style={estilos.avisoSobreImagen} accessibilityLiveRegion="polite">
              <Text variant="caption" weight="700" color={media.text}>
                {avisoDeConexion}
              </Text>
            </View>
          ) : null}

          {/* Empezar la emision programada. Terminarla va en la cabecera. */}
          {puedeGestionar && emision.estado === 'scheduled' ? (
            <View style={estilos.filaDeGestion}>
              <BotonDeTexto
                texto={t('create.startNow')}
                alPulsar={empezar}
                desactivado={vista.ocupado}
              />
            </View>
          ) : null}

          {/*
            Bajarse del escenario, para quien salio invitado: el boton que
            corta lo propio. Quien emite tiene el suyo —«Terminar»— arriba,
            en la cabecera.
          */}
          {escena.enPantalla && emision.estado === 'live' ? (
            <View style={estilos.filaDeGestion}>
              <BotonDeTexto
                texto={t('live.stageLeave')}
                alPulsar={() => void escena.bajarme()}
                desactivado={escena.ocupado}
              />
            </View>
          ) : null}

          {/* El hueco por el que se ve la emision. Sin imagen, aqui va el cartel. */}
          <View style={estilos.hueco} pointerEvents="box-none">
            {terminada ? (
              <FinDeDirecto
                emision={emision}
                // A quien emitia no se le mueve: acaba de terminar el.
                volverSolo={terminoMirando && !puedeGestionar}
                alIrAInicio={irAInicio}
              />
            ) : hayImagen ? null : (
              <CartelDeVideo emision={emision} estado={vista.estado} />
            )}

            {/*
              La grabacion, para quien emitio (prototipo). Solo pinta algo si el
              servidor tiene la funcion; el enlace lo da el proveedor de video
              unos minutos despues de terminar, y caduca.
            */}
            {terminada && puedeGestionar ? (
              <DescargaDeGrabacion emisionId={emision.id} alFallar={setAviso} />
            ) : null}

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
              <BotonDeTexto texto={t('live.openSettings')} alPulsar={abrirAjustes} />
            ) : vista.estado === 'error_definitivo' ? (
              <BotonDeTexto texto={t('live.retry')} alPulsar={() => sesion.reintentar()} />
            ) : null}

            {/*
              Quien acepto salir y luego no dio el permiso de camara se queda
              sin emitir Y sin ver: la sala no le deja entrar a medias. Tiene
              que poder volver a mirar sin ir a los ajustes.
            */}
            {escena.enPantalla && pideAccionDeLaPersona(vista.estado) ? (
              <BotonDeTexto
                texto={t('live.stageKeepWatching')}
                alPulsar={() => void escena.bajarme()}
                desactivado={escena.ocupado}
              />
            ) : null}

            {/* Quien emite me invita a salir con mi camara. */}
            {escena.meInvitan ? (
              <InvitacionAlEscenario
                anfitrion={emision.anfitrionNombre}
                ocupado={escena.ocupado}
                alAceptar={() => void escena.aceptar()}
                alRechazar={() => void escena.rechazar()}
              />
            ) : null}

            {vista.puedePublicar && !enDirecto ? (
              <BotonDeTexto
                texto={t('live.goLive')}
                alPulsar={empezar}
                desactivado={vista.ocupado}
              />
            ) : null}
          </View>

          {/*
            El texto de quien emite, suelto sobre la imagen. Va DESPUÉS del
            hueco —por encima de lo que se pinta en lugar de la imagen, como el
            cartel de «el video no está disponible», que si no lo tapaba y se
            quedaba con el toque— y ANTES de la fila del chat y los botones,
            que quedan por encima. Con la cabecera no se cruza: su zona empieza
            debajo. Tocarlo abre la hoja; quien gestiona además lo arrastra, lo
            pellizca y lo gira. La sala lo ve moverse cuando se suelta.
          */}
          <CapaDelRotulo
            rotulo={rotuloEnPantalla}
            clave={claveEnPantalla}
            geometria={geometriaDelRotulo}
            puedeMover={puedeMoverRotulo && enDirecto}
            puedeEditar={puedeDestacar && enDirecto}
            editando={editandoRotulo}
            techoDeLaHoja={techoDeLaHoja}
            reduceMotion={reduceMotion}
            etiqueta={
              rotuloEnPantalla
                ? t('live.bannerA11y', {
                    nombre: emision.anfitrionNombre,
                    texto: rotuloEnPantalla.texto,
                  })
                : ''
            }
            pista={
              puedeMoverRotulo
                ? t('live.bannerMoveHint')
                : puedeDestacar
                  ? t('live.bannerEditHint')
                  : undefined
            }
            alTocar={abrirHojaDeRotulo}
            alSoltar={destacar.moverRotulo}
            alTirar={quitarElRotulo}
            alCambiarGesto={setMoviendoRotulo}
            alMedirLienzo={(medida) => medirParte('lienzo', medida)}
          />

          {/*
            Abajo: el chat a la izquierda y los controles de quien emite a la
            derecha. Se miden: la zona libre del rotulo acaba encima del chat
            (con el mensaje fijado, si lo hay).
          */}
          <View
            style={estilos.filaInferior}
            pointerEvents="box-none"
            onLayout={(evento: LayoutChangeEvent) => medirParte('fila', evento.nativeEvent.layout.y)}
          >
            <View
              style={estilos.ladoDelChat}
              onLayout={(evento: LayoutChangeEvent) => medirParte('chat', evento.nativeEvent.layout.y)}
            >
              {/* El mensaje fijado: encima del chat, para que no se lo lleve. */}
              {destacar.disponible && fijado ? (
                <MensajeFijado
                  mensaje={fijado}
                  puedeSoltar={puedeDestacar}
                  ocupado={destacar.ocupado}
                  alSoltar={() => void destacar.soltar()}
                />
              ) : null}
              <ChatDeDirecto
                ref={chat}
                emisionId={emision.id}
                abierto={chatAbierto}
                puedeModerar={puedeGestionar}
                alto={altoDelChat}
                alFallar={alFallarElChat}
                destacar={fijarDesdeElChat}
              />
            </View>
            <View style={estilos.ladoDeAcciones}>
              {/*
                Compartir, para quien emite y para quien mira. Solo en
                directo: un enlace a una sala cerrada no lleva a nada.
              */}
              {enDirecto ? (
                <BotonDeControl
                  icono="share-2"
                  etiqueta={t('live.share')}
                  activo={false}
                  desactivado={false}
                  alPulsar={compartir}
                />
              ) : null}
              {/*
                Invitar a alguien a salir con su camara. Solo para quien
                gestiona, y solo si el servidor dice que se puede: sin la tabla
                de invitados, o con el tope en cero, el boton no existe.
              */}
              {enDirecto && escena.disponible && escena.escenario.puedeInvitar ? (
                <BotonDeControl
                  icono="user-plus"
                  etiqueta={t('live.stageInviteButton')}
                  activo={false}
                  desactivado={false}
                  alPulsar={() => setHojaDeInvitados(true)}
                />
              ) : null}
              {/*
                El texto en pantalla de quien emite. Encendido cuando hay uno
                puesto: asi se sabe sin mirar arriba.
              */}
              {enDirecto && puedeDestacar ? (
                <BotonDeControl
                  icono="type"
                  etiqueta={t('live.bannerButton')}
                  activo={Boolean(rotulo)}
                  desactivado={false}
                  alPulsar={abrirHojaDeRotulo}
                />
              ) : null}
              {/*
                La calidad solo se ofrece si hay capas entre las que elegir
                (Simulcast en la plantilla del proveedor). Sin ellas, no hay
                boton: uno que no cambia nada seria prometer algo que no
                existe.
              */}
              {calidad.estado.opciones.length > 0 ? (
                <BotonDeControl
                  icono="sliders"
                  etiqueta={t('live.quality')}
                  activo={false}
                  desactivado={false}
                  alPulsar={() => setHojaDeCalidad(true)}
                />
              ) : null}
            <ControlesDeAnfitrion
              vista={vista}
              hayEfectos={efectos.capacidad.admitidos}
              efectoPuesto={efectos.estado.efecto.tipo !== 'ninguno'}
              alAlternarCamara={() => void sesion.alternarCamara()}
              alAlternarMicrofono={() => void sesion.alternarMicrofono()}
              alCambiarCamara={() => void sesion.cambiarCamara()}
              alAbrirEfectos={() => setHojaDeEfectos(true)}
            />
            </View>
          </View>

          {aviso ? (
            <View style={estilos.aviso} accessibilityLiveRegion="polite">
              <Text variant="caption" weight="700" color={media.danger} style={estilos.centrado}>
                {aviso}
              </Text>
            </View>
          ) : null}

          {/*
            El tema del directo: debajo de los comentarios y encima de las
            reacciones, con su propio aire para que no se pegue a ninguno.
          */}
          <TemaDeDirecto titulo={emision.titulo} />

          <ReaccionesDeDirecto
            emisionId={emision.id}
            abierto={chatAbierto}
            totalesDelServidor={emision.reacciones}
            reduceMotion={reduceMotion}
          />

          {chatAbierto ? (
            <EscribirEnElChat
              emisionId={emision.id}
              alAvisar={setAviso}
              alGuardar={alGuardarMensaje}
            />
          ) : (
            <Text variant="caption" color={media.textMuted} style={estilos.chatCerrado}>
              {emision.estado === 'scheduled' ? t('live.chatOpensLater') : t('live.chatClosed')}
            </Text>
          )}

          {/* «Texto quitado · Deshacer»: solo para quien lo quitó, seis segundos. */}
          {rotuloQuitado && puedeDestacar && enDirecto ? (
            <AvisoDeRotuloQuitado
              arriba={(geometriaDelRotulo?.zona.arriba ?? 56) + spacing.md}
              ocupado={destacar.ocupado}
              alDeshacer={() => void deshacerQuitado()}
            />
          ) : null}
        </SinTecladoDelante>
      </SafeAreaView>

      <HojaDeEfectos
        visible={hojaDeEfectos}
        alCerrar={() => setHojaDeEfectos(false)}
        capacidad={efectos.capacidad}
        estado={efectos.estado}
        alElegir={efectos.aplicar}
      />
      <HojaDeInvitados
        visible={hojaDeInvitados && escena.disponible && escena.escenario.puedeInvitar}
        alCerrar={() => setHojaDeInvitados(false)}
        escena={escena}
        anfitrionId={emision.anfitrionId}
      />
      {borradorDeLaHoja ? (
        <HojaDeRotulo
          visible={editandoRotulo}
          alCerrar={cerrarHojaDeRotulo}
          destacar={destacar}
          borrador={borradorDeLaHoja}
          alCambiar={cambiarBorrador}
          alQuitar={() => {
            cerrarHojaDeRotulo();
            void quitarElRotulo();
          }}
          alMedirAlto={setAltoDeLaHoja}
        />
      ) : null}
      <HojaDeCalidad
        visible={hojaDeCalidad && calidad.estado.opciones.length > 0}
        alCerrar={() => setHojaDeCalidad(false)}
        estado={calidad.estado}
        alElegir={calidad.elegir}
      />
    </View>
  );
}

/** El estado de la sala, dicho sin adornos. */
function Insignia({ estado }: { estado: EstadoDeEmision }) {
  const { t } = useTranslation();
  if (estado === 'live') {
    return (
      <View style={[estilos.insignia, { backgroundColor: rellenoDeEnVivo.fondo }]}>
        <View style={[estilos.punto, { backgroundColor: rellenoDeEnVivo.texto }]} />
        <Text variant="caption" weight="900" color={rellenoDeEnVivo.texto}>
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
  columna: { flex: 1, paddingHorizontal: spacing.md },
  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  centrado: { textAlign: 'center' },
  botonRedondo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Lo que va encima de la imagen lleva su propio velo: se tiene que leer
  // tambien sobre una camara que apunta a una ventana.
  sobreImagen: { backgroundColor: VELO },
  insignia: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  punto: { width: 6, height: 6, borderRadius: 3 },
  cartel: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  avisoSobreImagen: {
    alignSelf: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  filaDeGestion: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: spacing.xs },
  // `minHeight: 0` deja que el hueco encoja cuando sube el teclado: lo que
  // tiene que caber siempre es lo de abajo.
  hueco: {
    flex: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  filaInferior: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, flexShrink: 1 },
  // Mientras se mueve el texto: arriba está la papelera, y la cabecera se aparta.
  cabeceraApagada: { opacity: 0.12 },
  ladoDelChat: { flex: 1, minWidth: 0, flexShrink: 1 },
  ladoDeAcciones: { gap: spacing.sm, alignItems: 'center' },
  columnaDeControles: { gap: spacing.sm, paddingBottom: spacing.xs },
  // El tema se distingue de los comentarios por el color: ellos van sobre
  // velo oscuro, el va en claro. Y por el aire de arriba y de abajo.
  tema: {
    alignSelf: 'flex-start',
    maxWidth: '88%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 30,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.94)',
  },
  textoDelTema: { flexShrink: 1 },
  // Encima de `insignia`: la misma píldora, un punto más alta porque se toca.
  terminar: { minHeight: 30 },
  botonDeTexto: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  aviso: {
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    marginTop: spacing.xs,
  },
  filaDeEscritura: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  campo: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    // Velo Y borde: el velo lo hace legible sobre la imagen, el borde lo
    // delimita cuando no hay imagen y el fondo es negro.
    borderWidth: 1,
    borderRadius: radius.pill,
    backgroundColor: VELO,
    paddingHorizontal: spacing.lg,
    fontSize: 14,
  },
  chatCerrado: { textAlign: 'center', paddingVertical: spacing.md },
});
