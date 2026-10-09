import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { FlashList, type FlashListRef, type ListRenderItem } from '@shopify/flash-list';
import { Feather } from '@expo/vector-icons';

import { Avatar } from '@/components/Avatar';
import { sobreMedio } from '@/components/CapaDeContraste';
import { AccionesDeMensaje } from '@/components/live/AccionesDeMensaje';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import { useTranslation } from '@/i18n/useTranslation';
import { confirm } from '@/lib/confirm';
import { accionesDeMensaje, type AccionDeMensaje } from '@/live/destacado';
import {
  UMBRAL_DEL_FINAL,
  alDesplazar,
  alLlegarMensajes,
  crearChatEnVivo,
  estadoDelChat,
  mensajesVisibles,
  seguimientoInicial,
  type ChatEnVivo,
  type Seguimiento,
} from '@/live/ventanaDeChat';
import { LiveRepository, type MensajeDeEmision } from '@/repositories/LiveRepository';
import {
  avisosDelChat,
  hayTiempoReal,
  suscribirseAlChat,
  type AvisosDelChat,
  type EstadoDelCanalDeChat,
} from '@/services/directoEnVivo';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';

/**
 * El chat de una emision, encima del video.
 *
 * LO QUE CAMBIO EL 04/10/2026. Era un `ScrollView` con un `.map()` sobre todos
 * los mensajes, dentro de la pantalla: cada mensaje nuevo volvia a pintar
 * todas las filas —y el panel de video, y los botones—, y la lista se
 * arrastraba al final aunque la persona estuviera leyendo mas arriba.
 *
 * Ahora:
 *
 *   - es una lista VIRTUALIZADA (`FlashList`): existen las filas que se ven;
 *   - guarda una VENTANA de los ultimos mensajes, no toda la emision;
 *   - la fila esta memorizada y los mensajes conservan su objeto, asi que un
 *     mensaje nuevo pinta una fila, no todas;
 *   - sigue el final solo si la persona esta al final; si subio a leer, se le
 *     dice cuantos hay nuevos y decide ella;
 *   - el estado del chat —conectando, reconectando, no se pudo leer— se dice.
 *
 * LAS REGLAS NO ESTAN AQUI. Que hacer con una fila que llega, con un autor
 * desconocido o con la lista del servidor lo decide `crearChatEnVivo`
 * (`live/ventanaDeChat.ts`), que no importa React y se prueba con varios
 * clientes. Este componente lo conecta con la suscripcion y lo pinta.
 *
 * Y vive en su propio componente: lo que pasa en el chat ya no repinta la
 * pantalla del directo.
 *
 * NO HAY HISTORIAL INFINITO. Se carga lo que devuelve el servidor (los ultimos
 * 50) y lo que va llegando. Quien entra a un directo quiere saber de que se
 * habla ahora.
 */

/**
 * Espera antes de volver a pedir la lista de mensajes.
 *
 * La fila que llega por Realtime trae `user_id` pero no el nombre, asi que la
 * primera vez que escribe alguien desconocido hay que preguntarle al servidor.
 * El pequeño retraso agrupa la rafaga inicial de una sala que se llena en una
 * sola peticion en vez de una por persona.
 */
const ESPERA_ANTES_DE_RECARGAR_MS = 250;

/**
 * Si el aviso de moderacion no pudo salir (el canal aun no estaba suscrito),
 * se intenta una vez mas pasado este rato. No mas: quien mira lo acabara
 * sabiendo igualmente en su siguiente lectura.
 */
const REINTENTO_DEL_AVISO_MS = 1_500;

export type ChatDeDirectoRef = {
  /**
   * Mete en la lista un mensaje que acaba de enviar esta persona.
   *
   * Solo hace falta SIN tiempo real (modo demo): con el, el mensaje propio
   * entra por la suscripcion como el de cualquiera, y pintarlo desde aqui lo
   * daria dos veces.
   */
  anadirPropio: (mensaje: MensajeDeEmision) => void;
};

type Props = {
  emisionId: string;
  /** La emision esta en directo: el chat admite mensajes. */
  abierto: boolean;
  /** Quien mira puede esconder mensajes (`can_manage` del servidor). */
  puedeModerar: boolean;
  /** Alto de la zona del chat. Lo decide la pantalla segun el telefono. */
  alto: number;
  /** Traduce un fallo del directo a algo legible y lo enseña. */
  alFallar: (error: unknown, respaldo: string) => void;
  /**
   * Fijar mensajes. Sin esto —o con `disponible` a `false`: el servidor aun no
   * lo admite— mantener pulsado solo sirve para ocultar, como siempre.
   */
  destacar?: FijarDesdeElChat;
};

