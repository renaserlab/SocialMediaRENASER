import React, { useEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { Avatar } from '@/components/Avatar';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { PostRepository } from '@/repositories/PostRepository';
import { ApiError } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Comment } from '@/types';

const demoComments: Comment[] = [
  { id: '1', author: 'Sophia V.', text: 'Esto cambia completamente mi perspectiva.', createdAt: 'Hace 2 h' },
  { id: '2', author: 'Daniel M.', text: '¡Excelente lección! Totalmente recomendado.', createdAt: 'Hace 5 h' },
  { id: '3', author: 'Esteban R.', text: 'Aplicando esto desde hoy mismo.', createdAt: 'Hace 1 d' },
];

export function CommentsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUser = useAppStore((state) => state.user);

  const [comments, setComments] = useState<Comment[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);

  const load = React.useCallback(async () => {
    if (!supabaseEnabled) {
      setComments(demoComments);
      setStatus('idle');
      return;
    }
    setStatus('loading');
    try {
      const data = await PostRepository.listComments(id);
      setComments([...data].reverse()); // más recientes primero
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }, [id, supabaseEnabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const sendComment = async () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;

    // Comentario optimista.
    const optimistic: Comment = {
      id: `tmp-${Date.now()}`,
      author: currentUser?.fullName ?? 'Tú',
      text: trimmed,
      createdAt: 'Ahora',
    };
    setComments((prev) => [optimistic, ...prev]);
    setInputText('');

    if (!supabaseEnabled) return;

    setSending(true);
    try {
      const saved = await PostRepository.addComment(id, trimmed);
      // Reemplaza el optimista por el real.
      setComments((prev) => prev.map((c) => (c.id === optimistic.id ? saved : c)));
    } catch (error) {
      // Si el post no existe (p. ej. un short), conservamos el optimista.
      if (!(error instanceof ApiError && error.status === 404)) {
        setComments((prev) => prev.filter((c) => c.id !== optimistic.id));
      }
    } finally {
      setSending(false);
    }
  };

  const uiState =
    status === 'loading' ? 'loading' : status === 'error' ? 'error' : comments.length === 0 ? 'empty' : 'content';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <AppHeader title="Comentarios" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <View style={styles.container}>
        <StateView
          state={uiState}
          onRetry={load}
          title={uiState === 'empty' ? 'Sé el primero en comentar' : undefined}
          description={uiState === 'empty' ? 'Aún no hay comentarios en esta publicación.' : undefined}
        >
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
                    <Text style={[styles.time, { color: colors.textMuted }]}>{item.createdAt}</Text>
                  </View>
                  <Text style={[styles.commentText, { color: colors.text }]}>{item.text}</Text>
                </View>
              </View>
            )}
          />
        </StateView>
        <View
          style={[
            styles.inputBar,
            {
              borderTopColor: colors.border,
              backgroundColor: colors.background,
              // Evita que el campo quede bajo la barra de gestos / home indicator.
              paddingBottom: spacing.md + insets.bottom,
            },
          ]}
        >
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
            loading={sending}
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
