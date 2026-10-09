import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Avatar } from '@/components/Avatar';
import { BurbujaDeNotaDeVoz } from '@/components/BurbujaDeNotaDeVoz';
import { Chip } from '@/components/Chip';
import { ImageViewer } from '@/components/ImageViewer';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { TextoConEnlaces } from '@/components/TextoConEnlaces';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { describeError } from '@/lib/describeError';
import { notify } from '@/lib/confirm';
import {
  MENSAJES_POR_PAGINA_DE_VISTA,
  SIN_VISTAS,
  VISTA_TODO,
  claveDeVista,
  crearTurnos,
  fundirPaginas,
  pestanasDe,
  refrescarPrimeraPagina,
  sigueExistiendo,
  type Categoria,
  type CursorDeVista,
  type VistaElegida,
  type VistasDeChat,
} from '@/lib/vistasDeChat';
import {
  MessageRepository,
  type MensajeDeVista,
} from '@/repositories/MessageRepository';
import { subscribeToConversation } from '@/services/realtime';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

const NOMBRE_DE_CATEGORIA: Record<Categoria, TranslationKey> = {
  all: 'chatViews.all',
  image: 'chatViews.images',
  video: 'chatViews.videos',
  document: 'chatViews.documents',
  audio: 'chatViews.audios',
  link: 'chatViews.links',
};

const ICONO_DE_CATEGORIA: Record<Categoria, keyof typeof Feather.glyphMap> = {
  all: 'message-circle',
  image: 'image',
  video: 'video',
  document: 'file-text',
  audio: 'mic',
  link: 'link',
};

const VACIO_DE_CATEGORIA: Record<Categoria, TranslationKey> = {
  all: 'chatViews.emptyAll',
  image: 'chatViews.emptyImages',
  video: 'chatViews.emptyVideos',
  document: 'chatViews.emptyDocuments',
  audio: 'chatViews.emptyAudios',
  link: 'chatViews.emptyLinks',
};

/** Cuánto se espera tras la última tecla antes de preguntar al servidor. */
const ESPERA_AL_BUSCAR_MS = 350;
/** Como mucho una recarga por mensajes nuevos cada tanto. */
const ESPERA_ENTRE_RECARGAS_MS = 2000;

function iconoSeguro(nombre: string): keyof typeof Feather.glyphMap {
  return nombre in Feather.glyphMap ? (nombre as keyof typeof Feather.glyphMap) : 'filter';
}

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

/**
 * El contenido de un chat, por vistas: «Todo», las categorías automáticas
 * (fotos, vídeos, archivos, audios, enlaces) y, en un grupo, sus filtros.
 *
 * ES UNA PANTALLA APARTE Y NO PESTAÑAS DENTRO DEL CHAT, a propósito. El chat
 * tiene su propia lógica de desplazamiento, envío y tiempo real; meterle
 * vistas filtradas por dentro la pondría en riesgo. Aquí se abre encima y, al
 * volver, la conversación está exactamente donde se dejó.
 *
 * UNA VISTA NO ES OTRO CHAT: enseña los mismos mensajes. Qué entra en cada una
 * lo decide el servidor; aquí no se filtra nada de lo ya descargado.
 */
