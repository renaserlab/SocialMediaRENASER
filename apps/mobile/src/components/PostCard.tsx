import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { Post } from '@/types';

export function PostCard({ post }: { post: Post }) {
  const { colors } = useAppTheme();
  const [showComments, setShowComments] = useState(false);
  const [comment, setComment] = useState('');
  const liked = useAppStore((state) => state.likedPostIds.includes(post.id));
  const saved = useAppStore((state) => state.savedPostIds.includes(post.id));
  const toggleLike = useAppStore((state) => state.toggleLikePost);
  const toggleSave = useAppStore((state) => state.toggleSavePost);
  const addComment = useAppStore((state) => state.addComment);

  const submitComment = () => {
    addComment(post.id, comment);
    setComment('');
    setShowComments(true);
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Image source={assets.avatar} style={styles.avatar} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.author, { color: colors.text }]}>{post.author}</Text>
          <Text style={[styles.meta, { color: colors.textMuted }]}>{post.username} · {post.createdAt}</Text>
        </View>
        <Ionicons name="ellipsis-horizontal" size={20} color={colors.textMuted} />
      </View>

      <Text style={[styles.body, { color: colors.text }]}>{post.body}</Text>
      {post.imageKey ? (
        <Image source={assets[post.imageKey]} resizeMode="cover" style={styles.image} />
      ) : null}

      <View style={styles.actions}>
        <Pressable style={styles.action} onPress={() => toggleLike(post.id)}>
          <Ionicons name={liked ? 'heart' : 'heart-outline'} size={22} color={liked ? colors.danger : colors.text} />
          <Text style={[styles.count, { color: colors.text }]}>{post.likes}</Text>
        </Pressable>
        <Pressable style={styles.action} onPress={() => setShowComments((value) => !value)}>
          <Ionicons name="chatbubble-outline" size={20} color={colors.text} />
          <Text style={[styles.count, { color: colors.text }]}>{post.comments.length}</Text>
        </Pressable>
        <Pressable style={styles.action}>
          <Ionicons name="paper-plane-outline" size={21} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => toggleSave(post.id)}>
          <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={21} color={colors.text} />
        </Pressable>
      </View>

      {showComments ? (
        <View style={[styles.comments, { borderTopColor: colors.border }]}>
          {post.comments.map((item) => (
            <View key={item.id} style={{ marginBottom: spacing.sm }}>
              <Text style={[styles.commentAuthor, { color: colors.text }]}>{item.author}</Text>
              <Text style={[styles.commentText, { color: colors.textMuted }]}>{item.text}</Text>
            </View>
          ))}
          <View style={styles.commentInputRow}>
            <TextInput
              value={comment}
              onChangeText={setComment}
              placeholder="Escribe un comentario..."
              placeholderTextColor={colors.textMuted}
              style={[styles.commentInput, { color: colors.text, backgroundColor: colors.surfaceAlt }]}
              returnKeyType="send"
              onSubmitEditing={submitComment}
            />
            <Pressable onPress={submitComment} disabled={!comment.trim()}>
              <Ionicons name="arrow-up-circle" size={30} color={comment.trim() ? colors.text : colors.border} />
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
  avatar: { width: 42, height: 42, borderRadius: 21 },
  author: { fontWeight: '800', fontSize: 14 },
  meta: { fontSize: 11, marginTop: 2 },
  body: { fontSize: 15, lineHeight: 22, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  image: { width: '100%', height: 340 },
  actions: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.lg },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  count: { fontSize: 12, fontWeight: '600' },
  comments: { borderTopWidth: 1, padding: spacing.lg },
  commentAuthor: { fontSize: 12, fontWeight: '800' },
  commentText: { fontSize: 13, marginTop: 2 },
  commentInputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  commentInput: { flex: 1, height: 40, borderRadius: radius.pill, paddingHorizontal: spacing.lg, fontSize: 13 },
});
