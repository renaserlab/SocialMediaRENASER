import React, { useState } from 'react';
import { ImageBackground, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Input } from '@/components/Input';
import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function LiveScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const messages = useAppStore((state) => state.liveMessages);
  const send = useAppStore((state) => state.sendLiveMessage);
  const [text, setText] = useState('');

  const submit = () => {
    send(text);
    setText('');
  };

  return (
    <ImageBackground source={assets.speaker} style={styles.background} resizeMode="cover">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]} />
      <SafeAreaView style={styles.safe}>
        <View style={styles.top}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            accessibilityLabel="Salir de sala"
            accessibilityRole="button"
            style={styles.backButton}
          >
            <Feather name="arrow-left" size={24} color="#FFFFFF" />
          </Pressable>

          <View style={styles.liveMeta}>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>EN VIVO</Text>
            </View>
            <View style={styles.viewers}>
              <Feather name="eye" size={14} color="#fff" />
              <Text style={styles.viewerText}>1,245</Text>
            </View>
          </View>
        </View>

        <View style={styles.spacer} />

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={styles.chat} contentContainerStyle={{ gap: 8 }} showsVerticalScrollIndicator={false}>
            {messages.slice(-8).map((message) => (
              <Text key={message.id} style={styles.message}>
                <Text style={styles.author}>{message.author}  </Text>
                {message.text}
              </Text>
            ))}
          </ScrollView>

          <View style={styles.inputRow}>
            <Input
              value={text}
              onChangeText={setText}
              onSubmitEditing={submit}
              returnKeyType="send"
              placeholder="Escribe un mensaje..."
              placeholderTextColor="#BEBEBE"
              containerStyle={styles.inputContainer}
              style={{ color: '#FFFFFF', minHeight: 44 }}
            />
            <Pressable
              onPress={submit}
              disabled={!text.trim()}
              style={[styles.send, { borderColor: colors.border }]}
              accessibilityLabel="Enviar mensaje"
              accessibilityRole="button"
            >
              <Feather name="send" size={18} color="#fff" />
            </Pressable>
            <Pressable
              style={[styles.send, { borderColor: colors.border }]}
              accessibilityLabel="Dar me gusta"
              accessibilityRole="button"
            >
              <Feather name="heart" size={18} color="#fff" />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, backgroundColor: '#000' },
  safe: { flex: 1, padding: spacing.lg },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#B3261E', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  liveText: { color: '#fff', fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  viewers: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  viewerText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  spacer: { flex: 1 },
  chat: { maxHeight: 180, marginBottom: spacing.md },
  message: { color: '#fff', fontSize: 13, lineHeight: 18, textShadowColor: '#000', textShadowRadius: 3 },
  author: { fontWeight: '900' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.sm },
  inputContainer: { flex: 1 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
});
