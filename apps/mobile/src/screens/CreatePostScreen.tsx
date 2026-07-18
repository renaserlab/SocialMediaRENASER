import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const prompts = ['Un aprendizaje', 'Una pregunta', 'Una victoria', 'Una reflexión'];

export function CreatePostScreen() {
  const { colors } = useAppTheme();
  const createPost = useAppStore((state) => state.createPost);
  const [text, setText] = useState('');
  const [prompt, setPrompt] = useState(prompts[0]);

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
    <AppScreen contentStyle={{ paddingBottom: 100 }}>
      <AppHeader title="CREAR" />
      <View style={styles.container}>
        <Text style={[styles.title, { color: colors.text }]}>Comparte algo que pueda transformar a alguien.</Text>
        <View style={styles.chips}>
          {prompts.map((item) => (
            <Pressable key={item} onPress={() => setPrompt(item)} style={[styles.chip, { backgroundColor: prompt === item ? colors.primary : colors.surface, borderColor: colors.border }]}>
              <Text style={{ color: prompt === item ? colors.onPrimary : colors.text, fontSize: 12, fontWeight: '700' }}>{item}</Text>
            </Pressable>
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
          />
          <View style={styles.editorFooter}>
            <View style={styles.mediaRow}>
              <Ionicons name="image-outline" size={23} color={colors.textMuted} />
              <Ionicons name="videocam-outline" size={23} color={colors.textMuted} />
              <Ionicons name="mic-outline" size={23} color={colors.textMuted} />
            </View>
            <Text style={[styles.counter, { color: colors.textMuted }]}>{text.length}/700</Text>
          </View>
        </View>
        <PrimaryButton label="Publicar" onPress={publish} disabled={!text.trim()} />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg },
  title: { fontSize: 27, lineHeight: 33, fontWeight: '900', marginBottom: spacing.xl },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1 },
  editor: { minHeight: 330, borderWidth: 1, borderRadius: radius.xl, padding: spacing.lg, marginBottom: spacing.lg },
  prompt: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 },
  input: { flex: 1, fontSize: 20, lineHeight: 29, marginTop: spacing.lg },
  editorFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mediaRow: { flexDirection: 'row', gap: spacing.lg },
  counter: { fontSize: 11 },
});
