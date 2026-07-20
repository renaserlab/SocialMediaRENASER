import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Input } from '@/components/Input';
import { VideoPlayer } from '@/components/VideoPlayer';
import { assets } from '@/data/assets';
import { SAMPLE_VIDEO_URL } from '@/data/media';
import { useAppStore } from '@/store/useAppStore';
import { palette, radius, spacing } from '@/theme/tokens';

// Superficie full-bleed sobre video → contexto de media (siempre oscuro).
const media = palette('dark');

export function LiveScreen() {
  const router = useRouter();
  const messages = useAppStore((state) => state.liveMessages);
  const send = useAppStore((state) => state.sendLiveMessage);
  const [text, setText] = useState('');

  const submit = () => {
    send(text);
    setText('');
  };

  return (
    <View style={styles.background}>
      {/* Transmisión en vivo (video real, autoplay + loop, silenciado) */}
      <VideoPlayer
        uri={SAMPLE_VIDEO_URL}
        poster={assets.speaker}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        loop
        autoPlay
        muted
        nativeControls={false}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: media.overlay }]} pointerEvents="none" />
      <SafeAreaView style={styles.safe}>
        <View style={styles.top}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            accessibilityLabel="Salir de sala"
            accessibilityRole="button"
            style={[styles.backButton, { backgroundColor: media.overlay }]}
          >
            <Feather name="arrow-left" size={24} color={media.text} />
          </Pressable>

          <View style={styles.liveMeta}>
            <View style={[styles.liveBadge, { backgroundColor: media.danger }]}>
              <View style={[styles.liveDot, { backgroundColor: media.text }]} />
              <Text style={[styles.liveText, { color: media.text }]}>EN VIVO</Text>
            </View>
            <View style={[styles.viewers, { backgroundColor: media.overlay }]}>
              <Feather name="eye" size={14} color={media.text} />
              <Text style={[styles.viewerText, { color: media.text }]}>1,245</Text>
            </View>
          </View>
        </View>

        <View style={styles.spacer} />

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={styles.chat} contentContainerStyle={{ gap: 8 }} showsVerticalScrollIndicator={false}>
            {messages.slice(-8).map((message) => (
              <Text key={message.id} style={[styles.message, { color: media.text }]}>
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
              placeholderTextColor={media.textMuted}
              containerStyle={styles.inputContainer}
              style={{ color: media.text, minHeight: 44 }}
            />
            <Pressable
              onPress={submit}
              disabled={!text.trim()}
              style={[styles.send, { backgroundColor: media.overlay, borderColor: media.textMuted }]}
              accessibilityLabel="Enviar mensaje"
              accessibilityRole="button"
            >
              <Feather name="send" size={18} color={media.text} />
            </Pressable>
            <Pressable
              style={[styles.send, { backgroundColor: media.overlay, borderColor: media.textMuted }]}
              accessibilityLabel="Dar me gusta"
              accessibilityRole="button"
            >
              <Feather name="heart" size={18} color={media.text} />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, backgroundColor: media.background },
  safe: { flex: 1, padding: spacing.lg },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  viewers: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  viewerText: { fontSize: 11, fontWeight: '700' },
  spacer: { flex: 1 },
  chat: { maxHeight: 180, marginBottom: spacing.md },
  message: { fontSize: 13, lineHeight: 18, textShadowColor: media.background, textShadowRadius: 3 },
  author: { fontWeight: '900' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.sm },
  inputContainer: { flex: 1 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
