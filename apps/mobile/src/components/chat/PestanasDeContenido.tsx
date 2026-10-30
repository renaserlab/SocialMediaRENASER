import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { BurbujaDeNotaDeVoz } from '@/components/BurbujaDeNotaDeVoz';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { ArchivoDeChat } from '@/components/chat/ArchivoDeChat';
import { MedioDeChat } from '@/components/chat/MedioDeChat';
import { Chip } from '@/components/Chip';
import { VisorDeAdjunto, type AccionDeVisor } from '@/components/chat/VisorDeAdjunto';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { TextoConEnlaces } from '@/components/TextoConEnlaces';
import { useMensajesDeVista } from '@/hooks/useMensajesDeVista';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { afterSheetClose } from '@/lib/afterSheetClose';
import { notify } from '@/lib/confirm';
import {
  adjuntosDe,
  columnasDeRejilla,
  direccionesDe,
  enFilasDe,
  nombreDeSitio,
  sitioDe,
  teselasDe,
  type Tesela,
} from '@/lib/contenidoDeChat';
import { rutaInternaDe } from '@/lib/enlaces';
import { partirEnEnlaces } from '@/lib/enlacesEnTexto';
import { pedirSalto } from '@/lib/saltoDeChat';
import { medioQueEs } from '@/lib/mediosDeChat';
import { claveDelFalloDeGrupo } from '@/lib/gruposDeChat';
import { alternarSeleccion, claveDelFalloDeAgregarVarios } from '@/lib/nombresDeAdjuntos';
import { claveDelFalloDeTemas, type TemaDeGrupo } from '@/lib/temasDeGrupo';
import { toast } from '@/lib/toast';
import {
  FILTRO_DE_TEMA_TODOS,
  SIN_VISTAS,
  categoriaDeVista,
  claveDeFiltroDeTema,
  cuentaDeCategoria,
  filtroDeTemaVigente,
  huellaDeCriterios,
  opcionesDeMedia,
  seccionesDeContenido,
  vistaDeSeccion,
  type CuentasDeTemas,
  type FiltroDeTema,
  type SeccionDeContenido,
  type SoloDeMedia,
  type VistasDeChat,
} from '@/lib/vistasDeChat';
import { MessageRepository, type MensajeDeVista } from '@/repositories/MessageRepository';
import { MAX_MENSAJES_POR_LOTE, TemasRepository } from '@/repositories/TemasRepository';
import { ApiError } from '@/services/api';
import { avisosDeTemas } from '@/services/realtime';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

/** El hueco entre teselas de la cuadrícula. */
const HUECO = 2;

const NOMBRE_DE_SECCION: Record<'media' | 'link' | 'document' | 'audio', TranslationKey> = {
  media: 'chatViews.media',
  link: 'chatViews.links',
  document: 'chatViews.documents',
  audio: 'chatViews.audios',
};

const VACIO_DE_SECCION: Record<'media' | 'link' | 'document' | 'audio', TranslationKey> = {
  media: 'chatViews.emptyMedia',
  link: 'chatViews.emptyLinks',
  document: 'chatViews.emptyDocuments',
  audio: 'chatViews.emptyAudios',
};

const NOMBRE_DE_SOLO: Record<SoloDeMedia, TranslationKey> = {
  todo: 'chatViews.all',
  image: 'chatViews.images',
  video: 'chatViews.videos',
};

type UnaTesela = Tesela<MensajeDeVista>;

/** Una fila de la lista: lo que cambia de una sección a otra es qué es cada fila. */
type Fila =
  | { tipo: 'propia'; clave: string }
  | { tipo: 'medios'; clave: string; teselas: UnaTesela[] }
  | { tipo: 'enlace'; clave: string; mensaje: MensajeDeVista; direcciones: string[] }
  | { tipo: 'archivo'; clave: string; mensaje: MensajeDeVista; adjunto: MessageAttachment }
  | { tipo: 'audio'; clave: string; mensaje: MensajeDeVista; adjunto: MessageAttachment }
  | { tipo: 'mensaje'; clave: string; mensaje: MensajeDeVista };

