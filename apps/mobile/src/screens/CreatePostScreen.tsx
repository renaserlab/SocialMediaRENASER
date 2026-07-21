import React, { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { AppHeader } from '@/components/AppHeader';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { VideoPlayer } from '@/components/VideoPlayer';
import {
  pickAudio,
  pickImage,
  pickVideo,
  uploadPostMedia,
  type PickedMedia,
} from '@/services/storage';
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
  const [media, setMedia] = useState<PickedMedia | null>(null);
  const [publishing, setPublishing] = useState(false);

  /** Elige un medio (imagen, video o audio) y lo deja listo para publicar. */
  const choose = async (kind: 'image' | 'video' | 'audio') => {
    if (!supabaseEnabled) {
      notify(
        'Adjuntos',
        'Conecta Supabase para adjuntar imágenes, videos o audios a tus publicaciones.',
      );
      return;
    }
    try {
      const picked =
        kind === 'image'
          ? await pickImage()
          : kind === 'video'
          ? await pickVideo()
          : await pickAudio();
      if (picked) setMedia(picked);
    } catch {
      notify('No se pudo abrir el selector', 'Revisa los permisos e inténtalo de nuevo.');
    }
  };

  const publish = async () => {
    if (!text.trim()) {
      notify('Escribe algo', 'Comparte una reflexión antes de publicar.');
      return;
    }
    setPublishing(true);
    try {
      const uploaded = media && supabaseEnabled ? [await uploadPostMedia(media)] : [];
      await createPost(text, uploaded);
      setText('');
      setMedia(null);
      // `navigate` conmuta de pestaña conservando el historial; `replace` lo
      // sustituía y el gesto atrás de Android podía cerrar la app.
      router.navigate('/(tabs)/home');
    } catch (error) {
      notify(
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
                  onPress={() => choose('image')}
                  accessibilityRole="button"
                  accessibilityLabel="Adjuntar imagen"
                  hitSlop={8}
                >
                  <Feather
                    name="image"
                    size={20}
                    color={media?.kind === 'image' ? colors.primary : colors.textMuted}
                  />
                </Pressable>
                <Pressable
                  onPress={() => choose('video')}
                  accessibilityRole="button"
                  accessibilityLabel="Adjuntar video"
                  hitSlop={8}
                >
                  <Feather
                    name="video"
                    size={20}
                    color={media?.kind === 'video' ? colors.primary : colors.textMuted}
                  />
                </Pressable>
                <Pressable
                  onPress={() => choose('audio')}
                  accessibilityRole="button"
                  accessibilityLabel="Adjuntar audio"
                  hitSlop={8}
                >
                  <Feather
                    name="mic"
                    size={20}
                    color={media?.kind === 'audio' ? colors.primary : colors.textMuted}
                  />
                </Pressable>
              </View>
              <Text style={[styles.counter, { color: colors.textMuted }]}>{text.length}/700</Text>
            </View>
          </View>

          {media && (
            <View style={styles.previewWrap}>
              {media.kind === 'image' ? (
                <Image source={{ uri: media.uri }} style={styles.preview} resizeMode="cover" />
              ) : media.kind === 'video' ? (
                <VideoPlayer uri={media.uri} style={styles.preview} nativeControls muted />
              ) : (
                <View
                  style={[
                    styles.audioPreview,
                    { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
                  ]}
                >
                  <Feather name="music" size={22} color={colors.text} />
                  <Text numberOfLines={1} style={[styles.audioName, { color: colors.text }]}>
                    {media.name ?? 'Audio seleccionado'}
                  </Text>
                </View>
              )}
              <Pressable
                onPress={() => setMedia(null)}
                style={styles.removeBtn}
                accessibilityRole="button"
                accessibilityLabel="Quitar adjunto"
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
  preview: { width: '100%', height: 200, borderRadius: radius.lg, overflow: 'hidden' },
  audioPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 72,
  },
  audioName: { flex: 1, fontSize: 13, fontWeight: '600' },
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
