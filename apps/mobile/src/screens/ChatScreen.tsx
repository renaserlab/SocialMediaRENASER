import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { Input } from '@/components/Input';
import { toMessageFromRow } from '@/mappers/messageMapper';
import { MessageRepository } from '@/repositories/MessageRepository';
import { subscribeToConversation } from '@/services/realtime';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Message } from '@/types';

export function ChatScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
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

  // Carga inicial + suscripción Realtime a los mensajes de la conversación.
  useEffect(() => {
    if (!supabaseEnabled || !params.id) return;
    let mounted = true;

    MessageRepository.listMessages(params.id, currentUserId)
      .then((msgs) => {
        if (mounted) setRemoteMessages(msgs);
      })
      .catch(() => {});
    MessageRepository.markRead(params.id).catch(() => {});

    const unsubscribe = subscribeToConversation(params.id, (row) => {
      setRemoteMessages((prev) =>
        prev.some((m) => m.id === row.id)
          ? prev
          : [...prev, toMessageFromRow(row, currentUserId)],
      );
      MessageRepository.markRead(params.id).catch(() => {});
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [supabaseEnabled, params.id, currentUserId]);

  const headerName = params.name ?? demoConversation?.name ?? 'Conversación';
  const messages = supabaseEnabled ? remoteMessages : demoConversation?.messages ?? [];

  const submit = async () => {
    const body = text.trim();
    if (!body) return;

    if (!supabaseEnabled) {
      if (demoConversation) sendMessageDemo(demoConversation.id, body);
      setText('');
      return;
    }

    setText('');
    const tempId = `tmp-${Date.now()}`;
    setRemoteMessages((prev) => [
      ...prev,
      { id: tempId, text: body, sender: 'me', createdAt: '' },
    ]);
    try {
      const saved = await MessageRepository.sendMessage(params.id, body, currentUserId);
      setRemoteMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId && m.id !== saved.id),
        saved,
      ]);
    } catch {
      setRemoteMessages((prev) => prev.filter((m) => m.id !== tempId));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={headerName} rightIcon="video" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <FlashList
          data={messages}
          keyExtractor={(item: Message) => item.id}
          contentContainerStyle={styles.messages}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }: { item: Message }) => {
            const mine = item.sender === 'me';
            return (
              <View
                style={[
                  styles.bubble,
                  mine ? styles.mine : styles.theirs,
                  {
                    backgroundColor: mine ? colors.primary : colors.surface,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text style={{ color: mine ? colors.onPrimary : colors.text, fontSize: 14, lineHeight: 20 }}>
                  {item.text}
                </Text>
                <Text
                  style={{
                    color: mine ? colors.onPrimary : colors.textMuted,
                    fontSize: 9,
                    marginTop: 5,
                    opacity: 0.75,
                  }}
                >
                  {item.createdAt}
                </Text>
              </View>
            );
          }}
        />
        <View style={[styles.inputBar, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
          <Pressable
            accessibilityLabel="Adjuntar archivo"
            accessibilityRole="button"
            style={styles.addButton}
          >
            <Feather name="plus" size={24} color={colors.text} />
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
            disabled={!text.trim()}
            style={styles.sendButton}
            accessibilityLabel="Enviar mensaje"
            accessibilityRole="button"
          >
            <Feather name="send" size={20} color={text.trim() ? colors.text : colors.border} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  // FlashList solo admite padding en contentContainerStyle (nada de gap/flexGrow).
  messages: { padding: spacing.lg },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, marginBottom: spacing.md },
  mine: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
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
