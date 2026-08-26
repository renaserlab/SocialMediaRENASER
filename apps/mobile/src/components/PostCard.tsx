import React, { memo, useEffect, useState } from 'react';
import { Pressable, Share, StyleSheet, TextInput, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AudioPlayer } from '@/components/AudioPlayer';
import { PostImage } from '@/components/PostImage';
import { BottomSheet } from '@/components/BottomSheet';
import { DoubleTapLike } from '@/components/DoubleTapLike';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { VideoTile } from '@/components/VideoTile';
import { assets } from '@/data/assets';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { haptics } from '@/lib/haptics';
import { bestVideoSource } from '@/lib/videoSource';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { ReportRepository } from '@/repositories/ReportRepository';
import { useAppStore } from '@/store/useAppStore';
import { palette, radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { Post } from '@/types';
import { irAlPerfil } from '@/lib/irAlPerfil';

/**
 * Los iconos de acción miden 18-20 px. Ampliamos el area tactil con hitSlop
 * (no con minHeight) para llegar a ~44 px sin alterar el layout de la fila.
 */
const ACTION_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 };

// Overlays sobre el video: contexto de media, siempre oscuro, en ambos temas.
const mediaPalette = palette('dark');

type Props = {
  post: Post;
  /**
   * La publicación deja de estar visible para quien mira: se ha borrado, o se
   * ha bloqueado a su autor. La pantalla anfitriona reacciona (p. ej. volver
   * atrás si la estaba mostrando en solitario).
   */
  onRemoved?: () => void;
  /**
   * La tarjeta esta a la vista dentro de la lista.
   *
   * Solo lo usa el video: al dejar de verse se pausa, para que no siga sonando
   * ni gastando bateria despues de haberlo dejado atras. NO lo arranca al
   * aparecer: en un muro eso seria intrusivo.
   *
   * Sin valor (por ejemplo en el detalle de una publicacion, donde solo hay
   * una) el video no se pausa nunca por este motivo.
   */
  visible?: boolean;
  /**
   * Esta tarjeta es la que manda: su video se reproduce SOLO, como en
   * Instagram. Lo decide la pantalla anfitriona, que es la unica que sabe
   * cual esta mas a la vista, y asi se garantiza que nunca suene mas de uno.
   *
   * Sin definir (detalle de una publicacion, galerias) la tarjeta vuelve al
   * comportamiento de siempre: portada quieta y el video arranca al tocarlo.
   */
  videoActive?: boolean;
  /**
   * El video que viene despues: se prepara sin reproducirse, para que al
   * llegar a el ya tenga contenido y no empiece en negro.
   */
  videoPreload?: boolean;
};

/**
 * Tarjeta de publicacion.
 *
 * Se exporta MEMOIZADA (ver el final del archivo): en el muro, cada vez que
 * cambia que videos se ven —y eso pasa en cada tramo de desplazamiento— el
 * componente de la lista se vuelve a dibujar entero. Sin memo, ese repintado
 * arrastraba consigo TODAS las tarjetas en pantalla, con su cabecera, su
 * cuerpo, sus contadores y su media, aunque a la mayoria no les hubiera
 * cambiado ni una propiedad. Con memo solo se repintan las que de verdad
 * cambian de estado (la que entra, la que sale, la que empieza a reproducir).
 */