function fechaLegible(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  const dia = fecha.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const hora = fecha.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${dia} · ${hora}`;
}

type Props = {
  conversationId: string;
  /** El nombre del chat: para volver a él con «Ver en el chat». */
  nombreDelChat?: string;
  /** Lo que va arriba y se desplaza con el contenido: la ficha del grupo. */
  cabecera?: React.ReactElement | null;
  /**
   * Una pestaña de quien lo usa, delante de las del contenido. En un grupo son
   * sus miembros.
   */
  primera?: { clave: string; etiqueta: string; contenido: React.ReactElement };
  /** Se tiró hacia abajo: para que quien lo usa refresque también lo suyo. */
  alRefrescar?: () => void;
  /**
   * General de una comunidad con temas (audios y temas, 30/10/2026): la fila
   * «Tema» para filtrar y, para quien administra, elegir varios con una
   * pulsación larga y agregarlos a un tema de una vez. Sin esto, todo como
   * antes.
   */
  temasDelGrupo?: { grupoId: string; puedoAdministrar: boolean } | null;
};

/**
 * El contenido compartido de un chat, por pestañas, como en cualquier
 * mensajería: «Media» (fotos y vídeos en una cuadrícula), «Enlaces»,
 * «Archivos», «Audios» y, en un grupo, sus filtros.
 *
 * SOLO SE OFRECE LO QUE HAY. Si nadie ha mandado un audio no hay pestaña de
 * audios: una pestaña que siempre sale vacía es un botón muerto. Qué entra en
 * cada una lo decide el servidor; aquí no se filtra nada de lo ya descargado.
 *
 * ES UNA SOLA LISTA. La cabecera, las pestañas y el contenido se desplazan
 * juntos, y la cuadrícula se pinta por filas de teselas: así la lista no se
 * desmonta al cambiar de pestaña, que es lo que haría cambiarle las columnas.
 */
export function PestanasDeContenido({
  conversationId,
  nombreDelChat,
  cabecera,
  primera,
  alRefrescar,
  temasDelGrupo = null,
}: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const currentUserId = useAppStore((state) => state.user?.id ?? null);

  const [vistas, setVistas] = useState<VistasDeChat>(SIN_VISTAS);
  const [vistasLeidas, setVistasLeidas] = useState(false);
  const [elegida, setElegida] = useState<string | null>(primera?.clave ?? null);
  const [solo, setSolo] = useState<SoloDeMedia>('todo');
  const [ampliado, setAmpliado] = useState<UnaTesela | null>(null);
  const [audioSonando, setAudioSonando] = useState<string | null>(null);

  const leerVistas = useCallback(() => {
    if (!conversationId) return;
    void MessageRepository.vistas(conversationId).then((leidas) => {
      setVistas(leidas);
      setVistasLeidas(true);
    });
  }, [conversationId]);

  // Las cuentas y los filtros, al entrar y al volver a esta pantalla.
  useFocusEffect(
    useCallback(() => {
      leerVistas();
    }, [leerVistas]),
  );

  const secciones = useMemo(() => seccionesDeContenido(vistas, elegida), [vistas, elegida]);

  // La pestaña abierta: la elegida si sigue existiendo; si no, la primera que
  // haya. Deja de existir cuando quien administra borra el filtro que se miraba.
  const abierta =
    elegida !== null && (elegida === primera?.clave || secciones.some((s) => s.clave === elegida))
      ? elegida
      : primera?.clave ?? secciones[0]?.clave ?? null;
  const seccion = secciones.find((s) => s.clave === abierta) ?? null;

  const opciones = useMemo(() => opcionesDeMedia(vistas), [vistas]);
  // Lo elegido dentro de «Media» solo vale mientras se siga ofreciendo.
  const soloVigente: SoloDeMedia = opciones.includes(solo) ? solo : opciones[0] ?? 'todo';

  const vista = seccion ? vistaDeSeccion(seccion, vistas, soloVigente) : null;

  /*
    LA FILA «TEMA» (audios y temas, 30/10/2026). Solo en General de una
    comunidad con temas y en una sección que es una categoría (no en los
    filtros del grupo): el servidor cuenta por categoría. Sin respuesta o con
    una API anterior no hay fila, y la sección se ve como siempre.
  */
  const categoria = temasDelGrupo ? categoriaDeVista(vista) : null;
  const [cuentasDeTemas, setCuentasDeTemas] = useState<CuentasDeTemas | null>(null);
  const [filtroDeTema, setFiltroDeTema] = useState<FiltroDeTema>(FILTRO_DE_TEMA_TODOS);
  const leerTemasDeLaSeccion = useCallback(() => {
    if (!conversationId || !categoria) {
      setCuentasDeTemas(null);
      return;
    }
    void MessageRepository.temasDeVista(conversationId, categoria).then(setCuentasDeTemas);
  }, [conversationId, categoria]);
  useEffect(() => {
    leerTemasDeLaSeccion();
  }, [leerTemasDeLaSeccion]);
  // Un tema que desaparece de la fila deja de filtrar: se vuelve a «Todos».
  const filtroVigente = filtroDeTemaVigente(filtroDeTema, cuentasDeTemas);
  const hayFilaDeTemas = !!cuentasDeTemas && cuentasDeTemas.temas.length > 0;

  const alHaberCambios = useCallback(() => {
    leerVistas();
    leerTemasDeLaSeccion();
  }, [leerVistas, leerTemasDeLaSeccion]);

  const { mensajes, cargando, cargandoMas, refrescando, fallo, cargarMas, refrescar, reintentar } =
    useMensajesDeVista(conversationId, vista, {
      currentUserId,
      huella: seccion?.tipo === 'filtro' ? huellaDeCriterios(seccion.filtro) : '',
      alHaberCambios,
      tema: hayFilaDeTemas ? filtroVigente : FILTRO_DE_TEMA_TODOS,
    });

  /*
    ELEGIR VARIOS, solo quien administra la comunidad: una pulsación larga
    empieza la selección, cada toque marca o desmarca, y «Agregar N a un
    tema» los agrega de una vez (`PUT` por lotes). Sin ninguno marcado se
    sale sola. El permiso es del servidor; esto evita ofrecer un 403.
  */
  // Y solo si el servidor contó los temas de la sección: una API sin el `PUT`
  // por lotes tampoco tiene `views/topics`, y así nunca se ofrece elegir.
  const puedeElegir = !!temasDelGrupo?.puedoAdministrar && cuentasDeTemas !== null;
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const seleccionando = seleccion.length > 0;
  const [eligiendoTema, setEligiendoTema] = useState(false);
  const alternar = useCallback(
    (mensajeId: string) =>
      setSeleccion((actual) =>
        // El servidor acepta hasta cincuenta de una vez: no se deja pasar.
        !actual.includes(mensajeId) && actual.length >= MAX_MENSAJES_POR_LOTE
          ? actual
          : alternarSeleccion(actual, mensajeId),
      ),
    [],
  );
  /** La pulsación larga que empieza a elegir, o nada si no se puede. */
  const mantenerPara = (mensaje: MensajeDeVista) =>
    puedeElegir && !seleccionando ? () => alternar(mensaje.id) : undefined;

  // Al cambiar de pestaña no sigue sonando el audio de la anterior, ni queda
  // un filtro de tema ni una selección que eran de la otra.
  useEffect(() => {
    setAudioSonando(null);
    setFiltroDeTema(FILTRO_DE_TEMA_TODOS);
    setSeleccion([]);
  }, [abierta]);

  const columnas = columnasDeRejilla(width);
  const lado = Math.floor((width - HUECO * (columnas - 1)) / columnas);

  const filas = useMemo<Fila[]>(() => {
    if (primera && abierta === primera.clave) return [{ tipo: 'propia', clave: primera.clave }];
    if (!seccion) return [];
    if (seccion.tipo === 'media') {
      // Con «Fotos» o «Vídeos» elegido se quitan los otros: un mensaje con las
      // dos cosas llega entero a las dos vistas.
      return enFilasDe(teselasDe(mensajes, soloVigente), columnas).map((teselas) => ({
        tipo: 'medios',
        clave: teselas[0]?.clave ?? '',
        teselas,
      }));
    }
    if (seccion.tipo === 'link') {
      // TODOS los que manda el servidor. Si aquí no se reconoce el enlace de
      // alguno, se enseña igual, con su texto: esconderlo dejaría la pestaña
      // diciendo que hay menos de lo que hay.
      return mensajes.map((mensaje) => ({
        tipo: 'enlace',
        clave: mensaje.id,
        mensaje,
        direcciones: direccionesDe(partirEnEnlaces(mensaje.texto)),
      }));
    }
    if (seccion.tipo === 'document') {
      return adjuntosDe(mensajes, 'document').map((tesela) => ({
        tipo: 'archivo',
        clave: tesela.clave,
        mensaje: tesela.mensaje,
        adjunto: tesela.adjunto,
      }));
    }
    if (seccion.tipo === 'audio') {
      return adjuntosDe(mensajes, 'audio').map((tesela) => ({
        tipo: 'audio',
        clave: tesela.clave,
        mensaje: tesela.mensaje,
        adjunto: tesela.adjunto,
      }));
    }
    return mensajes.map((mensaje) => ({ tipo: 'mensaje', clave: mensaje.id, mensaje }));
  }, [primera, abierta, seccion, mensajes, soloVigente, columnas]);

  /*
    VER EL MENSAJE EN SU SITIO. Se deja el encargo y se vuelve al chat que
    está abierto debajo, que lo recoge al recuperar el foco y sube hasta el
    mensaje. `dismissTo` cierra las pantallas de en medio; si no hubiera un
    chat debajo, lo abre.
  */
  const irAlMensaje = useCallback(
    (mensaje: MensajeDeVista) => {
      if (!conversationId) return;
      pedirSalto(conversationId, mensaje.id);
      router.dismissTo({
        pathname: '/chat/[id]',
        params: nombreDelChat
          ? { id: conversationId, name: nombreDelChat }
          : { id: conversationId },
      });
    },
    [conversationId, nombreDelChat, router],
  );

  const abrirEnlace = useCallback(
    (direccion: string) => {
      // Un enlace de Z se abre DENTRO de la aplicación; los demás, fuera.
      const ruta = rutaInternaDe(direccion);
      if (ruta) {
        router.push(ruta as never);
        return;
      }
      Linking.openURL(direccion).catch(() => {
        notify(t('common.couldNotOpen'), t('common.tryAgainSoon'));
      });
    },
    [router, t],
  );

  /**
   * Qué hace tocar un archivo que en realidad es una foto o un video: verlo
   * en el visor. Para los demás devuelve `undefined`, y tocarlo lo descarga
   * dentro de la aplicación (ver `ArchivoDeChat`). Ya no se abre nada en el
   * navegador.
   */
  const verSiEsMedio = (clave: string, mensaje: MensajeDeVista, adjunto: MessageAttachment) => {
    const medio = adjunto.url ? medioQueEs(adjunto.mimeType, adjunto.fileName) : null;
    return medio
      ? () => setAmpliado({ clave, mensaje, adjunto: { ...adjunto, kind: medio } })
      : undefined;
  };

  const quien = (mensaje: MensajeDeVista) =>
    mensaje.mio ? t('chatViews.you') : mensaje.autor.nombre;

  /** El círculo que dice si está elegido: lleno con ✓, o vacío. */
  const marcaDeSeleccion = (mensajeId: string, encima = false) => {
    const marcado = seleccion.includes(mensajeId);
    return (
      <View
        pointerEvents="none"
        style={[
          styles.marca,
          encima && styles.marcaEncima,
          marcado
            ? { backgroundColor: colors.primary, borderColor: colors.primary }
            : { backgroundColor: colors.background, borderColor: colors.border },
        ]}
      >
        {marcado ? <Feather name="check" size={13} color={colors.onPrimary} /> : null}
      </View>
    );
  };

  /**
   * Mientras se elige, una fila entera es un solo toque que la marca. Va
   * ENCIMA del contenido y como hermana suya (nunca envolviéndolo): en la
   * web un botón dentro de otro rompe la página, y los de dentro (el play,
   * la descarga) no deben responder mientras se elige.
   */
  const capaDeSeleccion = (mensaje: MensajeDeVista) =>
    seleccionando ? (
      <Pressable
        onPress={() => alternar(mensaje.id)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: seleccion.includes(mensaje.id) }}
        accessibilityLabel={t('contentTopics.selectItem', { autor: quien(mensaje) })}
        style={StyleSheet.absoluteFill}
      />
    ) : null;

  /** Los temas de una fila: «# Meditaciones», o «Sin tema» si hay fila y no está en ninguno. */
  const temasDeLaFila = (mensaje: MensajeDeVista) => {
    if (!temasDelGrupo) return null;
    if (mensaje.temas.length === 0) {
      return hayFilaDeTemas ? (
        <View style={styles.temasDeLaFila}>
          <View style={[styles.temaDeLaFila, styles.sinTema, { borderColor: colors.textMuted }]}>
            <Text weight="600" color={colors.textMuted} style={styles.temaDeLaFilaTexto}>
              {t('contentTopics.noTopic')}
            </Text>
          </View>
        </View>
      ) : null;
    }
    return (
      <View style={styles.temasDeLaFila}>
        {mensaje.temas.map((tema) => (
          <View
            key={tema.id}
            style={[styles.temaDeLaFila, { backgroundColor: colors.tarjetaRelleno }]}
          >
            <Feather name="hash" size={11} color={colors.text} />
            <Text weight="600" numberOfLines={1} style={styles.temaDeLaFilaTexto}>
              {tema.nombre}
            </Text>
          </View>
        ))}
      </View>
    );
  };

  const botonDeIrAlChat = (mensaje: MensajeDeVista) => seleccionando ? null : (
    <Pressable
      onPress={() => irAlMensaje(mensaje)}
      accessibilityRole="button"
      accessibilityLabel={t('chatViews.goToMessage')}
      hitSlop={10}
      style={styles.irAlChat}
    >
      <Feather name="corner-up-right" size={16} color={colors.textMuted} />
    </Pressable>
  );

  const pintarTesela = (tesela: UnaTesela, indice: number) => {
    const { adjunto } = tesela;
    const esVideo = adjunto.kind === 'video';
    return (
      <Pressable
        key={tesela.clave}
        onPress={() => {
          if (seleccionando) {
            alternar(tesela.mensaje.id);
            return;
          }
          // Fotos y vídeos se ven DENTRO, en el mismo visor que en el chat.
          if (adjunto.url) setAmpliado(tesela);
        }}
        onLongPress={mantenerPara(tesela.mensaje)}
        delayLongPress={400}
        accessibilityRole={seleccionando ? 'checkbox' : 'button'}
        accessibilityState={
          seleccionando ? { checked: seleccion.includes(tesela.mensaje.id) } : undefined
        }
        accessibilityLabel={esVideo ? t('chat.viewVideo') : t('chat.viewPhoto')}
        style={[
          styles.tesela,
          { width: lado, height: lado, marginLeft: indice === 0 ? 0 : HUECO },
        ]}
      >
        {/*
          La misma pieza que la burbuja del chat: lo que ya se vio allí sale
          aquí del disco sin volver a bajarlo, y un video enseña su portada
          en vez de un cuadro negro.
        */}
        <MedioDeChat adjunto={adjunto} compacto style={StyleSheet.absoluteFill} />
        {seleccionando ? marcaDeSeleccion(tesela.mensaje.id, true) : null}
      </Pressable>
    );
  };

  const pintarFila = ({ item }: { item: Fila }) => {
    if (item.tipo === 'propia') return primera?.contenido ?? null;

    if (item.tipo === 'medios') {
      return <View style={styles.filaDeTeselas}>{item.teselas.map(pintarTesela)}</View>;
    }

    if (item.tipo === 'enlace') {
      const primeraDireccion = item.direcciones[0];
      const nombre = nombreDeSitio(sitioDe(primeraDireccion)) || t('chatViews.links');
      return (
        <Pressable
          // Sin una dirección que abrir, la fila lleva al mensaje.
          onPress={() =>
            seleccionando
              ? alternar(item.mensaje.id)
              : primeraDireccion
                ? abrirEnlace(primeraDireccion)
                : irAlMensaje(item.mensaje)
          }
          onLongPress={mantenerPara(item.mensaje)}
          delayLongPress={400}
          accessibilityRole="button"
          accessibilityLabel={primeraDireccion ? `${nombre}. ${primeraDireccion}` : nombre}
          accessibilityHint={primeraDireccion ? t('chat.openLink') : t('chatViews.goToMessage')}
          style={[styles.fila, { borderBottomColor: colors.border }]}
        >
          {seleccionando ? marcaDeSeleccion(item.mensaje.id) : null}
          <View style={[styles.sitio, { backgroundColor: colors.surfaceAlt }]}>
            <Text weight="700" color={colors.textMuted} style={styles.inicial}>
              {nombre.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={styles.cuerpo}>
            <View style={styles.titular}>
              <Text weight="700" numberOfLines={1} style={styles.nombre}>
                {nombre}
              </Text>
              {botonDeIrAlChat(item.mensaje)}
            </View>
            <Text numberOfLines={3} style={styles.textoDeEnlace}>
              {item.mensaje.texto.trim()}
            </Text>
            {item.direcciones.map((direccion) => (
              <Text
                key={direccion}
                numberOfLines={1}
                onPress={() => abrirEnlace(direccion)}
                style={[styles.direccion, { color: colors.enlace }]}
              >
                {direccion}
              </Text>
            ))}
            <Text color={colors.textMuted} numberOfLines={1} style={styles.detalle}>
              {`${quien(item.mensaje)} · ${fechaLegible(item.mensaje.fechaIso)}`}
            </Text>
          </View>
        </Pressable>
      );
    }

    if (item.tipo === 'archivo') {
      return (
        <View style={[styles.fila, styles.filaDeArchivo, { borderBottomColor: colors.border }]}>
          {seleccionando ? marcaDeSeleccion(item.mensaje.id) : null}
          <View style={styles.cuerpo}>
            {/* El mismo archivo que en la burbuja, con su botón de descargar. */}
            <ArchivoDeChat
              adjunto={item.adjunto}
              style={styles.archivoDeMensaje}
              pie={[quien(item.mensaje), fechaLegible(item.mensaje.fechaIso)]
                .filter(Boolean)
                .join(' · ')}
              alVer={verSiEsMedio(item.clave, item.mensaje, item.adjunto)}
              alMantener={mantenerPara(item.mensaje)}
            />
            {temasDeLaFila(item.mensaje)}
          </View>
          {botonDeIrAlChat(item.mensaje)}
          {capaDeSeleccion(item.mensaje)}
        </View>
      );
    }

    if (item.tipo === 'audio') {
      return (
        <View style={[styles.filaDeAudio, { borderBottomColor: colors.border }]}>
          <View style={styles.titular}>
            {seleccionando ? marcaDeSeleccion(item.mensaje.id) : null}
            <Avatar size={24} image={item.mensaje.autor.avatarUrl ?? null} name={item.mensaje.autor.nombre} />
            <Text weight="700" numberOfLines={1} style={styles.autor}>
              {quien(item.mensaje)}
            </Text>
            <Text color={colors.textMuted} numberOfLines={1} style={styles.detalle}>
              {fechaLegible(item.mensaje.fechaIso)}
            </Text>
            {botonDeIrAlChat(item.mensaje)}
          </View>
          <View style={[styles.audio, { backgroundColor: colors.surface }]}>
            <BurbujaDeNotaDeVoz
              adjunto={item.adjunto}
              mio={false}
              activo={audioSonando === item.adjunto.id}
              alPulsar={() =>
                setAudioSonando((actual) => (actual === item.adjunto.id ? null : item.adjunto.id))
              }
              alTerminar={() =>
                setAudioSonando((actual) => (actual === item.adjunto.id ? null : actual))
              }
              alMantener={mantenerPara(item.mensaje)}
            />
          </View>
          {temasDeLaFila(item.mensaje)}
          {capaDeSeleccion(item.mensaje)}
        </View>
      );
    }

    // Un filtro del grupo puede traer cualquier cosa: se enseña el mensaje.
    const { mensaje } = item;
    const medios = teselasDe([mensaje]);
    const archivos = adjuntosDe([mensaje], 'document');
    return (
      <View style={[styles.filaDeAudio, { borderBottomColor: colors.border }]}>
        <View style={styles.titular}>
          <Avatar size={24} image={mensaje.autor.avatarUrl ?? null} name={mensaje.autor.nombre} />
          <Text weight="700" numberOfLines={1} style={styles.autor}>
            {quien(mensaje)}
          </Text>
          <Text color={colors.textMuted} numberOfLines={1} style={styles.detalle}>
            {fechaLegible(mensaje.fechaIso)}
          </Text>
          {botonDeIrAlChat(mensaje)}
        </View>
        {mensaje.texto.trim() ? (
          <TextoConEnlaces texto={mensaje.texto} colorDelTexto={colors.text} style={styles.texto} />
        ) : null}
        {medios.length > 0 ? (
          <View style={styles.mediosDeMensaje}>
            {medios.map((tesela) => (
              <Pressable
                key={tesela.clave}
                onPress={() => {
                  if (tesela.adjunto.url) setAmpliado(tesela);
                }}
                accessibilityRole="button"
                accessibilityLabel={
                  tesela.adjunto.kind === 'video' ? t('chat.viewVideo') : t('chat.viewPhoto')
                }
                style={styles.medioDeMensaje}
              >
                <MedioDeChat
                  adjunto={tesela.adjunto}
                  compacto
                  style={StyleSheet.absoluteFill}
                />
              </Pressable>
            ))}
          </View>
        ) : null}
        {archivos.map((tesela) => (
          <ArchivoDeChat
            key={tesela.clave}
            adjunto={tesela.adjunto}
            style={styles.archivoDeMensaje}
            alVer={verSiEsMedio(tesela.clave, tesela.mensaje, tesela.adjunto)}
          />
        ))}
      </View>
    );
  };

  const pestanas: { clave: string; etiqueta: string }[] = [
    ...(primera ? [{ clave: primera.clave, etiqueta: primera.etiqueta }] : []),
    ...secciones.map((s) => ({
      clave: s.clave,
      etiqueta:
        s.tipo === 'filtro'
          ? s.filtro.activo
            ? s.filtro.nombre
            : t('chatViews.filterOff', { nombre: s.filtro.nombre })
          : t(NOMBRE_DE_SECCION[s.tipo]),
    })),
  ];

  const enLaPropia = !!primera && abierta === primera.clave;
  const sinNada = vistasLeidas && pestanas.length === 0;

  // Lo que se enseña cuando la sección abierta no tiene filas que pintar.
  const estado = enLaPropia ? null : sinNada ? (
    <StateView
      state="empty"
      title={t('chatViews.nothingSharedTitle')}
      description={t('chatViews.nothingSharedBody')}
    />
  ) : !seccion ? (
    vistasLeidas ? null : <ActivityIndicator style={styles.espera} color={colors.primary} />
  ) : cargando && filas.length === 0 ? (
    <ActivityIndicator style={styles.espera} color={colors.primary} />
  ) : fallo && filas.length === 0 ? (
    <StateView state="error" title={fallo} onRetry={reintentar} />
  ) : filas.length === 0 ? (
    <StateView
      state="empty"
      title={
        seccion.tipo === 'filtro' ? t('chatViews.emptyFilterTitle') : t('chatViews.emptyTitle')
      }
      description={
        seccion.tipo === 'filtro'
          ? t('chatViews.emptyFilterBody')
          : hayFilaDeTemas && filtroVigente.tipo !== 'todos'
            ? t('contentTopics.emptyFiltered')
            : t(VACIO_DE_SECCION[seccion.tipo])
      }
    />
  ) : null;

  const encima = (
    <View>
      {cabecera ?? null}

      {pestanas.length > 1 || (pestanas.length === 1 && !primera) ? (
        // Deslizar las pestañas no puede cambiar de sección de la aplicación.
        <SinCambioDeSeccion>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pestanas}
            keyboardShouldPersistTaps="handled"
          >
            <View
              accessibilityRole="tablist"
              style={[styles.barra, { backgroundColor: colors.surfaceAlt }]}
            >
              {pestanas.map((pestana) => {
                const activa = pestana.clave === abierta;
                return (
                  <Pressable
                    key={pestana.clave}
                    onPress={() => setElegida(pestana.clave)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: activa }}
                    accessibilityLabel={pestana.etiqueta}
                    style={[styles.pestana, activa ? { backgroundColor: colors.background } : null]}
                  >
                    <Text
                      weight={activa ? '700' : '600'}
                      color={activa ? colors.text : colors.textMuted}
                      numberOfLines={1}
                      style={styles.etiqueta}
                    >
                      {pestana.etiqueta}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </SinCambioDeSeccion>
      ) : null}

      {seccion?.tipo === 'media' && opciones.length > 0 ? (
        <View accessibilityRole="radiogroup" style={styles.opciones}>
          {opciones.map((opcion) => (
            <Chip
              key={opcion}
              rol="radio"
              selected={opcion === soloVigente}
              onPress={() => setSolo(opcion)}
              label={t(NOMBRE_DE_SOLO[opcion])}
            />
          ))}
        </View>
      ) : null}

      {hayFilaDeTemas && cuentasDeTemas && categoria ? (
        <View style={styles.filaDeTemas}>
          <Text weight="700" color={colors.textMuted} style={styles.rotuloDeTemas}>
            {t('contentTopics.label')}
          </Text>
          {/* Deslizar los temas no puede cambiar de sección de la aplicación. */}
          <SinCambioDeSeccion>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.opcionesDeTema}
              keyboardShouldPersistTaps="handled"
            >
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={t('contentTopics.filterLabel')}
                style={styles.opcionesDeTemaFila}
              >
                {[
                  {
                    filtro: FILTRO_DE_TEMA_TODOS,
                    etiqueta: t('contentTopics.all', { n: cuentaDeCategoria(vistas, categoria) }),
                  },
                  {
                    filtro: { tipo: 'sin' } as FiltroDeTema,
                    etiqueta: t('contentTopics.none', { n: cuentasDeTemas.sinTema }),
                  },
                  ...cuentasDeTemas.temas.map((tema) => ({
                    filtro: { tipo: 'tema', id: tema.id } as FiltroDeTema,
                    // El nombre lo puso la comunidad: no hay nada que traducir.
                    etiqueta: `${tema.nombre} · ${tema.cuantos}`,
                  })),
                ].map(({ filtro, etiqueta }) => (
                  <Chip
                    key={claveDeFiltroDeTema(filtro)}
                    rol="radio"
                    selected={claveDeFiltroDeTema(filtro) === claveDeFiltroDeTema(filtroVigente)}
                    onPress={() => setFiltroDeTema(filtro)}
                    label={etiqueta}
                  />
                ))}
              </View>
            </ScrollView>
          </SinCambioDeSeccion>
        </View>
      ) : null}

      {seccion?.tipo === 'filtro' && seccion.filtro.descripcion ? (
        <Text color={colors.textMuted} style={styles.descripcion}>
          {seccion.filtro.descripcion}
        </Text>
      ) : null}

      {estado}
    </View>
  );

  const accionesDelVisor: AccionDeVisor[] = ampliado
    ? [
        {
          icono: 'corner-up-right',
          etiqueta: t('chatViews.goToMessage'),
          alPulsar: () => {
            const { mensaje } = ampliado;
            setAmpliado(null);
            irAlMensaje(mensaje);
          },
        },
      ]
    : [];

  /** Ya se agregaron: la hoja se va, y DESPUÉS se dice (iOS no pinta nada encima de una hoja). */
  const alAgregarVarios = async (tema: TemaDeGrupo, agregados: number) => {
    setEligiendoTema(false);
    setSeleccion([]);
    leerTemasDeLaSeccion();
    refrescar();
    await afterSheetClose();
    toast(
      agregados === 0
        ? t('contentTopics.addedNone', { tema: tema.nombre })
        : agregados === 1
          ? t('contentTopics.addedOne', { tema: tema.nombre })
          : t('contentTopics.addedMany', { n: agregados, tema: tema.nombre }),
    );
  };

  return (
    <>
      {seleccionando ? (
        <View
          style={[
            styles.barraDeSeleccion,
            { borderBottomColor: colors.border, backgroundColor: colors.background },
          ]}
        >
          <Pressable
            onPress={() => setSeleccion([])}
            accessibilityRole="button"
            accessibilityLabel={t('contentTopics.exitSelection')}
            hitSlop={8}
            style={styles.salirDeSeleccion}
          >
            <Feather name="x" size={22} color={colors.text} />
          </Pressable>
          <Text weight="800" style={styles.cuantosSeleccionados} accessibilityLiveRegion="polite">
            {seleccion.length === 1
              ? t('contentTopics.selectedOne')
              : t('contentTopics.selectedMany', { n: seleccion.length })}
          </Text>
        </View>
      ) : null}
      <FlatList
        data={filas}
        keyExtractor={(item) => `${item.tipo}:${item.clave}`}
        renderItem={pintarFila}
        ListHeaderComponent={encima}
        contentContainerStyle={styles.lista}
        keyboardShouldPersistTaps="handled"
        onEndReached={enLaPropia ? undefined : cargarMas}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={refrescando}
            tintColor={colors.primary}
            onRefresh={() => {
              leerVistas();
              refrescar();
              alRefrescar?.();
            }}
          />
        }
        ListFooterComponent={
          cargandoMas ? <ActivityIndicator style={styles.pie} color={colors.primary} /> : null
        }
      />

      {seleccionando ? (
        <View
          style={[
            styles.pieDeSeleccion,
            { borderTopColor: colors.border, backgroundColor: colors.background },
          ]}
        >
          <Button
            label={t('contentTopics.addMany', { n: seleccion.length })}
            icon="hash"
            onPress={() => setEligiendoTema(true)}
          />
        </View>
      ) : null}

      {temasDelGrupo && puedeElegir ? (
        <HojaDeAgregarVarios
          grupoId={temasDelGrupo.grupoId}
          visible={eligiendoTema}
          mensajeIds={seleccion}
          onClose={() => setEligiendoTema(false)}
          alAgregar={(tema, agregados) => void alAgregarVarios(tema, agregados)}
        />
      ) : null}

      <VisorDeAdjunto
        adjunto={ampliado?.adjunto.url ? ampliado.adjunto : null}
        autor={ampliado ? quien(ampliado.mensaje) : ''}
        fecha={ampliado ? fechaLegible(ampliado.mensaje.fechaIso) : undefined}
        acciones={accionesDelVisor}
        onClose={() => setAmpliado(null)}
      />
    </>
  );
}

/**
 * «Agregar N a un tema»: la lista de temas de la comunidad, y elegir uno los
 * agrega todos de una vez (`PUT` por lotes, todo o nada).
 *
 * TRAS AGREGAR SE AVISA por `chat-temas:{grupo}`, como hace la hoja del chat:
 * quien tenga General abierto refresca sus etiquetas, y quien tenga la lista
 * o el tema, lo suyo. El canal se abre al abrir la hoja para que, al elegir,
 * ya esté unido. Los errores van DENTRO de la hoja (`InlineError`).
 */
function HojaDeAgregarVarios({
  grupoId,
  visible,
  mensajeIds,
  onClose,
  alAgregar,
}: {
  grupoId: string;
  visible: boolean;
  mensajeIds: string[];
  onClose: () => void;
  alAgregar: (tema: TemaDeGrupo, agregados: number) => void;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [temas, setTemas] = useState<TemaDeGrupo[] | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const textoDelFallo = useCallback(
    (error: unknown): string => {
      const codigo = error instanceof ApiError ? error.code : null;
      return t(
        (claveDelFalloDeAgregarVarios(codigo) ??
          claveDelFalloDeTemas(codigo) ??
          claveDelFalloDeGrupo(codigo)) as TranslationKey,
      );
    },
    [t],
  );

  const canal = React.useRef<{ avisar: () => void; cerrar: () => void } | null>(null);
  useEffect(() => {
    if (!visible || !grupoId) return undefined;
    const abierto = avisosDeTemas(grupoId, () => {});
    canal.current = abierto;
    return () => {
      canal.current = null;
      abierto.cerrar();
    };
  }, [visible, grupoId]);

  useEffect(() => {
    if (!visible || !grupoId) return undefined;
    let vigente = true;
    setTemas(null);
    setFallo(null);
    TemasRepository.listar(grupoId)
      .then((leidos) => {
        if (vigente) setTemas(leidos.temas);
      })
      .catch((error) => {
        if (!vigente) return;
        setTemas([]);
        setFallo(textoDelFallo(error));
      });
    return () => {
      vigente = false;
    };
  }, [visible, grupoId, textoDelFallo]);

  const agregar = async (tema: TemaDeGrupo) => {
    if (ocupado || mensajeIds.length === 0) return;
    setOcupado(tema.id);
    setFallo(null);
    try {
      const { agregados } = await TemasRepository.agregarVarios(grupoId, tema.id, mensajeIds);
      canal.current?.avisar();
      alAgregar(tema, agregados);
    } catch (error) {
      setFallo(textoDelFallo(error));
    } finally {
      setOcupado(null);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.hoja}>
        <Text weight="800" style={styles.hojaTitulo}>
          {t('contentTopics.addMany', { n: mensajeIds.length })}
        </Text>
        <Text color={colors.textMuted} style={styles.hojaAyuda}>
          {t('contentTopics.addManyHelp')}
        </Text>
        {temas === null ? (
          <ActivityIndicator style={styles.espera} color={colors.textMuted} />
        ) : temas.length === 0 && !fallo ? (
          <Text color={colors.textMuted} style={styles.hojaAyuda}>
            {t('contentTopics.noTopicsYet')}
          </Text>
        ) : (
          <View>
            {temas.map((tema) => (
              <Pressable
                key={tema.id}
                onPress={() => void agregar(tema)}
                disabled={!!ocupado}
                accessibilityRole="button"
                accessibilityLabel={t('contentTopics.addTo', { tema: tema.nombre })}
                accessibilityState={{ disabled: !!ocupado, busy: ocupado === tema.id }}
                style={[styles.hojaFila, { borderBottomColor: colors.border }]}
              >
                <View style={[styles.hojaIcono, { borderColor: colors.border }]}>
                  <Feather name={tema.icono} size={18} color={colors.text} />
                </View>
                <Text weight="600" numberOfLines={1} style={styles.hojaNombre}>
                  {tema.nombre}
                </Text>
                {ocupado === tema.id ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : (
                  <Feather name="plus" size={18} color={colors.textMuted} />
                )}
              </Pressable>
            ))}
          </View>
        )}
        <InlineError message={fallo} />
        <Button label={t('common.cancel')} variant="secondary" onPress={onClose} disabled={!!ocupado} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  lista: { paddingBottom: spacing.xl, flexGrow: 1 },
  pestanas: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  barra: { flexDirection: 'row', borderRadius: radius.pill, padding: 4, gap: 2 },
  pestana: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  etiqueta: { fontSize: 14 },
  opciones: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  descripcion: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, fontSize: 13 },
  espera: { paddingVertical: spacing.xl },
  pie: { paddingVertical: spacing.md },

  filaDeTeselas: { flexDirection: 'row', marginBottom: HUECO },
  tesela: { overflow: 'hidden' },
  // Un archivo en su fila: ocupa el ancho y deja sitio al «ver en el chat».
  filaDeArchivo: { alignItems: 'center' },

  fila: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sitio: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inicial: { fontSize: 22 },
  cuerpo: { flex: 1, minWidth: 0, gap: 2 },
  titular: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nombre: { flex: 1, minWidth: 0, fontSize: 15 },
  autor: { flexShrink: 1, fontSize: 14 },
  textoDeEnlace: { fontSize: 14, lineHeight: 19 },
  direccion: { fontSize: 13, lineHeight: 18 },
  detalle: { fontSize: 12 },
  irAlChat: { marginLeft: 'auto', padding: spacing.xs },

  filaDeAudio: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  audio: { borderRadius: radius.md, padding: spacing.sm, alignSelf: 'flex-start', minWidth: 220 },
  texto: { fontSize: 15, lineHeight: 21 },
  mediosDeMensaje: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  medioDeMensaje: {
    width: 96,
    height: 96,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  archivoDeMensaje: { width: undefined, alignSelf: 'stretch' },

  // La fila «Tema» (audios y temas, 30/10/2026).
  filaDeTemas: { gap: spacing.xs, paddingBottom: spacing.sm },
  rotuloDeTemas: { fontSize: 12, paddingHorizontal: spacing.md },
  opcionesDeTema: { paddingHorizontal: spacing.md },
  opcionesDeTemaFila: { flexDirection: 'row', gap: spacing.xs },
  temasDeLaFila: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: spacing.xs },
  temaDeLaFila: {
    height: 24,
    maxWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  // «Sin tema» se distingue por el borde punteado, no por un color.
  sinTema: { borderWidth: 1, borderStyle: 'dashed' },
  temaDeLaFilaTexto: { flexShrink: 1, fontSize: 12, lineHeight: 16 },

  // Elegir varios.
  marca: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  marcaEncima: { position: 'absolute', top: 6, left: 6 },
  barraDeSeleccion: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  salirDeSeleccion: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  cuantosSeleccionados: { fontSize: 15 },
  pieDeSeleccion: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  hoja: { gap: spacing.sm, paddingBottom: spacing.sm },
  hojaTitulo: { fontSize: 20, lineHeight: 24 },
  hojaAyuda: { fontSize: 13, lineHeight: 18 },
  hojaFila: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  hojaIcono: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hojaNombre: { flex: 1, fontSize: 15 },
});
