import React, { useState } from 'react';
import { Pressable, Share, StyleSheet, TextInput, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AudioPlayer } from '@/components/AudioPlayer';
import { BottomSheet } from '@/components/BottomSheet';
import { DoubleTapLike } from '@/components/DoubleTapLike';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { assets } from '@/data/assets';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { haptics } from '@/lib/haptics';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { ReportRepository } from '@/repositories/ReportRepository';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { Post } from '@/types';

/**
 * Los iconos de acción miden 18-20 px. Ampliamos el area tactil con hitSlop
 * (no con minHeight) para llegar a ~44 px sin alterar el layout de la fila.
 */
const ACTION_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 };

type Props = {
  post: Post;
  /**
   * La publicación deja de estar visible para quien mira: se ha borrado, o se
   * ha bloqueado a su autor. La pantalla anfitriona reacciona (p. ej. volver
   * atrás si la estaba mostrando en solitario).
   */
  onRemoved?: () => void;
};

export function PostCard({ post, onRemoved }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const [showComments, setShowComments] = useState(false);
  const [comment, setComment] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const liked = useAppStore((state) => state.likedPostIds.includes(post.id));
  const saved = useAppStore((state) => state.savedPostIds.includes(post.id));
  const toggleLike = useAppStore((state) => state.toggleLikePost);
  const toggleSave = useAppStore((state) => state.toggleSavePost);
  const addComment = useAppStore((state) => state.addComment);
  const loadCommentsFor = useAppStore((state) => state.loadCommentsFor);
  const deletePost = useAppStore((state) => state.deletePost);
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
      message: `"${post.body}" — ${post.author} en Renaser Social Media.`,
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
          onPress={() => post.authorId && router.push(`/profile/${post.authorId}` as never)}
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
      {post.mediaType === 'video' && post.mediaUrl ? (
        <VideoPlayer uri={post.mediaUrl} style={styles.image} nativeControls />
      ) : post.mediaType === 'audio' && post.mediaUrl ? (
        <AudioPlayer uri={post.mediaUrl} title={`Audio de ${post.author}`} />
      ) : post.mediaUrl || post.imageKey ? (
        <DoubleTapLike
          onDoubleTap={() => { if (!liked) toggleLike(post.id); }}
          onSingleTap={() => router.push(`/post/${post.id}` as never)}
        >
          <ExpoImage
            source={post.mediaUrl ? { uri: post.mediaUrl } : assets[post.imageKey!]}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={150}
            style={styles.image}
          />
        </DoubleTapLike>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          style={styles.action}
          hitSlop={ACTION_HIT_SLOP}
          onPress={() => { toggleLike(post.id); haptics.light(); }}
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
          onPress={() => toggleSave(post.id)}
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
              router.push(`/profile/${post.authorId}` as never);
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
  actions: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.lg },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  count: { marginLeft: 2 },
  comments: { borderTopWidth: 1, padding: spacing.lg },
  commentInputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  commentInput: { flex: 1, height: 40, borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: spacing.lg, fontSize: 13 },
});