/** Lo que el chat necesita para fijar y soltar. Lo pone `useDestacadoDeDirecto`. */
export type FijarDesdeElChat = {
  disponible: boolean;
  /** El mensaje fijado ahora mismo, o `null`. */
  fijadoId: string | null;
  ocupado: boolean;
  fijar: (mensajeId: string) => Promise<boolean>;
  soltar: () => Promise<boolean>;
  /** Se ha escondido el mensaje que estaba fijado. */
  cambioPorFuera: () => void;
};

/* ------------------------------------------------------------------ Fila --- */

type PropsDeFila = {
  mensaje: MensajeDeEmision;
  puedeModerar: boolean;
  alMantener: (mensaje: MensajeDeEmision) => void;
  pista: string;
};

/**
 * Un mensaje. MEMORIZADA: sus propiedades no cambian mientras no cambie el
 * mensaje, y `alMantener` es la misma funcion durante toda la emision.
 *
 * Fondo translucido propio y no una tarjeta: se lee sobre cualquier imagen y
 * no tapa la emision.
 */
const FilaDeChat = React.memo(function FilaDeChat({
  mensaje,
  puedeModerar,
  alMantener,
  pista,
}: PropsDeFila) {
  const contenido = (
    <>
      <Avatar size={24} image={mensaje.usuarioAvatarUrl} name={mensaje.usuarioNombre} />
      <View style={estilos.globo}>
        <Text variant="secondary" color={sobreMedio.text}>
          <Text variant="secondary" weight="800" color={sobreMedio.textMuted}>
            {mensaje.usuarioNombre}
            {'  '}
          </Text>
          {mensaje.cuerpo}
        </Text>
      </View>
    </>
  );
  const etiqueta = `${mensaje.usuarioNombre}: ${mensaje.cuerpo}`;

  if (!puedeModerar) {
    return (
      <View style={estilos.fila} accessible accessibilityRole="text" accessibilityLabel={etiqueta}>
        {contenido}
      </View>
    );
  }
  return (
    <Pulsable
      onLongPress={() => alMantener(mensaje)}
      delayLongPress={400}
      escala={1}
      accessibilityRole="button"
      accessibilityLabel={etiqueta}
      accessibilityHint={pista}
      style={estilos.fila}
    >
      {contenido}
    </Pulsable>
  );
});

const claveDeMensaje = (mensaje: MensajeDeEmision) => mensaje.id;

/* ------------------------------------------------------------------ Chat --- */

