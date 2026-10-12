import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Avatar } from '@/components/Avatar';
import { BurbujaDeNotaDeVoz } from '@/components/BurbujaDeNotaDeVoz';
import { Chip } from '@/components/Chip';
import { VisorDeAdjunto, type AccionDeVisor } from '@/components/chat/VisorDeAdjunto';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { TextoConEnlaces } from '@/components/TextoConEnlaces';
import { useMensajesDeVista } from '@/hooks/useMensajesDeVista';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { notify } from '@/lib/confirm';
import {
  adjuntosDe,
  columnasDeRejilla,
  direccionesDe,
  duracionLegible,
  enFilasDe,
  nombreDeSitio,
  sitioDe,
  teselasDe,
  type Tesela,
} from '@/lib/contenidoDeChat';
import { rutaInternaDe } from '@/lib/enlaces';
import { colorDelEnlace, partirEnEnlaces } from '@/lib/enlacesEnTexto';
import { pedirSalto } from '@/lib/saltoDeChat';
import { enlaceDeDescarga, esHtml } from '@/lib/tiposDeArchivo';
import {
  SIN_VISTAS,
  huellaDeCriterios,
  opcionesDeMedia,
  seccionesDeContenido,
  vistaDeSeccion,
  type SeccionDeContenido,
  type SoloDeMedia,
  type VistasDeChat,
} from '@/lib/vistasDeChat';
import { MessageRepository, type MensajeDeVista } from '@/repositories/MessageRepository';
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

function pesoLegible(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const { mensajes, cargando, cargandoMas, refrescando, fallo, cargarMas, refrescar, reintentar } =
    useMensajesDeVista(conversationId, vista, {
      currentUserId,
      huella: seccion?.tipo === 'filtro' ? huellaDeCriterios(seccion.filtro) : '',
      alHaberCambios: leerVistas,
    });

  // Al cambiar de pestaña no sigue sonando el audio de la anterior.
  useEffect(() => {
    setAudioSonando(null);
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

  const abrirArchivo = useCallback(
    (adjunto: MessageAttachment) => {
      if (!adjunto.url) return;
      // Un HTML se DESCARGA, no se abre como página: ver `enlaceDeDescarga`.
      const destino = esHtml(adjunto.mimeType, adjunto.fileName)
        ? enlaceDeDescarga(adjunto.url, adjunto.fileName)
        : adjunto.url;
      Linking.openURL(destino).catch(() => {
        notify(t('common.couldNotOpen'), t('common.tryAgainSoon'));
      });
    },
    [t],
  );

  const quien = (mensaje: MensajeDeVista) =>
    mensaje.mio ? t('chatViews.you') : mensaje.autor.nombre;

  const botonDeIrAlChat = (mensaje: MensajeDeVista) => (
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
    const duracion = esVideo ? duracionLegible(adjunto.durationS) : '';
    return (
      <Pressable
        key={tesela.clave}
        onPress={() => {
          // Fotos y vídeos se ven DENTRO, en el mismo visor que en el chat.
          if (adjunto.url) setAmpliado(tesela);
        }}
        accessibilityRole="button"
        accessibilityLabel={esVideo ? t('chat.viewVideo') : t('chat.viewPhoto')}
        style={[
          styles.tesela,
          {
            width: lado,
            height: lado,
            marginLeft: indice === 0 ? 0 : HUECO,
            backgroundColor: esVideo ? '#111' : colors.surfaceAlt,
          },
        ]}
      >
        {/* De un vídeo no hay fotograma que enseñar: se dice que lo es. */}
        {!esVideo && adjunto.url ? (
          <Image source={{ uri: adjunto.url }} style={StyleSheet.absoluteFill} />
        ) : null}
        {esVideo ? (
          <>
            <View style={styles.play}>
              <Feather name="play" size={18} color="#FFF" />
            </View>
            {duracion ? (
              <View style={styles.duracion}>
                <Text color="#FFF" weight="600" style={styles.duracionTexto}>
                  {duracion}
                </Text>
              </View>
            ) : null}
          </>
        ) : null}
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
            primeraDireccion ? abrirEnlace(primeraDireccion) : irAlMensaje(item.mensaje)
          }
          accessibilityRole="button"
          accessibilityLabel={primeraDireccion ? `${nombre}. ${primeraDireccion}` : nombre}
          accessibilityHint={primeraDireccion ? t('chat.openLink') : t('chatViews.goToMessage')}
          style={[styles.fila, { borderBottomColor: colors.border }]}
        >
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
                style={[styles.direccion, { color: colorDelEnlace(colors.text) }]}
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
      const peso = pesoLegible(item.adjunto.bytes);
      return (
        <Pressable
          onPress={() => abrirArchivo(item.adjunto)}
          accessibilityRole="button"
          accessibilityLabel={item.adjunto.fileName ?? t('chat.file')}
          style={[styles.fila, { borderBottomColor: colors.border }]}
        >
          <View style={[styles.sitio, { backgroundColor: colors.surfaceAlt }]}>
            <Feather name="file-text" size={22} color={colors.primary} />
          </View>
          <View style={styles.cuerpo}>
            <View style={styles.titular}>
              <Text weight="700" numberOfLines={1} style={styles.nombre}>
                {item.adjunto.fileName ?? t('chat.file')}
              </Text>
              {botonDeIrAlChat(item.mensaje)}
            </View>
            <Text color={colors.textMuted} numberOfLines={1} style={styles.detalle}>
              {[peso, quien(item.mensaje), fechaLegible(item.mensaje.fechaIso)]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
        </Pressable>
      );
    }

    if (item.tipo === 'audio') {
      return (
        <View style={[styles.filaDeAudio, { borderBottomColor: colors.border }]}>
          <View style={styles.titular}>
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
            />
          </View>
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
                style={[
                  styles.medioDeMensaje,
                  { backgroundColor: tesela.adjunto.kind === 'video' ? '#111' : colors.surfaceAlt },
                ]}
              >
                {tesela.adjunto.kind !== 'video' && tesela.adjunto.url ? (
                  <Image source={{ uri: tesela.adjunto.url }} style={StyleSheet.absoluteFill} />
                ) : null}
                {tesela.adjunto.kind === 'video' ? (
                  <View style={styles.play}>
                    <Feather name="play" size={18} color="#FFF" />
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : null}
        {archivos.map((tesela) => (
          <Pressable
            key={tesela.clave}
            onPress={() => abrirArchivo(tesela.adjunto)}
            accessibilityRole="button"
            accessibilityLabel={tesela.adjunto.fileName ?? t('chat.file')}
            style={styles.archivoDeMensaje}
          >
            <Feather name="file-text" size={18} color={colors.primary} />
            <Text numberOfLines={1} weight="600" style={styles.nombre}>
              {tesela.adjunto.fileName ?? t('chat.file')}
            </Text>
          </Pressable>
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

  return (
    <>
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
  tesela: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  play: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  duracion: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  duracionTexto: { fontSize: 11 },

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
  archivoDeMensaje: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