export function ContenidoDeChatScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const conversationId = typeof params.id === 'string' ? params.id : '';
  const currentUserId = useAppStore((state) => state.user?.id ?? null);

  const [vistas, setVistas] = useState<VistasDeChat>(SIN_VISTAS);
  const [vista, setVista] = useState<VistaElegida>(VISTA_TODO);
  const [escrito, setEscrito] = useState('');
  const [buscar, setBuscar] = useState('');
  const [mensajes, setMensajes] = useState<MensajeDeVista[]>([]);
  const [siguiente, setSiguiente] = useState<CursorDeVista | null>(null);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [refrescando, setRefrescando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);
  const [fotoAmpliada, setFotoAmpliada] = useState<MessageAttachment | null>(null);
  const [audioSonando, setAudioSonando] = useState<string | null>(null);

  const turnos = useRef(crearTurnos()).current;
  const enCurso = useRef<AbortController | null>(null);
  /** La vista y la busqueda de ahora mismo, para reconocer respuestas viejas. */
  const loQueSeMira = useRef('');
  loQueSeMira.current = `${claveDeVista(vista)}|${buscar}`;

  const leerVistas = useCallback(() => {
    if (!conversationId) return;
    void MessageRepository.vistas(conversationId).then(setVistas);
  }, [conversationId]);

  /**
   * Pide la PRIMERA página de la vista abierta.
   *
   * `silencioso` es la recarga por un mensaje nuevo o al tirar hacia abajo: no
   * vacía la lista ni enseña el indicador grande, y conserva las páginas ya
   * cargadas por debajo.
   */
  const cargar = useCallback(
    (silencioso: boolean) => {
      if (!conversationId) return;
      enCurso.current?.abort();
      const control = new AbortController();
      enCurso.current = control;
      const turno = turnos.siguiente();
      if (!silencioso) {
        setCargando(true);
        setFallo(null);
      }
      MessageRepository.mensajesDeVista(conversationId, vista, {
        buscar,
        signal: control.signal,
        currentUserId,
      })
        .then((pagina) => {
          // Solo cuenta la última petición: si se cambió de pestaña mientras
          // esta viajaba, su respuesta ya no es de lo que se está mirando.
          if (!turnos.vigente(turno)) return;
          setMensajes((previos) =>
            silencioso
              ? refrescarPrimeraPagina(previos, pagina.mensajes, MENSAJES_POR_PAGINA_DE_VISTA)
              : pagina.mensajes,
          );
          // En una recarga silenciosa con más páginas cargadas, el cursor que
          // vale es el de la última página, no el de la primera.
          setSiguiente((previo) => (silencioso && previo ? previo : pagina.siguiente));
          setFallo(null);
        })
        .catch((error: unknown) => {
          if (!turnos.vigente(turno) || control.signal.aborted) return;
          // Una recarga silenciosa que falla no tapa lo que ya se ve.
          if (!silencioso) setFallo(describeError(error, t('chatViews.loadError')));
        })
        .finally(() => {
          // El gesto de tirar se suelta siempre, gane quien gane el turno.
          setRefrescando(false);
          if (turnos.vigente(turno)) setCargando(false);
        });
    },
    [conversationId, vista, buscar, currentUserId, turnos, t],
  );

  // Al entrar, y cada vez que cambia la vista o lo que se busca.
  useEffect(() => {
    setMensajes([]);
    setSiguiente(null);
    cargar(false);
    return () => enCurso.current?.abort();
  }, [cargar]);

  // Las cuentas y los filtros, al entrar y al volver a esta pantalla.
  useFocusEffect(
    useCallback(() => {
      leerVistas();
    }, [leerVistas]),
  );

  // Si quien administra borró o apagó el filtro que se estaba mirando, se
  // vuelve a «Todo» en vez de quedarse en una vista que ya no existe.
  useEffect(() => {
    if (!sigueExistiendo(vistas, vista)) setVista(VISTA_TODO);
  }, [vistas, vista]);

  // El buscador pregunta al servidor cuando se deja de teclear.
  useEffect(() => {
    const espera = setTimeout(() => setBuscar(escrito.trim()), ESPERA_AL_BUSCAR_MS);
    return () => clearTimeout(espera);
  }, [escrito]);

  // MENSAJES NUEVOS. Se usa el mismo canal que el chat: cuando entra algo en la
  // conversación, se vuelve a pedir la primera página y las cuentas. No se
  // intenta adivinar aquí si el mensaje nuevo pertenece a la vista: eso lo
  // sabe el servidor. Como mucho una recarga cada dos segundos.
  const recargar = useRef(cargar);
  recargar.current = cargar;
  useEffect(() => {
    if (!conversationId) return;
    let pendiente: ReturnType<typeof setTimeout> | null = null;
    const desengancha = subscribeToConversation(conversationId, () => {
      if (pendiente) return;
      pendiente = setTimeout(() => {
        pendiente = null;
        recargar.current(true);
        leerVistas();
      }, ESPERA_ENTRE_RECARGAS_MS);
    });
    return () => {
      if (pendiente) clearTimeout(pendiente);
      desengancha();
    };
  }, [conversationId, leerVistas]);

  const cargarMas = useCallback(() => {
    if (!conversationId || !siguiente || cargando || cargandoMas) return;
    // NO toma turno: tomarlo anularia una recarga de la primera pagina que
    // estuviera en camino. Le basta saber si, al contestar, se sigue mirando
    // la misma vista con la misma busqueda.
    const pedida = loQueSeMira.current;
    setCargandoMas(true);
    MessageRepository.mensajesDeVista(conversationId, vista, {
      buscar,
      cursor: siguiente,
      currentUserId,
    })
      .then((pagina) => {
        if (loQueSeMira.current !== pedida) return;
        setMensajes((previos) => fundirPaginas(previos, pagina.mensajes));
        setSiguiente(pagina.siguiente);
      })
      .catch(() => {
        // Se queda el cursor: al volver a llegar al final se reintenta.
      })
      .finally(() => setCargandoMas(false));
  }, [conversationId, siguiente, cargando, cargandoMas, vista, buscar, currentUserId]);

  const pestanas = useMemo(() => pestanasDe(vistas, vista), [vistas, vista]);
  const abierta = claveDeVista(vista);
  const filtroAbierto =
    vista.tipo === 'filtro' ? vistas.filtros.find((f) => f.id === vista.id) : undefined;

  const abrirFuera = useCallback(
    (adjunto: MessageAttachment) => {
      if (!adjunto.url) return;
      Linking.openURL(adjunto.url).catch(() => {
        notify(t('common.couldNotOpen'), t('common.tryAgainSoon'));
      });
    },
    [t],
  );

  const pintarAdjunto = (adjunto: MessageAttachment) => {
    if (adjunto.kind === 'audio') {
      return (
        <View key={adjunto.id} style={[styles.audio, { backgroundColor: colors.surface }]}>
          <BurbujaDeNotaDeVoz
            adjunto={adjunto}
            mio={false}
            activo={audioSonando === adjunto.id}
            alPulsar={() => setAudioSonando((actual) => (actual === adjunto.id ? null : adjunto.id))}
            alTerminar={() => setAudioSonando((actual) => (actual === adjunto.id ? null : actual))}
          />
        </View>
      );
    }
    if (adjunto.kind === 'document') {
      return (
        <Pressable
          key={adjunto.id}
          onPress={() => abrirFuera(adjunto)}
          accessibilityRole="button"
          accessibilityLabel={adjunto.fileName ?? t('chat.file')}
          style={[styles.documento, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Feather name="file-text" size={20} color={colors.primary} />
          <View style={styles.documentoTexto}>
            <Text numberOfLines={1} weight="600" style={styles.documentoNombre}>
              {adjunto.fileName ?? t('chat.file')}
            </Text>
            {adjunto.bytes ? (
              <Text color={colors.textMuted} style={styles.detalle}>
                {pesoLegible(adjunto.bytes)}
              </Text>
            ) : null}
          </View>
          <Feather name="download" size={16} color={colors.textMuted} />
        </Pressable>
      );
    }
    return (
      <Pressable
        key={adjunto.id}
        onPress={() => {
          // Un vídeo no va al visor de imágenes: se abre fuera, como en el chat.
          if (adjunto.kind === 'video') abrirFuera(adjunto);
          else if (adjunto.url) setFotoAmpliada(adjunto);
        }}
        accessibilityRole="button"
        accessibilityLabel={adjunto.kind === 'video' ? t('chat.viewVideo') : t('chat.viewPhoto')}
        style={styles.medio}
      >
        {adjunto.url ? (
          <Image source={{ uri: adjunto.url }} style={styles.medioImagen} />
        ) : (
          <View style={[styles.medioImagen, { backgroundColor: colors.border }]} />
        )}
        {adjunto.kind === 'video' ? (
          <View style={styles.play}>
            <Feather name="play" size={18} color="#FFF" />
          </View>
        ) : null}
      </Pressable>
    );
  };

  const pintarMensaje = ({ item }: { item: MensajeDeVista }) => {
    const medios = item.adjuntos.filter((a) => a.kind === 'image' || a.kind === 'video');
    const resto = item.adjuntos.filter((a) => a.kind !== 'image' && a.kind !== 'video');
    return (
      <View style={[styles.fila, { borderBottomColor: colors.border }]}>
        <View style={styles.cabeceraDeFila}>
          <Avatar size={28} image={item.autor.avatarUrl ?? null} name={item.autor.nombre} />
          <Text numberOfLines={1} weight="700" style={styles.autor}>
            {item.mio ? t('chatViews.you') : item.autor.nombre}
          </Text>
          <Text color={colors.textMuted} style={styles.detalle}>
            {fechaLegible(item.fechaIso)}
          </Text>
        </View>
        {item.texto.trim() ? (
          <TextoConEnlaces texto={item.texto} colorDelTexto={colors.text} style={styles.texto} />
        ) : null}
        {medios.length > 0 ? <View style={styles.medios}>{medios.map(pintarAdjunto)}</View> : null}
        {resto.map(pintarAdjunto)}
      </View>
    );
  };

  const vacio = buscar
    ? { titulo: t('chatViews.emptySearchTitle'), cuerpo: t('chatViews.emptySearchBody', { texto: buscar }) }
    : vista.tipo === 'filtro'
      ? { titulo: t('chatViews.emptyFilterTitle'), cuerpo: t('chatViews.emptyFilterBody') }
      : { titulo: t('chatViews.emptyTitle'), cuerpo: t(VACIO_DE_CATEGORIA[vista.clave]) };

  return (
    <AppScreen scroll={false}>
      <AppHeader
        title={params.name ? t('chatViews.titleOf', { nombre: params.name }) : t('chatViews.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />

      <View style={styles.buscador}>
        <Input
          value={escrito}
          onChangeText={setEscrito}
          placeholder={t('chatViews.searchPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={80}
        />
      </View>

      {/* Deslizar las pestañas no puede cambiar de sección de la aplicación. */}
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pestanas}
          keyboardShouldPersistTaps="handled"
        >
          {pestanas.map((pestana, indice) => {
            const clave = claveDeVista(pestana.vista);
            const esFiltro = 'filtro' in pestana;
            const anterior = pestanas[indice - 1];
            // Una raya separa lo automático de lo que creó una persona.
            const empiezanLosFiltros = esFiltro && anterior !== undefined && !('filtro' in anterior);
            return (
              <React.Fragment key={clave}>
                {empiezanLosFiltros ? (
                  <View style={[styles.separador, { backgroundColor: colors.border }]} />
                ) : null}
                <Chip
                  rol="radio"
                  selected={clave === abierta}
                  onPress={() => setVista(pestana.vista)}
                  icon={
                    esFiltro
                      ? iconoSeguro(pestana.filtro.icono)
                      : ICONO_DE_CATEGORIA[pestana.vista.clave]
                  }
                  label={
                    esFiltro
                      ? pestana.filtro.activo
                        ? pestana.filtro.nombre
                        : t('chatViews.filterOff', { nombre: pestana.filtro.nombre })
                      : pestana.vista.clave === 'all' || pestana.cuantos === 0
                        ? t(NOMBRE_DE_CATEGORIA[pestana.vista.clave])
                        : `${t(NOMBRE_DE_CATEGORIA[pestana.vista.clave])} · ${pestana.cuantos}`
                  }
                />
              </React.Fragment>
            );
          })}
        </ScrollView>
      </SinCambioDeSeccion>

      {filtroAbierto?.descripcion ? (
        <Text color={colors.textMuted} style={styles.descripcion}>
          {filtroAbierto.descripcion}
        </Text>
      ) : null}

      {cargando && mensajes.length === 0 ? (
        <StateView state="loading" />
      ) : fallo && mensajes.length === 0 ? (
        <StateView state="error" title={fallo} onRetry={() => cargar(false)} />
      ) : (
        <FlatList
          data={mensajes}
          keyExtractor={(item) => item.id}
          renderItem={pintarMensaje}
          contentContainerStyle={mensajes.length === 0 ? styles.listaVacia : styles.lista}
          keyboardShouldPersistTaps="handled"
          onEndReached={cargarMas}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl
              refreshing={refrescando}
              tintColor={colors.primary}
              onRefresh={() => {
                setRefrescando(true);
                leerVistas();
                cargar(true);
              }}
            />
          }
          ListEmptyComponent={
            <StateView state="empty" title={vacio.titulo} description={vacio.cuerpo} />
          }
          ListFooterComponent={
            cargandoMas ? <ActivityIndicator style={styles.pie} color={colors.primary} /> : null
          }
        />
      )}

      {fotoAmpliada?.url ? (
        <ImageViewer
          uri={fotoAmpliada.url}
          caption={fotoAmpliada.fileName ?? undefined}
          onClose={() => setFotoAmpliada(null)}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  buscador: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  pestanas: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    alignItems: 'center',
  },
  separador: { width: 1, height: 22, marginHorizontal: spacing.xs },
  descripcion: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, fontSize: 13 },
  lista: { paddingBottom: spacing.xl },
  listaVacia: { flexGrow: 1, justifyContent: 'center' },
  fila: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cabeceraDeFila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  autor: { flexShrink: 1, fontSize: 14 },
  detalle: { fontSize: 12 },
  texto: { fontSize: 15, lineHeight: 21 },
  medios: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  medio: {
    width: 104,
    height: 104,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  medioImagen: { ...StyleSheet.absoluteFillObject },
  play: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  documento: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  documentoTexto: { flex: 1, minWidth: 0 },
  documentoNombre: { fontSize: 14 },
  audio: { borderRadius: radius.md, padding: spacing.sm, alignSelf: 'flex-start', minWidth: 220 },
  pie: { paddingVertical: spacing.md },
});
