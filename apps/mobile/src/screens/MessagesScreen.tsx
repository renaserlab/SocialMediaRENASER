import React, { useCallback, useState } from 'react';
import { Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
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
  const [refreshing, setRefreshing] = useState(false);

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

  // Sin espera artificial: `load()` ya gestiona su propio estado de carga.
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
    setRefreshing(false);
  }, [load]);

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
      <FlashList
        data={uiState === 'content' ? filteredConversations : []}
        keyExtractor={(item: Conversation) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} colors={[colors.text]} />
        }
        ListHeaderComponent={
          <View style={styles.searchWrapper}>
            <Input
              placeholder="Buscar mensajes..."
              value={searchText}
              onChangeText={setSearchText}
              placeholderTextColor={colors.textMuted}
              // Deja hueco para la lupa: sin esto el texto arranca debajo de ella.
              style={styles.searchInput}
            />
            <View style={styles.searchIcon} pointerEvents="none">
              <Feather name="search" size={18} color={colors.textMuted} />
            </View>
          </View>
        }
        ListEmptyComponent={
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
          />
        }
        renderItem={({ item: conversation }: { item: Conversation }) => (
              <Pressable
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
                {/*
                  La foto real de la otra persona. Antes se elegia una imagen
                  de muestra segun la POSICION de la fila (la primera una, la
                  segunda otra...), asi que no correspondia con nadie: quien
                  tenia foto salia con la de otro.
                */}
                <Image
                  source={conversation.avatarUrl ? { uri: conversation.avatarUrl } : assets.avatar}
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
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: 100 },
  searchWrapper: {
    position: 'relative',
    marginBottom: spacing.md,
  },
  // El texto ya empieza en el margen del campo, donde tambien esta la lupa; se
  // desplaza el ancho del icono (18) mas un respiro (8) para que no se pisen.
  searchInput: {
    paddingLeft: 18 + spacing.sm,
  },
  // top/bottom a 0 centra la lupa verticalmente sea cual sea el alto del campo,
  // sin depender de un desplazamiento fijo que se descuadra si cambia la fuente.
  searchIcon: {
    position: 'absolute',
    left: spacing.md,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg, borderBottomWidth: 1 },
  avatar: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: '#DDD' },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: 14, fontWeight: '800' },
  time: { fontSize: 10 },
  subtitle: { fontSize: 12, marginTop: 4 },
  badge: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