export const ChatDeDirecto = forwardRef<ChatDeDirectoRef, Props>(function ChatDeDirecto(
  { emisionId, abierto, puedeModerar, alto, alFallar, destacar },
  ref,
) {
  const { t } = useTranslation();
  const reduceMotion = useReduceMotion();
  const usuario = useAppStore((estado) => estado.user);

  const [ventana, setVentana] = useState<readonly MensajeDeEmision[]>([]);
  const [carga, setCarga] = useState<'pendiente' | 'lista' | 'fallida'>('pendiente');
  const [canal, setCanal] = useState<EstadoDelCanalDeChat>(hayTiempoReal ? 'conectando' : 'suscrito');
  const [seguimiento, setSeguimiento] = useState<Seguimiento>(seguimientoInicial);

  const chat = useRef<ChatEnVivo | null>(null);
  const avisos = useRef<AvisosDelChat | null>(null);
  /*
    Si la persona esta viendo lo ultimo. Va tambien en una referencia porque
    quien lo consulta —el aviso de que la lista ha crecido— se llama fuera del
    pintado y necesita el valor de AHORA, no el del ultimo render.
  */
  const alFinal = useRef(true);
  const seConectoAntes = useRef(false);
  const listaRef = useRef<FlashListRef<MensajeDeEmision> | null>(null);
  const alFallarRef = useRef(alFallar);
  alFallarRef.current = alFallar;
  /*
    Lo de fijar entra por referencia: `alMantener` tiene que ser la MISMA
    funcion durante toda la emision, o cada cambio de lo destacado volveria a
    pintar todas las filas del chat.
  */
  const destacarRef = useRef(destacar);
  destacarRef.current = destacar;
  /** El mensaje sobre el que se esta eligiendo que hacer. */
  const [elegido, setElegido] = useState<MensajeDeEmision | null>(null);

  const visibles = useMemo(() => mensajesVisibles(ventana), [ventana]);

  /* ---- Un chat por emision: nace con la pantalla y se destruye con ella. ---- */
  useEffect(() => {
    if (!emisionId) return;
    let vigente = true;
    setVentana([]);
    setCarga('pendiente');
    setSeguimiento(seguimientoInicial());
    alFinal.current = true;
    seConectoAntes.current = false;

    const enVivo = crearChatEnVivo({
      leer: () => LiveRepository.listarMensajes(emisionId),
      esperaMs: ESPERA_ANTES_DE_RECARGAR_MS,
      programar: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      ahora: () => Date.now(),
      alCambiar: (siguiente, nuevos) => {
        if (!vigente) return;
        setVentana(siguiente);
        // A quien esta leyendo mas arriba se le cuentan; no se le mueve.
        if (nuevos > 0) setSeguimiento((actual) => alLlegarMensajes(actual, nuevos));
      },
      alLeer: (resultado) => {
        if (!vigente) return;
        // Una lectura fallida despues de una buena no borra lo que ya se ve.
        setCarga((actual) => (resultado === 'fallida' && actual === 'lista' ? actual : resultado));
      },
    });
    chat.current = enVivo;

    void enVivo.cargar();

    /*
      Esconder un mensaje no le llega por la base a quien solo mira (Realtime
      aplica la politica de lectura). Quien modera manda un aviso sin contenido
      por Broadcast, y quien lo recibe vuelve a leer del servidor.
    */
    const avisosDeEsteChat = avisosDelChat(emisionId, () => enVivo.seModero());
    avisos.current = avisosDeEsteChat;

    const dejarChat = suscribirseAlChat(emisionId, enVivo.llegaFila, (estado) => {
      if (!vigente) return;
      setCanal(estado);
      if (estado !== 'suscrito') return;
      // Vuelve despues de una caida: lo que se escribio entre medias no llego
      // por el canal. Una lectura lo recupera.
      if (seConectoAntes.current) enVivo.volvioElCanal();
      seConectoAntes.current = true;
    });

    return () => {
      vigente = false;
      dejarChat();
      avisosDeEsteChat.cerrar();
      if (avisos.current === avisosDeEsteChat) avisos.current = null;
      enVivo.destruir();
      if (chat.current === enVivo) chat.current = null;
    };
  }, [emisionId]);

  /*
    El propio nombre, para que los mensajes de uno aparezcan al instante en vez
    de esperar a la lectura que dispara un autor desconocido.
  */
  useEffect(() => {
    if (usuario?.id) chat.current?.conocerA(usuario.id, usuario.fullName, usuario.avatarUrl);
  }, [usuario?.id, usuario?.fullName, usuario?.avatarUrl, emisionId]);

  useImperativeHandle(
    ref,
    () => ({
      anadirPropio(mensaje) {
        chat.current?.poner(mensaje);
      },
    }),
    [],
  );

  const reintentar = useCallback(() => {
    setCarga('pendiente');
    void chat.current?.cargar();
  }, []);

  /* -------------------------------------------------------- Moderacion ---- */

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
        await LiveRepository.ocultarMensaje(mensaje.id);
        // Tambien llegara por Realtime; se aplica ya para que quien modera vea
        // el efecto en el mismo momento en que lo pide.
        chat.current?.poner({ ...mensaje, oculto: true });
        // Si era el fijado, el servidor ya lo ha soltado: se vuelve a preguntar
        // y se avisa, o seguiria en lo alto de la pantalla de todo el mundo.
        if (destacarRef.current?.fijadoId === mensaje.id) destacarRef.current.cambioPorFuera();
        // Y se avisa a los demas, que no lo van a recibir por la base.
        const emisor = avisos.current;
        if (emisor && !emisor.avisar()) {
          setTimeout(() => {
            if (avisos.current === emisor) emisor.avisar();
          }, REINTENTO_DEL_AVISO_MS);
        }
      } catch (error) {
        alFallarRef.current(error, t('live.hideFailed'));
      }
    },
    [t],
  );

  /**
   * Mantener pulsado un mensaje, para quien modera.
   *
   * Con una sola cosa que hacer —ocultar— se va directo a su confirmacion, que
   * es lo que pasaba siempre. Con dos, primero se elige.
   */
  const alMantener = useCallback(
    (mensaje: MensajeDeEmision) => {
      const acciones = accionesDeMensaje({
        puedeModerar: true,
        puedeDestacar: destacarRef.current?.disponible ?? false,
        mensajeId: mensaje.id,
        fijadoId: destacarRef.current?.fijadoId ?? null,
      });
      if (acciones.length === 1 && acciones[0] === 'ocultar') void ocultar(mensaje);
      else setElegido(mensaje);
    },
    [ocultar],
  );

  const alElegirAccion = useCallback(
    (accion: AccionDeMensaje, mensaje: MensajeDeEmision) => {
      setElegido(null);
      if (accion === 'ocultar') void ocultar(mensaje);
      else if (accion === 'fijar') void destacarRef.current?.fijar(mensaje.id);
      else void destacarRef.current?.soltar();
    },
    [ocultar],
  );

  /* -------------------------------------------------- Seguir el final ----- */

  const alDesplazarLaLista = useCallback((evento: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = evento.nativeEvent;
    const distancia = contentSize.height - layoutMeasurement.height - contentOffset.y;
    alFinal.current = distancia <= UMBRAL_DEL_FINAL;
    setSeguimiento((actual) => alDesplazar(actual, distancia));
  }, []);

  const irAlFinal = useCallback(() => {
    alFinal.current = true;
    listaRef.current?.scrollToEnd({ animated: !reduceMotion });
    setSeguimiento(seguimientoInicial());
  }, [reduceMotion]);

  /*
    La lista ha crecido: ha entrado un mensaje. SE SIGUE EL FINAL SOLO SI LA
    PERSONA YA ESTABA AL FINAL. Antes esto era un `scrollToEnd` sin condicion,
    que arrastraba abajo a quien habia subido a leer.

    POR QUE AQUI, si `maintainVisibleContentPosition` ya sigue el final. La
    lista decide «esta cerca del final» con SU umbral (una fraccion del alto
    visible) y este componente decide «esta al final» con el suyo
    (`UMBRAL_DEL_FINAL`), que es el que usa para contar los «N nuevos». Si solo
    siguiera la lista, entre los dos umbrales quedaria una franja en la que un
    mensaje ni se sigue ni se cuenta: llega y nadie se entera. Con esto, seguir
    y contar salen de la misma pregunta. Cuando los dos coinciden, la lista
    recibe la misma orden dos veces, que no hace nada.
  */
  const alCrecerLaLista = useCallback(() => {
    if (alFinal.current) listaRef.current?.scrollToEnd({ animated: !reduceMotion });
  }, [reduceMotion]);

  /*
    Al pintarse por primera vez la lista se coloca en el ULTIMO mensaje, sin
    animacion. `startRenderingFromBottom` la deja cerca, pero calcula con
    alturas estimadas: con mensajes de dos lineas el ultimo quedaba cortado
    (visto en el navegador el 04/10/2026).
  */
  const alPintarPorPrimeraVez = useCallback(() => {
    listaRef.current?.scrollToEnd({ animated: false });
  }, []);

  /* ----------------------------------------------------------- Pintado ---- */

  const puedeFijar = puedeModerar && Boolean(destacar?.disponible);
  const pista = t(puedeFijar ? 'live.holdForActions' : 'live.holdToHide');
  const pintarFila = useCallback<ListRenderItem<MensajeDeEmision>>(
    ({ item }) => (
      <FilaDeChat mensaje={item} puedeModerar={puedeModerar} alMantener={alMantener} pista={pista} />
    ),
    [puedeModerar, alMantener, pista],
  );

  const estado = estadoDelChat({
    abierto,
    carga,
    canal,
    seConectoAntes: seConectoAntes.current,
  });

  const etiquetaDeNuevos =
    seguimiento.nuevos === 1
      ? t('live.newMessageOne')
      : t('live.newMessages', { n: seguimiento.nuevos });

  const seguirElFinal = useMemo(
    () => ({
      // Solo arrastra al final a quien ya estaba al final.
      autoscrollToBottomThreshold: 0.2,
      animateAutoScrollToBottom: !reduceMotion,
      // Con pocos mensajes, pegados abajo: junto al campo donde se escribe.
      startRenderingFromBottom: true,
    }),
    [reduceMotion],
  );

  return (
    <View style={[estilos.zona, { height: alto }]}>
      {estado === 'conectando' || estado === 'reconectando' ? (
        <View style={estilos.estado} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={sobreMedio.textMuted} />
          <Text variant="caption" weight="700" color={sobreMedio.textMuted}>
            {estado === 'conectando' ? t('live.chatConnecting') : t('live.chatReconnecting')}
          </Text>
        </View>
      ) : null}

      {estado === 'error' ? (
        <View style={estilos.estado} accessibilityLiveRegion="polite">
          <Text variant="caption" weight="700" color={sobreMedio.text}>
            {t('chat.loadFailed')}
          </Text>
          <Pulsable
            onPress={reintentar}
            accessibilityRole="button"
            hitSlop={10}
            style={estilos.reintentar}
          >
            <Text variant="caption" weight="800" color={sobreMedio.text}>
              {t('live.retry')}
            </Text>
          </Pulsable>
        </View>
      ) : null}

      {visibles.length === 0 ? (
        carga === 'lista' ? (
          <View style={estilos.vacio}>
            <Text variant="caption" color={sobreMedio.textMuted}>
              {abierto ? t('live.chatEmptyOpen') : t('live.chatEmptyClosed')}
            </Text>
          </View>
        ) : null
      ) : (
        <View style={estilos.lista}>
          <FlashList
            ref={listaRef}
            data={visibles as MensajeDeEmision[]}
            renderItem={pintarFila}
            keyExtractor={claveDeMensaje}
            maintainVisibleContentPosition={seguirElFinal}
            onLoad={alPintarPorPrimeraVez}
            onContentSizeChange={alCrecerLaLista}
            onScroll={alDesplazarLaLista}
            scrollEventThrottle={64}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={estilos.contenido}
          />
        </View>
      )}

      {seguimiento.nuevos > 0 ? (
        <Pulsable
          onPress={irAlFinal}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={etiquetaDeNuevos}
          style={estilos.nuevos}
        >
          <Feather name="arrow-down" size={14} color={sobreMedio.background} />
          <Text variant="caption" weight="800" color={sobreMedio.background}>
            {etiquetaDeNuevos}
          </Text>
        </Pulsable>
      ) : null}

      {puedeModerar ? (
        <AccionesDeMensaje
          mensaje={elegido}
          acciones={
            elegido
              ? accionesDeMensaje({
                  puedeModerar,
                  puedeDestacar: puedeFijar,
                  mensajeId: elegido.id,
                  fijadoId: destacar?.fijadoId ?? null,
                })
              : []
          }
          ocupado={destacar?.ocupado ?? false}
          alElegir={alElegirAccion}
          alCerrar={() => setElegido(null)}
        />
      ) : null}
    </View>
  );
});

