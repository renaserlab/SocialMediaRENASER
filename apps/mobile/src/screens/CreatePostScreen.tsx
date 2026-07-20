import React, { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const prompts = ['Un aprendizaje', 'Una pregunta', 'Una victoria', 'Una reflexión'];

export function CreatePostScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const createPost = useAppStore((state) => state.createPost);
  const [text, setText] = useState('');
  const [prompt, setPrompt] = useState(prompts[0]!);

  const publish = () => {
    if (!text.trim()) {
      Alert.alert('Escribe algo', 'Comparte una reflexión antes de publicar.');
      return;
    }
    createPost(text);
    setText('');
    router.replace('/(tabs)/home');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="CREAR" />
      <AppScreen contentStyle={{ paddingBottom: 100 }}>
        <View style={styles.container}>
          <Text style={[styles.title, { color: colors.text }]}>Comparte algo que pueda transformar a alguien.</Text>

          <View style={styles.chips}>
            {prompts.map((item) => (
              <Chip
                key={item}
                label={item}
                selected={prompt === item}
                onPress={() => setPrompt(item)}
              />
            ))}
          </View>

          <View style={[styles.editor, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.prompt, { color: colors.textMuted }]}>{prompt}</Text>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Hoy comprendí que..."
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={700}
              textAlignVertical="top"
              style={[styles.input, { color: colors.text }]}
              accessibilityLabel="Escribe tu publicación"
            />
            <View style={styles.editorFooter}>
              <View style={styles.mediaRow}>
                <Feather name="image" size={20} color={colors.textMuted} />
                <Feather name="video" size={20} color={colors.textMuted} />
                <Feather name="mic" size={20} color={colors.textMuted} />
              </View>
              <Text style={[styles.counter, { color: colors.textMuted }]}>{text.length}/700</Text>
            </View>
          </View>
          <Button label="Publicar" onPress={publish} disabled={!text.trim()} />
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '900', marginBottom: spacing.xl },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  editor: { minHeight: 280, borderWidth: 1, borderRadius: radius.xl, padding: spacing.lg, marginBottom: spacing.lg },
  prompt: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 },
  input: { flex: 1, fontSize: 16, lineHeight: 24, marginTop: spacing.md },
  editorFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
  mediaRow: { flexDirection: 'row', gap: spacing.lg },
  counter: { fontSize: 11 },
});
