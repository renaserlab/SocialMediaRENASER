import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
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

import { AppHeader } from '@/components/AppHeader';
import { BottomSheet } from '@/components/BottomSheet';
import { ImageViewer } from '@/components/ImageViewer';
import { ListRow } from '@/components/ListRow';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { Input } from '@/components/Input';
import { notify } from '@/lib/confirm';
import {
  descartarEnvio,
  fusionar,
  instanteMasAntiguo,
  instanteMasReciente,
  nuevoIdTemporal,
  reconciliarEnvio,
} from '@/lib/mensajesEnVivo';
import { toMessageFromRow } from '@/mappers/messageMapper';
import { MessageRepository, MENSAJES_POR_PAGINA } from '@/repositories/MessageRepository';
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

function pesoLegible(bytes?: number | null): string {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ChatScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const keyboardOffset = useKeyboardOffset();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUserId = useAppStore((state) => state.user?.id);

  // Modo demo (sin Supabase): usa el store local.
  const conversations = useAppStore((state) => state.conversations);
  const sendMessageDemo = useAppStore((state) => state.sendMessage);

  const demoConversation = useMemo(() => {
    let found = conversations.find((item) => item.id === params.id);
    if (!found && params.id === 'darren') {
      found = {
        id: 'darren',
        name: 'Darren Hardy',
        subtitle: 'Mentor de líderes',
        unread: 0,
        messages: [
          { id: 'd1', sender: 'them', text: '¡Hola! Qué gusto saludarte. ¿En qué puedo apoyarte hoy en tu camino de crecimiento?', createdAt: '10:00 AM' },
        ],
      };
    }
    return found;
  }, [conversations, params.id]);

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
        if (montado) setLoadError('No se pudieron cargar los mensajes.');
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
        archivos que cuelgan de ella, así que se piden las novedades desde el
        último mensaje conocido: UNA petición para toda la ráfaga, no una por
        mensaje.
      */
      const desde = instanteMasReciente(
        mensajesRef.current.filter((m) => (m.attachments?.length ?? 0) > 0 || m.id !== row.id),
      );
      if (desde) {
        MessageRepository.listMessagesSince(conversationId, desde, currentUserId)
          .then((nuevos) => {
            if (montado && nuevos.length) {
              aplicar(fusionar(mensajesRef.current, nuevos));
            }
          })
          .catch(() => {
            // La burbuja de texto ya está puesta; sin esto solo faltaría el
            // adjunto, y volverá con el siguiente mensaje o al reabrir.
          });
      }
      MessageRepository.markRead(conversationId).catch(() => {});
    });

    return () => {
      montado = false;
      unsubscribe();
    };
  }, [supabaseEnabled, params.id, currentUserId, aplicar]);

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

  const headerName = params.name ?? demoConversation?.name ?? 'Conversación';
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
          'No se pudo abrir',
          error instanceof PermisoDenegadoError
            ? error.message
            : 'No se pudo abrir el selector de archivos.',
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

        const esFaltaDeMigracion =
          error instanceof ApiError && error.code === 'chat_attachments_not_available';
        notify(
          esFaltaDeMigracion ? 'Archivos no disponibles todavía' : 'No se pudo enviar',
          esFaltaDeMigracion
            ? 'Por ahora solo se pueden mandar mensajes de texto por el chat.'
            : error instanceof Error
              ? error.message
              : 'Revisa tu conexión e inténtalo de nuevo.',
        );
      } finally {
        setEnviando(false);
      }
    },
    [params.id, currentUserId, aplicar],
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
    setEnviando(true);

    const idTemporal = nuevoIdTemporal();
    aplicar(
      fusionar(mensajesRef.current, [
        {
          id: idTemporal,
          text: body,
          sender: 'me' as const,
          createdAt: '',
          estado: 'enviando' as const,
          progreso: envio.archivos.length ? 0 : undefined,
          // Vista previa local mientras sube: la ruta local vale como `url`,
          // así la burbuja enseña la foto desde el primer instante.
          attachments: envio.archivos.map((archivo, i) => ({
            id: `${idTemporal}-${i}`,
            storagePath: '',
            kind: archivo.kind,
            fileName: archivo.name,
            bytes: archivo.bytes,
            width: archivo.width,
            height: archivo.height,
            url: archivo.uri,
          })),
        },
      ]),
    );
    await enviar(envio, idTemporal);
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
  // Pintar
  // -------------------------------------------------------------------------

  const pintarAdjunto = (adjunto: MessageAttachment, mio: boolean) => {
    const colorTexto = mio ? colors.onPrimary : colors.text;

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
        accessibilityLabel={adjunto.kind === 'video' ? 'Ver vídeo' : 'Ver foto'}
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={headerName} rightIcon="video" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      {loadError ? (
        <Text style={{ color: colors.danger, textAlign: 'center', padding: spacing.sm, fontSize: 12 }}>
          {loadError}
        </Text>
      ) : null}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
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
          renderItem={({ item }: { item: Message }) => {
            const mine = item.sender === 'me';
            const fallido = item.estado === 'error';
            return (
              <View style={mine ? styles.filaMia : styles.filaSuya}>
                <View
                  style={[
                    styles.bubble,
                    mine ? styles.mine : styles.theirs,
                    {
                      backgroundColor: mine ? colors.primary : colors.surface,
                      borderColor: fallido ? colors.danger : colors.border,
                      opacity: item.estado === 'enviando' ? 0.75 : 1,
                    },
                  ]}
                >
                  {item.attachments?.length ? (
                    <View style={styles.adjuntos}>
                      {item.attachments.map((adjunto) => pintarAdjunto(adjunto, mine))}
                    </View>
                  ) : null}

                  {item.text ? (
                    <Text style={{ color: mine ? colors.onPrimary : colors.text, fontSize: 14, lineHeight: 20 }}>
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

                  <Text
                    style={{
                      color: mine ? colors.onPrimary : colors.textMuted,
                      fontSize: 9,
                      marginTop: 5,
                      opacity: 0.75,
                    }}
                  >
                    {item.estado === 'enviando'
                      ? 'Enviando…'
                      : fallido
                        ? 'No se envió'
                        : item.createdAt}
                  </Text>
                </View>

                {fallido ? (
                  <View style={styles.accionesFallo}>
                    <Pressable
                      onPress={() => reintentar(item)}
                      accessibilityRole="button"
                      accessibilityLabel="Reintentar el envío"
                      style={styles.accionFallo}
                    >
                      <Feather name="refresh-cw" size={13} color={colors.primary} />
                      <Text style={{ color: colors.primary, fontSize: 11 }}>Reintentar</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => descartar(item)}
                      accessibilityRole="button"
                      accessibilityLabel="Descartar el mensaje"
                      style={styles.accionFallo}
                    >
                      <Text style={{ color: colors.textMuted, fontSize: 11 }}>Descartar</Text>
                    </Pressable>
                  </View>
                ) : null}
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
                {archivo.kind === 'document' ? (
                  <View style={styles.previaDocumento}>
                    <Feather name="file-text" size={20} color={colors.text} />
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
                  accessibilityLabel={`Quitar ${archivo.name ?? 'el archivo'}`}
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
            disabled={!supabaseEnabled}
            style={styles.addButton}
          >
            <Feather
              name="plus"
              size={24}
              color={supabaseEnabled ? colors.text : colors.border}
            />
          </Pressable>
          <Input
            value={text}
            onChangeText={setText}
            onSubmitEditing={submit}
            placeholder="Mensaje"
            placeholderTextColor={colors.textMuted}
            returnKeyType="send"
            containerStyle={styles.inputContainer}
            style={{ minHeight: 40 }}
          />
          <Pressable
            onPress={submit}
            disabled={(!text.trim() && elegidos.length === 0) || enviando}
            style={styles.sendButton}
            accessibilityLabel="Enviar mensaje"
            accessibilityRole="button"
          >
            {enviando ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Feather
                name="send"
                size={20}
                color={text.trim() || elegidos.length ? colors.text : colors.border}
              />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <BottomSheet visible={menuAbierto} onClose={() => setMenuAbierto(false)}>
        <ListRow
          title="Fotos y vídeos"
          leftIcon="image"
          onPress={() => void elegirCon(() => elegirFotosOVideos(MAX_ADJUNTOS - elegidos.length))}
        />
        <ListRow title="Cámara" leftIcon="camera" onPress={() => void elegirCon(hacerFoto)} />
        <ListRow title="Archivo" leftIcon="paperclip" onPress={() => void elegirCon(elegirArchivo)} />
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
  filaMia: { alignItems: 'flex-end' },
  filaSuya: { alignItems: 'flex-start' },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, marginBottom: spacing.md },
  mine: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
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
  inputBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderTopWidth: 1, padding: spacing.md, paddingBottom: spacing.lg },
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