/**
 * Lo que ocupa una fila de UNA linea: el globo —la linea del texto y su
 * relleno— mas el aire de la fila. Sale de los estilos de abajo; si cambian,
 * cambia con ellos (lo vigila `pantallaDeDirecto.test.mts`).
 */
const LINEA_DEL_TEXTO = 18.2;
const RELLENO_DEL_GLOBO = 5;
const AIRE_DE_LA_FILA = 3;
const ALTO_DE_UNA_FILA = LINEA_DEL_TEXTO + RELLENO_DEL_GLOBO * 2 + AIRE_DE_LA_FILA * 2;

/**
 * El alto de la zona del chat para que se vean `filas` comentarios.
 *
 * La pantalla pide FILAS y no puntos: «que se vean cuatro» es la decision de
 * producto, y cuanto mide una fila solo lo sabe este fichero.
 */
export function altoDelChatPara(filas: number): number {
  return Math.ceil(filas * ALTO_DE_UNA_FILA + spacing.xs * 2);
}

const estilos = StyleSheet.create({
  // Encoge si no cabe (teclado abierto en un telefono pequeno) antes que
  // empujar fuera de la pantalla el campo donde se escribe.
  zona: { justifyContent: 'flex-end', flexShrink: 1, minHeight: 96 },
  lista: { flex: 1 },
  contenido: { paddingVertical: spacing.xs },
  fila: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    paddingVertical: AIRE_DE_LA_FILA,
  },
  globo: {
    flexShrink: 1,
    backgroundColor: 'rgba(0,0,0,0.38)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: RELLENO_DEL_GLOBO,
  },
  estado: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    marginBottom: spacing.xs,
  },
  reintentar: { minHeight: 28, justifyContent: 'center', paddingHorizontal: spacing.xs },
  vacio: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0,0,0,0.38)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    marginBottom: spacing.xs,
  },
  nuevos: {
    position: 'absolute',
    bottom: spacing.xs,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 32,
    backgroundColor: sobreMedio.text,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
  },
});
