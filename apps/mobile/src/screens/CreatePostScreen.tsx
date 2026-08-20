import React, { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { AppHeader } from '@/components/AppHeader';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { VideoPlayer } from '@/components/VideoPlayer';
import {
  pickAudio,
  pickImage,
  pickVideo,
  uploadPostMedia,
  type PickedMedia,
  type UploadProgress,
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
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const [text, setText] = useState('');
  const [prompt, setPrompt] = useState(prompts[0]!);
  const [media, setMedia] = useState<PickedMedia | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Un video puede tardar minutos: sin esto el boton solo gira y parece colgado.
  const [phase, setPhase] = useState<'idle' | 'compressing' | 'uploading' | 'posting'>('idle');
  const [progress, setProgress] = useState(0);

  /** Elige un medio (imagen, video o audio) y lo deja listo para publicar. */
  const choose = async (kind: 'image' | 'video' | 'audio') => {
    if (!supabaseEnabled) {
      setError('Conecta Supabase para adjuntar imágenes, videos o audios a tus publicaciones.');
      return;
    }
    try {
      const picked =
        kind === 'image'
          ? await pickImage()
          : kind === 'video'
          ? await pickVideo()
          : await pickAudio();
      if (picked) {
        setMedia(picked);
        setError(null);
      }
    } catch {
      setError('No se pudo abrir el selector. Revisa los permisos e inténtalo de nuevo.');
    }
  };

  const publish = async () => {
    if (!text.trim()) {
      setError('Comparte una reflexión antes de publicar.');
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      let uploaded: Awaited<ReturnType<typeof uploadPostMedia>>[] = [];
      if (media && supabaseEnabled) {
        const onProgress = ({ phase: p, ratio }: UploadProgress) => {
          setPhase(p);
          setProgress(ratio);
        };
        uploaded = [await uploadPostMedia(media, onProgress)];
      }
      setPhase('posting');
      setProgress(1);
      await createPost(text, uploaded);
      setText('');
      setMedia(null);
      // `navigate` conmuta de pestaña conservando el historial; `replace` lo
      // sustituía y el gesto atrás de Android podía cerrar la app.
      router.navigate('/(tabs)/home');
    } catch (err) {
      // Se muestra en la propia pantalla: Alert.alert es un no-op en web y el
      // motivo real del fallo (tamaño, permisos, tipo) se perdía en silencio.
      setError(err instanceof Error ? err.message : 'No se pudo publicar. Inténtalo de nuevo.');
    } finally {
      setPublishing(false);
      setPhase('idle');
      setProgress(0);
    }
  };

  // Publicar es la accion que mas claramente necesita una cuenta: lo que se
  // escribe queda firmado. Se explica en la propia pantalla en vez de saltar un
  // dialogo encima, que interrumpe sin decir donde se ha entrado.
  if (supabaseEnabled && !signedIn) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="CREAR" />
        <StateView
          state="empty"
          icon="edit-3"
          title="Crea tu cuenta para publicar"
          description="Puedes seguir explorando sin cuenta. Para compartir algo, necesitamos saber quién eres."
          actionLabel="Crear cuenta"
          onAction={() => router.push('/register' as never)}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="CREAR" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
      <AppScreen contentStyle={{ paddingBottom: 120 }}>
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

          {error && (
            <View style={[styles.errorBox, { backgroundColor: colors.surfaceAlt, borderColor: colors.danger }]}>
              <Feather name="alert-triangle" size={18} color={colors.danger} />
              <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
            </View>
          )}

          {publishing && phase !== 'idle' && (
            <View style={styles.progressWrap}>
              <View style={styles.progressHeader}>
                <Text style={[styles.progressLabel, { color: colors.textMuted }]}>
                  {phase === 'compressing'
                    ? 'Optimizando video…'
                    : phase === 'uploading'
                    ? 'Subiendo…'
                    : 'Publicando…'}
                </Text>
                {phase !== 'posting' && (
                  <Text style={[styles.progressLabel, { color: colors.textMuted }]}>
                    {Math.round(progress * 100)}%
                  </Text>
                )}
              </View>
              <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.max(2, progress * 100)}%`, backgroundColor: colors.primary },
                  ]}
                />
              </View>
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
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  errorText: { flex: 1, fontSize: 13, lineHeight: 18 },
  progressWrap: { marginBottom: spacing.lg, gap: spacing.sm },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  progressLabel: { fontSize: 12, fontWeight: '600' },
  progressTrack: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: radius.pill },
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