function PostCardBase({ post, onRemoved, visible, videoActive, videoPreload }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const [showComments, setShowComments] = useState(false);
  const [comment, setComment] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  /*
    El reproductor de video solo existe DESPUES de que la persona pulse play.

    Crear el reproductor con la fuente ya dispara la descarga del buffer
    inicial, aunque nadie vaya a reproducir: con varios videos en el muro eso
    eran megas de datos y memoria nativa gastados en pasar de largo. Hasta el
    toque se muestra el poster (una imagen ligera); al perderse de vista, el
    reproductor se suelta y vuelve el poster.
  */
  const [videoStarted, setVideoStarted] = useState(false);
  useEffect(() => {
    if (visible === false) setVideoStarted(false);
  }, [visible]);
  // HLS si el video esta transcodificado; MP4 optimizado/original si no.
  const videoSource = post.mediaType === 'video' ? bestVideoSource(post) : null;

  /*
    Muro con reproduccion automatica: la pantalla anfitriona dice quien manda
    (`videoActive`) y quien se prepara (`videoPreload`). Donde no lo diga
    —detalle de una publicacion, galeria— se conserva el comportamiento
    anterior: portada quieta hasta que la persona toca.
  */
  const autoFeed = videoActive !== undefined;
  const feedMuted = useAppStore((state) => state.feedMuted);
  const toggleFeedMuted = useAppStore((state) => state.toggleFeedMuted);

  // Solo existe reproductor para el video que suena y para el siguiente: dos
  // como mucho en todo el muro, aunque haya veinte publicaciones con video.
  const montarReproductor = autoFeed
    ? Boolean(videoActive || videoPreload)
    : videoStarted && visible !== false;
  const liked = useAppStore((state) => state.likedPostIds.includes(post.id));
  const saved = useAppStore((state) => state.savedPostIds.includes(post.id));
  const toggleLike = useAppStore((state) => state.toggleLikePost);
  const toggleSave = useAppStore((state) => state.toggleSavePost);
  const addComment = useAppStore((state) => state.addComment);
  const loadCommentsFor = useAppStore((state) => state.loadCommentsFor);
  const deletePost = useAppStore((state) => state.deletePost);
  // Reaccionar, comentar y guardar quedan asociados a una cuenta: se pide al
  // usarlos, no al entrar en la aplicacion.
  const requireAuth = useRequireAuth();
  const currentUserId = useAppStore((state) => state.user?.id);

  /**
   * La propiedad se deriva en cada render y NO se confia solo en `post.isOwn`:
   * ese campo lo fija el mapper con el id que hubiera al descargar el feed, y
   * si el feed carga antes que el perfil llega vacio y ya no se recalcula.
   */
  const isOwn =
    post.isOwn === true || (!!currentUserId && !!post.authorId && post.authorId === currentUserId);

  const commentCount = post.commentsCount ?? post.comments.length;

  const openComments = () => {
    setShowComments((value) => {
      const next = !value;
      // Al abrir, carga los comentarios del backend si aún no están.
      if (next && post.comments.length === 0 && commentCount > 0) {
        void loadCommentsFor(post.id);
      }
      return next;
    });
  };

  const submitComment = async () => {
    const body = comment;
    // Leer los comentarios es libre; escribirlos queda a nombre de alguien.
    // Se comprueba antes de vaciar el campo, para no perder lo escrito si la
    // persona decide no registrarse ahora.
    let autorizado = false;
    await requireAuth('para comentar', () => {
      autorizado = true;
    });
    if (!autorizado) return;

    setComment('');
    setShowComments(true);
    try {
      await addComment(post.id, body);
    } catch {
      // `addComment` lanza si el POST falla. Antes se llamaba con `void`, asi
      // que el fallo quedaba como rechazo sin capturar: el campo se vaciaba y
      // el comentario no aparecia nunca, sin explicacion.
      notify('No se pudo comentar', 'Revisa tu conexión e inténtalo de nuevo.');
      setComment(body);
    }
  };

  /**
   * Cierra la hoja y despues ejecuta la accion. El retardo deja que el Modal
   * termine su animacion de salida: en iOS un dialogo lanzado durante ese cierre
   * no llega a mostrarse.
   */
  const closeMenuThen = (action: () => void) => {
    setMenuOpen(false);
    setTimeout(action, 250);
  };

  const sharePost = () => {
    Share.share({
      message: `"${post.body}" — ${post.author} en Z.`,
    }).catch(() => {
      // El usuario cancelo, o el navegador no expone navigator.share.
    });
  };

  /** Solo para publicaciones propias: confirmar y eliminar. */
  const deleteOwnPost = async () => {
    const accepted = await confirm({
      title: 'Eliminar publicación',
      message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await deletePost(post.id);
      haptics.light();
      toast('Publicación eliminada');
      onRemoved?.();
    } catch {
      notify('No se pudo eliminar', 'Inténtalo de nuevo.');
    }
  };

  const reportPost = async () => {
    let autorizado = false;
    await requireAuth('para reportar una publicación', () => {
      autorizado = true;
    });
    if (!autorizado) return;
    const accepted = await confirm({
      title: 'Reportar publicación',
      message: '¿Deseas reportar esta publicación?',
      confirmLabel: 'Reportar',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await ReportRepository.create({
        entityType: 'post',
        entityId: post.id,
        reportedUserId: post.authorId,
        reason: 'Contenido inapropiado',
      });
      toast('Reporte enviado. Gracias por avisar.', 'flag');
    } catch {
      notify('No se pudo enviar', 'Inténtalo de nuevo.');
    }
  };

  /**
   * Bloquear al autor desde la propia publicacion.
   *
   * Google exige que se pueda bloquear a alguien, y el sitio natural es donde
   * aparece lo que molesta: obligar a entrar en su perfil anade friccion justo
   * cuando la persona quiere cortar por lo sano.
   */
  const blockAuthor = async () => {
    // Los posts de demostracion no traen autor real: no hay a quien bloquear.
    if (!post.authorId) return;
    let autorizado = false;
    await requireAuth('para bloquear a alguien', () => {
      autorizado = true;
    });
    if (!autorizado) return;
    const accepted = await confirm({
      title: `Bloquear a ${post.author}`,
      message:
        'Dejaréis de seguiros y no volverás a ver sus publicaciones. ' +
        'Puedes deshacerlo desde Ajustes › Cuentas bloqueadas.',
      confirmLabel: 'Bloquear',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await ProfileRepository.block(post.authorId);
      toast('Cuenta bloqueada.', 'slash');
      onRemoved?.();
    } catch {
      notify('No se pudo bloquear', 'Inténtalo de nuevo.');
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Pressable
          style={styles.headerInfo}
          onPress={() => irAlPerfil(router, post.authorId)}
          disabled={!post.authorId}
          accessibilityRole="button"
          accessibilityLabel={`Ver perfil de ${post.author}`}
        >
          <ExpoImage
            source={post.authorAvatarUrl ? { uri: post.authorAvatarUrl } : assets.avatar}
            style={styles.avatar}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
          <View style={{ flex: 1 }}>
            <Text variant="body" weight="700">{post.author}</Text>
            <Text variant="secondary" color={colors.textMuted}>{post.username} · {post.createdAt}</Text>
          </View>
        </Pressable>
        <Pressable
          onPress={() => setMenuOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Más opciones"
        >
          <Feather name="more-horizontal" size={20} color={colors.textMuted} />
        </Pressable>
      </View>

      <Text variant="body" style={styles.body}>{post.body}</Text>
      {post.mediaType === 'video' ? (
        /*
          16:9 en vez de una caja fija: la mayoria de videos son apaisados y
          con alto fijo quedaban con franjas negras arriba y abajo.

          El reproductor SOLO existe despues de pulsar play y mientras la
          publicacion esta en pantalla. Antes se montaba uno por cada video
          visible del muro: cada reproductor reserva memoria y ADEMAS empieza a
          descargar su buffer aunque nadie le haya dado a play. Con el poster
          delante, pasar por el muro no cuesta ni un byte de video, y la
          memoria de reproductores queda en cero hasta que alguien mira uno.
        */
        montarReproductor && videoSource ? (
          <View style={styles.video}>
            <VideoPlayer
              uri={videoSource.uri}
              poster={post.posterUrl ? { uri: post.posterUrl } : undefined}
              posterCacheKey={post.posterPath}
              cacheToDisk={!videoSource.isStream}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              visible={visible}
              /*
                En el muro manda `active`: reproduce el protagonista y deja
                preparado —pero parado— al siguiente. Fuera del muro sigue
                mandando el toque de la persona (autoPlay tras pulsar).
              */
              active={autoFeed ? videoActive : undefined}
              autoPlay={!autoFeed}
              muted={autoFeed ? feedMuted : false}
              /*
                Sin botonera del sistema en el muro: tapa el video y desentona
                con una reproduccion que empieza sola. En su lugar, los mismos
                controles del formato corto: un toque pausa o reanuda y abajo
                queda una barra fina de avance.
              */
              nativeControls={!autoFeed}
              shortsControls={autoFeed}
              /*
                Sin circulo de play en el muro: el video arranca solo, asi que
                ese boton solo conseguia que pareciera parado mientras cargaba
                —y en el que espera turno, que pareciera que hay que pulsarlo.
                Reaparece si la persona pausa a mano, para poder reanudar.
              */
              hidePlayButton={autoFeed}
              /*
                Los navegadores no dejan arrancar con sonido si la persona aun
                no ha tocado la pagina: el reproductor se silencia solo para
                poder empezar y lo avisa por aqui. Sin recoger ese aviso, el
                boton diria que hay audio mientras no se oye nada.
              */
              onMutedChange={
                autoFeed
                  ? () => {
                      if (!feedMuted) toggleFeedMuted();
                    }
                  : undefined
              }
            />
            {autoFeed ? (
              /*
                Sonido. Arranca en silencio —igual que Instagram— y este boton
                es la forma de activarlo. El estado lo lleva el ICONO (tachado
                o con ondas), no un color, para que se entienda sin depender de
                distinguir tonos.
              */
              <Pressable
                onPress={toggleFeedMuted}
                hitSlop={10}
                style={[
                  styles.soundButton,
                  { backgroundColor: mediaPalette.overlay, borderColor: mediaPalette.border },
                ]}
                accessibilityRole="switch"
                accessibilityState={{ checked: !feedMuted }}
                accessibilityLabel={feedMuted ? 'Activar el sonido' : 'Silenciar'}
              >
                <Feather
                  name={feedMuted ? 'volume-x' : 'volume-2'}
                  size={16}
                  color={mediaPalette.text}
                />
              </Pressable>
            ) : null}
          </View>
        ) : (
          <Pressable
            style={styles.video}
            onPress={() => setVideoStarted(true)}
            disabled={autoFeed}
            accessibilityRole={autoFeed ? 'image' : 'button'}
            accessibilityLabel={autoFeed ? 'Video' : 'Reproducir video'}
          >
            {/*
              `uri` importa aunque no haya reproductor: en el navegador la
              celda pinta con el el PRIMER FOTOGRAMA del video (pidiendo solo
              la cabecera del archivo, no el video entero). Sin el quedaba un
              rectangulo negro, que es justo lo que se veia en el muro
              mientras los videos no tengan miniatura guardada.
            */}
            <VideoTile
              uri={post.mediaUrl}
              posterUrl={post.posterUrl}
              posterCacheKey={post.posterPath}
            />
            {/*
              El circulo de play solo donde hay que pulsar para arrancar. En el
              muro el video se reproduce solo, asi que un boton de play seria
              una instruccion falsa.
            */}
            {!autoFeed ? (
              <View style={styles.playOverlay} pointerEvents="none">
                <View
                  style={[
                    styles.playCircle,
                    { backgroundColor: mediaPalette.overlay, borderColor: mediaPalette.text },
                  ]}
                >
                  <Feather name="play" size={30} color={mediaPalette.text} />
                </View>
              </View>
            ) : null}
          </Pressable>
        )
      ) : post.mediaType === 'audio' && post.mediaUrl ? (
        <AudioPlayer uri={post.mediaUrl} title={`Audio de ${post.author}`} />
      ) : post.mediaUrl || post.imageKey ? (
        <DoubleTapLike
          onDoubleTap={() =>
            void requireAuth('para dar me gusta', () => {
              if (!liked) toggleLike(post.id);
            })
          }
          onSingleTap={() => router.push(`/post/${post.id}` as never)}
        >
          {/* El alto lo marca la foto (ver PostImage), no una caja fija. */}
          <PostImage
            uri={post.mediaUrl ?? undefined}
            source={post.mediaUrl ? undefined : assets[post.imageKey!]}
            cacheKey={post.mediaPath}
            width={post.mediaWidth}
            height={post.mediaHeight}
          />
        </DoubleTapLike>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          style={styles.action}
          hitSlop={ACTION_HIT_SLOP}
          onPress={() =>
            void requireAuth('para dar me gusta', () => {
              toggleLike(post.id);
              haptics.light();
            })
          }
          accessibilityLabel="Me gusta"
          accessibilityRole="button"
        >
          <Feather name="heart" size={20} color={liked ? colors.danger : colors.text} />
          <Text variant="secondary" weight="600" style={styles.count}>{post.likes}</Text>
        </Pressable>
        <Pressable
          style={styles.action}
          hitSlop={ACTION_HIT_SLOP}
          onPress={openComments}
          accessibilityLabel="Comentarios"
          accessibilityRole="button"
        >
          <Feather name="message-square" size={18} color={colors.text} />
          <Text variant="secondary" weight="600" style={styles.count}>{commentCount}</Text>
        </Pressable>
        <Pressable
          style={styles.action}
          hitSlop={ACTION_HIT_SLOP}
          onPress={sharePost}
          accessibilityLabel="Compartir"
          accessibilityRole="button"
        >
          <Feather name="share-2" size={19} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => void requireAuth('para guardar contenido', () => toggleSave(post.id))}
          hitSlop={ACTION_HIT_SLOP}
          accessibilityLabel="Guardar"
          accessibilityRole="button"
        >
          <Feather name="bookmark" size={19} color={saved ? colors.text : colors.textMuted} />
        </Pressable>
      </View>

      {showComments ? (
        <View style={[styles.comments, { borderTopColor: colors.border }]}>
          {post.comments.map((item) => (
            <View key={item.id} style={{ marginBottom: spacing.sm }}>
              <Text variant="secondary" weight="700">{item.author}</Text>
              <Text variant="body" color={colors.textMuted}>{item.text}</Text>
            </View>
          ))}
          <View style={styles.commentInputRow}>
            <TextInput
              value={comment}
              onChangeText={setComment}
              placeholder="Añade un comentario…"
              placeholderTextColor={colors.textMuted}
              style={[styles.commentInput, { color: colors.text, backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
              returnKeyType="send"
              onSubmitEditing={() => void submitComment()}
            />
            <Pressable
              onPress={() => void submitComment()}
              disabled={!comment.trim()}
              hitSlop={ACTION_HIT_SLOP}
              accessibilityLabel="Enviar comentario"
              accessibilityRole="button"
            >
              <Feather name="arrow-up-circle" size={30} color={comment.trim() ? colors.text : colors.border} />
            </Pressable>
          </View>
        </View>
      ) : null}

      <BottomSheet visible={menuOpen} onClose={() => setMenuOpen(false)}>
        {!isOwn && post.authorId ? (
          <ListRow
            title={`Ver perfil de ${post.author}`}
            leftIcon="user"
            onPress={() => {
              setMenuOpen(false);
              irAlPerfil(router, post.authorId);
            }}
          />
        ) : null}
        <ListRow
          title={saved ? 'Quitar de guardados' : 'Guardar'}
          leftIcon="bookmark"
          onPress={() => {
            setMenuOpen(false);
            toggleSave(post.id);
          }}
        />
        <ListRow
          title="Compartir"
          leftIcon="share-2"
          onPress={() => closeMenuThen(sharePost)}
        />
        {isOwn ? (
          <>
            <ListRow
              title="Editar publicación"
              leftIcon="edit-2"
              onPress={() =>
                closeMenuThen(() => router.push(`/edit-post/${post.id}` as never))
              }
            />
            <ListRow
              title="Eliminar publicación"
              leftIcon="trash-2"
              destructive
              onPress={() => closeMenuThen(() => void deleteOwnPost())}
            />
          </>
        ) : (
          <>
            <ListRow
              title="Reportar publicación"
              leftIcon="flag"
              destructive
              onPress={() => closeMenuThen(() => void reportPost())}
            />
            <ListRow
              title={`Bloquear a ${post.author}`}
              leftIcon="slash"
              destructive
              onPress={() => closeMenuThen(() => void blockAuthor())}
            />
          </>
        )}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden', marginBottom: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  headerInfo: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  image: { width: '100%', height: 340 },
  video: { width: '100%', aspectRatio: 16 / 9 },
  actions: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.lg },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  count: { marginLeft: 2 },
  playOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  // Arriba a la derecha: no estorba al contenido ni a la barra de avance.
  soundButton: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  comments: { borderTopWidth: 1, padding: spacing.lg },
  commentInputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  commentInput: { flex: 1, height: 40, borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: spacing.lg, fontSize: 13 },
});

/*
  La comparacion por omision (superficial) es la correcta aqui: `post` viene del
  estado global y conserva su identidad mientras no cambie de verdad —dar un
  «me gusta» crea un objeto nuevo, y entonces SI hay que repintar—, y el resto
  de propiedades son booleanos.
*/
export const PostCard = memo(PostCardBase);
