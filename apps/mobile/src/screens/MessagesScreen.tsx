import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function MessagesScreen() {
  const { colors } = useAppTheme();
  const conversations = useAppStore((state) => state.conversations);

  return (
    <AppScreen contentStyle={{ paddingBottom: 100 }}>
      <AppHeader title="MENSAJES" rightIcon="create-outline" />
      <View style={styles.container}>
        <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name="search" size={19} color={colors.textMuted} />
          <TextInput placeholder="Buscar" placeholderTextColor={colors.textMuted} style={{ flex: 1, color: colors.text }} />
        </View>

        {conversations.map((conversation, index) => (
          <Pressable
            key={conversation.id}
            onPress={() => router.push(`/chat/${conversation.id}`)}
            style={[styles.row, { borderBottomColor: colors.border }]}
          >
            <Image source={index === 0 ? assets.avatar : index === 1 ? assets.circle : assets.speaker} style={styles.avatar} />
            <View style={{ flex: 1 }}>
              <View style={styles.nameRow}>
                <Text style={[styles.name, { color: colors.text }]}>{conversation.name}</Text>
                <Text style={[styles.time, { color: colors.textMuted }]}>{conversation.messages.at(-1)?.createdAt}</Text>
              </View>
              <Text numberOfLines={1} style={[styles.subtitle, { color: colors.textMuted }]}>{conversation.subtitle}</Text>
            </View>
            {conversation.unread > 0 ? <View style={[styles.badge, { backgroundColor: colors.primary }]}><Text style={{ color: colors.onPrimary, fontSize: 10 }}>{conversation.unread}</Text></View> : null}
          </Pressable>
        ))}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  search: { flexDirection: 'row', height: 46, borderRadius: radius.pill, borderWidth: 1, alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg, borderBottomWidth: 1 },
  avatar: { width: 54, height: 54, borderRadius: 27 },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: 14, fontWeight: '800' },
  time: { fontSize: 10 },
  subtitle: { fontSize: 12, marginTop: 5 },
  badge: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
