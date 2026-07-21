import React, { useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import type { ImagePickerAsset } from 'expo-image-picker';

import { AppHeader } from '@/components/AppHeader';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { pickImage, uploadPostImage } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const prompts = ['Un aprendizaje', 'Una pregunta', 'Una victoria', 'Una reflexión'];

export function CreatePostScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const keyboardOffset = useKeyboardOffset();
  const createPost = useAppStore((state) => state.createPost);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const [text, setText] = useState('');
  const [prompt, setPrompt] = useState(prompts[0]!);
  const [image, setImage] = useState<ImagePickerAsset | null>(null);
  const [publishing, setPublishing] = useState(false);

  const chooseImage = async () => {
    if (!supabaseEnabled) {
      Alert.alert('Imágenes', 'Conecta Supabase para adjuntar imágenes a tus publicaciones.');
      return;
    }
    try {
      const asset = await pickImage();
      if (asset) setImage(asset);
    } catch {
      Alert.alert('No se pudo abrir la galería', 'Revisa los permisos e inténtalo de nuevo.');
    }
  };

  const publish = async () => {
    if (!text.trim()) {
      Alert.alert('Escribe algo', 'Comparte una reflexión antes de publicar.');
      return;
    }
    setPublishing(true);
    try {
      let imagePaths: string[] = [];
      if (image && supabaseEnabled) {
        imagePaths = [await uploadPostImage(image)];
      }
      await createPost(text, imagePaths);
      setText('');
      setImage(null);
      // `navigate` conmuta de pestaña conservando el historial; `replace` lo
      // sustituía y el gesto atrás de Android podía cerrar la app.
      router.navigate('/(tabs)/home');
    } catch (error) {
      Alert.alert(
        'No se pudo publicar',
        error instanceof Error ? error.message : 'Inténtalo de nuevo.',
      );
    } finally {
      setPublishing(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="CREAR" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
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
                <Pressable
                  onPress={chooseImage}
                  accessibilityRole="button"
                  accessibilityLabel="Adjuntar imagen"
                  hitSlop={8}
                >
                  <Feather name="image" size={20} color={image ? colors.primary : colors.textMuted} />
                </Pressable>
                <Feather name="video" size={20} color={colors.textMuted} />
                <Feather name="mic" size={20} color={colors.textMuted} />
              </View>
              <Text style={[styles.counter, { color: colors.textMuted }]}>{text.length}/700</Text>
            </View>
          </View>

          {image && (
            <View style={styles.previewWrap}>
              <Image source={{ uri: image.uri }} style={styles.preview} resizeMode="cover" />
              <Pressable
                onPress={() => setImage(null)}
                style={styles.removeBtn}
                accessibilityRole="button"
                accessibilityLabel="Quitar imagen"
                hitSlop={8}
              >
                <Feather name="x" size={16} color="#FFFFFF" />
              </Pressable>
            </View>
          )}

          <Button label="Publicar" onPress={publish} loading={publishing} disabled={!text.trim()} />
        </View>
      </AppScreen>
      </KeyboardAvoidingView>
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
  previewWrap: { position: 'relative', marginBottom: spacing.lg },
  preview: { width: '100%', height: 200, borderRadius: radius.lg },
  removeBtn: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
