import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { useConversation } from '@/hooks/useConversations';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function ChatScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const sendMessage = useAppStore((state) => state.sendMessage);

  // Conversación vía la capa de repositorio; se lee del store (reactivo: los
  // mensajes enviados aparecen al instante).
  const { conversation, loading } = useConversation(params.id);

  const [text, setText] = useState('');

  const submit = () => {
    if (!conversation) return;
    sendMessage(conversation.id, text);
    setText('');
  };

  if (loading && !conversation) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Conversación" onBack={() => router.back()} />
        <StateView state="loading" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={conversation?.name ?? 'Conversación'}
        rightIcon="video"
        onBack={() => router.back()}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <ScrollView contentContainerStyle={styles.messages} showsVerticalScrollIndicator={false}>
          {conversation?.messages.map((message) => {
            const mine = message.sender === 'me';
            return (
              <View
                key={message.id}
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
                  {message.text}
                </Text>
                <Text
                  style={{
                    color: mine ? colors.onPrimary : colors.textMuted,
                    fontSize: 9,
                    marginTop: 5,
                    opacity: 0.75,
                  }}
                >
                  {message.createdAt}
                </Text>
              </View>
            );
          })}
        </ScrollView>
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
            <Feather
              name="send"
              size={20}
              color={text.trim() ? colors.text : colors.border}
            />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  messages: { padding: spacing.lg, gap: spacing.md, flexGrow: 1, justifyContent: 'flex-end' },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, padding: spacing.md, borderWidth: 1 },
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
