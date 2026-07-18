import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { ImageBackground, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';

export function LiveScreen() {
  const messages = useAppStore((state) => state.liveMessages);
  const send = useAppStore((state) => state.sendLiveMessage);
  const [text, setText] = useState('');

  const submit = () => {
    send(text);
    setText('');
  };

  return (
    <ImageBackground source={assets.speaker} style={styles.background} resizeMode="cover">
      <LinearGradient colors={['rgba(0,0,0,0.12)', 'rgba(0,0,0,0.38)', 'rgba(0,0,0,0.95)']} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.safe}>
        <View style={styles.top}>
          <View style={styles.liveBadge}><View style={styles.liveDot} /><Text style={styles.liveText}>EN VIVO</Text></View>
          <View style={styles.viewers}><Ionicons name="eye" size={14} color="#fff" /><Text style={styles.viewerText}>1,245</Text></View>
        </View>

        <View style={styles.spacer} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={styles.chat} contentContainerStyle={{ gap: 7 }} showsVerticalScrollIndicator={false}>
            {messages.slice(-8).map((message) => (
              <Text key={message.id} style={styles.message}><Text style={styles.author}>{message.author}  </Text>{message.text}</Text>
            ))}
          </ScrollView>
          <View style={styles.inputRow}>
            <TextInput
              value={text}
              onChangeText={setText}
              onSubmitEditing={submit}
              returnKeyType="send"
              placeholder="Escribe un mensaje..."
              placeholderTextColor="#BEBEBE"
              style={styles.input}
            />
            <Pressable onPress={submit} disabled={!text.trim()} style={styles.send}><Ionicons name="paper-plane-outline" size={23} color="#fff" /></Pressable>
            <Pressable style={styles.send}><Ionicons name="heart-outline" size={24} color="#fff" /></Pressable>
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
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#C92020', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 7 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
  liveText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  viewers: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 7 },
  viewerText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  spacer: { flex: 1 },
  chat: { maxHeight: 190, marginBottom: spacing.md },
  message: { color: '#fff', fontSize: 13, lineHeight: 18, textShadowColor: '#000', textShadowRadius: 3 },
  author: { fontWeight: '900' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: { flex: 1, height: 46, borderRadius: radius.pill, borderWidth: 1, borderColor: '#777', paddingHorizontal: spacing.lg, color: '#fff', backgroundColor: 'rgba(0,0,0,0.35)' },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#777', backgroundColor: 'rgba(0,0,0,0.35)' },
});
