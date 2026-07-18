import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function ChatScreen() {
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const conversations = useAppStore((state) => state.conversations);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const conversation = useMemo(() => conversations.find((item) => item.id === params.id), [conversations, params.id]);
  const [text, setText] = useState('');

  const submit = () => {
    if (!conversation) return;
    sendMessage(conversation.id, text);
    setText('');
  };

  return (
    <AppScreen scroll={false} edges={['top', 'left', 'right', 'bottom']}>
      <AppHeader back title={conversation?.name ?? 'Conversación'} rightIcon="videocam-outline" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={10}>
        <ScrollView contentContainerStyle={styles.messages} showsVerticalScrollIndicator={false}>
          {conversation?.messages.map((message) => {
            const mine = message.sender === 'me';
            return (
              <View key={message.id} style={[styles.bubble, mine ? styles.mine : styles.theirs, { backgroundColor: mine ? colors.primary : colors.surface, borderColor: colors.border }]}>
                <Text style={{ color: mine ? colors.onPrimary : colors.text, fontSize: 14, lineHeight: 20 }}>{message.text}</Text>
                <Text style={{ color: mine ? colors.onPrimary : colors.textMuted, fontSize: 9, marginTop: 5, opacity: 0.75 }}>{message.createdAt}</Text>
              </View>
            );
          })}
        </ScrollView>
        <View style={[styles.inputBar, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
          <Pressable><Ionicons name="add-circle-outline" size={28} color={colors.text} /></Pressable>
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={submit}
            placeholder="Mensaje"
            placeholderTextColor={colors.textMuted}
            returnKeyType="send"
            style={[styles.input, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
          />
          <Pressable onPress={submit} disabled={!text.trim()}><Ionicons name="send" size={24} color={text.trim() ? colors.text : colors.border} /></Pressable>
        </View>
      </KeyboardAvoidingView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  messages: { padding: spacing.lg, gap: spacing.md, flexGrow: 1, justifyContent: 'flex-end' },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, padding: spacing.md, borderWidth: 1 },
  mine: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
  inputBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderTopWidth: 1, padding: spacing.md },
  input: { flex: 1, height: 44, borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: spacing.lg },
});
