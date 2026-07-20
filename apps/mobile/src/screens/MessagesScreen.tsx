import React, { useCallback, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { assets } from '@/data/assets';
import { MessageRepository } from '@/repositories/MessageRepository';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Conversation } from '@/types';

export function MessagesScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const demoConversations = useAppStore((state) => state.conversations);

  const [searchText, setSearchText] = useState('');
  const [remote, setRemote] = useState<Conversation[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');

  const load = useCallback(() => {
    if (!supabaseEnabled) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    MessageRepository.listConversations()
      .then((data) => {
        setRemote(data);
        setStatus('idle');
      })
      .catch(() => setStatus('error'));
  }, [supabaseEnabled]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const conversations = supabaseEnabled ? remote : demoConversations;

  const filteredConversations = conversations.filter((conv) =>
    conv.name.toLowerCase().includes(searchText.toLowerCase()) ||
    conv.subtitle.toLowerCase().includes(searchText.toLowerCase())
  );

  const hasMessages = filteredConversations.length > 0;
  const uiState = supabaseEnabled && status === 'loading'
    ? 'loading'
    : supabaseEnabled && status === 'error'
    ? 'error'
    : hasMessages
    ? 'content'
    : 'empty';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="MENSAJES"
        rightIcon="edit"
        onRightPress={() => {}}
      />
      <AppScreen contentStyle={{ paddingBottom: 100 }}>
        <View style={styles.container}>
          {/* Búsqueda interactiva */}
          <View style={styles.searchWrapper}>
            <Input
              placeholder="Buscar mensajes..."
              value={searchText}
              onChangeText={setSearchText}
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.searchIcon}>
              <Feather name="search" size={18} color={colors.textMuted} />
            </View>
          </View>

          <StateView
            state={uiState}
            onRetry={load}
            title={uiState === 'empty' ? 'No hay conversaciones' : undefined}
            description={
              uiState === 'empty'
                ? 'Inicia un chat desde el perfil de alguien.'
                : undefined
            }
            icon="message-square"
          >
            {filteredConversations.map((conversation, index) => (
              <Pressable
                key={conversation.id}
                onPress={() =>
                  router.push({
                    pathname: '/chat/[id]',
                    params: { id: conversation.id, name: conversation.name },
                  })
                }
                accessibilityRole="button"
                accessibilityLabel={`Chat con ${conversation.name}. ${conversation.subtitle}`}
                style={({ pressed }) => [
                  styles.row,
                  { borderBottomColor: colors.border, opacity: pressed ? 0.78 : 1 },
                ]}
              >
                <Image
                  source={index === 0 ? assets.avatar : index === 1 ? assets.circle : assets.speaker}
                  style={styles.avatar}
                />
                <View style={{ flex: 1 }}>
                  <View style={styles.nameRow}>
                    <Text style={[styles.name, { color: colors.text }]}>{conversation.name}</Text>
                    <Text style={[styles.time, { color: colors.textMuted }]}>
                      {conversation.time ?? conversation.messages.at(-1)?.createdAt}
                    </Text>
                  </View>
                  <Text numberOfLines={1} style={[styles.subtitle, { color: colors.textMuted }]}>
                    {conversation.subtitle}
                  </Text>
                </View>
                {conversation.unread > 0 ? (
                  <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                    <Text style={{ color: colors.onPrimary, fontSize: 10, fontWeight: '700' }}>
                      {conversation.unread}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            ))}
          </StateView>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  searchWrapper: {
    position: 'relative',
    marginBottom: spacing.md,
  },
  searchIcon: {
    position: 'absolute',
    left: spacing.md,
    top: 15,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg, borderBottomWidth: 1 },
  avatar: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: '#DDD' },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: 14, fontWeight: '800' },
  time: { fontSize: 10 },
  subtitle: { fontSize: 12, marginTop: 4 },
  badge: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
