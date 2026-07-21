import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { DoubleTapLike } from '@/components/DoubleTapLike';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { haptics } from '@/lib/haptics';
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

export function PostCard({ post }: { post: Post }) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const [showComments, setShowComments] = useState(false);
  const [comment, setComment] = useState('');
  const liked = useAppStore((state) => state.likedPostIds.includes(post.id));
  const saved = useAppStore((state) => state.savedPostIds.includes(post.id));
  const toggleLike = useAppStore((state) => state.toggleLikePost);
  const toggleSave = useAppStore((state) => state.toggleSavePost);
  const addComment = useAppStore((state) => state.addComment);
  const loadCommentsFor = useAppStore((state) => state.loadCommentsFor);

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

  const submitComment = () => {
    void addComment(post.id, comment);
    setComment('');
    setShowComments(true);
  };

  const reportPost = () => {
    Alert.alert('Reportar publicación', '¿Deseas reportar esta publicación?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Reportar',
        style: 'destructive',
        onPress: async () => {
          try {
            await ReportRepository.create({
              entityType: 'post',
              entityId: post.id,
              reportedUserId: post.authorId,
              reason: 'Contenido inapropiado',
            });
            Alert.alert('Gracias', 'Hemos recibido tu reporte.');
          } catch {
            Alert.alert('No se pudo enviar', 'Inténtalo de nuevo.');
          }
        },
      },
    ]);
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
          <ExpoImage source={assets.avatar} style={styles.avatar} contentFit="cover" />
          <View style={{ flex: 1 }}>
            <Text variant="body" weight="700">{post.author}</Text>
            <Text variant="secondary" color={colors.textMuted}>{post.username} · {post.createdAt}</Text>
          </View>
        </Pressable>
        <Pressable
          onPress={reportPost}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Más opciones"
        >
          <Feather name="more-horizontal" size={20} color={colors.textMuted} />
        </Pressable>
      </View>

      <Text variant="body" style={styles.body}>{post.body}</Text>
      {post.imageUrl || post.imageKey ? (
        <DoubleTapLike
          onDoubleTap={() => { if (!liked) toggleLike(post.id); }}
          onSingleTap={() => router.push(`/post/${post.id}` as never)}
        >
          <ExpoImage
            source={post.imageUrl ? { uri: post.imageUrl } : assets[post.imageKey!]}
            contentFit="cover"
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
              onSubmitEditing={submitComment}
            />
            <Pressable
              onPress={submitComment}
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
