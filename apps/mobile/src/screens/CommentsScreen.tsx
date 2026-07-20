import React, { useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { Avatar } from '@/components/Avatar';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type CommentItem = {
  id: string;
  author: string;
  username: string;
  text: string;
  time: string;
};

const initialComments: CommentItem[] = [
  { id: '1', author: 'Sophia V.', username: '@sophia', text: 'Esto cambia completamente mi perspectiva.', time: 'Hace 2 h' },
  { id: '2', author: 'Daniel M.', username: '@daniel', text: '¡Excelente lección! Totalmente recomendado.', time: 'Hace 5 h' },
  { id: '3', author: 'Esteban R.', username: '@esteban', text: 'Aplicando esto desde hoy mismo.', time: 'Hace 1 d' },
];

export function CommentsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [comments, setComments] = useState<CommentItem[]>(initialComments);
  const [inputText, setInputText] = useState('');

  const sendComment = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    const newComment: CommentItem = {
      id: `comment-${Date.now()}`,
      author: 'Katherine Béjar',
      username: '@katherine',
      text: trimmed,
      time: 'Ahora',
    };
    setComments([newComment, ...comments]);
    setInputText('');
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <AppHeader title="Comentarios" onBack={() => router.back()} />
      <View style={styles.container}>
        <FlatList
          data={comments}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={[styles.commentRow, { borderBottomColor: colors.border }]}>
              <Avatar size={36} image="avatar" />
              <View style={styles.textContainer}>
                <View style={styles.commentHeader}>
                  <Text style={[styles.author, { color: colors.text }]}>{item.author}</Text>
                  <Text style={[styles.time, { color: colors.textMuted }]}>{item.time}</Text>
                </View>
                <Text style={[styles.commentText, { color: colors.text }]}>{item.text}</Text>
              </View>
            </View>
          )}
        />
        <View style={[styles.inputBar, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
          <Input
            placeholder="Escribe un comentario..."
            value={inputText}
            onChangeText={setInputText}
            containerStyle={styles.inputContainer}
          />
          <Button
            label="Enviar"
            variant="ghost"
            onPress={sendComment}
            disabled={!inputText.trim()}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
  },
  listContent: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  commentRow: {
    flexDirection: 'row',
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    gap: spacing.md,
  },
  textContainer: {
    flex: 1,
  },
  commentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  author: {
    fontSize: 13,
    fontWeight: '700',
  },
  time: {
    fontSize: 10,
  },
  commentText: {
    fontSize: 13,
    lineHeight: 18,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  inputContainer: {
    flex: 1,
  },
});
