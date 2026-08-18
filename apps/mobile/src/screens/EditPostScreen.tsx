import React, { useEffect, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { StateView } from '@/components/StateView';
import { VideoPlayer } from '@/components/VideoPlayer';
import { CATEGORIES, type CategoryId } from '@/data/categories';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { PostRepository } from '@/repositories/PostRepository';
import {
  pickAudio,
  pickImage,
  pickVideo,
  uploadPostMedia,
  type PickedMedia,
  type UploadProgress,
} from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

/**
 * Edicion de una publicacion propia: texto y adjunto.
 *
 * El adjunto se trata en tres estados para no perder informacion: `null` =
 * conservar el que ya tiene, `'remove'` = quitarlo, y un `PickedMedia` =
 * reemplazarlo. Enviar siempre el medio obligaria a resubirlo sin necesidad.
 */
type MediaChange = null | 'remove' | PickedMedia;

export function EditPostScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const keyboardOffset = useKeyboardOffset();
  const { id } = useLocalSearchParams<{ id: string }>();

  const posts = useAppStore((state) => state.posts);
  const setPosts = useAppStore((state) => state.setPosts);
  const currentUserId = useAppStore((state) => state.user?.id);

  const [post, setPost] = useState<Post | null>(null);
  const [text, setText] = useState('');
  const [media, setMedia] = useState<MediaChange>(null);
  /** Categoría, solo relevante en los audios (episodios del podcast). */
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<UploadProgress['phase'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    // Si viene del feed ya está en memoria; si se abre directo, se pide.
    const cached = posts.find((p) => p.id === id);
    if (cached) {
      setPost(cached);
      setText(cached.body);
      setCategory((cached.category as CategoryId | null) ?? null);
      setLoading(false);
      return;
    }
    let alive = true;
    /*
      Se pide la publicacion por su identificador.

      Antes se descargaban las 60 ultimas del autor para buscar una: pesaba de
      mas y, sobre todo, quien tuviera mas de sesenta publicaciones no podia
      editar las antiguas —la pantalla se quedaba vacia sin decir por que—.
    */
    PostRepository.getById(id, currentUserId)
      .then((found) => {
        if (!alive) return;
        setPost(found);
        setText(found.body);
        setCategory((found.category as CategoryId | null) ?? null);
      })
      .catch((error) => {
        console.warn('[editar publicacion] no se pudo cargar', error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, posts, currentUserId]);

  const choose = async (kind: 'image' | 'video' | 'audio') => {
    try {
      const picked =
        kind === 'image' ? await pickImage() : kind === 'video' ? await pickVideo() : await pickAudio();
      if (picked) setMedia(picked);
    } catch {
      setError('No se pudo abrir el selector.');
    }
  };

  const save = async () => {
    if (!post) return;
    if (!text.trim()) {
      setError('La publicación no puede quedarse vacía.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const changes: {
        body?: string;
        media?: Awaited<ReturnType<typeof uploadPostMedia>>[];
        category?: string | null;
      } = {};
      if (text.trim() !== post.body) changes.body = text.trim();
      if ((category ?? null) !== (post.category ?? null)) changes.category = category;
      if (media === 'remove') {
        changes.media = [];
      } else if (media) {
        const uploaded = await uploadPostMedia(media, (p) => setPhase(p.phase));
        changes.media = [uploaded];
      }

      if (Object.keys(changes).length === 0) {
        router.back();
        return;
      }

      const updated = await PostRepository.updatePost(post.id, changes, currentUserId);
      // Refleja el cambio en el feed sin tener que recargarlo entero.
      setPosts(posts.map((p) => (p.id === updated.id ? updated : p)));
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally {
      setSaving(false);
      setPhase(null);
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Editar publicación" back />
        <StateView state="loading" />
      </View>
    );
  }

  if (!post) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Editar publicación" back />
        <StateView state="empty" title="Publicación no encontrada" />
      </View>
    );
  }

  const keepsCurrentMedia = media === null && (post.mediaUrl || post.imageKey);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Editar publicación" back />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
        <AppScreen contentStyle={{ padding: spacing.lg, paddingBottom: 100 }}>
          <View style={[styles.editor, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              maxLength={700}
              textAlignVertical="top"
              style={[styles.input, { color: colors.text }]}
              accessibilityLabel="Texto de la publicación"
            />
            <View style={styles.mediaRow}>
              <Pressable onPress={() => choose('image')} hitSlop={8} accessibilityLabel="Cambiar por imagen">
                <Feather name="image" size={20} color={colors.textMuted} />
              </Pressable>
              <Pressable onPress={() => choose('video')} hitSlop={8} accessibilityLabel="Cambiar por video">
                <Feather name="video" size={20} color={colors.textMuted} />
              </Pressable>
              <Pressable onPress={() => choose('audio')} hitSlop={8} accessibilityLabel="Cambiar por audio">
                <Feather name="mic" size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          </View>

          {/* Adjunto actual o el nuevo elegido */}
          {media && media !== 'remove' ? (
            <View style={styles.previewWrap}>
              {media.kind === 'image' ? (
                <Image source={{ uri: media.uri }} style={styles.preview} resizeMode="cover" />
              ) : media.kind === 'video' ? (
                <VideoPlayer uri={media.uri} style={styles.preview} nativeControls muted />
              ) : (
                <View style={[styles.audioRow, { borderColor: colors.border }]}>
                  <Feather name="music" size={20} color={colors.text} />
                  <Text style={{ color: colors.text }}>{media.name ?? 'Audio seleccionado'}</Text>
                </View>
              )}
              <Pressable onPress={() => setMedia(null)} style={styles.removeBtn} accessibilityLabel="Descartar cambio">
                <Feather name="x" size={16} color="#FFFFFF" />
              </Pressable>
            </View>
          ) : keepsCurrentMedia ? (
            <View style={styles.previewWrap}>
              {post.mediaType === 'video' && post.mediaUrl ? (
                <VideoPlayer uri={post.mediaUrl} style={styles.preview} nativeControls />
              ) : post.mediaUrl ? (
                <Image source={{ uri: post.mediaUrl }} style={styles.preview} resizeMode="cover" />
              ) : null}
              <Pressable
                onPress={() => setMedia('remove')}
                style={styles.removeBtn}
                accessibilityLabel="Quitar adjunto"
              >
                <Feather name="trash-2" size={15} color="#FFFFFF" />
              </Pressable>
            </View>
          ) : media === 'remove' ? (
            <Text style={[styles.removedNote, { color: colors.textMuted }]}>
              El adjunto se quitará al guardar.
            </Text>
          ) : null}

          {/* Los audios son episodios del podcast: su categoría alimenta los
              filtros de esa sección. */}
          {post.mediaType === 'audio' ? (
            <View style={styles.categories}>
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>Categoría</Text>
              <View style={styles.chips}>
                {CATEGORIES.map((c) => (
                  <Chip
                    key={c.id}
                    label={c.label}
                    selected={category === c.id}
                    onPress={() => setCategory(category === c.id ? null : c.id)}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {error ? (
            <View style={[styles.errorBox, { borderColor: colors.danger, backgroundColor: colors.surfaceAlt }]}>
              <Feather name="alert-triangle" size={18} color={colors.danger} />
              <Text style={{ color: colors.danger, flex: 1, fontSize: 13 }}>{error}</Text>
            </View>
          ) : null}

          <Button
            label={phase === 'compressing' ? 'Optimizando…' : phase === 'uploading' ? 'Subiendo…' : 'Guardar cambios'}
            onPress={() => void save()}
            loading={saving}
            disabled={!text.trim()}
          />
        </AppScreen>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { minHeight: 200, borderWidth: 1, borderRadius: radius.xl, padding: spacing.lg, marginBottom: spacing.lg },
  input: { flex: 1, fontSize: 16, lineHeight: 24, minHeight: 120 },
  mediaRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md },
  previewWrap: { position: 'relative', marginBottom: spacing.lg },
  preview: { width: '100%', height: 200, borderRadius: radius.lg, overflow: 'hidden' },
  audioRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, minHeight: 72,
  },
  removeBtn: {
    position: 'absolute', top: spacing.sm, right: spacing.sm,
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center',
  },
  categories: { gap: spacing.sm, marginBottom: spacing.lg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  removedNote: { fontSize: 13, marginBottom: spacing.lg },
  errorBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md,
    borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.lg,
  },
});
